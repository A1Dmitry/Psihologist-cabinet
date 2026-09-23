# Заявки на изменения схемы

Очередь изменений, которые должен интегрировать Агент 1 (или владелец БД). До применения миграции клиентская часть не полагается на новые колонки как на обязательные: публичная запись сохраняет совместимость с текущим контрактом.

## SR-001 — часовой пояс клиента в `sessions`

- **Что:** добавить `client_timezone text` и `client_timezone_offset_min integer` в `sessions`; желательно также вычисляемое/заполняемое сервером `scheduled_at timestamptz` для однозначного момента начала.
- **Зачем:** T-03. Страница записи определяет IANA-зону браузера через `Intl.DateTimeFormat().resolvedOptions().timeZone`, показывает время в зоне клиента и конвертирует его в локальное время специалиста перед созданием записи. Сейчас существующие `session_date/session_time` хранят локальное время специалиста, поэтому факт зоны клиента теряется.
- **Куда:** таблица `public.sessions`; значения должны проходить через `rpc/create_booking` и возвращаться владельцу кабинета. Не публиковать эти поля в `public_booked_slots`.
- **Миграция:**
  ```sql
  alter table public.sessions
    add column if not exists client_timezone text,
    add column if not exists client_timezone_offset_min integer,
    add column if not exists scheduled_at timestamptz;

  alter table public.sessions
    add constraint sessions_client_timezone_offset_check
    check (client_timezone_offset_min is null or client_timezone_offset_min between -840 and 840);
  ```
  При записи `scheduled_at` следует вычислять на сервере из локального слота специалиста и `session_settings.timezone`, а не доверять клиентскому timestamp.
- **Приоритет:** P0 (до включения многозонных записей в проде).
- **Статус:** `pending` — UI-совместимый fallback уже реализован в BookingViewModel, колонку не добавлял.

## SR-002 — T-22, автогенерация Google Meet

- **Что:** для `sessions` нужны `google_event_id text`, `meet_link text`, `meet_link_created_at timestamptz` и, при необходимости, `video_link_status text` (`pending|created|failed`). Первое поле уже есть в текущей модели/схеме; заявку фиксируем как проверку полноты контракта и добавление недостающих полей.
- **Зачем:** автоматически выдавать ссылку Meet после подтверждения записи, не раскрывая OAuth-токены в браузере.
- **Куда:** `public.sessions`; OAuth-настройки и refresh token — в защищённое хранилище Edge Function/Google Secret Manager, не в `session_settings` и не в `localStorage`.
- **Миграция:**
  ```sql
  alter table public.sessions
    add column if not exists meet_link_created_at timestamptz,
    add column if not exists video_link_status text default 'pending';
  ```
