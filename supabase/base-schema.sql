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
