-- ============================================================
-- Seed — референсные данные профиля с сайта nataliamikhailouskaya.by
-- (модель сайта извлечена и сведена в docs/DATA-MODEL.md)
-- Файл идемпотентен: upsert по id.
--
-- ВАЖНО: email каталожной записи — технический маркер example.invalid
-- (реальные учётки не создаются). Публичный контактный email — в
-- колонке public_email.
-- ============================================================

insert into psychologists (
  id, email, full_name, phone, specialization, city, about,
  website, source_url, address, experience, slug,
  greeting, approach, photo_url, public_email,
  directions, education, experience_items, socials,
  payment_links, payment_requisites, is_active
) values (
  'psy_catalog_19',
  'catalog+наталья-михайловская-19@example.invalid',
  'Наталия Михайловская',
  '+375 (29) 780-45-45',
  'Гештальт-терапевт, кризисный и семейный психолог',
  'Гродно',
  'Работа с отношениями, кризисами, тревогой, самооценкой, личными границами, эмоциональным выгоранием и семейными запросами. Использует гештальт-подход, системную семейную терапию, НЛП/ИНП и МАК.',
  'https://nataliamikhailouskaya.by/',
  'https://nataliamikhailouskaya.by/',
  'г. Гродно, ул. Свердлова, 16',
  '10 лет работы в областном клиническом центре и 10 лет частной практики по данным официального сайта',
  'наталия-михайловская-19',
  'Добро пожаловать. Меня зовут Наталия Михайловская.',
  'В своей работе я использую методы и концепции из различных направлений психотерапии, подбирая их под психические особенности клиента.',
  'https://optim.tildacdn.biz/tild3136-3339-4362-b337-613561643332/-/format/webp/IMG_6796.JPG.webp',
  'mikhailouskayanataliya@gmail.com',
  -- «Направления моей работы» / «С чем могу помочь»
  '[
    {"title": "Взаимоотношения", "details": "созависимые, кризисы, сложности в построении отношений: супружеских, партнёрских, детско-родительских; переживания измены, болезненные расставания и разводы"},
    {"title": "Страхи, повышенная тревожность", "details": ""},
    {"title": "Неуверенность в себе, низкая самооценка, поиск себя", "details": ""},
    {"title": "Переживания злости, обиды, стыда, чувство вины", "details": ""},
    {"title": "Личные границы", "details": ""},
    {"title": "Стресс, упадок сил, эмоциональное выгорание", "details": ""}
  ]'::jsonb,
  -- Психологическое + дополнительное образование
  '{
    "basic": [
      {"title": "Гродненский государственный университет им. Я. Купалы, факультет психологии (5-ти летнее обучение)", "institution": "Гродненский государственный университет им. Я. Купалы", "details": "факультет психологии; 5-ти летнее обучение"},
      {"title": "Московский Гештальт Институт (МГИ)", "institution": "Московский Гештальт Институт (МГИ)", "details": ""}
    ],
    "additional": [
      {"title": "Специалист в области кризисов и травм", "institution": "", "details": ""},
      {"title": "Специалист в области семейной системной психотерапии", "institution": "", "details": ""},
      {"title": "Психотерапия секса и сексуальных отношений", "institution": "", "details": ""},
      {"title": "Сертифицированный НЛП-практик", "institution": "", "details": ""},
      {"title": "Специалист по использованию метафорических ассоциативных карт", "institution": "", "details": ""}
    ]
  }'::jsonb,
  -- Опыт работы
  '[
    {"organisation": "Областной клинический центр «Психиатрия-наркология»", "details": "В данный момент работаю в областном клиническом центре «Психиатрия-наркология» 10 лет", "years": 10, "isCurrent": true},
    {"organisation": "Частная практика", "details": "Также консультирую на протяжении 10 лет в рамках частной практики", "years": 10, "isCurrent": true}
  ]'::jsonb,
  -- Соцсети / мессенджеры контактов
  '[
    {"kind": "telegram", "url": "https://t.me/psyholog_natali", "title": "telegram"},
    {"kind": "instagram", "url": "https://www.instagram.com/psyholog__natali", "title": "instagram"}
  ]'::jsonb,
  -- Платёжные ссылки (bePaid + свободный платёж)
  '[
    {"label": "Очная/онлайн консультации", "url": "https://api.bepaid.by/products/prd_4b68b00019808a21/pay", "kind": "service"},
    {"label": "Семейная консультация", "url": "https://api.bepaid.by/products/prd_eec3c942ea52cfed/pay", "kind": "service"},
    {"label": "Свободный платёж", "url": "https://nataliamikhailouskaya.by/donation", "kind": "donation"}
  ]'::jsonb,
  -- Реквизиты для платежа по реквизитам.
  -- ВАЖНО: банковские и регистрационные данные (получатель, юр. адрес, УНП,
  -- расчётный счёт, банк, БИК) — персональные данные специалиста и в репозитории
  -- НЕ хранятся. Специалист заполняет их сам в кабинете
  -- («Профиль» → «Реквизиты для оплаты»); сид оставляет блок пустым.
  '{}'::jsonb,
  true
)
on conflict (id) do update set
  email = excluded.email,
  full_name = excluded.full_name,
  phone = excluded.phone,
  specialization = excluded.specialization,
  city = excluded.city,
  about = excluded.about,
  website = excluded.website,
  source_url = excluded.source_url,
  address = excluded.address,
  experience = excluded.experience,
  slug = excluded.slug,
  greeting = excluded.greeting,
  approach = excluded.approach,
  photo_url = excluded.photo_url,
  public_email = excluded.public_email,
  directions = excluded.directions,
  education = excluded.education,
  experience_items = excluded.experience_items,
  socials = excluded.socials,
  payment_links = excluded.payment_links,
  payment_requisites = excluded.payment_requisites,
  is_active = excluded.is_active,
  updated_at = now();

