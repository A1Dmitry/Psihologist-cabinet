# Очередь заявок на изменения схемы данных (SCHEMA-REQUESTS)

> Единое окно для изменений общей инфраструктуры данных. Создано Агентом 1
> (инфраструктура и интеграция), 2026-09-23.

## Кому и зачем

Агенты 2–5 (публичная запись/SEO, кабинет/клиенты, уведомления/оплата, QA)
**не редактируют** файлы инфраструктуры данных напрямую. Если для фичи нужна
новая таблица/колонка/политика/RPC или изменение клиентской модели — оставьте
заявку в этом файле (раздел «Очередь»), а Агент 1 внесёт изменение сам.

Это защищает: RLS-контракт (аноним видит только публичное), идемпотентность
`schema.sql`, паритет Code First ↔ БД и работоспособность чужих фич.

## Файлы в эксклюзивной зоне Агента 1

| Файл | Что это |
|------|---------|
| `supabase/schema.sql` | DDL, RLS, view, RPC — единственный источник схемы БД |
| `supabase/seed.sql` | Референс-данные продакшен-профиля |
| `supabase/functions/**` | Edge Functions (`auth-code`, `telegram-notify`) |
| `supabase/config.toml` | Конфиг CLI (verify_jwt и пр.) |
| `.github/workflows/**` | CI/CD: Pages, деплой функций |
| `js/core/dbContext.js` | Клиентский DbContext / хранилище |
| `js/models/entities.js` | Code First сущности (источник истины для маппинга) |
| `js/app.js` (структурная обвязка) | boot, маршрутизация, загрузка каталога — НЕ блоки фич |
| `index.html` (структурная обвязка) | каркас, boot-error, скрипты — НЕ разметка фич |
| `docs/INFRA.md`, `docs/SCHEMA-REQUESTS.md` | Этот процесс и runbook |

## Формат заявки

Добавьте строку в таблицу «Очередь» + разверните детали под ней:

```
### SR-XXX — <краткое название>
- **От:** Агент N (<роль>)
- **Дата:** YYYY-MM-DD
- **Что нужно:** <таблица/колонка/индекс/политика/RPC/поле сущности>
- **Куда:** <schema.sql → …, entities.js → …, dbContext.js → …>
- **Зачем:** <какая фича/задача T-XX, что сломается без этого>
- **Миграция:** как обновить существующие строки (дефолты/backfill; если непрозрачно — напишите)
- **Приоритет:** блокер | обычный | можно позже
```

Нумерация: **по диапазонам агентов** (см. врезку под «Очередью») — так параллельные
раунды не занимают один номер. Внутри диапазона — последовательно и без пропусков;
следующая свободная указана в таблице. Если Агент 1 решит вернуть сквозную нумерацию,
это его решение — номера в коде фич легко переименовать механически.

## Правила интеграции

1. **Обычные заявки** — Агент 1 разбирает очередь при каждом запуске и возвращает
   результат в тот же раунд: статус в таблице + коммит со ссылкой на SR-XXX.
2. **Блокеры** (фича не может продвинуться без изменения) — пометьте «блокер» и
   продолжайте всё, что можно сделать без него; Агент 1 разбирает блокеры первыми.
3. Агент 1 может отклонить заявку с причиной (нарушает RLS-контракт, дублирует
   существующее, проще решить на уровне фичи) — тогда в статусе будет альтернатива.
4. Изменения всегда: `schema.sql` (идемпотентно) → `entities.js` (паритет) →
   `js/core/dbContext.js` (если нужна клиентская сущность) → упоминание в
   `docs/INFRA.md`, если нужна ручная операция в проде.
5. **Не забудьте про прод:** после мержа schema-изменения кто-то должен
   переприменить `schema.sql` в проде (см. «Статус» в `docs/INFRA.md`).
   Агент 1 помечает это в коммите.

## Очередь

> Нумерация по агентам, чтобы параллельные раунды не сталкивались номерами:
> **Агент 2 (запись/SEO) — SR-001…SR-099**, **Агент 3 (кабинет/клиенты) — SR-101…SR-199**,
> **Агент 4 (уведомления/оплата) — SR-201…SR-299**. Первая свободная — в конце своего диапазона.

