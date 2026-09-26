-- Telegram Mini App identity mapping + self-registration for a Telegram-only account.
-- Review and apply once to Supabase. The bot token/service role are never stored here.

create table if not exists public.psychologist_telegram_accounts (
  telegram_user_id bigint primary key check (telegram_user_id > 0),
  auth_user_id uuid not null unique
    references auth.users(id) on delete cascade,
  linked_at timestamptz not null default now()
);

alter table public.psychologist_telegram_accounts enable row level security;
revoke all on public.psychologist_telegram_accounts from public, anon, authenticated;
grant all on public.psychologist_telegram_accounts to service_role;

create table if not exists public.telegram_auth_replays (
  init_data_hash text primary key check (init_data_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now()
);

alter table public.telegram_auth_replays enable row level security;
revoke all on public.telegram_auth_replays from public, anon, authenticated;
grant all on public.telegram_auth_replays to service_role;

-- Telegram creates an incomplete private profile; existing profiles are marked complete once.
do $$
declare v_added boolean := false;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'psychologists'
       and column_name = 'profile_completed'
  ) then
    alter table public.psychologists add column profile_completed boolean not null default false;
    v_added := true;
  end if;
  if v_added then
    update public.psychologists set profile_completed = true;
  end if;
end $$;

create index if not exists psychologists_owner_idx on public.psychologists(owner_id);

create or replace function public.link_or_create_psychologist_for_telegram()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_telegram_id bigint;
  v_email text;
  v_full_name text;
  v_confirmed timestamptz;
  v_n int;
  v_id text;
  v_active boolean;
  v_completed boolean;
  v_base text;
  v_slug text;
  v_i int := 0;
begin
  if v_owner is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated', 'error', 'Войдите через Telegram снова.');
  end if;

  -- Само наличие auth.uid() недостаточно: Telegram map создаёт только Edge
  -- Function после проверки initData либо bind после живой owner-сессии.
  select count(*), min(telegram_user_id)
    into v_n, v_telegram_id
    from public.psychologist_telegram_accounts
   where auth_user_id = v_owner;
  if v_n <> 1 then
    return jsonb_build_object('ok', false, 'code', 'telegram_not_linked', 'error', 'Telegram не подтверждён для этой сессии.');
  end if;

  select count(*), min(id), bool_and(is_active), bool_and(profile_completed)
    into v_n, v_id, v_active, v_completed
    from public.psychologists where owner_id = v_owner;
  if v_n > 1 then
    return jsonb_build_object('ok', false, 'code', 'multiple_owned', 'error', 'У аккаунта найдено несколько кабинетов.');
  end if;
  if v_n = 1 then
    if not coalesce(v_active, false) then
      return jsonb_build_object('ok', false, 'code', 'profile_inactive', 'error', 'Доступ к кабинету отключён. Обратитесь к администратору.');
    end if;
    return jsonb_build_object('ok', true, 'code', 'already_linked', 'id', v_id,
      'created', false, 'is_active', true, 'profile_completed', coalesce(v_completed, false));
  end if;

  select lower(trim(coalesce(u.email, ''))), u.email_confirmed_at,
         coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
                  nullif(trim(u.raw_user_meta_data ->> 'name'), ''),
                  'Специалист Telegram')
    into v_email, v_confirmed, v_full_name
    from auth.users u where u.id = v_owner;
  if v_email <> ('telegram-' || v_telegram_id::text || '@telegram.invalid')
     or (select u.raw_user_meta_data ->> 'telegram_user_id' from auth.users u where u.id = v_owner) <> v_telegram_id::text then
    return jsonb_build_object('ok', false, 'code', 'identity_mismatch', 'error', 'Новая регистрация Telegram не подтверждена.');
  end if;
  if v_confirmed is null then
    return jsonb_build_object('ok', false, 'code', 'email_unconfirmed', 'error', 'Не подтверждена учётная запись Telegram.');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('psy_email:' || v_email, 0));
  perform pg_advisory_xact_lock(hashtextextended('psy_owner:' || v_owner::text, 0));

  select count(*) into v_n from public.psychologists where owner_id = v_owner;
  if v_n > 0 then
    select id, is_active, profile_completed into v_id, v_active, v_completed
      from public.psychologists where owner_id = v_owner limit 1;
    if not coalesce(v_active, false) then
      return jsonb_build_object('ok', false, 'code', 'profile_inactive', 'error', 'Доступ к кабинету отключён. Обратитесь к администратору.');
    end if;
    return jsonb_build_object('ok', true, 'code', 'already_linked', 'id', v_id,
      'created', false, 'is_active', true, 'profile_completed', coalesce(v_completed, false));
  end if;
  if exists (select 1 from public.psychologists where lower(trim(email)) = v_email) then
    return jsonb_build_object('ok', false, 'code', 'email_taken', 'error', 'Не удалось безопасно создать кабинет с этой учётной записью.');
  end if;

  v_base := lower(regexp_replace(v_full_name, '[^0-9a-zA-Zа-яё]+', '-', 'gi'));
  v_base := trim(both '-' from v_base);
  if v_base is null or v_base = '' then v_base := 'telegram-specialist'; end if;
  v_slug := v_base;
  while exists (select 1 from public.psychologists where slug = v_slug) loop
    v_i := v_i + 1;
    v_slug := v_base || '-' || v_i;
  end loop;

  insert into public.psychologists (email, full_name, specialization, slug, owner_id, is_active, profile_completed)
  values (v_email, v_full_name, 'Психолог', v_slug, v_owner, true, false)
  returning id into v_id;
  insert into public.session_settings(psychologist_id) values (v_id)
    on conflict (psychologist_id) do nothing;

  return jsonb_build_object('ok', true, 'code', 'created', 'id', v_id,
    'created', true, 'is_active', true, 'profile_completed', false);
