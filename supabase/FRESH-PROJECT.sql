-- Cursed player · ПОЛНАЯ СХЕМА ДЛЯ НОВОГО ПРОЕКТА SUPABASE
--
-- Как применить (≈15 секунд):
--   1. Создать пустой проект на supabase.com (регион — Central EU / Frankfurt).
--   2. Открыть SQL Editor этого проекта.
--   3. Вставить весь файл и нажать Run.
--
-- После этого прислать владельцу разработки: Project URL и ПУБЛИЧНЫЙ ключ
-- sb_publishable_… (Settings → API). Секретный sb_secret_… не нужен.
--
-- Что внутри: базовая схема (user_data, profiles, app_config, RLS) + система
-- приглашений (invites, app_admins, триггер регистрации) + владелец в app_admins.


-- ===================== 1/4 · базовая схема =====================

-- Cursed player · базовая схема для ЧИСТОГО проекта Supabase.
--
-- Нужна, только если старого проекта нет (потерян доступ) и создаётся новый.
-- Для уже работающего проекта этот файл не нужен — там таблицы уже есть.
--
-- Что создаёт: user_data (лайки/плейлисты/история/настройки), profiles
-- (ник, аватар, описание, поиск людей), app_config (флаг «регистрация
-- открыта»), обновление updated_at на сервере и правила RLS:
-- свои строки читает и пишет только их владелец, профили читают все вошедшие.
--
-- Запускать ПЕРЕД миграциями приглашений: они ссылаются на app_config.

create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────── Конфигурация приложения ───────────────────────

create table if not exists public.app_config (
  id             int primary key default 1 check (id = 1),
  "open"         boolean not null default false,
  allowed_emails text[]  not null default '{}'
);

insert into public.app_config (id) values (1) on conflict (id) do nothing;

alter table public.app_config enable row level security;
-- Клиенту конфиг читать не нужно: registration_open() — security definer.
revoke all on public.app_config from public, anon, authenticated;

-- ─────────────────────────── Профили (публичные) ───────────────────────────

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null,
  display_name text not null default '',
  avatar       text,
  banner       text,
  bio          text not null default '',
  privacy      jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

-- Ник уникален без учёта регистра: @Dev и @dev — один человек.
create unique index if not exists profiles_username_key on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_write  on public.profiles;
drop policy if exists profiles_update on public.profiles;

-- Читают все вошедшие: по этим строкам работает раздел «Люди».
create policy profiles_read on public.profiles
  for select to authenticated using (true);

create policy profiles_write on public.profiles
  for insert to authenticated with check (id = auth.uid());

create policy profiles_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

grant select, insert, update on public.profiles to authenticated;

-- ─────────────────────────── Данные пользователя ───────────────────────────

-- Ключ — тройка (пользователь, вид, элемент): по ней PostgREST делает upsert
-- через `Prefer: resolution=merge-duplicates`, поэтому отдельного id нет.
create table if not exists public.user_data (
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null,
  item_id    text not null,
  payload    jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, item_id)
);

create index if not exists user_data_user_idx on public.user_data (user_id, updated_at desc);

alter table public.user_data enable row level security;

drop policy if exists user_data_read   on public.user_data;
drop policy if exists user_data_write  on public.user_data;
drop policy if exists user_data_update on public.user_data;
drop policy if exists user_data_delete on public.user_data;

create policy user_data_read on public.user_data
  for select to authenticated using (user_id = auth.uid());
create policy user_data_write on public.user_data
  for insert to authenticated with check (user_id = auth.uid());
create policy user_data_update on public.user_data
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy user_data_delete on public.user_data
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.user_data to authenticated;

-- Время изменения ставит сервер: часы устройств врут, и по этому полю
-- решается, чья запись новее.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists user_data_touch on public.user_data;
create trigger user_data_touch
  before insert or update on public.user_data
  for each row execute function public.set_updated_at();

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before insert or update on public.profiles
  for each row execute function public.set_updated_at();


-- ===================== 2/4 · приглашения (23.10) =====================

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


-- ===================== 3/4 · владелец в app_admins (28.10) =====================

