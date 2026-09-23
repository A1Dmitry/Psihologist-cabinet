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