-- ——— Услуги (блок «Услуги» сайта: цена, длительность, формат, каналы, ссылка оплаты) ———
insert into services (id, psychologist_id, title, description, duration_min, price, currency, format, platforms, pay_url, sort_order) values
  ('svc_natalia_1', 'psy_catalog_19', 'Очная консультация', 'в г. Гродно (Беларусь)', 60, 80, 'BYN', 'offline', '[]'::jsonb, 'https://api.bepaid.by/products/prd_4b68b00019808a21/pay', 1),
  ('svc_natalia_2', 'psy_catalog_19', 'Супружеское (семейное) консультирование', 'личный приём в г. Гродно', 90, 110, 'BYN', 'offline', '[]'::jsonb, 'https://api.bepaid.by/products/prd_eec3c942ea52cfed/pay', 2),
  ('svc_natalia_3', 'psy_catalog_19', 'Онлайн-консультация', 'в Skype, WhatsApp, Viber, Telegram, Zoom', 60, 3000, 'RUB', 'online',
   '["skype","whatsapp","viber","telegram","zoom"]'::jsonb, 'https://api.bepaid.by/products/prd_4b68b00019808a21/pay', 3)
on conflict (id) do update set
  title = excluded.title,
  description = excluded.description,
  duration_min = excluded.duration_min,
  price = excluded.price,
  currency = excluded.currency,
  format = excluded.format,
  platforms = excluded.platforms,
  pay_url = excluded.pay_url,
  sort_order = excluded.sort_order;

-- ——— Настройки кабинета (часовой пояс Минска; слоты как на сайте — 60 мин) ———
insert into session_settings (psychologist_id, timezone, slot_start, slot_end, slot_step_min) values
  ('psy_catalog_19', 'Europe/Minsk', '10:00', '19:00', 60)
on conflict (psychologist_id) do nothing;

-- ——— Блокировки занятости: пример (воскресенье — выходной) ———
-- Клиентам видны только тип/заголовок/период (public_schedule_blocks); заметка приватна.
insert into schedule_blocks (id, psychologist_id, date_from, date_to, kind, title, note, source)
values ('blk_natalia_sunday', 'psy_catalog_19',
        to_char(current_date + (7 - extract(isodow from current_date))::int, 'YYYY-MM-DD'),
        to_char(current_date + (7 - extract(isodow from current_date))::int, 'YYYY-MM-DD'),
        'day_off', 'Выходной', '', 'manual')
on conflict (id) do nothing;
