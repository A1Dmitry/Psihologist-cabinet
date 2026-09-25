-- ============================================================================
-- МИГРАЦИЯ (ПОДГОТОВЛЕНА, НЕ ПРИМЕНЕНА)
-- Открытая регистрация специалистов через Google (Supabase Auth OAuth, PKCE)
-- Проект: phiavtroybgwyjdhqqkh
-- Дата:   2026-09-25
--
-- ⚠ Применять ТОЛЬКО после прочтения раздела «Что делает миграция» ниже и
--   только вручную владельцем (SQL Editor / supabase db push). Файл НЕ входит
--   в supabase/schema.sql и не применяется CI (`.github/workflows/pages.yml`
--   деплоит только статику; `supabase-deploy.yml` — только Edge Functions).
--
-- ---------------------------------------------------------------------------
-- ЧТО ДЕЛАЕТ МИГРАЦИЯ (5 шагов, всё аддитивно — удаления данных нет)
-- ---------------------------------------------------------------------------
-- 1. `psychologists.profile_completed boolean not null default false`
--      — признак «профиль заполнен» (онбординг).
--      ВАЖНО про существующие данные: колонка добавляется со значением false,
--      но сразу в тот же момент выполняется ОДНОКРАТНАЯ обратная миграция
--      существующих строк в true (`update psychologists set profile_completed
--      = true`) — реальные профили портала заполнены, и помечать их
--      «незаполненными» было бы ложью. Бэкфилл выполняется ТОЛЬКО если колонка
--      была создана этим скриптом: при повторном применении он не затрёт
--      profile_completed = false у новых (недозаполненных) Google-кабинетов.
--
-- 2. `public.link_or_create_psychologist_for_google()` — security definer RPC.
--      Атомарно (две advisory-блокировки: по email и по auth.uid) выполняет
--      поиск → привязку существующей записи → создание новой. Email берётся
--      ТОЛЬКО из auth.users (доверенный сервер), никогда из аргументов.
--
-- 3. `public.complete_psychologist_profile(...)` — security definer RPC.
--      Единственный способ перевести профиль в «заполнен». Пишет только
--      разрешённые поля + profile_completed. Не трогает email/is_active/
--      owner_id/slug.
--
-- 4. Ограничение прав `authenticated` на таблице psychologists (колоночные
--      гранты): прямой INSERT запрещён entirely (создание кабинета — только
--      через RPC из п.2), UPDATE разрешён только на список публичных полей
--      профиля. email, is_active, owner_id, id, created_at и profile_completed
--      через обычный PATCH изменить нельзя.
--
-- 5. `public_profiles` пересоздаётся с условием `is_active and profile_completed`
--      — недозаполненные Google-кабинеты не попадают в публичный каталог,
--      пока специалист не заполнит профиль. Существующие профили не затронуты
--      (см. бэкфилл в п.1).
--
-- ОТКАТ (если понадобится):
--   drop function if exists public.complete_psychologist_profile(text,text,text,text,text);
--   drop function if exists public.link_or_create_psychologist_for_google();
--   -- пересоздать public_profiles из supabase/schema.sql (без profile_completed)
--   -- вернуть гранты: grant insert, update on public.psychologists to authenticated;
--   alter table public.psychologists drop column if exists profile_completed;
-- ============================================================================

-- ============================================================================
-- 1. profile_completed (+ однократный бэкфилл существующих профилей)
-- ============================================================================
do $$
declare
  v_added boolean := false;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'psychologists'
       and column_name  = 'profile_completed'
  ) then
    alter table public.psychologists
      add column profile_completed boolean not null default false;
    v_added := true;
  end if;

  -- Однократно: все уже существующие кабинеты считаем заполненными.
  -- Повторный прогон миграции этого не делает (v_added = false), поэтому
  -- недозаполненные Google-кабинеты не «дозаполняются» сами собой.
  if v_added then
    update public.psychologists set profile_completed = true;
  end if;
end $$;

comment on column public.psychologists.profile_completed is
  'Профиль заполнен специалистом (онбординг пройден). false → показывается форма заполнения профиля; публичный каталог (public_profiles) такой кабинет не показывает. Меняется только public.complete_psychologist_profile().';

-- Поиск «свой кабинет» по auth.uid() — на каждой авторизации
create index if not exists psychologists_owner_idx on public.psychologists (owner_id);

-- ============================================================================
-- 2. link_or_create_psychologist_for_google — атомарный поиск/привязка/создание
-- ============================================================================

