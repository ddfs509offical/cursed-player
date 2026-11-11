-- ============================================================================
-- Cursed player · приглашения вместо ручной правки app_config.allowed_emails
-- ----------------------------------------------------------------------------
-- Как применять: Supabase Dashboard → SQL Editor → вставить файл целиком → Run.
-- Скрипт идемпотентный: повторный запуск не теряет уже созданные приглашения.
--
-- Что появляется:
--   public.invites       — сами коды (кто выдал, срок, лимит использований);
--   public.invite_uses   — журнал: какой аккаунт каким кодом зарегистрировался;
--   public.app_admins    — кто имеет право выдавать коды (владелец);
--   public.invite_create / invite_list / invite_revoke / invite_check — RPC;
--   триггер на auth.users — пускает регистрацию только по коду.
--
-- ВАЖНО для клиента: код передаётся в метаданных регистрации:
--   POST /auth/v1/signup { "email": ..., "password": ...,
--                          "data": { "invite_code": "ABCD-EFGH-JKLM" } }
-- Без этого поля триггер отклонит регистрацию (кроме владельца и open = true).
--
-- Владелец определяется по public.app_admins. При первом запуске таблица
-- автоматически заполняется из public.app_config.allowed_emails, если такая
-- колонка есть. Если схема app_config другая — добавь себя вручную:
--   insert into public.app_admins (email) values ('you@example.com')
--   on conflict (email) do nothing;
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Кто может выдавать приглашения
-- ----------------------------------------------------------------------------

create table if not exists public.app_admins (
  email      text primary key,
  user_id    uuid,
  created_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;

-- Переносим владельца из app_config.allowed_emails (если колонка существует).
do $$
declare
  v_type text;
begin
  select c.data_type
    into v_type
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'app_config'
    and c.column_name = 'allowed_emails';

  if v_type is null then
    return;
  end if;

  if v_type = 'ARRAY' then
    execute $sql$
      insert into public.app_admins (email)
      select distinct lower(btrim(x))
      from public.app_config, unnest(allowed_emails) as x
      where x is not null and btrim(x) <> ''
      on conflict (email) do nothing
    $sql$;
  elsif v_type = 'jsonb' then
    execute $sql$
      insert into public.app_admins (email)
      select distinct lower(btrim(x))
      from public.app_config, jsonb_array_elements_text(allowed_emails) as x
      where x is not null and btrim(x) <> ''
      on conflict (email) do nothing
    $sql$;
  end if;
end $$;

-- SECURITY DEFINER: функцию вызывают RPC, у которых нет прямого доступа к таблице.
create or replace function public.is_app_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.app_admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
       or (a.user_id is not null and a.user_id = auth.uid())
  );
$$;

create or replace function public.is_app_allowed_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.app_admins a
    where lower(a.email) = lower(btrim(coalesce(p_email, '')))
  );
$$;

-- Открыта ли регистрация для всех (app_config.open = true).
-- Читаем защищённо: при другой схеме конфига просто возвращаем false.
create or replace function public.registration_open()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v boolean := false;
begin
  if to_regclass('public.app_config') is null then
    return false;
  end if;

  begin
    execute 'select coalesce(bool_or("open"), false) from public.app_config' into v;
  exception when undefined_column then
    -- Запасной вариант: конфиг в виде key/value.
    begin
      execute $sql$
        select coalesce(bool_or("value"::boolean), false)
        from public.app_config
        where "key" = 'open'
      $sql$ into v;
    exception when others then
      v := false;
    end;
  end;

  return coalesce(v, false);
end $$;

-- ----------------------------------------------------------------------------
-- 2. Таблицы
-- ----------------------------------------------------------------------------

