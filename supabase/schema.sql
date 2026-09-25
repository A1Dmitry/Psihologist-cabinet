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

-- ——— Переопределения расписания на конкретную дату (D1 / SR-D1) ———
-- Закрытые дни (праздники/исключения) и особые окна приёма. В отличие от
-- schedule_blocks (блокировки занятости), override может не только закрыть
-- день, но и задать другое окно (open_from/open_to) вместо slot_start/slot_end.
create table if not exists schedule_overrides (
  id               text primary key default ('ovr_' || extract(epoch from now())::bigint::text || '_' || substr(md5(random()::text), 1, 6)),
  psychologist_id  text not null references psychologists(id) on delete cascade,
  date             text not null,                                  -- YYYY-MM-DD
  is_closed        boolean not null default false,                 -- true = в этот день записи нет
  open_from        text not null default '',                       -- HH:MM, пусто = из настроек
  open_to          text not null default '',                       -- HH:MM, пусто = из настроек
  title            text not null default '',                       -- «8 марта», «Приём до обеда» — видно публично
  created_at       timestamptz not null default now()
);

create unique index if not exists schedule_overrides_psy_date_uidx
  on schedule_overrides (psychologist_id, date);

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

-- D1 / SR-D1 — Booking Policy: правила доступности, проверяемые сервером.
-- Дефолты сохраняют поведение до D1: notice/буферы = 0, лимиты/горизонт/
-- инкремент = NULL (без ограничения / шаг сетки).
alter table session_settings add column if not exists min_notice_minutes   integer not null default 0;
alter table session_settings add column if not exists max_advance_days     integer;
alter table session_settings add column if not exists buffer_before_min    integer not null default 0;
alter table session_settings add column if not exists buffer_after_min     integer not null default 0;
alter table session_settings add column if not exists slot_increment_min   integer;
alter table session_settings add column if not exists max_bookings_per_day  integer;
alter table session_settings add column if not exists max_bookings_per_week integer;

-- D1 / SR-D1 — service-specific availability: {"days":[1,2,3],"start":"12:00","end":"16:00"}.
-- NULL = наследовать расписание из session_settings; частичный объект = перекрыть часть.
alter table services add column if not exists availability jsonb;

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
                           'session_reminders','schedule_blocks','schedule_overrides','tasks','psy_notes','client_entries']
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
                           'schedule_overrides','tasks','psy_notes','client_entries']
  loop
    execute format('drop policy if exists owner_all on %I', t);
    execute format('drop policy if exists owner_select on %I', t);
    execute format('drop policy if exists owner_modify on %I', t);
    execute format('drop policy if exists owner_update on %I', t);
    execute format('drop policy if exists owner_delete on %I', t);
  end loop;
end $$;

