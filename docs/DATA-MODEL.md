# Модель данных: сайт nataliamikhailouskaya.by ↔ Psihologist-cabinet

Источник: публичные страницы [nataliamikhailouskaya.by](https://nataliamikhailouskaya.by/)
(«Обо мне», «С чем могу помочь», «Направления моей работы», образование, опыт, «Услуги»,
«Оплатить», «Контакты») и [/donation](https://nataliamikhailouskaya.by/donation) (реквизиты).

Целевая модель приложения — `js/models/entities.js` (Code First),
БД — PostgreSQL/Supabase (`supabase/schema.sql`), маппинг — `js/services/supabaseSync.js`.

---

## 1. Модель данных сайта (извлечена)

| Сущность сайта | Что содержит |
|---|---|
| **Профиль («Обо мне»)** | приветствие, ФИО, специализация («гештальт-терапевт, кризисный и семейный психолог»), подход в работе, фото |
| **Запросы / направления работы** («С чем могу помочь», «Направления моей работы») | упорядоченный список тем с детализацией в скобках (6 пунктов: взаимоотношения, страхи/тревожность, самооценка, эмоции, границы, выгорание) |
| **Образование** | 2 группы: психологическое (2 записи), дополнительное (5 записей) |
| **Опыт работы** | 2 записи: организация, срок (лет), текущее место |
| **Услуги** | 3 услуги: название, цена, валюта (BYN/RUB), длительность (60/90/60 мин), формат (очно/онлайн), примечание (город / каналы), платёжная ссылка |
| **Оплата** | 3 платёжные ссылки (2× bePaid product, «свободный платёж») + банковские реквизиты ИП (получатель, юр. адрес, УНП, р/с, банк, БИК, назначение платежа) + страница /donation |
| **Контакты** | телефон, публичный email, адрес приёма, соцсети (telegram, instagram); онлайн-каналы (Skype, WhatsApp, Viber, Telegram, Zoom) |

Конкретные значения (эталон для seed) — `supabase/seed.sql` и `_seed()` в `js/core/dbContext.js`.

---

## 2. Сверка с моделью проекта (было → стало)

| Поле модели сайта | Было в `Psychologist` | Стало |
|---|---|---|
| ФИО | ✅ `fullName` | ✅ |
| Специализация | ✅ `specialization` | ✅ |
| Город | ✅ `city` | ✅ |
| О себе (текст) | ✅ `about` (смешивал всё подряд) | ✅ `about` + отдельные поля ниже |
| Приветствие | ❌ терялось | ✅ `greeting` |
| Подход в работе | ❌ терялось | ✅ `approach` |
| Фото | ❌ терялось | ✅ `photoUrl` |
| Публичный email | ⚠️ `email` = учётка входа | ✅ `publicEmail` (вход — отдельно) |
| Телефон | ✅ `phone` | ✅ |
| Адрес приёма | ✅ `address` | ✅ |
| Сайт / источник | ✅ `website`, `sourceUrl` | ✅ |
| Направления работы (запросы) | ❌ терялось | ✅ `directions[]` `{title, details}` |
| Образование (2 группы) | ❌ терялось | ✅ `education.basic[]` / `education.additional[]` `{title, institution, details}` |
| Опыт (структурированный) | ⚠️ только текст `experience` | ✅ `experienceItems[]` `{organisation, details, years, isCurrent}` (текст `experience` сохранён как краткое резюме) |
| Соцсети/мессенджеры | ❌ терялось | ✅ `socials[]` `{kind, url, title}` |
| Платёжные ссылки | ❌ терялось | ✅ `paymentLinks[]` `{label, url, kind}` |
| Банковские реквизиты | ❌ терялось | ✅ `paymentRequisites` `{recipient, legalAddress, unp, account, bankName, bik, purpose, donationUrl}` |
| Услуги: цена/длительность/формат | ✅ `Service` | ✅ |
| Услуги: примечание («в г. Гродно…», «в Skype, …») | ❌ терялось (и терялось при sync!) | ✅ `Service.description` |
| Услуги: каналы онлайн | ❌ терялось | ✅ `Service.platforms[]` |
| Услуги: ссылка оплаты | ❌ терялось | ✅ `Service.payUrl` |
| Услуги: порядок | ❌ терялось при sync (sort_order) | ✅ `Service.sortOrder` |

Итог: после расширения **вся** модель сайта помещается в модель приложения и в БД без потерь.

---

## 3. Структура расширенной модели (`Psychologist`)

```text
Psychologist
├─ учётка: id, email (вход), keyVerifier, isActive, createdAt, slug
├─ профиль: fullName, phone, publicEmail, specialization, city,
│           greeting, about, approach, photoUrl,
│           website, sourceUrl, address, experience (резюме)
├─ directions[]        — «С чем могу помочь» / «Направления работы»
├─ education           — { basic[], additional[] }
├─ experienceItems[]   — «Опыт» (структурированно)
├─ socials[]           — telegram/instagram/… контакты
├─ paymentLinks[]      — кнопки «Оплатить» (bePaid, /donation)
└─ paymentRequisites   — реквизиты ИП со страницы /donation

Service (услуга)
├─ name, price, currency, duration, format
├─ description   — примечание строки услуги
├─ platforms[]   — skype/whatsapp/viber/telegram/zoom (online)
├─ payUrl        — внешняя платёжная ссылка
└─ sortOrder, paymentPolicy, depositPercent, depositAmount, isActive
```

---

## 4. Маппинг в БД (PostgreSQL/Supabase)

Таблица `psychologists` (`supabase/schema.sql`):

| Поле модели | Колонка | Тип |
|---|---|---|
| greeting | `greeting` | text |
| approach | `approach` | text |
| photoUrl | `photo_url` | text |
| publicEmail | `public_email` | text |
| directions | `directions` | jsonb `[{title, details}]` |
| education | `education` | jsonb `{basic:[…], additional:[…]}` |
| experienceItems | `experience_items` | jsonb `[{organisation, details, years, isCurrent}]` |
| socials | `socials` | jsonb `[{kind, url, title}]` |
| paymentLinks | `payment_links` | jsonb `[{label, url, kind}]` |
| paymentRequisites | `payment_requisites` | jsonb `{recipient, legalAddress, unp, account, bankName, bik, purpose, donationUrl}` |

Таблица `services`:

| Поле модели | Колонка | Тип |
|---|---|---|
| name | `title` | text |
| description | `description` | text |
| duration | `duration_min` | integer |
| platforms | `platforms` | jsonb |
| payUrl | `pay_url` | text |
| sortOrder | `sort_order` | integer |

Формат jsonb сохраняет структуру списков (без «сплющивания» в строки) — данные читаются
и пишутся без потерь (`mapPsy`/`toPsyRow` в `js/services/supabaseSync.js`).
Локальная копия — localStorage (`js/core/dbContext.js`, вложенные массивы в агрегате
`Psychologist`; типы строк в конструкторе нормализуются, старые записи мигрируют без ключа).

### Существующие таблицы (дополнены колонками под модель)

`clients`, `sessions`, `session_settings`, `payments`, `email_codes`, `waiting_items`,
`booking_attempts`, `client_risks`, `session_reminders` — см. `supabase/schema.sql`
(DDL идемпотентный: `create table if not exists` + `add column if not exists`).

---

## 5. Замечания по синхронизации (зафиксировано, вне задачи)

* `mapClient`/`mapSession` не переносят часть служебных полей (`encryptedPii`,
  `previousSlot`, `changeConsentStatus`, `holdExpiresAt`, `requiresPayment`).
  Колонки в схеме уже предусмотрены; маппинг можно расширить аналогично `mapPsy`.
* Логин-`email` каталожных записей — технический маркер `example.invalid`
  (учётки не создаются). Реальный контактный email хранится в `publicEmail`.

---

## 6. Приватность, занятость, SEO (расширение по требованиям продукта)

### 6.1 Разграничение доступа (см. supabase/schema.sql, секция RLS)

| Кто | Что видит |
|---|---|
| **Аноним** | Только публичное: `public_profiles` (профиль без email-учётки и `key_verifier`), `services` (активные), `public_settings` (часы/слоты/оплата), `public_schedule_blocks` (free/busy без заметок), `public_booked_slots` (дата/время занятых слотов, без данных клиентов). Запись — только через `rpc/create_booking` (security definer: проверка слота, блокировок и анти-спама на сервере). |
| **Владелец кабинета** (`authenticated`, `owner_id = auth.uid()`) | Только СВОИ данные: клиенты, сессии, платежи, ожидание, напоминания, блокировки (включая приватные заметки), настройки с iCal-адресом. |
| **Сервисные ключи** | `service_role` — всё (миграции, бэкенд). |

Клиенты видны **только психологу, на которого записаны** (`psychologist_id in (select id from psychologists where owner_id = auth.uid())`) — и никому больше.

### 6.2 Занятость (schedule_blocks)

* Сущность `ScheduleBlock`: `{dateFrom, dateTo, timeFrom, timeTo, kind: day_off|busy|vacation|holiday|other, title, note, source: manual|google}`.
* `note` — приватная (в public-вью не попадает); `title` виден клиентам («Выходной»).
* Вкладка «Занятость» в кабинете: диапазон дат, время или весь день; слоты записи закрываются автоматически (`BookingViewModel.slots` + `db.isSlotBlocked`).
* **Google Calendar**: `calendarService` — (а) кнопки «Добавить в Google Calendar» (шаблонная ссылка `calendar/render?action=TEMPLATE` — как у Calendly/Booksy) на странице успеха и в расписании; (б) импорт занятости по секретному iCal-адресу (`parseIcs` → `schedule_blocks`, `source=google`, идемпотентно по `googleEventId`). Адрес хранится в `session_settings.google_calendar_ical_url` приватно; публично отдаются только итоговые free/busy. Для двусторонней синхронизации — Google Calendar API (OAuth), точка расширения `sessions.google_event_id`.

### 6.3 Мультипрофильность и SEO

* `Psychologist.profession` — дискриминатор (`Professions`: psychologist, psychotherapist, coach, lawyer, accountant); schema.org-тип подбирается автоматически (`ProfessionalService`/`MedicalBusiness`/`LegalService`/…).
* Индексируемые URL: `/psy/{slug}` (страница специалиста=страница записи), `/cabinet`, `/auth`; Deep links работают на GitHub Pages через `404.html`-fallback и локально через `devserver.py` (SPA-fallback, `%BASE%`-подстановка).
* `seoService`: canonical, Open Graph, Twitter Card, JSON-LD `@graph [Person + ProfessionalService]` с `OfferCatalog` (услуги/цены), `knowsAbout` (направления), `sameAs` (соцсети), `alumniOf` (образование). Каталог — `WebSite` + SearchAction.
* Карта сайта для краулеров генерируется статически при сборке (см. README).

### 6.4 Реквизиты (налоговое требование)

Блок реквизитов плательщика (`payment_requisites`: получатель, юр. адрес, УНП, р/с, банк, БИК, назначение платежа) — часть публичного профиля каждого специалиста, редактируется в кабинете, публикуется на странице записи. Эталон — реквизиты ИП с сайта Н. Михайловской в `supabase/seed.sql`.

### 6.5 Рабочие инструменты психолога (сущности)

* `Task` — задача кабинета: `{title, details, dueDate, clientId?, done}` → таблица `tasks`.
* `PsyNote` — «блокнот»/планировщик: `{title, body, date, pinned}` → таблица `psy_notes`.
* `ClientEntry` — запись о работе с клиентом (журнал): `{clientId, sessionId?, date, text}` → таблица `client_entries`; PII, доступ — только владельцу (RLS owner).
* Книга записей — представление над `sessions` (фильтры upcoming/pending/past/all + действия), новых таблиц не требует.

Клиентские страницы разделены: `/psy/{slug}` — SEO-лендинг специалиста (профиль,
услуги, реквизиты, контакты; canonical/OG/JSON-LD), `/book/{slug}` — отдельный шаг
записи (лёгкое SEO, без JSON-LD); у залогиненного владельца на `/psy/{slug}` — панель
управления. Легаси-ссылки `?book=` и `/psy/{slug}#book` ведут на `/book/{slug}`.

### 6.6 Персональная карточка = модель сайта из БД

Карточка `/psy/{slug}` показывает всё содержимое информационной модели сайта
специалиста, полученное из БД (`public_profiles` + `services`): фото (по умолчанию
извлекается с сайта-первоисточника; пусто → инициалы), контакты с мессенджерами
(tel:, `wa.me/<digits>`, `viber://chat?number=%2B<digits>`, Telegram/Instagram из
`socials`), адрес практики + схема проезда (Google Maps embed по строке адреса +
ссылки на маршруты Google/Яндекс), услуги/цены, образование, опыт, платёжные
ссылки и реквизиты. Ссылка на первоисточник — в подвале карточки. Плюс кнопка
«Поделиться специалистом» (navigator.share → копирование `/psy/{slug}`).

### 6.7 Telegram-уведомления (свой бот психолога)

- `session_settings`: `telegram_bot_token`, `telegram_chat_id`, `telegram_bot_name`,
  `telegram_notify_booking|reminders|payments` (bool), `last_notified_session_at`
  (watermark против дублей outbox).
- `clients.telegram_chat` — chat_id клиента (подключение бота по `/start <clientId>`).
- `js/services/telegramService.js`: тест токена/чата, переключатели событий,
  напоминания, outbox новых записей (таймер кабинета 60 с), привязка чатов.
- Мгновенная доставка с публичной страницы — `NOTIFY_WEBHOOK_URL`
  (Edge Function `supabase/functions/telegram-notify`; токен — только там).
  См. docs/TELEGRAM.md.
