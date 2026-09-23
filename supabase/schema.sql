-- ============================================================
-- Supabase / PostgreSQL schema — портал кабинетов психологов
-- Code First источник истины: js/models/entities.js
-- Маппинг колонок: js/services/supabaseSync.js
-- Модель данных сайта-первоисточника: docs/DATA-MODEL.md
--
-- Файл идемпотентен: можно применять и к пустой, и к существующей БД.
-- ============================================================

-- ——— Психолог — владелец кабинета (расширенный публичный профиль сайта) ———
create table if not exists psychologists (
  id                 text primary key default ('psy_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  email              text not null unique,
  full_name          text not null default '',
  phone              text not null default '',
  specialization     text not null default 'Психолог',
  city               text not null default '',
  about              text not null default '',
  website            text not null default '',
  source_url         text not null default '',
  address            text not null default '',
  experience         text not null default '',
  slug               text not null unique,
  profession         text not null default 'psychologist',      -- discriminator: psychologist|psychotherapist|coach|… (портал не только для психологов)
  -- «Обо мне»
  greeting           text not null default '',
  approach           text not null default '',
  photo_url          text not null default '',
  public_email       text not null default '',
  -- Списки профиля (jsonb — без потерь, структурированно)
  directions         jsonb not null default '[]'::jsonb,          -- [{title, details}] «Направления работы» / «С чем могу помочь»
  education          jsonb not null default '{}'::jsonb,          -- {basic:[{title,institution,details}], additional:[...]}
  experience_items   jsonb not null default '[]'::jsonb,          -- [{organisation, details, years, isCurrent}]
  socials            jsonb not null default '[]'::jsonb,          -- [{kind, url, title}] telegram/instagram/...
  payment_links      jsonb not null default '[]'::jsonb,          -- [{label, url, kind: service|donation|other}]
  payment_requisites jsonb not null default '{}'::jsonb,          -- {recipient, legalAddress, unp, account, bankName, bik, purpose, donationUrl}
  is_active          boolean not null default true,
  key_verifier       jsonb,                                       -- {salt, iv, data} — verifier ключа; пароль не хранится
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Миграция существующей БД (no-op, если колонки уже есть)
alter table psychologists add column if not exists profession          text not null default 'psychologist';
alter table psychologists add column if not exists greeting           text not null default '';
alter table psychologists add column if not exists approach           text not null default '';
alter table psychologists add column if not exists photo_url          text not null default '';
alter table psychologists add column if not exists public_email       text not null default '';
alter table psychologists add column if not exists directions         jsonb not null default '[]'::jsonb;
alter table psychologists add column if not exists education          jsonb not null default '{}'::jsonb;
alter table psychologists add column if not exists experience_items   jsonb not null default '[]'::jsonb;
alter table psychologists add column if not exists socials            jsonb not null default '[]'::jsonb;
alter table psychologists add column if not exists payment_links      jsonb not null default '[]'::jsonb;
alter table psychologists add column if not exists payment_requisites jsonb not null default '{}'::jsonb;
alter table psychologists add column if not exists updated_at         timestamptz not null default now();

-- ——— Услуга психолога (блок «Услуги» сайта) ———
create table if not exists services (
  id               text primary key default ('svc_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id  text not null references psychologists(id) on delete cascade,
  title            text not null default '',
  description      text not null default '',                      -- «в г. Гродно (Беларусь)», «в Skype, WhatsApp, ...»
  duration_min     integer not null default 60,
  price            numeric not null default 0,
  currency         text not null default 'BYN',                   -- BYN | RUB | ...
  format           text not null default 'offline',               -- offline | online
  platforms        jsonb not null default '[]'::jsonb,            -- ['skype','whatsapp','viber','telegram','zoom']
  pay_url          text not null default '',                      -- bePaid product URL и т.п.
  sort_order       integer not null default 0,
  payment_policy   text,                                          -- null = из session_settings
  deposit_percent  numeric,
  deposit_amount   numeric,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

alter table services add column if not exists description     text not null default '';
alter table services add column if not exists platforms       jsonb not null default '[]'::jsonb;
alter table services add column if not exists pay_url         text not null default '';
alter table services add column if not exists sort_order      integer not null default 0;
alter table services add column if not exists payment_policy  text;
alter table services add column if not exists deposit_percent numeric;
alter table services add column if not exists deposit_amount  numeric;

create index if not exists services_psy_idx on services (psychologist_id);

-- ——— Клиент (PII может храниться зашифрованным) ———
create table if not exists clients (
  id                text primary key default ('cli_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id   text not null references psychologists(id) on delete cascade,
  name              text not null default '',
  nickname          text not null default '',
  phone             text not null default '',
  contact           text not null default '',
  note              text not null default '',
  trust_level       text not null default 'new',                 -- new | trusted | caution | blocked
  no_show_count     integer not null default 0,
  cancel_count      integer not null default 0,
  verified_contact  boolean not null default false,
  encrypted_pii     jsonb,                                        -- {salt, iv, data} или null
  nickname_hash     text not null default '',
  needs_encryption  boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists clients_psy_idx on clients (psychologist_id);

-- ——— Сессия / запись ———
create table if not exists sessions (
  id                   text primary key default ('ses_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id      text not null references psychologists(id) on delete cascade,
  client_id            text references clients(id) on delete set null,
  service_id           text references services(id) on delete set null,
  session_date         text not null,                             -- YYYY-MM-DD
  session_time         text not null,                             -- HH:MM
  status               text not null default 'pending',           -- pending|held|confirmed|paid|done|cancelled|no_show|expired
  note                 text not null default '',
  video_platform       text not null default '',
  meet_link            text not null default '',
  payment_policy       text not null default 'none',
  payment_status       text not null default 'unpaid',
  amount_due           numeric not null default 0,
  amount_paid          numeric not null default 0,
  currency             text not null default 'BYN',
  hold_expires_at      timestamptz,
  requires_payment     boolean not null default false,
  client_response      text,                                      -- null|confirmed|declined|change_confirmed|change_declined
  client_responded_at  timestamptz,
  pending_change       jsonb,                                     -- {date, time, reason, proposedAt}
  previous_slot        jsonb,                                     -- {date, time}
  change_consent_status text,                                     -- pending|confirmed|declined
  google_event_id      text not null default '',                  -- Google Calendar event id (для синхронизации)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table sessions add column if not exists google_event_id text not null default '';

-- T-03 / SR-001 / SR-108 — КАНОНЧЕСКИЙ контракт часового пояса клиента:
--   client_timezone        — IANA-имя пояса клиента ('Europe/Berlin'); '' = пояс кабинета.
--                            Пояс — первичен: он единственный корректен при переходе на DST.
--   client_utc_offset_min  — снимок смещения пояса клиента в минутах НА МОМЕНТ записи.
--                            Это история, а не замена пояса (пояс мог сменить смещение).
--   duration_min           — снимок длительности услуги на момент записи: если услуга
--                            позже изменится, историческая занятость не «поедет».
-- Раньше здесь была колонка timezone_offset text ('+02:00') — несовместимый формат
-- и альтернативное имя того же бизнес-поля; она удалена (SR-001 закрыт).
alter table sessions drop column if exists timezone_offset;
alter table sessions add column if not exists client_timezone       text not null default '';
alter table sessions add column if not exists client_utc_offset_min integer;
alter table sessions add column if not exists duration_min          integer;

alter table sessions
  drop constraint if exists sessions_client_utc_offset_min_check;
alter table sessions
  add constraint sessions_client_utc_offset_min_check
  check (client_utc_offset_min is null or client_utc_offset_min between -840 and 840);

create index if not exists sessions_psy_idx on sessions (psychologist_id, session_date);

-- ——— Блокировки занятости (выходной, занят, отпуск…) ———
-- Публично виден только free/busy (тип/заголовок/период); заметка — приватно.
create table if not exists schedule_blocks (
  id               text primary key default ('blk_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id  text not null references psychologists(id) on delete cascade,
  date_from        text not null,                                  -- YYYY-MM-DD (включительно)
  date_to          text not null,                                  -- YYYY-MM-DD (включительно)
  time_from        text not null default '',                       -- HH:MM, пусто = весь день
  time_to          text not null default '',
  kind             text not null default 'busy',                   -- day_off|busy|vacation|holiday|other
  title            text not null default '',                       -- «Выходной», «Отпуск» — видно публично
  note             text not null default '',                       -- приватная заметка (НЕ видна анонимам)
  source           text not null default 'manual',                 -- manual | google
  google_event_id  text not null default '',
  created_at       timestamptz not null default now()
);

create index if not exists schedule_blocks_psy_idx on schedule_blocks (psychologist_id, date_from);

-- ——— Задачи кабинета (список дел; опционально связаны с клиентом) ———
create table if not exists tasks (
  id              text primary key default ('task_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id text not null references psychologists(id) on delete cascade,
  title           text not null,
  details         text not null default '',
  due_date        text not null default '',          -- YYYY-MM-DD
  client_id       text references clients(id) on delete set null,
  done            boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists tasks_psy_idx on tasks (psychologist_id, done, due_date);

-- ——— Блокнот / планировщик (свободные заметки и планы) ———
create table if not exists psy_notes (
  id              text primary key default ('note_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id text not null references psychologists(id) on delete cascade,
  title           text not null default '',
  body            text not null default '',
  date            text not null default '',          -- план на дату (YYYY-MM-DD)
  pinned          boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists psy_notes_psy_idx on psy_notes (psychologist_id, pinned, date);

-- ——— Записи о клиентах (журнал работы; PII — только владельцу) ———
create table if not exists client_entries (
  id              text primary key default ('entry_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id text not null references psychologists(id) on delete cascade,
  client_id       text not null references clients(id) on delete cascade,
  session_id      text references sessions(id) on delete set null,
  date            text not null,                     -- YYYY-MM-DD
  text            text not null default '',
  created_at      timestamptz not null default now()
);
create index if not exists client_entries_client_idx on client_entries (psychologist_id, client_id, date);

-- ——— Настройки кабинета / слотов / оплаты / защиты записи ———
create table if not exists session_settings (
  psychologist_id                  text primary key references psychologists(id) on delete cascade,
  work_hours                       text not null default 'Пн–Пт 10:00–19:00',
  work_days                        jsonb not null default '[1,2,3,4,5]'::jsonb,
  timezone                         text not null default 'Europe/Minsk',
  default_video_platform           text not null default 'google_meet',
  slot_times                       jsonb,                          -- ['10:00', ...]
  slot_start                       text not null default '10:00',
  slot_end                         text not null default '18:00',
  slot_step_min                    integer not null default 60,
  payment_policy                   text not null default 'deposit',
  deposit_percent                  numeric not null default 30,
  deposit_amount                   numeric,
  hold_minutes                     integer not null default 60,
  max_active_unpaid_per_phone      integer not null default 1,
  max_bookings_per_day_per_phone   integer not null default 2,
  min_seconds_on_form              integer not null default 4,
  cooldown_minutes_after_cancel    integer not null default 120,
  block_after_no_shows             integer not null default 2,
  require_verified_contact_if_risk boolean not null default true,
  allow_new_client_without_deposit boolean not null default false,
  reminder_enabled                 boolean not null default true,
  reminder_hours_before            integer not null default 24,
  reminder_second_hours_before     integer not null default 12,
  reminder_channel                 text not null default 'telegram_sms',
  -- Google Calendar: секретный iCal-адрес (приватно! публично отдаются только free/busy блоки)
  google_calendar_ical_url         text not null default '',
  google_sync_busy                 boolean not null default true
);

alter table session_settings add column if not exists google_calendar_ical_url text not null default '';
alter table session_settings add column if not exists google_sync_busy         boolean not null default true;

-- Telegram-уведомления (настройка в кабинете; токен — приватно, RLS-владелец)
alter table session_settings add column if not exists telegram_bot_token        text not null default '';
alter table session_settings add column if not exists telegram_chat_id          text not null default '';
alter table session_settings add column if not exists telegram_bot_name         text not null default '';
alter table session_settings add column if not exists telegram_notify_booking   boolean not null default true;
alter table session_settings add column if not exists telegram_notify_reminders boolean not null default true;
alter table session_settings add column if not exists telegram_notify_payments  boolean not null default true;
alter table session_settings add column if not exists last_notified_session_at  timestamptz;

-- chat_id клиента для напоминаний (подключение бота по /start <clientId>)
alter table clients add column if not exists telegram_chat text not null default '';

-- T-25: факт согласия на обработку ПДн (дано при записи через форму)
alter table clients add column if not exists consent   boolean not null default false;
alter table clients add column if not exists consent_at timestamptz;

-- Одноразовые коды входа специалиста (6–8 букв/цифр, окно 2 минуты).
-- Письмо отправляет Edge Function auth-code (Resend) — шаблоны Supabase Auth
-- не участвуют. Код хранится хешем (SHA-256), одноразовый (used_at),
-- max 5 попыток. RLS без policies: доступ только сервисным ключом функции.
create table if not exists auth_login_codes (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  code_hash  text not null,
  attempts   int not null default 0,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_login_codes_email_idx on auth_login_codes (email);
alter table auth_login_codes enable row level security;

-- SR-004 (issue #14, п.4): атомарность погашения кода.
-- Раньше Edge Function ставила used_at ДО создания сессии в Supabase Auth:
-- временный отказ Auth сжигал верный код, и регистрация терялась безвозвратно.
-- Теперь состояние кода описывается тремя отметками:
--   issued_token_hash — null: код не выпущен; uuid-«захват»: сессию выпускает
--                       ровно один запрос (условный UPDATE = атомарный захват);
--                       SHA-256(hashed_token): токен выпущен, браузер его ещё
--                       не обменял (в пределах TTL возможен перевыпуск);
--   issues            — сколько раз по этому коду выпускалась сессия (лимит 3);
--   consumed_at       — браузер получил JWT: перевыпуск закрыт навсегда.
alter table auth_login_codes add column if not exists issued_token_hash text;
alter table auth_login_codes add column if not exists issues            integer not null default 1;
alter table auth_login_codes add column if not exists consumed_at       timestamptz;

-- ——— Платёж / чек ———
create table if not exists payments (
  id              text primary key default ('pay_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  session_id      text references sessions(id) on delete cascade,
  psychologist_id text references psychologists(id) on delete cascade,
  client_id       text references clients(id) on delete set null,
  amount          numeric not null default 0,
  currency        text not null default 'BYN',
  kind            text not null default 'full',                   -- deposit | full | balance
  method          text not null default 'manual',                 -- manual | card_demo | transfer | receipt
  status          text not null default 'unpaid',
  receipt_code    text not null default '',
  external_ref    text not null default '',
  paid_at         timestamptz,
  note            text not null default '',
  created_at      timestamptz not null default now()
);

-- ——— Код подтверждения email ———
create table if not exists email_codes (
  id         text primary key default ('code_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  email      text not null,
  code       text not null,
  purpose    text not null default 'register',                    -- register | login | client_verify
  expires_at timestamptz,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);

-- ——— Лист ожидания ———
create table if not exists waiting_items (
  id              text primary key default ('wait_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id text not null references psychologists(id) on delete cascade,
  client_id       text references clients(id) on delete set null,
  type            text not null default 'wait',
  name            text not null default '',
  phone           text not null default '',
  note            text not null default '',
  created_at      timestamptz not null default now()
);

-- ——— Антиспам-журнал попыток записи ———
create table if not exists booking_attempts (
  id              text primary key default ('ba_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id text references psychologists(id) on delete cascade,
  phone_key       text not null default '',
  fingerprint     text not null default '',
  success         boolean not null default false,
  reason          text not null default '',
  -- T-25: согласие на обработку ПДн, данное при попытке записи
  consent         boolean not null default false,
  consent_at      timestamptz,
  created_at      timestamptz not null default now()
);

-- ——— Глобальный риск по телефону ———
create table if not exists client_risks (
  id            text primary key default ('risk_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  phone_key     text not null unique,
  no_show_total integer not null default 0,
  cancel_total  integer not null default 0,
  fraud_flags   integer not null default 0,
  blocked       boolean not null default false,
  block_reason  text not null default '',
  updated_at    timestamptz not null default now()
);

-- ——— Напоминания клиенту ———
create table if not exists session_reminders (
  id              text primary key default ('rem_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  session_id      text references sessions(id) on delete cascade,
  psychologist_id text references psychologists(id) on delete cascade,
  client_id       text references clients(id) on delete set null,
  kind            text not null default 'confirm_request',
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  status          text not null default 'scheduled',
  channel         text not null default 'telegram_sms',
  message_body    text not null default '',
  response_token  text not null default '',
  responded_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- ============================================================
-- Доступ данных (известные наработки multi-tenant SaaS):
--
--  1) Аноним видит ТОЛЬКО публичное (как на сайте специалиста):
--     профиль, услуги/цены, часы/слоты/условия, free/busy.
--     Публичный контракт — VIEW ниже (минимальные привилегии).
--  2) Клиенты, сессии, платежи, PII — НИКОМУ кроме владельца кабинета.
--     Запись клиента идёт только через RPC create_booking (security definer):
--     сервер проверяет слот и анти-спам, PII не светится через REST.
--  3) Владелец кабинета (после подключения Supabase Auth):
--     политики authenticated с owner_id = auth.uid() — полный доступ к своим данным.
-- ============================================================

-- ——— Убираем широкие anon-политики пилота ———
do $$
declare t text;
begin
  foreach t in array array['psychologists','services','clients','sessions','session_settings',
                           'payments','email_codes','waiting_items','booking_attempts','client_risks',
                           'session_reminders','schedule_blocks','tasks','psy_notes','client_entries']
  loop
    execute format('drop policy if exists anon_all on %I', t);
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

-- ——— Владелец кабинета: свои данные через Supabase Auth (owner_id = auth.uid()) ———
alter table psychologists add column if not exists owner_id uuid references auth.users(id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['psychologists','services','clients','sessions','session_settings',
                           'payments','waiting_items','booking_attempts','session_reminders','schedule_blocks',
                           'tasks','psy_notes','client_entries']
  loop
    execute format('drop policy if exists owner_all on %I', t);
  end loop;
end $$;

create policy owner_all on psychologists
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- остальные таблицы — по принадлежности психологу
create policy owner_all on services
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on clients
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on sessions
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on session_settings
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on payments
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on waiting_items
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on booking_attempts
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on session_reminders
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on schedule_blocks
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on tasks
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on psy_notes
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

create policy owner_all on client_entries
  for all to authenticated
  using (psychologist_id in (select id from psychologists where owner_id = auth.uid()))
  with check (psychologist_id in (select id from psychologists where owner_id = auth.uid()));

-- услуги/цены публичны (как на сайте специалиста) — anon читает активные
drop policy if exists anon_read_services on services;
create policy anon_read_services on services
  for select to anon
  using (is_active = true);

-- client_risks — глобальный антифрод: чтение владельцам, запись через service_role
drop policy if exists owner_read on client_risks;
create policy owner_read on client_risks for select to authenticated using (true);

-- ——— Публичный контракт для anon: view с минимальными полями ———
drop view if exists public_profiles;
drop view if exists public_settings;
drop view if exists public_schedule_blocks;
drop view if exists public_booked_slots;

-- 1) Публичный профиль (без email-учётки и key_verifier — они приватны)
create or replace view public_profiles as
  select id, full_name, phone, specialization, city, about, website, source_url, address,
         experience, slug, profession, greeting, approach, photo_url, public_email,
         directions, education, experience_items, socials, payment_links, payment_requisites,
         is_active, created_at
  from psychologists;

-- 2) Условия записи: часы/слоты/оплата (без антиспам-настроек и iCal-секрета)
create or replace view public_settings as
  select psychologist_id, work_hours, work_days, timezone, default_video_platform,
         slot_times, slot_start, slot_end, slot_step_min,
         payment_policy, deposit_percent, deposit_amount, hold_minutes
  from session_settings;

-- 3) Free/busy блокировки (без приватных заметок)
create or replace view public_schedule_blocks as
  select id, psychologist_id, date_from, date_to, time_from, time_to, kind, title, source
  from schedule_blocks;

-- 4) Занятые слоты (дата/время — без данных клиентов)
--    duration_min — длительность занятой записи: 90-минутная сессия закрывает на
--    клиенте и частичные перекрытия сетки (T-02, SR-003).
--    Приоритет: снимок длительности в сессии → текущая услуга → шаг сетки → 60.
create or replace view public_booked_slots as
  select s.psychologist_id, s.session_date, s.session_time,
         coalesce(s.duration_min, sv.duration_min, ss.slot_step_min, 60) as duration_min
  from sessions s
  left join services sv on sv.id = s.service_id
  left join session_settings ss on ss.psychologist_id = s.psychologist_id
  where s.status not in ('cancelled', 'expired', 'no_show')
    and (s.status <> 'held' or s.hold_expires_at is null or s.hold_expires_at > now());

grant select on public_profiles        to anon, authenticated;
grant select on public_settings        to anon, authenticated;
grant select on public_schedule_blocks to anon, authenticated;
grant select on public_booked_slots    to anon, authenticated;
grant select on services               to anon, authenticated;

-- ============================================================
-- RPC create_booking — единственный публичный путь записи:
-- security definer (пишет в clients/sessions минуя RLS),
-- проверяет активность специалиста, свободный слот и анти-спам по телефону.
-- ============================================================
-- SR-001/SR-002/SR-108: каноническая сигнатура (пояс клиента — IANA + снимок
-- смещения; снимок длительности). Все предыдущие перегрузки убираем явно —
-- иначе create or replace создал бы вторую функцию с тем же именем.
drop function if exists public.create_booking(text, text, text, text, text, text, text, text, text, text, text, text, text, text, numeric, numeric, text);
drop function if exists public.create_booking(text, text, text, text, text, text, text, text, text, text, text, text, text, text, numeric, numeric, text, text);
drop function if exists public.create_booking(text, text, text, text, text, text, text, text, text, text, text, text, text, text, text, numeric, numeric, text, boolean, timestamptz);
drop function if exists public.create_booking(text, text, text, text, text, text, text, text, text, text, text, text, text, text, numeric, numeric, text, text, integer, integer, boolean, timestamptz);

create or replace function public.create_booking(
  p_psychologist_id       text,
  p_service_id            text,
  p_session_date          text,
  p_session_time          text,
  p_client_name           text default '',
  p_client_nickname       text default '',
  p_client_phone          text default '',
  p_client_contact        text default '',
  p_client_note           text default '',
  p_session_note          text default '',
  p_status                text default 'pending',
  p_video_platform        text default '',
  p_payment_policy        text default 'none',
  p_payment_status        text default 'unpaid',
  p_amount_due            numeric default 0,
  p_amount_paid           numeric default 0,
  p_currency              text default 'BYN',
  p_client_timezone       text default '',
  p_client_utc_offset_min integer default null,
  p_duration_min          integer default null,
  p_consent               boolean default false,
  p_consent_at            timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Канонический дефолт длительности на сервере. Зеркало константы
  -- DEFAULT_DURATION_MIN в js/domain/duration.js — менять только парой.
  v_default_dur constant int := 60;
  v_psy_id text;
  v_phone_key text := regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g');
  v_client_id text;
  v_session_id text;
  v_today_count bigint;
  v_new_start int := (substr(p_session_time, 1, 2)::int * 60 + substr(p_session_time, 4, 2)::int);
  v_new_dur int;
  v_step int;
begin
  select id into v_psy_id from psychologists where id = p_psychologist_id and is_active;
  if v_psy_id is null then
    return jsonb_build_object('ok', false, 'error', 'Специалист не найден или неактивен');
  end if;

  -- ============================================================
  -- Атомарность (SR-002). Проверка занятости и INSERT ниже — одна транзакция,
  -- но без блокировки две параллельные записи на один слот обе проходят проверку
  -- и обе вставляются (гонка). Транзакционная advisory-блокировка по
  -- (психолог, дата) сериализует такие вызовы: второй ждёт коммита первого
  -- и уже видит его запись в проверке перекрытия.
  -- ============================================================
  perform pg_advisory_xact_lock(hashtext('booking:' || p_psychologist_id || ':' || p_session_date));

  -- Длительность новой записи: снимок от клиента → услуга → шаг сетки → дефолт
  select coalesce(sv.duration_min, v_default_dur) into v_new_dur
  from services sv where sv.id = p_service_id and sv.psychologist_id = p_psychologist_id;
  select coalesce(ss.slot_step_min, v_default_dur) into v_step
  from session_settings ss where ss.psychologist_id = p_psychologist_id;
  v_new_dur := coalesce(nullif(p_duration_min, 0), v_new_dur, v_step, v_default_dur);

  -- Занятость по ИНТЕРВАЛАМ: новый [start, start+dur) не должен пересекаться
  -- ни с одной существующей записью [s, s+dur_s). Длительность чужой записи —
  -- её снимок, иначе услуга, иначе шаг сетки, иначе дефолт.
  if exists (
    select 1 from sessions s
    left join services sv on sv.id = s.service_id
    left join session_settings ss on ss.psychologist_id = s.psychologist_id
    where s.psychologist_id = p_psychologist_id
      and s.session_date = p_session_date
      and s.status not in ('cancelled', 'expired', 'no_show')
      and (s.status <> 'held' or s.hold_expires_at is null or s.hold_expires_at > now())
      and (substr(s.session_time, 1, 2)::int * 60 + substr(s.session_time, 4, 2)::int) < v_new_start + v_new_dur
      and (substr(s.session_time, 1, 2)::int * 60 + substr(s.session_time, 4, 2)::int)
            + coalesce(s.duration_min, sv.duration_min, ss.slot_step_min, v_default_dur) > v_new_start
  ) then
    return jsonb_build_object('ok', false, 'error', 'Это время только что заняли — выберите другое');
  end if;

  -- Блокировки занятости — тоже по интервалам (раньше сравнивался только старт слота)
  if exists (
    select 1 from schedule_blocks b
    where b.psychologist_id = p_psychologist_id
      and p_session_date between b.date_from and b.date_to
      and (
        (b.time_from = '' and b.time_to = '')
        or (
          v_new_start < (substr(coalesce(nullif(b.time_to, ''), '23:59'), 1, 2)::int * 60
                         + substr(coalesce(nullif(b.time_to, ''), '23:59'), 4, 2)::int)
          and (substr(coalesce(nullif(b.time_from, ''), '00:00'), 1, 2)::int * 60
               + substr(coalesce(nullif(b.time_from, ''), '00:00'), 4, 2)::int) < v_new_start + v_new_dur
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'error', 'В это время специалист не принимает');
  end if;

  -- анти-спам: не больше 3 записей в день на телефон
  if v_phone_key <> '' then
    select count(*) into v_today_count
    from sessions s join clients c on c.id = s.client_id
    where s.psychologist_id = p_psychologist_id
      and s.session_date = current_date::text
      and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') = v_phone_key;
    if v_today_count >= 3 then
      return jsonb_build_object('ok', false, 'error', 'Слишком много записей за день, попробуйте позже');
    end if;
  end if;

  -- повторный клиент по телефону
  if v_phone_key <> '' then
    select id into v_client_id from clients
    where psychologist_id = p_psychologist_id
      and regexp_replace(coalesce(phone, ''), '\D', '', 'g') = v_phone_key
    order by created_at limit 1;
  end if;

  if v_client_id is null then
    insert into clients (psychologist_id, name, nickname, phone, contact, note, consent, consent_at)
    values (p_psychologist_id,
            coalesce(nullif(p_client_name, ''), p_client_nickname),
            coalesce(nullif(p_client_nickname, ''), p_client_name),
            p_client_phone, p_client_contact, p_client_note,
            coalesce(p_consent, false), p_consent_at)  -- T-25: факт согласия
    returning id into v_client_id;
  end if;

  insert into sessions (psychologist_id, client_id, service_id, session_date, session_time,
                        status, note, video_platform,
                        payment_policy, payment_status, amount_due, amount_paid, currency,
                        client_timezone, client_utc_offset_min, duration_min)
  values (p_psychologist_id, v_client_id, p_service_id, p_session_date, p_session_time,
          coalesce(p_status, 'pending'), p_session_note, p_video_platform,
          p_payment_policy, p_payment_status, p_amount_due, p_amount_paid, p_currency,
          coalesce(nullif(p_client_timezone, ''), ''), p_client_utc_offset_min, v_new_dur)
  returning id into v_session_id;

  return jsonb_build_object(
    'ok', true,
    'client_id', v_client_id,
    'session_id', v_session_id,
    'duration_min', v_new_dur
  );
end;
$$;

-- Сигнатура должна совпадать с объявлением выше (22 параметра). Раньше здесь
-- было на один text больше и на один text меньше — schema.sql падал на этом
-- месте, и всё, что ниже (claim_psychologist_profile, client_error_logs),
-- в проде не создавалось.
revoke execute on function public.create_booking(text, text, text, text, text, text, text, text, text, text, text, text, text, text, numeric, numeric, text, text, integer, integer, boolean, timestamptz) from public;
grant execute on function public.create_booking(text, text, text, text, text, text, text, text, text, text, text, text, text, text, numeric, numeric, text, text, integer, integer, boolean, timestamptz) to anon, authenticated;

-- ============================================================
-- claim_psychologist_profile — привязка профиля к АУТЕНТИФИЦИРОВАННОМУ пользователю.
-- Вызывается ПОСЛЕ подтверждения кода, когда auth.uid() уже задан.
--
-- Инварианты (проверяются тестами tests/db-contract.mjs):
--   1) владение определяется ТОЛЬКО auth.uid(); email — лишь способ найти профиль,
--      но никогда не источник ownership;
--   2) профиль создаётся только после подтверждения личности (без uid — отказ);
--   3) повторный вход тем же email возвращает тот же id и НЕ создаёт дубль;
--   4) чужой уже привязанный профиль не отбирается — честная ошибка;
--   5) все обязательные поля регистрации сохраняются (email, full_name, phone,
--      specialization, city, about).
-- ============================================================
drop function if exists public.claim_psychologist_profile(text, text, text, text);

create or replace function public.claim_psychologist_profile(
  p_email          text,
  p_full_name      text default '',
  p_phone          text default '',
  p_specialization text default 'Психолог',
  p_city           text default '',
  p_about          text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    text;
  v_owner uuid := auth.uid();
  v_cur   uuid;
  v_base  text;
  v_slug  text;
  v_i     int := 0;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name  text := nullif(trim(coalesce(p_full_name, '')), '');
  v_spec  text := nullif(trim(coalesce(p_specialization, '')), '');
begin
  if v_owner is null then
    return jsonb_build_object('ok', false, 'error', 'Email не подтверждён');
  end if;
  if v_email = '' then
    return jsonb_build_object('ok', false, 'error', 'Не указан email');
  end if;
  -- имя по умолчанию — локальная часть email (профиль не остаётся без имени)
  v_name := coalesce(v_name, split_part(v_email, '@', 1));

  select id, owner_id into v_id, v_cur
  from psychologists
  where lower(trim(email)) = v_email
  order by created_at
  limit 1;

  if v_id is not null then
    -- профиль уже привязан к ДРУГОМУ пользователю Auth — не отбираем
    if v_cur is not null and v_cur <> v_owner then
      return jsonb_build_object(
        'ok', false,
        'error', 'Этот профиль уже привязан к другой учётной записи'
      );
    end if;

    update psychologists
    set owner_id       = coalesce(owner_id, v_owner),
        is_active      = true,
        -- дозаполняем только пустое: существующие данные специалиста не затираем
        full_name      = nullif(trim(full_name), '') || '',
        phone          = case when coalesce(trim(phone), '') = '' then coalesce(trim(p_phone), '') else phone end,
        specialization = case when coalesce(trim(specialization), '') = '' then coalesce(v_spec, 'Психолог') else specialization end,
        city           = case when coalesce(trim(city), '') = '' then coalesce(trim(p_city), '') else city end,
        about          = case when coalesce(trim(about), '') = '' then coalesce(trim(p_about), '') else about end,
        updated_at     = now()
    where id = v_id
    returning owner_id into v_cur;

    return jsonb_build_object(
      'ok', true,
      'id', v_id,
      'owner_id', v_cur,
      'created', false
    );
  end if;

  v_base := lower(regexp_replace(v_name, '[^0-9a-zA-Zа-яё]+', '-', 'gi'));
  if v_base is null or v_base in ('', '-') then
    v_base := 'specialist';
  end if;
  v_slug := v_base;
  while exists (select 1 from psychologists where slug = v_slug) loop
    v_i := v_i + 1;
    v_slug := v_base || '-' || v_i;
  end loop;

  insert into psychologists (email, full_name, phone, specialization, city, about, slug, owner_id, is_active)
  values (
    v_email,
    v_name,
    coalesce(trim(p_phone), ''),
    coalesce(v_spec, 'Психолог'),
    coalesce(trim(p_city), ''),
    coalesce(trim(p_about), ''),
    v_slug,
    v_owner,
    true
  )
  returning id, owner_id into v_id, v_cur;

  -- стартовые настройки кабинета: без них сетка слотов и часовой пояс не определены
  insert into session_settings (psychologist_id)
  values (v_id)
  on conflict (psychologist_id) do nothing;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'owner_id', v_cur,
    'created', true
  );
end;
$$;

revoke execute on function public.claim_psychologist_profile(text, text, text, text, text, text) from public, anon;
grant execute on function public.claim_psychologist_profile(text, text, text, text, text, text) to authenticated;

-- ============================================================
-- client_error_logs — критичные ошибки фронтенда (boot, runtime, catalog).
-- Пишет только клиентский errorLogService (insert, fire-and-forget, анонимно).
-- Чтение — ТОЛЬКО через service_role (SQL Editor / дашборд): select-политики
-- намеренно отсутствуют, логи недоступны по REST ни anon, ни authenticated.
-- Чистка старых записей — вручную или по расписанию (см. docs/INFRA.md).
-- ============================================================
create table if not exists client_error_logs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  level       text not null default 'error',     -- error | rejection | boot | catalog
  message     text not null default '',
  stack       text not null default '',
  route       text not null default '',          -- location.pathname
  url         text not null default '',          -- полный URL (base path включён)
  user_agent  text not null default '',
  app_version text not null default '',          -- ?v= из index.html / версия сборки
  extra       jsonb not null default '{}'::jsonb
);

alter table client_error_logs enable row level security;

drop policy if exists client_error_logs_insert on client_error_logs;
create policy client_error_logs_insert on client_error_logs
  for insert to anon, authenticated
  with check (true);

grant insert on client_error_logs to anon, authenticated;