| ID | Дата | От | Что | Куда | Приоритет | Статус |
|----|------|----|-----|------|-----------|--------|
| SR-001 | 2026-09-23 | Агент 2 (запись/SEO) | Пояс клиента + duration в public_booked_slots + create_booking | schema.sql sessions/view/RPC, entities.js Session | обычный | очередь |
| SR-002 | 2026-09-23 | Агент 2 (запись/SEO) | OAuth Google Calendar / авто-Meet (T-22) | schema.sql session_settings + sessions, entities.js | можно позже | очередь |
| SR-101 | 2026-09-23 | Агент 3 (кабинет/клиенты) | таблица `session_series` + `sessions.series_id` | schema.sql, entities.js, cabinetApi.js | обычный (фича работает локально) | ждёт Агента 1 |
| SR-102 | 2026-09-23 | Агент 3 | `clients`: `price_override`, `currency`, `payment_method`, `meet_link`, `payment_url` | schema.sql, entities.js, cabinetApi.js | обычный | ждёт Агента 1 |
| SR-103 | 2026-09-23 | Агент 3 | таблица `client_access_tokens` + публичный RPC `client_cabinet(p_token)` | schema.sql | блокер для кросс-девайс мини-кабинета (T-12) | ждёт Агента 1 |
| SR-104 | 2026-09-23 | Агент 3 | таблица `client_materials` (+ отдача в `client_cabinet`) | schema.sql | обычный (T-13) | ждёт Агента 1 |
| SR-105 | 2026-09-23 | Агент 3 | таблица `client_requests` + RPC `client_cabinet_action(p_token, p_action, p_payload)` | schema.sql | обычный (T-08/T-12/T-24) | ждёт Агента 1 |
| SR-106 | 2026-09-23 | Агент 3 (совместно с Агентом 2 по форме записи) | `waiting_items`: `desired_date`, `desired_time`, `recurring`, `weekday`, `session_id`, `status` | schema.sql, entities.js, cabinetApi.js | обычный (T-08/T-24) | ждёт Агента 1 |
| SR-107 | 2026-09-23 | Агент 3 | таблица `client_documents` (подпись клиента) | schema.sql | можно позже (T-14) | ждёт Агента 1 |
| SR-108 | 2026-09-23 | Агент 3 (синхронизация с T-03 Агента 2) | `sessions.client_timezone` (`zone_offset_min` при необходимости) | schema.sql, entities.js, cabinetApi.js | обычный (T-23) | **покрыто SR-001** — не дублировать колонки; кабинет читает поля SR-001 |
| SR-109 | 2026-09-23 | Агент 3 | маппинг новых полей в `cabinetApi.mapSession/sessRow/applyPull` (клиенты/сессии/ожидание) | cabinetApi.js | обычный | ждёт Агента 1 |


## Детали заявок Агента 2 (публичная запись и SEO)

### SR-001 — часовой пояс клиента и длительность занятости

- **От:** Агент 2 (публичная запись и SEO)
- **Дата:** 2026-09-23
- **Что нужно:**
  1. Колонки `sessions`:
     - `client_timezone text not null default ''` — IANA, напр. `Europe/Berlin`
     - `client_utc_offset_min integer not null default 0` — смещение на момент записи (минуты)
     - `starts_at timestamptz` — абсолютный старт слота в TZ специалиста (удобно для T-23/напоминаний)
  2. View `public_booked_slots`: добавить `duration_min` (join `services.duration_min`, fallback 60) — иначе 90-мин сессия на сервере занимает только стартовый слот.
  3. RPC `create_booking`: опциональные аргументы `p_client_timezone text default ''`, `p_client_utc_offset_min integer default 0` и запись их в `sessions`.
- **Куда:** `schema.sql` → `sessions` + `public_booked_slots` + `create_booking`; `entities.js` → `Session.clientTimeZone / clientUtcOffsetMin / startsAt`; `supabaseSync.pushBooking` прокинуть новые поля.
- **Зачем:** T-03 (показ и конверсия слотов в поясе клиента) и T-02 (серверная занятость с учётом длительности). Клиентский wizard уже пишет пояс в `session.note` и на объект сессии; без колонок это не доедет до кабинета/напоминаний.
- **Миграция:** `alter table ... add column if not exists` с дефолтами; backfill не нужен (`''` / `0` / null). View и RPC — `create or replace`.
- **Приоритет:** обычный (фича записи работает локально без колонок)
- **Пересечение с SR-108:** канонический контракт пояса — этот SR. Агент 3 (T-23) читает `client_timezone` + `client_utc_offset_min`; отдельную колонку `zone_offset_min` не заводить.

