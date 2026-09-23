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
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists sessions_psy_idx on sessions (psychologist_id, session_date);

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
  reminder_channel                 text not null default 'telegram_sms'
);

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
-- RLS: пилотный режим — приложение работает через anon key.
-- Ужесточить (по психологу / по owner) при подключении auth.
-- ============================================================
alter table psychologists      enable row level security;
alter table services           enable row level security;
alter table clients            enable row level security;
alter table sessions           enable row level security;
alter table session_settings   enable row level security;
alter table payments           enable row level security;
alter table email_codes        enable row level security;
alter table waiting_items      enable row level security;
alter table booking_attempts   enable row level security;
alter table client_risks       enable row level security;
alter table session_reminders  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['psychologists','services','clients','sessions','session_settings',
                           'payments','email_codes','waiting_items','booking_attempts','client_risks','session_reminders']
  loop
    execute format('drop policy if exists anon_all on %I', t);
    execute format('create policy anon_all on %I for all to anon using (true) with check (true)', t);
  end loop;
end $$;