create table if not exists public.invites (
  code       text primary key,
  note       text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  max_uses   integer not null default 1,
  used_count integer not null default 0,
  revoked_at timestamptz,
  constraint invites_code_format
    check (code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  constraint invites_max_uses_range
    check (max_uses between 1 and 1000),
  constraint invites_used_count_range
    check (used_count >= 0)
);

create index if not exists invites_active_idx
  on public.invites (expires_at)
  where revoked_at is null;

create table if not exists public.invite_uses (
  id          bigserial primary key,
  invite_code text not null references public.invites (code) on delete cascade,
  user_id     uuid not null,
  email       text,
  used_at     timestamptz not null default now()
);

create index if not exists invite_uses_user_idx
  on public.invite_uses (user_id);

alter table public.invites enable row level security;
alter table public.invite_uses enable row level security;

-- ----------------------------------------------------------------------------
-- 3. Генерация кода
-- ----------------------------------------------------------------------------
-- Алфавит без похожих символов (нет I, O, 0, 1). Длина 32, поэтому
-- остаток от деления байта не даёт смещения. 12 символов ≈ 32^12 ≈ 1.15e18.
create or replace function public.generate_invite_code()
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  raw bytea := gen_random_bytes(12);
  result text := '';
  i integer;
begin
  for i in 0..11 loop
    result := result || substr(alphabet, (get_byte(raw, i) % length(alphabet)) + 1, 1);
  end loop;

  return substr(result, 1, 4) || '-' || substr(result, 5, 4) || '-' || substr(result, 9, 4);
end $$;

-- ----------------------------------------------------------------------------
-- 4. RPC для приложения
-- ----------------------------------------------------------------------------

-- Создать приглашение. Возвращает всю строку (включая code).
create or replace function public.invite_create(
  p_note     text default null,
  p_days     integer default 14,
  p_max_uses integer default 1
)
returns public.invites
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v public.invites;
  attempt integer := 0;
begin
  if not public.is_app_owner() then
    raise exception 'not_allowed: только владелец может создавать приглашения';
  end if;

  if p_days is null or p_days < 1 or p_days > 365 then
    raise exception 'bad_days: срок приглашения — от 1 до 365 дней';
  end if;

  if p_max_uses is null or p_max_uses < 1 or p_max_uses > 1000 then
    raise exception 'bad_max_uses: использований — от 1 до 1000';
  end if;

  loop
    attempt := attempt + 1;

    begin
      insert into public.invites (code, note, created_by, expires_at, max_uses)
      values (
        public.generate_invite_code(),
        nullif(btrim(coalesce(p_note, '')), ''),
        auth.uid(),
        now() + make_interval(days => p_days),
        p_max_uses
      )
      returning * into v;

      return v;

    exception when unique_violation then
      if attempt >= 10 then
        raise;
      end if;
    end;
  end loop;
end $$;

-- Список приглашений для настроек. Статус считается здесь, а не в UI.
create or replace function public.invite_list()
returns table (
  code       text,
  note       text,
  created_at timestamptz,
  expires_at timestamptz,
  max_uses   integer,
  used_count integer,
  revoked_at timestamptz,
  status     text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_app_owner() then
    raise exception 'not_allowed: только владелец видит приглашения';
  end if;

  return query
    select
      i.code,
      i.note,
      i.created_at,
      i.expires_at,
      i.max_uses,
      i.used_count,
      i.revoked_at,
      case
        when i.revoked_at is not null then 'revoked'
        when i.expires_at <= now() then 'expired'
        when i.used_count >= i.max_uses then 'used'
        else 'active'
      end
    from public.invites i
    order by i.created_at desc;
end $$;

-- Отозвать код. Уже зарегистрированных это не удаляет.
create or replace function public.invite_revoke(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  if not public.is_app_owner() then
    raise exception 'not_allowed: только владелец может отзывать приглашения';
  end if;

  update public.invites
     set revoked_at = coalesce(revoked_at, now())
   where code = upper(btrim(coalesce(p_code, '')));

  get diagnostics changed = row_count;
  return changed > 0;
end $$;

-- Проверка кода до отправки формы регистрации (код не расходуется).
-- Доступна анонимно: коды высокоэнтропийные, перебор нереален.
create or replace function public.invite_check(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.invites i
    where i.code = upper(btrim(coalesce(p_code, '')))
      and i.revoked_at is null
      and i.expires_at > now()
      and i.used_count < i.max_uses
  );
$$;

-- ----------------------------------------------------------------------------
-- 5. Триггер регистрации
-- ----------------------------------------------------------------------------
-- Перед созданием пользователя: владелец/разрешённый адрес — пропускаем,
-- open = true — пропускаем, иначе требуется действующий код.
-- Проверка и списание использования идут одним UPDATE, поэтому два
-- одновременных signup не смогут израсходовать одно приглашение дважды.
create or replace function public.enforce_registration_invite()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_code   text;
  v_invite public.invites;
begin
  if public.is_app_allowed_email(new.email) then
    return new;
  end if;

  if public.registration_open() then
    return new;
  end if;

  v_code := upper(btrim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')));

  if v_code = '' then
    raise exception 'registration_closed: нужен код приглашения';
  end if;

  update public.invites i
     set used_count = i.used_count + 1
   where i.code = v_code
     and i.revoked_at is null
     and i.expires_at > now()
     and i.used_count < i.max_uses
  returning * into v_invite;

  if not found then
    raise exception 'registration_closed: приглашение недействительно, просрочено или уже использовано';
  end if;

  insert into public.invite_uses (invite_code, user_id, email)
  values (v_invite.code, new.id, new.email);

  return new;
end $$;

-- Убираем старый триггер закрытой регистрации, иначе он сработает раньше
-- нашего и отклонит регистрацию даже с правильным кодом. Удаляем только
-- триггеры, чья функция ссылается на app_config / allowed_emails /
-- registration_closed, — чужие триггеры не затрагиваются.
do $$
declare
  r record;
begin
  for r in
    select t.tgname
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'auth.users'::regclass
      and not t.tgisinternal
      and t.tgname <> 'on_auth_user_registration_invite'
      and (
        p.prosrc ilike '%registration_closed%'
        or p.prosrc ilike '%allowed_emails%'
        or p.prosrc ilike '%app_config%'
      )
  loop
    execute format('drop trigger if exists %I on auth.users', r.tgname);
  end loop;
end $$;

drop trigger if exists on_auth_user_registration_invite on auth.users;

create trigger on_auth_user_registration_invite
before insert on auth.users
for each row
execute function public.enforce_registration_invite();

-- ----------------------------------------------------------------------------
-- 6. Права
-- ----------------------------------------------------------------------------
-- Прямого доступа к таблицам у клиентов нет: только через RPC выше.
revoke all on table public.app_admins   from public, anon, authenticated;
revoke all on table public.invites      from public, anon, authenticated;
revoke all on table public.invite_uses  from public, anon, authenticated;

revoke all on function public.generate_invite_code()          from public, anon, authenticated;
revoke all on function public.is_app_owner()                  from public, anon, authenticated;
revoke all on function public.is_app_allowed_email(text)       from public, anon, authenticated;
revoke all on function public.registration_open()             from public, anon, authenticated;
revoke all on function public.enforce_registration_invite()   from public, anon, authenticated;

revoke all on function public.invite_create(text, integer, integer) from public, anon, authenticated;
revoke all on function public.invite_list()                         from public, anon, authenticated;
revoke all on function public.invite_revoke(text)                   from public, anon, authenticated;
revoke all on function public.invite_check(text)                    from public, anon, authenticated;

grant execute on function public.invite_create(text, integer, integer) to authenticated;
grant execute on function public.invite_list()                         to authenticated;
grant execute on function public.invite_revoke(text)                   to authenticated;
grant execute on function public.invite_check(text)                    to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Быстрая проверка после применения
-- ----------------------------------------------------------------------------
-- Ручной код (владельцу из SQL Editor, где auth.uid() = null):
--   insert into public.invites (code, note, expires_at, max_uses)
--   values (public.generate_invite_code(), 'вручную', now() + interval '14 days', 1)
--   returning code;
--
-- Список триггеров на auth.users (должен остаться только наш):
--   select tgname from pg_trigger
--   where tgrelid = 'auth.users'::regclass and not tgisinternal;
--
-- Журнал использований:
--   select * from public.invite_uses order by used_at desc;
--
-- Откат (вернёт ручную правку allowed_emails, старый триггер придётся
-- восстановить самостоятельно):
--   drop trigger if exists on_auth_user_registration_invite on auth.users;
--   drop function if exists public.invite_check(text);
--   drop function if exists public.invite_revoke(text);
--   drop function if exists public.invite_list();
--   drop function if exists public.invite_create(text, integer, integer);
--   drop function if exists public.enforce_registration_invite();
--   drop function if exists public.registration_open();
--   drop function if exists public.is_app_allowed_email(text);
--   drop function if exists public.is_app_owner();
--   drop function if exists public.generate_invite_code();
--   drop table if exists public.invite_uses;
--   drop table if exists public.invites;
--   drop table if exists public.app_admins;