-- ——— Каноническое правило доступа владельца (issue #40/#46) ———
-- «Свой кабинет» = owner_id = auth.uid() И кабинет активен. Одна реализация на
-- все таблицы: раньше предикат `owner_id = auth.uid()` был продублирован в 13
-- политиках, и отключение специалиста (is_active = false) не закрывало доступ —
-- сессия, выданная до отключения, продолжала читать/писать чужие уже данные.
-- Без security definer: подзапрос к psychologists проходит через её же политику
-- owner_select, т.е. привилегий не добавляет (least privilege).
create or replace function public.is_active_own_psychologist(p_psychologist_id text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from psychologists p
    where p.id = p_psychologist_id
      and p.is_active
      and p.owner_id = auth.uid()
  );
$$;

revoke execute on function public.is_active_own_psychologist(text) from public, anon;
grant execute on function public.is_active_own_psychologist(text) to authenticated;

-- Свой профиль владелец читает даже отключённым: кабинету нужно показать
-- причину («учётная запись отключена»), а не пустой экран.
create policy owner_select on psychologists
  for select to authenticated
  using (owner_id = auth.uid());

-- Писать (и создавать записи) может только владелец АКТИВНОГО кабинета.
create policy owner_modify on psychologists
  for insert to authenticated
  with check (owner_id = auth.uid() and is_active);

create policy owner_update on psychologists
  for update to authenticated
  using (owner_id = auth.uid() and is_active)
  with check (owner_id = auth.uid() and is_active);

create policy owner_delete on psychologists
  for delete to authenticated
  using (owner_id = auth.uid() and is_active);

-- остальные таблицы — по принадлежности психологу
create policy owner_all on services
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on clients
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on sessions
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on session_settings
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on payments
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on waiting_items
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on booking_attempts
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on session_reminders
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on schedule_blocks
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on schedule_overrides
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on tasks
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on psy_notes
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

create policy owner_all on client_entries
  for all to authenticated
  using (public.is_active_own_psychologist(psychologist_id))
  with check (public.is_active_own_psychologist(psychologist_id));

-- услуги/цены публичны (как на сайте специалиста) — anon читает активные
drop policy if exists anon_read_services on services;
create policy anon_read_services on services
  for select to anon
  using (is_active = true);

-- client_risks — глобальный антифрод: ТОЛЬКО service_role / security definer RPC.
-- Любой authenticated ранее читал всю таблицу (using true) — cross-tenant утечка
-- phone_key (квази-PII). Теперь прямого SELECT для anon/authenticated нет:
-- RLS включен, политик для чтения нет, service_role обходит RLS.
-- Проверка блокировки — внутри create_booking (security definer).
drop policy if exists owner_read on client_risks;
-- no policies for anon/authenticated → only service_role can read
-- ensure RLS enabled (already enabled in loop above, but explicit for clarity)
alter table client_risks enable row level security;
revoke all on client_risks from anon, authenticated;

-- ——— Публичный контракт для anon: view с минимальными полями ———
drop view if exists public_profiles;
drop view if exists public_settings;
drop view if exists public_schedule_blocks;
drop view if exists public_schedule_overrides;
drop view if exists public_booked_slots;

-- 1) Публичный профиль (без email-учётки и key_verifier — они приватны)
create or replace view public_profiles as
  select id, full_name, phone, specialization, city, about, website, source_url, address,
         experience, slug, profession, greeting, approach, photo_url, public_email,
         directions, education, experience_items, socials, payment_links, payment_requisites,
         is_active, created_at
  from psychologists;

-- 2) Условия записи: часы/слоты/оплата/политика доступности
--    (без антиспам-настроек и iCal-секрета; поля политики не секретны —
--    они нужны публичному engine для расчёта BookableSlots)
create or replace view public_settings as
  select psychologist_id, work_hours, work_days, timezone, default_video_platform,
         slot_times, slot_start, slot_end, slot_step_min,
         payment_policy, deposit_percent, deposit_amount, hold_minutes,
         min_notice_minutes, max_advance_days, buffer_before_min, buffer_after_min,
         slot_increment_min, max_bookings_per_day, max_bookings_per_week
  from session_settings;

-- 3) Free/busy блокировки (без приватных заметок)
create or replace view public_schedule_blocks as
  select id, psychologist_id, date_from, date_to, time_from, time_to, kind, title, source
  from schedule_blocks;

-- 3b) Переопределения расписания на дату (D1): закрытые дни и особые окна
create or replace view public_schedule_overrides as
  select id, psychologist_id, date, is_closed, open_from, open_to, title
  from schedule_overrides;

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
grant select on public_schedule_overrides to anon, authenticated;
grant select on public_booked_slots    to anon, authenticated;
grant select on services               to anon, authenticated;

