-- Cursed player · HWID и админ-панель для УЖЕ РАБОТАЮЩЕГО проекта
--
-- Как применить (≈10 секунд):
--   1. Открыть SQL Editor своего проекта.
--   2. Вставить весь файл и нажать Run. Скрипт идемпотентный.
--
-- Что появляется: привязка аккаунта к компьютеру (device_links, device_bind,
-- device_lookup), роль владельца для клиента (is_owner) и функции админ-панели
-- (admin_stats, admin_users, admin_devices, admin_invite_uses, admin_set_open).


-- ===================== HWID и админ-панель (29.10) =====================

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