-- Cursed player · владелец в списке тех, кто выдаёт коды.
--
-- Запускать ПОСЛЕ 20261023_invites.sql (он создаёт public.app_admins).
-- Идемпотентно: повторный запуск ничего не меняет.
--
-- Зачем отдельным файлом: app_config в проекте пустой (allowed_emails нет),
-- поэтому автоматический перенос владельца из app_config не срабатывает —
-- без этой строки invite_create ответит отказом.

insert into public.app_admins (email, user_id)
values ('ddfs509offical@gmail.com', '0859d133-e4a5-4d0e-be10-ab12b5835645')
on conflict (email) do update
  set user_id = coalesce(public.app_admins.user_id, excluded.user_id);

-- Проверка: должна вернуться одна строка.
select email, user_id, created_at from public.app_admins;


-- ===================== 4/5 · HWID и админ-панель (29.10) =====================

-- Cursed player · привязка аккаунта к компьютеру (HWID) и админ-панель.
--
-- Идемпотентно: можно запускать повторно.
-- Нужно применить к уже работающему проекту (после 20261023_invites.sql).
--
-- Что появляется:
--   public.device_links  — какие компьютеры привязаны к каким аккаунтам;
--   device_bind(hwid)    — привязать текущий компьютер (после входа);
--   device_lookup(hwid)  — к какому аккаунту привязан этот компьютер (до входа);
--   is_owner()           — роль для клиента (владелец или обычный);
--   admin_*              — данные и действия админ-панели (только владелец).

-- ─────────────────────────── 1. Привязка устройства ───────────────────────

create table if not exists public.device_links (
  user_id      uuid not null references auth.users (id) on delete cascade,
  hwid_hash    text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, hwid_hash)
);

create index if not exists device_links_hwid_idx on public.device_links (hwid_hash);

alter table public.device_links enable row level security;
-- Прямого доступа нет ни у кого: только через функции ниже.
revoke all on public.device_links from public, anon, authenticated;

-- Привязать этот компьютер к текущему аккаунту. Зовётся после входа; повторный
-- вызов просто обновляет «последний раз видели».
create or replace function public.device_bind(p_hwid text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hwid text := lower(btrim(coalesce(p_hwid, '')));
begin
  if auth.uid() is null then
    raise exception 'not_authorized: сначала войди в аккаунт';
  end if;
  if length(v_hwid) < 32 or length(v_hwid) > 128 then
    raise exception 'bad_hwid: неверный идентификатор устройства';
  end if;

  insert into public.device_links (user_id, hwid_hash)
  values (auth.uid(), v_hwid)
  on conflict (user_id, hwid_hash) do update set last_seen_at = now();
end $$;

-- К какому аккаунту привязан компьютер. Доступно ДО входа (иначе забывшему
-- пароль и ник не помочь), но отвечает только по точному HWID: перебор
-- бессмысленен — отпечаток 64 символа hex и известен лишь владельцу машины.
create or replace function public.device_lookup(p_hwid text)
returns table (username text, display_name text, email text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(p.username, '') as username,
    coalesce(p.display_name, '') as display_name,
    coalesce(u.email, '')::text as email
  from public.device_links d
  join auth.users u on u.id = d.user_id
  left join public.profiles p on p.id = d.user_id
  where d.hwid_hash = lower(btrim(coalesce(p_hwid, '')))
  order by d.last_seen_at desc
  limit 1;
$$;

grant execute on function public.device_bind(text) to authenticated;
grant execute on function public.device_lookup(text) to anon, authenticated;

-- ─────────────────────────── 2. Роль для клиента ───────────────────────────

-- Обёртка над is_app_owner(): клиенту не нужно знать про app_admins, ему
-- достаточно ответа «ты владелец или нет». Нужна, чтобы прятать разделы
-- разработчика у всех, кроме владельца.
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_app_owner();
$$;

grant execute on function public.is_owner() to authenticated;

-- ─────────────────────────── 3. Админ-панель ───────────────────────────────

-- Сводка: сколько людей, кодов, устройств и открыта ли регистрация.
drop function if exists public.admin_stats();
create or replace function public.admin_stats()
returns table (
  users bigint,
  invites_active bigint,
  invites_used bigint,
  devices bigint,
  registration_open boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_app_owner() then
    raise exception 'not_allowed: панель только для владельца';
  end if;

  return query
    select
      (select count(*) from auth.users),
      (select count(*) from public.invites i
        where i.revoked_at is null and i.expires_at > now() and i.used_count < i.max_uses),
      (select count(*) from public.invite_uses),
      (select count(*) from public.device_links),
      public.registration_open();
end $$;

-- Люди: ник, почта, когда зарегистрировался, сколько устройств привязано.
-- Почта видна только владельцу — это данные администрирования.
drop function if exists public.admin_users(integer);
create or replace function public.admin_users(p_limit integer default 200)
returns table (
  user_id uuid,
  username text,
  display_name text,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  devices bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_app_owner() then
    raise exception 'not_allowed: панель только для владельца';
  end if;

  return query
    select
      u.id,
      coalesce(p.username, ''),
      coalesce(p.display_name, ''),
      coalesce(u.email, '')::text,
      u.created_at,
      u.last_sign_in_at,
      (select count(*) from public.device_links d where d.user_id = u.id)
    from auth.users u
    left join public.profiles p on p.id = u.id
    order by u.created_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 1000));
end $$;

-- Устройства: аккаунт, отпечаток (обрезанный), когда привязан и когда видели.
drop function if exists public.admin_devices(integer);
create or replace function public.admin_devices(p_limit integer default 200)
returns table (
  username text,
  email text,
  hwid text,
  created_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_app_owner() then
    raise exception 'not_allowed: панель только для владельца';
  end if;

  return query
    select
      coalesce(p.username, ''),
      coalesce(u.email, '')::text,
      left(d.hwid_hash, 12) || '…',
      d.created_at,
      d.last_seen_at
    from public.device_links d
    join auth.users u on u.id = d.user_id
    left join public.profiles p on p.id = d.user_id
    order by d.last_seen_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 1000));
end $$;

-- Журнал: каким кодом кто зарегистрировался.
drop function if exists public.admin_invite_uses(integer);
create or replace function public.admin_invite_uses(p_limit integer default 100)
returns table (code text, email text, used_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_app_owner() then
    raise exception 'not_allowed: панель только для владельца';
  end if;

  return query
    select v.invite_code, coalesce(v.email, '')::text, v.used_at
    from public.invite_uses v
    order by v.used_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 1000));