- **Flow:** владелец один раз проходит OAuth consent в кабинете; Edge Function хранит refresh token и получает access token. При переходе записи в `confirmed/paid` функция создаёт Google Calendar event с `conferenceData.createRequest`, передаёт `conferenceSolutionKey.type = 'hangoutsMeet'`, сохраняет `google_event_id`/`meet_link` и отправляет уведомление клиенту. Повторные вызовы идемпотентны по `session.id`; отмена записи удаляет/отменяет event. Нужны Google Cloud OAuth client, Calendar API и разрешение `calendar.events`.
- **Приоритет:** P1 / stretch (не блокирует T-01—T-04).
- **Статус:** `design-only` — OAuth/Google Cloud у владельца ещё не настроены, код автосоздания не включался.
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
| SR-001 | 2026-09-23 | Агент 2 (запись/SEO) | Часовой пояс клиента в записи: `sessions.client_timezone`, `sessions.client_utc_offset` (+ снимок `duration_min`) | `schema.sql` → sessions + RPC `create_booking`; `entities.js` → `Session` | обычный | **ожидает Агента 1** |
| SR-002 | 2026-09-23 | Агент 2 (запись/SEO) | RPC `create_booking`: проверка занятости по интервалу (длительность услуги), а не по точному совпадению времени | `schema.sql` → RPC `create_booking` | обычный (до реального трафика) | **ожидает Агента 1** |
| SR-003 | 2026-09-23 | Агент 2 (запись/SEO) | `public_booked_slots`: отдать `duration_min` чужой записи | `schema.sql` → view; `supabaseApi.listBookedSlots`; `BookingViewModel._bookingDurationAt` | обычный | **ожидает Агента 1** |
| SR-101 | 2026-09-23 | Агент 3 (кабинет/клиенты) | таблица `session_series` + `sessions.series_id` | schema.sql, entities.js, cabinetApi.js | обычный (фича работает локально) | ждёт Агента 1 |
| SR-102 | 2026-09-23 | Агент 3 | `clients`: `price_override`, `currency`, `payment_method`, `meet_link`, `payment_url` | schema.sql, entities.js, cabinetApi.js | обычный | ждёт Агента 1 |
| SR-103 | 2026-09-23 | Агент 3 | таблица `client_access_tokens` + публичный RPC `client_cabinet(p_token)` | schema.sql | блокер для кросс-девайс мини-кабинета (T-12) | ждёт Агента 1 |
| SR-104 | 2026-09-23 | Агент 3 | таблица `client_materials` (+ отдача в `client_cabinet`) | schema.sql | обычный (T-13) | ждёт Агента 1 |
| SR-105 | 2026-09-23 | Агент 3 | таблица `client_requests` + RPC `client_cabinet_action(p_token, p_action, p_payload)` | schema.sql | обычный (T-08/T-12/T-24) | ждёт Агента 1 |
| SR-106 | 2026-09-23 | Агент 3 (совместно с Агентом 2 по форме записи) | `waiting_items`: `desired_date`, `desired_time`, `recurring`, `weekday`, `session_id`, `status` | schema.sql, entities.js, cabinetApi.js | обычный (T-08/T-24) | ждёт Агента 1 |
| SR-107 | 2026-09-23 | Агент 3 | таблица `client_documents` (подпись клиента) | schema.sql | можно позже (T-14) | ждёт Агента 1 |
| SR-108 | 2026-09-23 | Агент 3 (синхронизация с T-03 Агента 2) | `sessions.client_timezone` (`zone_offset_min` при необходимости) | schema.sql, entities.js, cabinetApi.js | обычный (T-23) | ждёт Агента 1 + сверки с SR Агента 2 по T-03 |
| SR-109 | 2026-09-23 | Агент 3 | маппинг новых полей в `cabinetApi.mapSession/sessRow/applyPull` (клиенты/сессии/ожидание) | cabinetApi.js | обычный | ждёт Агента 1 |

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
- **От:** Агент 3 (сверить с заявкой Агента 2 по T-03 «часовые пояса в записи» — не дублировать). **Дата:** 2026-09-23
- **Что нужно:** `sessions.client_timezone` text (IANA, например `Europe/Berlin`), опционально `sessions.zone_offset_min` int — смещение на момент встречи, если пояс клиента неизвестен.
- **Куда:** `schema.sql`, `entities.js` (`Session`), `cabinetApi.js` (маппинг).
- **Зачем:** T-23 — в расписании психолога рядом с временем видно «у клиента 09:00», а из мини-кабинета клиента время приходит уже в его поясе. Если Агент 2 тем же полем закрывает T-03 — берём его вариант и просто используем.
- **Миграция:** `alter table sessions add column if not exists client_timezone text;` (null = «пояс кабинета»).
- **Приоритет:** обычный. Синхронизировать с Агентом 2 до реализации его T-03.

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


---

## Заявки Агента 2 «Публичная запись и SEO» (2026-09-23)

### SR-001 — часовой пояс клиента в записи
- **От:** Агент 2 (публичная запись и SEO)
- **Дата:** 2026-09-23
- **Что нужно:**
  - `sessions.client_timezone text null` — IANA-пояс клиента (например `Asia/Tashkent`);
  - `sessions.client_utc_offset smallint null` — смещение в минутах на момент записи (для истории: пояс мог сменить оффсет);
  - желательно вместе с ними `sessions.duration_min smallint null` — снимок длительности услуги на момент записи (сейчас длительность живёт только в `services` и может измениться задним числом).
- **Куда:** `supabase/schema.sql` → `create table sessions` (+ `alter table … add column if not exists`), RPC `create_booking` (новые параметры `p_client_timezone`, `p_client_utc_offset`, `p_duration_min`); `js/models/entities.js` → `Session` (паритет Code First); `js/services/supabaseSync.js` → `pushBooking` (передаёт значения).
- **Зачем:** T-03 «Часовой пояс клиента». Слоты клиенту показываются в его поясе, а в БД пишутся в поясе специалиста; без сохранения пояса клиента специалист не сможет понять, какое время видел клиент, а уведомления (T-15, Агент 4) не смогут корректно подписывать время. **Временное решение уже в коде:** пояс клиента дописывается строкой в `sessions.note` (`Часовой пояс клиента: Asia/Tashkent (UTC+5) — время записи в поясе специалиста: Europe/Minsk.`) — после SR-001 эту строку из note уберу, оставив только поля.
- **Миграция:** `alter table sessions add column if not exists …` — без дефолтов и backfill (null = пояс неизвестен, старые записи читаются как «пояс специалиста»). Идемпотентно, безопасно для существующих строк.
- **Приоритет:** обычный (фича работает и без него, но данные теряются).