### SR-002 — автогенерация Google Meet (T-22)

- **От:** Агент 2 (публичная запись и SEO)
- **Дата:** 2026-09-23
- **Что нужно:**
  1. `session_settings`:
     - `google_oauth_refresh_token text not null default ''` — **приватно**, не в `public_settings`
     - `google_oauth_account_email text not null default ''`
     - `google_calendar_id text not null default 'primary'`
     - `auto_create_meet boolean not null default false`
  2. `sessions` (частично уже есть `meet_link`, `google_event_id`, `video_platform`):
     - `meet_created_at timestamptz`
     - `meet_error text not null default ''` — чтобы кабинет видел сбой автосоздания
- **Куда:** `schema.sql` → `session_settings` + `sessions` (не добавлять токен в public_settings!); `entities.js` → `SessionSettings` + `Session`; Edge Function `gcal-create-event` (новая, verify_jwt=true, только владелец).
- **Зачем:** T-22. Черновик события — `calendarService.meetEventDraft()`. OAuth и секрет — только на сервере. Дизайн flow: `docs/T-22-MEET.md`.
- **Миграция:** новые колонки с дефолтами, backfill не нужен.
- **Приоритет:** можно позже (стретч; не блокирует запись)

## Детали заявок Агента 3 (кабинет и клиенты, задачи T-05…T-24)

### SR-101 — серии сессий (T-05, T-06, T-07)
- **От:** Агент 3 (кабинет/клиенты). **Дата:** 2026-09-23
- **Что нужно:**
  - таблица `session_series`:
    | поле | тип | смысл |
    |------|-----|-------|
    | `id` | text pk | id серии |
    | `psychologist_id` | text not null | владелец |
    | `client_id` | text not null | клиент серии |
    | `service_id` | text | услуга |
    | `weekday` | int not null (1=Пн…7=Вс) | день недели |
    | `slot_time` | text not null ('HH:MM') | время начала |
    | `interval_weeks` | int not null default 1 | 1 / 2 / 4 |
    | `date_from` | date not null | с чего начинать |
    | `date_to` | date | до какого (null = горизонт) |
    | `horizon_weeks` | int not null default 8 | на сколько недель генерировать |
    | `paused` | bool not null default false | пауза |
    | `created_at` | timestamptz default now() | |
  - `sessions.series_id` text — ссылка встречи на серию (для честного «перестить только эту»).
  - RLS как у остальных таблиц кабинета: `owner_all … psychologist_id in (select id from psychologists where owner_id = auth.uid())`.
- **Куда:** `schema.sql`, `entities.js` (`SessionSeries` + `Session.seriesId`), `cabinetApi.js` (push/pull серий и маппинг `series_id`).
- **Зачем:** T-05 (серия на 8 недель = 8 встреч), T-06 (перенос одной встречи / всей серии), T-07 (пауза-возобновление). Без серверной таблицы фича живёт только в localStorage одного браузера.
- **Миграция:** новая таблица + `alter table sessions add column if not exists series_id text;` (существующие строки — null).
- **Приоритет:** обычный — локальный режим уже работает, теряется только кросс-девайс.

### SR-102 — индивидуальные условия клиента (T-09, T-10)
- **От:** Агент 3. **Дата:** 2026-09-23
- **Что нужно:** `clients` добавить `price_override` numeric, `currency` text, `payment_method` text, `meet_link` text, `payment_url` text.
- **Куда:** `schema.sql`, `entities.js` (`Client`), `cabinetApi.js` (`clientRow`/`applyPull` — уже частично читает эти поля, если они есть).
- **Зачем:** T-09 (своя цена/валюта/способ оплаты клиента, авто-подстановка в новые встречи), T-10 (постоянная ссылка на встречу и ссылка оплаты в карточке).
- **Миграция:** `add column if not exists` с null-дефолтами — старые строки остаются «по прайсу», поведение не меняется.
- **Приоритет:** обычный. В сейфе кабинета значения уже хранятся (шифрованно); колонки — для паритета и работы без разблокировки сейфа.