end $$;

-- Открыть/закрыть регистрацию для всех (обычно закрыта: пускают только коды).
drop function if exists public.admin_set_open(boolean);
create or replace function public.admin_set_open(p_open boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_app_owner() then
    raise exception 'not_allowed: панель только для владельца';
  end if;

  update public.app_config set "open" = coalesce(p_open, false) where id = 1;
  return public.registration_open();
end $$;

grant execute on function public.admin_stats() to authenticated;
grant execute on function public.admin_users(integer) to authenticated;
grant execute on function public.admin_devices(integer) to authenticated;
grant execute on function public.admin_invite_uses(integer) to authenticated;
grant execute on function public.admin_set_open(boolean) to authenticated;


-- ===================== 5/5 · регистрация и обновления (30.10) =====================

-- Cursed player · открытая регистрация для клиента и автообновление.
--
-- Идемпотентно. Запускать один раз в SQL Editor проекта.
--
-- 1. app_registration_state() — клиент узнаёт, открыта ли регистрация:
--    если владелец открыл её в админ-панели, экран входа больше не требует ключ.
--    (Раньше флаг жил только на сервере, и приложение всё равно просило код.)
-- 2. Публичный бакет updates в Storage: приложение скачивает оттуда latest.json
--    и новый установщик. Читать может кто угодно (это установщик, не секрет),
--    загружать — только владелец через дашборд.

create or replace function public.app_registration_state()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'open', public.registration_open(),
    'invites', to_regclass('public.invites') is not null
  );
$$;

grant execute on function public.app_registration_state() to anon, authenticated;

-- ─────────────────────────── Обновления ───────────────────────────

insert into storage.buckets (id, name, public)
values ('updates', 'updates', true)
on conflict (id) do update set public = true;

drop policy if exists updates_public_read on storage.objects;
create policy updates_public_read on storage.objects
  for select
  using (bucket_id = 'updates');

-- Проверка после применения: бакет есть и публичный.
select id, name, public from storage.buckets where id = 'updates';