### SR-002 — RPC `create_booking`: проверка занятости по интервалу
- **От:** Агент 2 (публичная запись и SEO)
- **Дата:** 2026-09-23
- **Что нужно:** RPC `public.create_booking` должна считать занятость по интервалу, а не по точному совпадению `session_time`:
  - новый интервал: `[p_session_time, p_session_time + duration)`, где `duration` = `services.duration_min` по `p_service_id` (fallback: `session_settings.slot_step_min`, иначе 60);
  - существующая запись: интервал `[session_time, session_time + duration_её_услуги)`;
  - конфликт = пересечение интервалов (`new_start < old_end and old_start < new_end`), плюс существующая проверка по `schedule_blocks` (её тоже хорошо бы перевести на интервалы: сейчас сравнивается только старт слота);
  - текст ошибки — человеческий: «Это время только что заняли — выберите другое».
- **Куда:** `supabase/schema.sql` → `create or replace function public.create_booking(…)` (сигнатуру не менять или добавить параметры в конец с дефолтами, чтобы не ломать уже выданные гранты).
- **Зачем:** T-02 «Слоты по длительности услуги». Клиентская сетка уже закрывает пересечения, а сервер — нет: 90-минутная запись 16:30–18:00 пройдёт серверную проверку даже при занятом 18:00. При одновременной записи двух клиентов это двойная бронь (гонка: оба видят свободный слот, оба звонят RPC).
- **Миграция:** `create or replace function` — идемпотентно; требуется переприменение `schema.sql` в проде (чек-лист `docs/INFRA.md`).
- **Приоритет:** обычный (желательно до приёма реальных записей — это целостность расписания).

### SR-003 — `public_booked_slots`: длительность чужой записи
- **От:** Агент 2 (публичная запись и SEO)
- **Дата:** 2026-09-23
- **Что нужно:** во view `public_booked_slots` добавить колонку `duration_min` — длительность занятой записи (`coalesce(services.duration_min, session_settings.slot_step_min, 60)` по `service_id`).
- **Куда:** `supabase/schema.sql` → view `public_booked_slots`; `js/services/supabaseApi.js` → `listBookedSlots` (добавить `duration_min` в select); `js/viewmodels/BookingViewModel.js` → `_bookingDurationAt` (убрать fallback «считать по шагу сетки»).
- **Зачем:** T-02. Сейчас сервер отдаёт только `session_date`/`session_time`, поэтому длительность чужой записи на клиенте считается по шагу сетки: при шаге 30 мин и чужой 90-минутной записи клиент недооценит занятость и покажет пересекающиеся слоты свободными. Сейчас это компенсируется осторожным fallback, но точность теряется.
- **Миграция:** `create or replace view` + `grant select` (уже есть) — идемпотентно. Данные клиента не раскрываются (в view только дата/время/длительность).
- **Приоритет:** обычный.

### Не заявки (рекомендации Агенту 1, без изменения схемы)
1. **sitemap.xml:** CI генерирует `/psy/{slug}`, но не `/book/{slug}`, хотя Pages отдаёт оба маршрута с HTTP 200. Предлагаю добавить `/book/{slug}` в sitemap (или, наоборот, поставить на `/book/{slug}` canonical → `/psy/{slug}` — тогда в sitemap они не нужны). Сейчас canonical на странице записи — собственный.
2. **Перерисовка после загрузки каталога:** в `loadServerCatalog()`/`enableDemoData()` заменены вызовы `renderPortal()` на `render()` — иначе глубокие ссылки `/psy/{slug}` и `/book/{slug}` после загрузки каталога оставались на экране «не найдено» (исправлено Агентом 2, точечно, с комментарием).
3. **robots/JSON-LD:** на приватных маршрутах (`/cabinet`, `/auth`, `/booking-done`, `/reply`) JSON-LD предыдущей страницы не сбрасывается (с этих страниц SEO не вызывается). Для роботов это не критично (`/cabinet` и `/auth` закрыты robots.txt), но при желании можно вызывать `applyNoIndex()` из их отрисовки.
