-- Cursed player · открытая регистрация для клиента и бакет обновлений
--
-- Как применить: SQL Editor проекта → вставить весь файл → Run. Идемпотентно.
--
-- Что появляется: app_registration_state() (клиент узнаёт, что регистрация
-- открыта, и не просит ключ) и публичный бакет storage «updates» для latest.json
-- и установщика.


-- ===================== регистрация и обновления (30.10) =====================

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
