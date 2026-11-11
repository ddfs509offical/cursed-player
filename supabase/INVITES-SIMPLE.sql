-- Cursed player · приглашения «как есть» на уже работающем проекте.
--
-- Одна кнопка → код, без ручной правки базы. Нужно, когда в проекте уже есть
-- profiles / app_config, но таблиц invites ещё нет (или миграция не применена).
--
-- Идемпотентно: можно запускать повторно, ничего не ломает.
-- Состав: app_admins + invites + invite_uses, функции invite_create / invite_list /
-- invite_revoke / invite_check, app_registration_state и триггер регистрации по коду.
-- Без проверки владельца: коды может выдавать любой вошедший в приложение —
-- сама сборка раздаётся только вами.

create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────── Кто выдаёт коды ───────────────────────────

create table if not exists public.app_admins (
  email      text primary key,
  user_id    uuid,
  created_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;
revoke all on public.app_admins from public, anon, authenticated;

-- ─────────────────────────── Сами коды ────────────────────────────────

create table if not exists public.invites (
  code       text primary key,
  note       text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  max_uses   integer not null default 1,
  used_count integer not null default 0,
  revoked_at timestamptz
);

create table if not exists public.invite_uses (
  invite_code text not null references public.invites (code) on delete cascade,
  user_id     uuid references auth.users (id) on delete set null,
  email       text,
  used_at     timestamptz not null default now()
);

alter table public.invites enable row level security;
alter table public.invite_uses enable row level security;
revoke all on public.invites from public, anon, authenticated;
revoke all on public.invite_uses from public, anon, authenticated;

-- Конфиг, если его ещё нет: триггер ниже читает флаг open.
create table if not exists public.app_config (
  id        int primary key default 1 check (id = 1),
  "open"    boolean not null default false
);
insert into public.app_config (id) values (1) on conflict (id) do nothing;
alter table public.app_config enable row level security;

-- ─────────────────────────── Генератор кода ───────────────────────────

-- Алфавит без похожих букв (нет I, O, 0, 1). 12 символов ≈ 3.6e21 вариантов.
create or replace function public.generate_invite_code()
returns text
language plpgsql
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

revoke all on function public.generate_invite_code() from public, anon, authenticated;

-- ─────────────────────────── RPC для приложения ───────────────────────

-- Создать код. Возвращает строку таблицы (включая code).
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
  if auth.uid() is null then
    raise exception 'not_authorized: сначала войди в аккаунт';
  end if;

  loop
    attempt := attempt + 1;
    begin
      insert into public.invites (code, note, created_by, expires_at, max_uses)
      values (
        public.generate_invite_code(),
        nullif(btrim(coalesce(p_note, '')), ''),
        auth.uid(),
        now() + make_interval(days => greatest(1, least(coalesce(p_days, 14), 365))),
        greatest(1, least(coalesce(p_max_uses, 1), 1000))
      )
      returning * into v;
      return v;
    exception when unique_violation then
      if attempt >= 5 then
        raise;
      end if;
    end;
  end loop;
end $$;

-- Список: любой вошедший видит коды (это инструмент владельца и его сборки).
create or replace function public.invite_list()
returns table (
  code        text,
  note        text,
  created_at  timestamptz,
  expires_at  timestamptz,
  max_uses    integer,
  used_count  integer,
  revoked_at  timestamptz,
  status      text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
  order by i.created_at desc
  limit 200;
$$;

create or replace function public.invite_revoke(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  if auth.uid() is null then
    raise exception 'not_authorized: сначала войди в аккаунт';
  end if;
  update public.invites
     set revoked_at = coalesce(revoked_at, now())
   where code = upper(btrim(coalesce(p_code, '')));
  get diagnostics changed = row_count;
  return changed > 0;
end $$;

-- Проверка кода до отправки формы. Доступна анонимно: коды перебрать нереально.
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

-- Открыта ли регистрация для всех — это читает экран входа.
create or replace function public.app_registration_state()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'open', coalesce((select "open" from public.app_config where id = 1), false),
    'invites', true
  );
$$;

grant execute on function public.invite_create(text, integer, integer) to authenticated;
grant execute on function public.invite_list() to authenticated;
grant execute on function public.invite_revoke(text) to authenticated;
grant execute on function public.invite_check(text) to anon, authenticated;
grant execute on function public.app_registration_state() to anon, authenticated;

-- ─────────────────────────── Триггер регистрации ───────────────────────

-- Без действующего кода регистрация закрыта; при open = true пускаем всех.
create or replace function public.enforce_registration_invite()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code   text;
  v_invite public.invites;
begin
  if coalesce((select "open" from public.app_config where id = 1), false) then
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

revoke all on function public.enforce_registration_invite() from public, anon, authenticated;

drop trigger if exists on_auth_user_registration_invite on auth.users;
create trigger on_auth_user_registration_invite
before insert on auth.users
for each row
execute function public.enforce_registration_invite();

-- Проверка после применения: таблицы на месте.
select
  to_regclass('public.invites') as invites,
  to_regclass('public.invite_uses') as invite_uses,
  coalesce((select "open" from public.app_config where id = 1), false) as registration_open;