-- Все перегрузки — до создания канонической (конвенция schema.sql: PostgREST
-- не переключается на новую сигнатуру, пока жива старая).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'link_or_create_psychologist_for_google'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;

create or replace function public.link_or_create_psychologist_for_google()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner     uuid := auth.uid();
  v_email     text;
  v_name      text;
  v_confirmed timestamptz;
  v_bound_n   int;
  v_bound_id  text;
  v_bound_active boolean;
  v_match_n   int;
  v_match     record;
  v_id        text;
  v_base      text;
  v_slug      text;
  v_i         int := 0;
begin
  -- ——— 0. Кто это: identity берётся ТОЛЬКО из Supabase Auth ———
  if v_owner is null then
    return jsonb_build_object(
      'ok', false, 'code', 'not_authenticated',
      'error', 'Вход не выполнен: нет активной сессии Supabase Auth. Войдите через Google снова.'
    );
  end if;

  -- email — из auth.users, а не из JWT payload и не из аргументов браузера.
  select lower(trim(coalesce(u.email, ''))),
         u.email_confirmed_at,
         coalesce(
           nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), ''),
           nullif(trim(coalesce(u.raw_user_meta_data ->> 'name', '')), ''),
           nullif(trim(concat_ws(' ',
             coalesce(u.raw_user_meta_data ->> 'given_name', ''),
             coalesce(u.raw_user_meta_data ->> 'family_name', ''))), ''),
           ''
         )
    into v_email, v_confirmed, v_name
    from auth.users u
   where u.id = v_owner;

  if v_email = '' then
    return jsonb_build_object(
      'ok', false, 'code', 'no_email',
      'error', 'В Google-аккаунте нет email. Войдите аккаунтом, у которого есть подтверждённый email.'
    );
  end if;

  if v_confirmed is null then
    return jsonb_build_object(
      'ok', false, 'code', 'email_unconfirmed',
      'error', 'Email Google-аккаунта не подтверждён в Supabase Auth. Повторите вход; если ошибка повторяется — обратитесь к администратору портала.'
    );
  end if;

  -- ——— 1. Сериализация: гонка «два параллельных входа» не создаст дублей ———
  perform pg_advisory_xact_lock(hashtextextended('psy_email:' || v_email, 0));
  perform pg_advisory_xact_lock(hashtextextended('psy_owner:' || v_owner::text, 0));

  -- ——— 2. Уже привязан к этому auth.uid() → идемпотентно, без дубля ———
  select count(*), min(id), bool_and(is_active)
    into v_bound_n, v_bound_id, v_bound_active
    from public.psychologists
   where owner_id = v_owner;

  if v_bound_n > 1 then
    return jsonb_build_object(
      'ok', false, 'code', 'multiple_owned',
      'error', 'К этому аккаунту привязано несколько кабинетов — автоматически выбрать нельзя.',
      'owned', v_bound_n,
      'resolution', 'Обратитесь к администратору портала: нужно оставить один кабинет и отвязать остальные (update psychologists set owner_id = null where …).'
    );
  end if;

  if v_bound_n = 1 then
    return jsonb_build_object(
      'ok', true, 'code', 'already_linked', 'id', v_bound_id, 'created', false,
      'is_active', coalesce(v_bound_active, false),
      'profile_completed', (select profile_completed from public.psychologists where id = v_bound_id)
    );
  end if;

  -- ——— 3. Поиск существующей записи специалиста по email ———
  -- Сравнение без учёта регистра и окружающих пробелов: lower(trim(...)).
  -- Уникальность email в схеме — регистрозависимая (unique на email), поэтому
  -- теоретически возможны «двойники» A@b.com и a@b.com — их считаем дублями.
  select count(*) into v_match_n
    from public.psychologists
   where lower(trim(email)) = v_email;

  if v_match_n > 1 then
    return jsonb_build_object(
      'ok', false, 'code', 'duplicate_email',
      'error', format('Найдено несколько записей специалиста с email %s (без учёта регистра). Автоматически выбрать нельзя.', v_email),
      'matches', v_match_n,
      'resolution', 'Оставьте одну запись: удалите лишние или измените им email (update psychologists set email = … where id = …), затем повторите вход через Google.'
    );
  end if;

  if v_match_n = 1 then
    select id, owner_id, is_active into v_match
      from public.psychologists
     where lower(trim(email)) = v_email;

    -- 3а. Занята другим аккаунтом → не отбираем и не перезаписываем
    if v_match.owner_id is not null then
      return jsonb_build_object(
        'ok', false, 'code', 'email_taken',
        'error', format('Запись специалиста с email %s уже привязана к другой учётной записи. Доступ не выдан.', v_email),
        'resolution', 'Если это ваш кабинет — войдите тем способом, которым он привязывался (код из письма), и обратитесь к администратору портала для переноса владельца. Самостоятельно «отжать» чужую запись нельзя.'
      );
    end if;

    -- 3б. Отключённый кабинет входом не реактивируется (инвариант issue #40/#46)
    if not v_match.is_active then
      return jsonb_build_object(
        'ok', false, 'code', 'profile_inactive',
        'error', 'Учётная запись отключена. Для восстановления доступа обратитесь к администратору портала.',
        'resolution', 'Реактивация — только явным действием администратора (SQL Editor от имени service_role). Вход сам по себе доступа не возвращает.'
      );
    end if;

    -- 3в. Безопасная привязка: меняем owner_id и updated_at.
    --     Ни одно содержательное поле (full_name, about, slug, phone, услуги,
    --     клиенты, сессии…) не перезаписывается.
    --
    --     profile_completed ВЫЧИСЛЯЕТСЯ из самой записи, а не сбрасывается:
    --     существующий профиль с заполненными обязательными полями не должен
    --     прогоняться через онбординг и тем более не должен быть затерт
    --     повторным вводом «ФИО/телефон/город/о себе». Это производное значение,
    --     а не пользовательские данные.
    update public.psychologists
       set owner_id   = v_owner,
           profile_completed = (
             coalesce(trim(full_name), '')      <> ''
             and coalesce(trim(phone), '')      <> ''
             and coalesce(trim(specialization), '') <> ''
             and coalesce(trim(city), '')       <> ''
             and coalesce(trim(about), '')      <> ''
           ),
           updated_at = now()
     where id = v_match.id;

    return jsonb_build_object(
      'ok', true, 'code', 'linked', 'id', v_match.id, 'created', false,
      'is_active', true,
      'profile_completed', (select profile_completed from public.psychologists where id = v_match.id)
    );
  end if;

  -- ——— 4. Записи нет → создаём новую, привязанную к auth.uid() ———
  --     Статус «профиль не заполнен» = profile_completed = false.
  if coalesce(trim(v_name), '') = '' then
    v_name := split_part(v_email, '@', 1);
  end if;

  v_base := lower(regexp_replace(v_name, '[^0-9a-zA-Zа-яё]+', '-', 'gi'));
  v_base := trim(both '-' from v_base);
  if v_base is null or v_base = '' then
    v_base := 'specialist';
  end if;
  v_slug := v_base;
  while exists (select 1 from public.psychologists where slug = v_slug) loop
    v_i := v_i + 1;
    v_slug := v_base || '-' || v_i;
  end loop;

  insert into public.psychologists (email, full_name, specialization, slug, owner_id, is_active, profile_completed)
  values (v_email, v_name, 'Психолог', v_slug, v_owner, true, false)
  returning id into v_id;

  -- стартовые настройки кабинета: без них сетка слотов и часовой пояс не определены
  insert into public.session_settings (psychologist_id)
  values (v_id)
  on conflict (psychologist_id) do nothing;

  return jsonb_build_object(
    'ok', true, 'code', 'created', 'id', v_id, 'created', true,
    'is_active', true, 'profile_completed', false
  );
end;
$$;

revoke execute on function public.link_or_create_psychologist_for_google() from public, anon;
grant  execute on function public.link_or_create_psychologist_for_google() to authenticated;

comment on function public.link_or_create_psychologist_for_google() is
  'Открытая регистрация/вход специалиста через Google. Атомарно: уже привязанный кабинет → linked/created=false; существующая запись с тем же email и свободным owner_id → привязка без перезаписи данных; записи нет → создание с profile_completed=false. Дубли и занятые/отключённые записи возвращают ok=false с code и resolution.';

-- ============================================================================
-- 3. complete_psychologist_profile — онбординг (единственный писатель флага)
-- ============================================================================
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'complete_psychologist_profile'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;

create or replace function public.complete_psychologist_profile(
  p_full_name      text,
  p_phone          text,
  p_specialization text,
  p_city           text,
  p_about          text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_id    text;
  v_n     int;
begin
  if v_owner is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated',
      'error', 'Вход не выполнен. Войдите через Google снова.');
  end if;

  select count(*), min(id) into v_n, v_id
    from public.psychologists
   where owner_id = v_owner;

  if v_n = 0 then
    return jsonb_build_object('ok', false, 'code', 'no_profile',
      'error', 'Кабинет не привязан к аккаунту. Повторите вход через Google.');
  end if;
  if v_n > 1 then
    return jsonb_build_object('ok', false, 'code', 'multiple_owned',
      'error', 'К аккаунту привязано несколько кабинетов; заполнение невозможно.',
      'resolution', 'Обратитесь к администратору портала.');
  end if;

  if coalesce(trim(coalesce(p_full_name, '')), '')      = ''
  or coalesce(trim(coalesce(p_phone, '')), '')          = ''
  or coalesce(trim(coalesce(p_specialization, '')), '') = ''
  or coalesce(trim(coalesce(p_city, '')), '')           = ''
  or coalesce(trim(coalesce(p_about, '')), '')          = '' then
    return jsonb_build_object('ok', false, 'code', 'validation',
      'error', 'Заполните ФИО, телефон, специализацию, город и рассказ о себе.');
  end if;

  -- Пишем ТОЛЬКО разрешённые поля профиля. email, is_active, owner_id, slug,
  -- id, created_at и любые служебные колонки здесь не touched.
  update public.psychologists
     set full_name         = trim(p_full_name),
         phone             = trim(p_phone),
         specialization    = trim(p_specialization),
         city              = trim(p_city),
         about             = trim(p_about),
         profile_completed = true,
         updated_at        = now()
   where id = v_id;

  return jsonb_build_object('ok', true, 'code', 'completed', 'id', v_id, 'profile_completed', true);
end;
$$;

revoke execute on function public.complete_psychologist_profile(text, text, text, text, text) from public, anon;
grant  execute on function public.complete_psychologist_profile(text, text, text, text, text) to authenticated;

comment on function public.complete_psychologist_profile(text, text, text, text, text) is
  'Онбординг специалиста: сохраняет только публичные поля профиля и выставляет profile_completed = true. Не меняет email, is_active, owner_id, slug.';

-- ============================================================================
-- 4. Права authenticated на psychologists: без прямого INSERT и с защитой
--    служебных колонок
-- ============================================================================
-- Почему INSERT запрещён полностью: при ОТКРЫТОЙ регистрации любой
-- authenticated смог бы через PostgREST создать сколько угодно кабинетов
-- (политика owner_modify разрешает insert при owner_id = auth.uid()).
-- Единственный легитимный создатель кабинета — RPC из п.2 (security definer).
revoke insert on public.psychologists from public, anon, authenticated;

-- Колоночные гранты: UPDATE только публичных полей профиля.
-- НЕ обновляются через обычный PATCH:
--   id, email (подтверждённый email входа), is_active (статус доступа),
--   owner_id (auth.uid() владельца), created_at, profile_completed.
revoke update on public.psychologists from public, anon, authenticated;
grant  update (
  full_name, phone, specialization, city, about, website, source_url,
  address, experience, slug, profession, greeting, approach, photo_url,
  public_email, directions, education, experience_items, socials,
  payment_links, payment_requisites, key_verifier, updated_at
) on public.psychologists to authenticated;

-- Создавать кабинет и менять статус заполнения — только через RPC/service_role.
-- (service_role обходит RLS и сохраняет полные права на таблицу.)

-- ============================================================================
-- 5. Публичный каталог: недозаполненные кабинеты не публикуются
-- ============================================================================
-- Существующие специалисты не пострадали: на шаге 1 им выставлен
-- profile_completed = true.
drop view if exists public.public_profiles;
create view public.public_profiles as
  select id, full_name, phone, specialization, city, about, website, source_url, address,
         experience, slug, profession, greeting, approach, photo_url, public_email,
         directions, education, experience_items, socials, payment_links, payment_requisites,
         is_active, created_at
    from public.psychologists
   where is_active
     and profile_completed;

-- ============================================================================
-- ПРОВЕРКА ПОСЛЕ ПРИМЕНЕНИЯ (read-only, владельцу)
-- ============================================================================
-- select proname from pg_proc
--  where pronamespace = 'public'::regnamespace
--    and proname in ('link_or_create_psychologist_for_google','complete_psychologist_profile');
--
-- select count(*) filter (where profile_completed) as completed,
--        count(*) filter (where not profile_completed) as pending
--   from public.psychologists;
--
-- -- колоночные права (должны быть только перечисленные колонки):
-- select string_agg(column_name, ', ' order by column_name)
--   from information_schema.column_privileges
--  where table_schema='public' and table_name='psychologists'
--    and grantee='authenticated' and privilege_type='UPDATE';
-- ============================================================================