-- ============================================================
-- RPC create_booking — единственный публичный путь записи:
-- security definer (пишет в clients/sessions минуя RLS),
-- проверяет активность специалиста, свободный слот и анти-спам по телефону.
-- ============================================================
-- SR-001/SR-002/SR-108: каноническая сигнатура (пояс клиента — IANA + снимок
-- смещения; снимок длительности).
--
-- Перегрузки убираем НЕ списком известных из истории, а все подряд (issue #46,
-- TASK 5: «canonical create_booking имеет единственную ожидаемую signature»).
-- Причина: `create or replace function` при ДРУГОЙ арности не заменяет функцию,
-- а создаёт ВТОРУЮ с тем же именем. В проде, где жила старая сигнатура не из
-- нашего списка, схема применялась «без ошибок», но PostgREST после этого либо
-- не может выбрать кандидата (PGRST203), либо резолвит не ту версию — прод
-- остаётся сломанным при зелёном применении миграции.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_booking'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;

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
  v_phone_digits text;
  v_phone_key text;
  v_client_id text;
  v_session_id text;
  v_today_count bigint;
  v_new_start int;
  v_new_dur int;
  v_step int;
  v_slot_start text;
  v_slot_end text;
  v_work_days jsonb;
  v_hold_minutes int;
  v_service_row services%rowtype;
  v_settings_row session_settings%rowtype;
  v_effective_policy text;
  v_price numeric;
  v_currency text;
  v_amount_due numeric;
  v_requires_payment boolean;
  v_status text;
  v_payment_status text;
  v_amount_paid numeric := 0;
  v_hold_expires_at timestamptz;
  v_date date;
  v_isodow int;
  v_time_valid boolean;
  v_date_valid boolean;
  v_blocked boolean;
  -- D1 (SR-D1): Booking Policy / Availability (зеркало js/domain/availability.js)
  v_tz text := 'UTC';
  v_today date;
  v_slot_ts timestamptz;
  v_min_notice int := 0;
  v_max_advance int := null;
  v_buf_before int := 0;
  v_buf_after int := 0;
  v_increment int := null;
  v_max_day int := null;
  v_max_week int := null;
  v_eff_days jsonb := null;
  v_win_start_min int := null;
  v_win_grace_min int := null;
  v_last_slot_min int := null;
  v_has_slot_list boolean := false;
  v_cand_from int;
  v_cand_to int;
  v_day_count bigint;
  v_week_count bigint;
  v_override_row schedule_overrides%rowtype;