end;
$$;

revoke execute on function public.link_or_create_psychologist_for_telegram() from public, anon;
grant execute on function public.link_or_create_psychologist_for_telegram() to authenticated;

create or replace function public.complete_telegram_psychologist_profile(
  p_full_name text,
  p_phone text,
  p_specialization text,
  p_city text,
  p_about text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_id text;
  v_n int;
begin
  if v_owner is null or not exists (
    select 1 from public.psychologist_telegram_accounts where auth_user_id = v_owner
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated', 'error', 'Telegram-сессия не подтверждена.');
  end if;
  if coalesce(trim(coalesce(p_full_name, '')), '') = ''
     or coalesce(trim(coalesce(p_phone, '')), '') = ''
     or coalesce(trim(coalesce(p_specialization, '')), '') = ''
     or coalesce(trim(coalesce(p_city, '')), '') = ''
     or coalesce(trim(coalesce(p_about, '')), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'Заполните ФИО, телефон, специализацию, город и рассказ о себе.');
  end if;
  select count(*), min(id) into v_n, v_id
    from public.psychologists where owner_id = v_owner and is_active;
  if v_n <> 1 then
    return jsonb_build_object('ok', false, 'code', 'no_profile', 'error', 'Активный кабинет не найден.');
  end if;
  update public.psychologists
     set full_name = trim(p_full_name), phone = trim(p_phone),
         specialization = trim(p_specialization), city = trim(p_city),
         about = trim(p_about), profile_completed = true, updated_at = now()
   where id = v_id;
  return jsonb_build_object('ok', true, 'code', 'completed', 'id', v_id, 'profile_completed', true);
end;
$$;

revoke execute on function public.complete_telegram_psychologist_profile(text,text,text,text,text) from public, anon;
grant execute on function public.complete_telegram_psychologist_profile(text,text,text,text,text) to authenticated;

-- Incomplete Telegram profiles stay private until onboarding is complete.
create or replace view public.public_profiles as
  select id, full_name, phone, specialization, city, about, website, source_url, address,
         experience, slug, profession, greeting, approach, photo_url, public_email,
         directions, education, experience_items, socials, payment_links, payment_requisites,
         is_active, created_at
    from public.psychologists
   where is_active and profile_completed;
grant select on public.public_profiles to anon, authenticated;

comment on table public.psychologist_telegram_accounts is
  'Private Telegram ID to Supabase Auth owner mapping; created by telegram-auth after validating Telegram initData. Existing accounts require an authenticated owner session to bind. No direct client access.';
comment on table public.telegram_auth_replays is
  'Single-use Telegram initData digests; service-role only. Rows may be pruned after expires_at.';