### SR-103 — доступ клиента в мини-кабинет (T-12)
- **От:** Агент 3. **Дата:** 2026-09-23
- **Что нужно:**
  - таблица `client_access_tokens`: `token` text pk, `psychologist_id` text not null, `client_id` text not null, `label` text, `created_at` timestamptz default now(), `expires_at` timestamptz, `revoked_at` timestamptz, `last_used_at` timestamptz. Индекс по `client_id`.
  - RLS: владелец кабинета — полный доступ (`owner_all` по `psychologist_id`); anon — НЕ читает таблицу напрямую.
  - RPC `client_cabinet(p_token text) returns jsonb`, `security definer`, `grant execute to anon`: отдаёт ТОЛЬКО данные этого клиента (имя/псевдоним, ближайшие и последние встречи с временем и ссылкой, материалы, документы, активный запрос) + пояс психолога и его имя для шапки. Обновляет `last_used_at`. Невалидный/истёкший/отозванный токен → `{ok:false, reason}`.
  - RPC `client_cabinet_action(p_token text, p_action text, p_payload jsonb) returns jsonb`, `security definer`, `grant execute to anon`: `propose_time` / `recurring` / `waiting_day` / `material_seen` / `sign_document` — пишет только от имени клиента этого токена.
- **Куда:** `schema.sql`.
- **Зачем:** ядро T-12 — клиент открывает мини-кабинет по секретной ссылке **без регистрации**. Сейчас ссылка работает только в браузере психолога (локальный режим); на устройстве клиента данных нет.
- **Миграция:** новые таблица + функции, существующие данные не трогаются.
- **Приоритет:** **блокер** для кросс-девайс мини-кабинета (T-12/T-13/T-14); остальные задачи делаю локально.

### SR-104 — материалы и домашние задания клиенту (T-13)
- **От:** Агент 3. **Дата:** 2026-09-23
- **Что нужно:** таблица `client_materials`: `id` text pk, `psychologist_id` text not null, `client_id` text not null, `kind` text not null ('text'|'link'|'file'), `title` text not null, `body` text, `url` text, `pinned` bool default false, `created_at` timestamptz default now(), `seen_at` timestamptz, `deleted_at` timestamptz. RLS `owner_all` по `psychologist_id`; для клиента отдаётся через RPC `client_cabinet` (SR-103).
- **Куда:** `schema.sql`; клиентский сервис Агента 3 уже умеет работать и с локальным зеркалом.
- **Зачем:** T-13 — психолог прикрепляет тексты/ссылки/файлы, клиент видит их в мини-кабинете и может отметить «прочитано» (`seen_at`).
- **Миграция:** новая таблица.
- **Приоритет:** обычный.

### SR-105 — запросы клиента из мини-кабинета (T-08, T-12, T-24)
- **От:** Агент 3. **Дата:** 2026-09-23
- **Что нужно:** таблица `client_requests`: `id` text pk, `psychologist_id` text not null, `client_id` text not null, `kind` text not null ('propose_time'|'recurring'|'waiting_day'), `session_id` text, `desired_date` date, `desired_time` text, `weekday` int, `interval_weeks` int, `comment` text, `status` text not null default 'pending' ('pending'|'accepted'|'declined'|'withdrawn'), `created_at` timestamptz default now(), `resolved_at` timestamptz. RLS `owner_all` по `psychologist_id` (психолог читает/меняет), запись — только через RPC `client_cabinet_action` (SR-103).
- **Куда:** `schema.sql`.
- **Зачем:** T-12 «предложить другое время», T-08 «хочу постоянное время» из кабинета клиента, T-24 витрина запросов в кабинете психолога. Позволяет клиенту встать в очередь на конкретный день без звонков.
- **Миграция:** новая таблица.
- **Приоритет:** обычный (в локальном режиме запросы копятся в браузере психолога).

