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