begin
  -- ——— 0. Базовая валидация формата даты/времени (T04) ———
  -- Дата: YYYY-MM-DD
  if p_session_date !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('ok', false, 'error', 'Неверный формат даты');
  end if;
  begin
    v_date := p_session_date::date;
    v_date_valid := true;
  exception when others then
    v_date_valid := false;
  end;
  if not v_date_valid then
    return jsonb_build_object('ok', false, 'error', 'Неверная дата');
  end if;

  -- Время: HH:MM
  if p_session_time !~ '^\d{2}:\d{2}$' then
    return jsonb_build_object('ok', false, 'error', 'Неверный формат времени');
  end if;
  begin
    -- проверка диапазона часов/минут через попытку парсинга
    if substr(p_session_time,1,2)::int < 0 or substr(p_session_time,1,2)::int > 23
       or substr(p_session_time,4,2)::int < 0 or substr(p_session_time,4,2)::int > 59 then
      raise exception 'invalid time';
    end if;
    v_new_start := (substr(p_session_time, 1, 2)::int * 60 + substr(p_session_time, 4, 2)::int);
    v_time_valid := true;
  exception when others then
    v_time_valid := false;
  end;
  if not v_time_valid then
    return jsonb_build_object('ok', false, 'error', 'Неверное время');
  end if;

  -- D1: «сегодня» и «прошлое» — в поясе специалиста, а не сервера.
  -- (Раньше same-day сравнивался с серверным временем — для поясов позади
  -- UTC это ложно отклоняло будущие слоты.)
  begin
    select timezone into v_tz from session_settings where psychologist_id = p_psychologist_id;
    if v_tz is null or v_tz = '' then v_tz := 'UTC'; end if;
    v_today := (now() at time zone v_tz)::date;
  exception when others then
    v_tz := 'UTC';
    v_today := current_date;
  end;

  -- Past-date rejection (T04): нельзя в прошлом
  if v_date < v_today then
    return jsonb_build_object('ok', false, 'error', 'Нельзя записаться в прошлое');
  end if;
  -- Момент слота в поясе специалиста; при битом поясе — fail-safe crude check.
  begin
    v_slot_ts := (p_session_date || ' ' || p_session_time)::timestamp at time zone v_tz;
  exception when others then
    v_slot_ts := null;
  end;
  if v_slot_ts is null then
    if v_date = v_today and p_session_time < to_char(now(), 'HH24:MI') then
      return jsonb_build_object('ok', false, 'error', 'Это время уже прошло');
    end if;
  else
    if v_slot_ts < now() then
      return jsonb_build_object('ok', false, 'error', 'Это время уже прошло');
    end if;
  end if;

  -- ——— 1. Психолог exists + active (T04) ———
  select id into v_psy_id from psychologists where id = p_psychologist_id and is_active;
  if v_psy_id is null then
    return jsonb_build_object('ok', false, 'error', 'Специалист не найден или неактивен');
  end if;

  -- ——— 2. Детерминированная нормализация телефона (T03) ———
  -- Клиент: last 9 digits; сервер — то же, чтобы bypass через форматирование не работал.
  v_phone_digits := regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g');
  if length(v_phone_digits) >= 9 then
    v_phone_key := right(v_phone_digits, 9);
  else
    v_phone_key := v_phone_digits;
  end if;

  -- ——— 3. Service existence / ownership / active (T04) ———
  if p_service_id is not null and p_service_id <> '' then
    select * into v_service_row from services where id = p_service_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'Услуга не найдена');
    end if;
    if v_service_row.psychologist_id <> p_psychologist_id then
      return jsonb_build_object('ok', false, 'error', 'Услуга не принадлежит выбранному специалисту');
    end if;
    if not v_service_row.is_active then
      return jsonb_build_object('ok', false, 'error', 'Услуга неактивна');
    end if;
  end if;

  -- ——— 4. Настройки кабинета (для расписания и оплаты) ———
  select * into v_settings_row from session_settings where psychologist_id = p_psychologist_id;
  -- defaults if no settings row
  v_step := coalesce(v_settings_row.slot_step_min, v_default_dur);
  v_slot_start := coalesce(v_settings_row.slot_start, '00:00');
  v_slot_end := coalesce(v_settings_row.slot_end, '23:59');
  v_work_days := v_settings_row.work_days;
  v_hold_minutes := coalesce(v_settings_row.hold_minutes, 60);

  -- Длительность — server-derived (T02 + T04): услуга → шаг сетки → дефолт
  -- Клиентский p_duration_min игнорируется (не может переопределять authoritative duration)
  v_new_dur := coalesce(v_service_row.duration_min, v_step, v_default_dur);
  if v_new_dur <= 0 or v_new_dur > 480 then
    v_new_dur := v_default_dur;
  end if;

  -- ——— 4b. D1: Booking Policy — загрузка и проверки уровня даты ———
  v_min_notice := greatest(coalesce(v_settings_row.min_notice_minutes, 0), 0);
  v_max_advance := v_settings_row.max_advance_days;
  if v_max_advance is not null and v_max_advance < 0 then v_max_advance := null; end if;
  v_buf_before := greatest(coalesce(v_settings_row.buffer_before_min, 0), 0);
  v_buf_after := greatest(coalesce(v_settings_row.buffer_after_min, 0), 0);
  v_increment := v_settings_row.slot_increment_min;
  if v_increment is not null and v_increment <= 0 then v_increment := null; end if;
  v_max_day := v_settings_row.max_bookings_per_day;
  if v_max_day is not null and v_max_day < 0 then v_max_day := null; end if;
  v_max_week := v_settings_row.max_bookings_per_week;
  if v_max_week is not null and v_max_week < 0 then v_max_week := null; end if;

  -- Minimum scheduling notice (зеркало engine: slotMs < nowMs + notice).
  -- Формат длительности — тот же, что formatNotice в js/domain/availability.js.
  if v_min_notice > 0 and v_slot_ts is not null
     and v_slot_ts < now() + (v_min_notice || ' minutes')::interval then
    return jsonb_build_object('ok', false, 'error',
      'Записаться можно минимум за ' ||
      case when v_min_notice >= 60 and v_min_notice % 60 = 0
        then (v_min_notice / 60) || ' ч' else v_min_notice || ' мин' end ||
      ' до начала');
  end if;

  -- Maximum advance booking window.
  if v_max_advance is not null and v_date > v_today + v_max_advance then
    return jsonb_build_object('ok', false, 'error',
      'Запись открыта только на ' || v_max_advance || ' дн вперёд');
  end if;

  -- Override на дату: закрытый день отклоняется сразу; особое окно применяется ниже.
  select * into v_override_row from schedule_overrides
  where psychologist_id = p_psychologist_id and date = p_session_date;
  if v_override_row.id is not null and v_override_row.is_closed then
    if coalesce(v_override_row.title, '') <> '' then
      return jsonb_build_object('ok', false, 'error',
        'В этот день записи нет (' || v_override_row.title || ')');
    else
      return jsonb_build_object('ok', false, 'error', 'В этот день записи нет');
    end if;
  end if;

  -- Service-specific availability перекрывает дни/окно настроек (частично).
  -- Битый JSON игнорируется (fail-open к настройкам).
  v_eff_days := v_work_days;
  begin
    if v_service_row.availability is not null
       and jsonb_typeof(v_service_row.availability) = 'object' then
      if jsonb_typeof(v_service_row.availability -> 'days') = 'array'
         and jsonb_array_length(v_service_row.availability -> 'days') > 0 then
        v_eff_days := v_service_row.availability -> 'days';
      end if;
      if (v_service_row.availability ->> 'start') ~ '^\d{2}:\d{2}$' then
        v_slot_start := v_service_row.availability ->> 'start';
      end if;
      if (v_service_row.availability ->> 'end') ~ '^\d{2}:\d{2}$' then
        v_slot_end := v_service_row.availability ->> 'end';
      end if;
    end if;
  exception when others then
    v_eff_days := v_work_days;
  end;

  -- Override-окно перекрывает окно (пустые границы наследуются из настроек/услуги).
  if v_override_row.id is not null then
    if v_override_row.open_from ~ '^\d{2}:\d{2}$' then
      v_slot_start := v_override_row.open_from;
    end if;
    if v_override_row.open_to ~ '^\d{2}:\d{2}$' then
      v_slot_end := v_override_row.open_to;
    end if;
  end if;

  -- ——— 5. Schedule validation (T04 + D1): work_days + work_hours ———
  if v_eff_days is not null then
    begin
      v_isodow := extract(isodow from v_date)::int;
      -- work_days is jsonb array like [1,2,3,4,5]; check containment
      if not (v_eff_days ? v_isodow::text) and not (v_eff_days @> to_jsonb(v_isodow)) then
        -- try both text and int containment for compatibility
        -- if work_days contains numbers, the @> check above works; if strings, first check
        -- For safety, also check if array contains isodow as int via jsonb_array_elements
        if exists (select 1 where jsonb_typeof(v_eff_days) = 'array') then
          -- if no match found via @> and ?, do explicit check
          if not exists (
            select 1 from jsonb_array_elements(v_eff_days) as elem
            where (elem::text)::int = v_isodow or elem::text = v_isodow::text
          ) then
            return jsonb_build_object('ok', false, 'error', 'В этот день недели приёма нет');
          end if;
        end if;
      end if;
    exception when others then
      -- if work_days malformed, skip strict check (fail open for schedule, but other checks remain)
      null;
    end;
  end if;

  -- work hours: start >= window start, and start+duration <= window end + step (grace).
  -- Тексты ошибок — те же, что у js/domain/availability.js (единый контракт).
  begin
    declare
      v_slot_start_min int := null;
      v_slot_end_min int := null;
    begin
      if v_slot_start ~ '^\d{2}:\d{2}$' then
        v_slot_start_min := substr(v_slot_start,1,2)::int*60 + substr(v_slot_start,4,2)::int;
      end if;
      if v_slot_end ~ '^\d{2}:\d{2}$' then
        v_slot_end_min := substr(v_slot_end,1,2)::int*60 + substr(v_slot_end,4,2)::int;
      end if;
      if v_slot_start_min is not null and v_slot_end_min is not null then
        v_win_start_min := v_slot_start_min;
        -- Явный slot_times: grace учитывает последний старт сетки, но никогда
        -- не строже прежнего поведения (fail-open для прямых RPC).
        v_win_grace_min := v_slot_end_min + v_step;
        v_has_slot_list := false;
        begin
          if jsonb_typeof(v_settings_row.slot_times) = 'array'
             and jsonb_array_length(v_settings_row.slot_times) > 0 then
            select max(substr(e, 1, 2)::int * 60 + substr(e, 4, 2)::int) into v_last_slot_min
            from jsonb_array_elements_text(v_settings_row.slot_times) as e
            where e ~ '^\d{2}:\d{2}$';
            if v_last_slot_min is not null then
              v_has_slot_list := true;
              v_win_grace_min := greatest(v_last_slot_min + v_step, v_win_grace_min);
            end if;
          end if;
        exception when others then
          v_has_slot_list := false;
        end;
        if v_new_start < v_win_start_min then
          return jsonb_build_object('ok', false, 'error', 'Время вне часов приёма');
        end if;
        if v_new_start + v_new_dur > v_win_grace_min then
          return jsonb_build_object('ok', false, 'error',
            'не хватает ' || v_new_dur || ' мин до конца приёма');
        end if;
        -- Slot start increment — только для сгенерированной сетки
        -- (явный slot_times побеждает, как в engine).
        if v_increment is not null and not v_has_slot_list then
          if ((v_new_start - v_win_start_min) % v_increment) <> 0 then
            return jsonb_build_object('ok', false, 'error',
              'Начало записи — каждые ' ||
              case when v_increment >= 60 and v_increment % 60 = 0
                then (v_increment / 60) || ' ч' else v_increment || ' мин' end);
          end if;
        end if;
      end if;
    end;
  exception when others then null; end;

  -- D1: кандидат с буферами занимает [start - buf_before, start + dur + buf_after).
  v_cand_from := v_new_start - v_buf_before;
  v_cand_to := v_new_start + v_new_dur + v_buf_after;

  -- ============================================================
  -- Атомарность (SR-002). Проверка занятости и INSERT ниже — одна транзакция,
  -- но без блокировки две параллельные записи на один слот обе проходят проверку
  -- и обе вставляются (гонка). Транзакционная advisory-блокировка по
  -- (психолог, дата) сериализует такие вызовы: второй ждёт коммита первого
  -- и уже видит его запись в проверке перекрытия.
  -- ============================================================
  perform pg_advisory_xact_lock(hashtext('booking:' || p_psychologist_id || ':' || p_session_date));

  -- ——— 6. Проверка client_risks blocked (server-side risk) ———
  if v_phone_key <> '' then
    select blocked into v_blocked from client_risks where phone_key = v_phone_key;
    if v_blocked then
      return jsonb_build_object('ok', false, 'error', 'Запись с этого номера временно недоступна');
    end if;
  end if;

  -- ——— 7. Занятость по ИНТЕРВАЛАМ с буферами (D1): кандидат занимает
  -- [start - buf_before, start + dur + buf_after), чужие записи — тоже
  -- с буферами (симметрично engine). При нулевых буферах — как раньше.
  -- Длительность чужой записи — её снимок, иначе услуга, иначе шаг сетки, иначе дефолт.
  if exists (
    select 1 from sessions s
    left join services sv on sv.id = s.service_id
    left join session_settings ss on ss.psychologist_id = s.psychologist_id
    where s.psychologist_id = p_psychologist_id
      and s.session_date = p_session_date
      and s.status not in ('cancelled', 'expired', 'no_show')
      and (s.status <> 'held' or s.hold_expires_at is null or s.hold_expires_at > now())
      and (substr(s.session_time, 1, 2)::int * 60 + substr(s.session_time, 4, 2)::int) - v_buf_before < v_cand_to
      and (substr(s.session_time, 1, 2)::int * 60 + substr(s.session_time, 4, 2)::int)
            + coalesce(s.duration_min, sv.duration_min, ss.slot_step_min, v_default_dur) + v_buf_after > v_cand_from
  ) then
    return jsonb_build_object('ok', false, 'error', 'Это время только что заняли — выберите другое');
  end if;

  -- Блокировки занятости — по интервалам против кандидата с буферами
  -- (сами блокировки жёсткие, буферами не расширяются — как в engine).
  if exists (
    select 1 from schedule_blocks b
    where b.psychologist_id = p_psychologist_id
      and p_session_date between b.date_from and b.date_to
      and (
        (b.time_from = '' and b.time_to = '')
        or (
          v_cand_from < (substr(coalesce(nullif(b.time_to, ''), '23:59'), 1, 2)::int * 60
                         + substr(coalesce(nullif(b.time_to, ''), '23:59'), 4, 2)::int)
          and (substr(coalesce(nullif(b.time_from, ''), '00:00'), 1, 2)::int * 60
               + substr(coalesce(nullif(b.time_from, ''), '00:00'), 4, 2)::int) < v_cand_to
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'error', 'В это время специалист не принимает');
  end if;

  -- D1: недельный лимит считает чужие даты той же недели — для него нужен
  -- lock уровня недели (дневной lock гонку между днями не закрывает).
  -- Порядок всегда один (день → неделя), дедлока между транзакциями нет.
  if v_max_week is not null then
    perform pg_advisory_xact_lock(hashtext('bookingw:' || p_psychologist_id || ':' || date_trunc('week', v_date)::date::text));
  end if;

  -- ——— 7b. Лимиты мест в день / неделю (D1) ———
  if v_max_day is not null then
    select count(*) into v_day_count from sessions s
    where s.psychologist_id = p_psychologist_id
      and s.session_date = p_session_date
      and s.status not in ('cancelled', 'expired', 'no_show')
      and (s.status <> 'held' or s.hold_expires_at is null or s.hold_expires_at > now());
    if v_day_count >= v_max_day then
      return jsonb_build_object('ok', false, 'error', 'На этот день мест больше нет');
    end if;
  end if;

  if v_max_week is not null then
    select count(*) into v_week_count from sessions s
    where s.psychologist_id = p_psychologist_id
      and date_trunc('week', s.session_date::date) = date_trunc('week', v_date)
      and s.status not in ('cancelled', 'expired', 'no_show')
      and (s.status <> 'held' or s.hold_expires_at is null or s.hold_expires_at > now());
    if v_week_count >= v_max_week then
      return jsonb_build_object('ok', false, 'error', 'На эту неделю мест больше нет');
    end if;
  end if;

  -- ——— 8. Анти-спам по времени СОЗДАНИЯ (T03) ———
  -- Раньше считалось session_date = current_date, что позволяло обойти лимит
  -- выбором будущих дат. Теперь — по created_at (факт создания заявки).
  if v_phone_key <> '' then
    -- normalize client phone in clients table same way for comparison
    select count(*) into v_today_count
    from sessions s
    join clients c on c.id = s.client_id
    where s.psychologist_id = p_psychologist_id
      and s.created_at >= current_date
      and (
        case when length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) >= 9
             then right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 9)
             else regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')
        end
      ) = v_phone_key;
    if v_today_count >= 3 then
      return jsonb_build_object('ok', false, 'error', 'Слишком много записей за день, попробуйте позже');
    end if;
  end if;

  -- ——— 9. Повторный клиент по телефону (детерминированная нормализация) ———
  if v_phone_key <> '' then
    select id into v_client_id from clients
    where psychologist_id = p_psychologist_id
      and (
        case when length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 9
             then right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9)
             else regexp_replace(coalesce(phone, ''), '\D', '', 'g')
        end
      ) = v_phone_key
    order by created_at limit 1;
  end if;

  if v_client_id is null then
    insert into clients (psychologist_id, name, nickname, phone, contact, note, consent, consent_at)
    values (p_psychologist_id,
            coalesce(nullif(p_client_name, ''), p_client_nickname),
            coalesce(nullif(p_client_nickname, ''), p_client_name),
            p_client_phone, p_client_contact, p_client_note,
            coalesce(p_consent, false), p_consent_at)
    returning id into v_client_id;
  end if;

  -- ——— 10. Server-authoritative payment derivation (T02) ———
  -- Клиентские p_status, p_payment_policy, p_payment_status, p_amount_due,
  -- p_amount_paid, p_currency, p_duration_min — игнорируются, authoritative
  -- значения выводятся сервером из услуги и настроек кабинета.
  v_price := coalesce(v_service_row.price, 0);
  v_currency := coalesce(v_service_row.currency, 'BYN');
  v_effective_policy := coalesce(v_service_row.payment_policy, v_settings_row.payment_policy, 'none');

  -- deposit calculation
  if v_effective_policy = 'full' then
    v_amount_due := v_price;
  elsif v_effective_policy in ('deposit', 'hold_until_paid', 'hold') then
    if v_service_row.deposit_amount is not null then
      v_amount_due := v_service_row.deposit_amount;
    elsif v_settings_row.deposit_amount is not null then
      v_amount_due := v_settings_row.deposit_amount;
    else
      declare
        v_pct numeric := coalesce(v_service_row.deposit_percent, v_settings_row.deposit_percent, 30);
      begin
        v_amount_due := round((v_price * v_pct / 100)::numeric, 2);
      end;
    end if;
    if v_amount_due > v_price then
      v_amount_due := v_price;
    end if;
  else
    v_amount_due := 0;
  end if;

  v_requires_payment := v_effective_policy <> 'none' and coalesce(v_amount_due,0) > 0;
  if v_requires_payment then
    v_status := 'held';
    v_hold_expires_at := now() + (v_hold_minutes || ' minutes')::interval;
  else
    v_status := 'confirmed';
    v_hold_expires_at := null;
  end if;
  v_payment_status := 'unpaid';
  v_amount_paid := 0;

  insert into sessions (psychologist_id, client_id, service_id, session_date, session_time,
                        status, note, video_platform,
                        payment_policy, payment_status, amount_due, amount_paid, currency,
                        hold_expires_at,
                        client_timezone, client_utc_offset_min, duration_min)
  values (p_psychologist_id, v_client_id, p_service_id, p_session_date, p_session_time,
          v_status, p_session_note, coalesce(p_video_platform,''),
          v_effective_policy, v_payment_status, v_amount_due, v_amount_paid, v_currency,
          v_hold_expires_at,
          coalesce(nullif(p_client_timezone, ''), ''), p_client_utc_offset_min, v_new_dur)
  returning id into v_session_id;

  -- ——— 11. Логирование попытки (для аудита anti-spam) ———
  begin
    insert into booking_attempts (psychologist_id, phone_key, fingerprint, success, reason, consent, consent_at)
    values (p_psychologist_id, v_phone_key, '', true, 'created', coalesce(p_consent,false), p_consent_at);
  exception when others then null; end;

  return jsonb_build_object(
    'ok', true,
    'client_id', v_client_id,
    'session_id', v_session_id,
    'duration_min', v_new_dur,
    'status', v_status,
    'payment_status', v_payment_status,
    'payment_policy', v_effective_policy,
    'amount_due', v_amount_due,
    'amount_paid', v_amount_paid,
    'currency', v_currency,
    'hold_expires_at', v_hold_expires_at
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
-- Все перегрузки — до создания канонической (см. пояснение у create_booking).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_psychologist_profile'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;

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
  v_is_active boolean;
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

  select id, owner_id, is_active into v_id, v_cur, v_is_active
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

    -- Отключённый кабинет входом НЕ реактивируется (issue #40, п.8 / #46, TASK 3).
    -- Раньше UPDATE ниже безусловно ставил is_active = true: деактивация
    -- специалиста отменялась его же следующим входом. Реактивация — только
    -- явным действием владельца (service_role / SQL Editor), не login-операцией.
    if not v_is_active then
      return jsonb_build_object(
        'ok', false,
        'inactive', true,
        'error', 'Учётная запись отключена. Для восстановления доступа обратитесь к администратору портала.'
      );
    end if;

    update psychologists
    set owner_id       = coalesce(owner_id, v_owner),
        -- is_active НЕ трогаем: см. проверку выше
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