### SR-106 — пожелания в листе ожидания (T-08, T-24)
- **От:** Агент 3 (согласовать с Агентом 2 — его форма записи ставит галочку «хочу постоянное время»). **Дата:** 2026-09-23
- **Что нужно:** `waiting_items` добавить: `desired_date` date, `desired_time` text, `recurring` bool default false, `weekday` int, `interval_weeks` int, `session_id` text, `status` text default 'new' ('new'|'planned'|'done'|'declined'), `updated_at` timestamptz.
- **Куда:** `schema.sql`, `entities.js` (`WaitingItem`), `cabinetApi.js` (`waitingRow`/`applyPull` — сейчас маппит только id/имя/телефон/заметку).
- **Зачем:** T-24 — очередь «кто на какой день», T-08 — заявка «постоянное время» с публичной формы попадает в кабинет как есть, а не теряет поля. Без `interval_weeks`/`weekday` нельзя одной кнопкой собрать серию из заявки.
- **Миграция:** `add column if not exists`, существующие строки — `recurring=false`, `status='new'`.
- **Приоритет:** обычный. Поля нужны обеим сторонам (форма — Агент 2, витрина — Агент 3).

### SR-107 — документы на подпись клиенту (T-14)
- **От:** Агент 3. **Дата:** 2026-09-23
- **Что нужно:** таблица `client_documents`: `id` text pk, `psychologist_id` text not null, `client_id` text not null, `title` text not null, `body` text not null, `kind` text default 'consent', `signed_at` timestamptz, `signature` text (отпечаток токена/подписи), `created_at` timestamptz default now(), `deleted_at` timestamptz. RLS `owner_all`; клиенту — только через RPC `client_cabinet`/`client_cabinet_action`.
- **Куда:** `schema.sql`.
- **Зачем:** T-14 — согласие/договор, клиент открывает и «подписывает» в мини-кабинете (клик + дата + отпечаток токена).
- **Миграция:** новая таблица.
- **Приоритет:** **можно позже** (по брифу T-14 — не приоритет). Локальная версия уже есть.

### SR-108 — часовой пояс клиента во встрече (T-23)
- **От:** Агент 3 (сверить с заявкой Агента 2 по T-03 — не дублировать). **Дата:** 2026-09-23
- **Статус после merge:** **покрыто SR-001.** Канонические поля: `sessions.client_timezone`, `sessions.client_utc_offset_min`, `sessions.starts_at`. Колонку `zone_offset_min` не заводить.
- **Что нужно кабинету:** маппинг тех же полей в `cabinetApi` / T-23 (`timezoneService.sessionZoneHint`). Реализацию DDL делает Агент 1 по SR-001.
- **Куда:** не дублировать DDL; `cabinetApi.js` читает поля SR-001.
- **Зачем:** T-23 — в расписании психолога рядом с временем видно «у клиента 09:00».
- **Приоритет:** обычный — ждёт применения SR-001.

### SR-109 — маппинг новых полей в cabinetApi (T-05…T-24)
- **От:** Агент 3. **Дата:** 2026-09-23
- **Что нужно:** в `cabinetApi.js` (`sessRow`, `clientRow`, `waitingRow`, `applyPull`, push-функции) добавить поля из SR-101/SR-102/SR-106/SR-108: серии, условия клиента, пожелания ожидания, пояс клиента, `sessions.series_id`.
- **Куда:** `js/services/cabinetApi.js`.
- **Зачем:** без маппинга поля есть в БД, но не доезжают до кабинета — фичи будут работать «наполовину».
- **Миграция:** не требуется.
- **Приоритет:** обычный (идёт в одном коммите с SR-101/SR-102/SR-106).

---

### Пример заполненной заявки (образец, выполнена до старта очереди)

```
### SR-000 — журнал критичных ошибок фронтенда
- **От:** Агент 1 (инфраструктура)
- **Дата:** 2026-09-23
- **Что нужно:** таблица client_error_logs (anon insert, без select)
- **Куда:** schema.sql, entities.js (ClientErrorLog), errorLogService.js (новый)
- **Зачем:** базовое логирование фронтенд-ошибок — сейчас только визуальный баннер
- **Миграция:** не требуется (новая таблица)
- **Приоритет:** обычный — СДЕЛАНО (коммит feat: client error reporting)
```

## Как подать заявку, если вы — агент-потребитель

1. Допишите свою SR-XXX в конец этого файла + строку в таблицу «Очередь»
   (это единственный инфраструктурный файл, который можно редактировать всем).
2. Укажите минимальный достаточный контракт (поля/типы/кто читает/кто пишет) —
   Агент 1 сам оформит DDL/RLS в стиле проекта.
3. Если сомневаетесь, нужна ли заявка: правило простое — трогаете ли вы БД,
   сущности или DbContext? Да → заявка. Нет (только свой ViewModel/сервис) → не нужна.
