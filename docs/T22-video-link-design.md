# T-22 · Автогенерация видеоссылки на сессию — дизайн-заметка

> Агент 2 «Публичная запись и SEO», 2026-09-23.
> Статус: **дизайн** (реализация не входила в обязательный объём — полноценная
> генерация требует OAuth-настройки со стороны владельца).

## 1. Что хотим получить

При подтверждении записи на онлайн-сессию (услуга `format = 'online'`) сессия
автоматически получает ссылку на видеовстречу:

- клиент видит ссылку сразу на экране «Заявка принята» и в напоминании;
- специалист видит её в карточке сессии в кабинете;
- никаких ручных действий (сейчас `sessions.meet_link` заполняется вручную).

## 2. Варианты и выбор

| Вариант | Плюсы | Минусы | Оценка |
|---|---|---|---|
| **A. Google Calendar API + OAuth (создать событие, взять `hangoutLink`)** | Meet-ссылка «как у всех», событие сразу в календаре специалиста, привычно клиентам | Нужен OAuth-консент владельца (Google Cloud проект, redirect URI, refresh token), хранение секретов, Edge Function с сервисным аккаунтом/рефрешем | M (2–3 дня) + настройка владельца |
| **B. Jitsi-комната per session (`https://meet.jit.si/psyportal-<sessionId>`)** | Ноль OAuth, работает сразу, бесплатно | Ссылка предсказуемая (нужен случайный суффикс), не в календаре, брендинг Jitsi | S (≈ 0,5 дня) |
| **C. Постоянная ссылка специалиста** | Уже можно (в кабинете) | Одна комната на все сессии, нет изоляции | уже есть |

**Рекомендация:** B — как быстрый путь «уже завтра» (даёт ценность без внешних
зависимостей), A — как целевой (когда владелец настроит OAuth).

## 3. Целевой поток (вариант A)

```
клиент записывается (pending)
        │
        ▼
специалист подтверждает в кабинете  ──►  meetService.ensureLink(sessionId)
        │                                        │
        │                                        ▼
        │                        Edge Function `meet-link` (service role)
        │                                        │
        │              ┌─────────────────────────┴──────────────────────────┐
        │              │ 1) POST /calendars/{calendarId}/events             │
        │              │    (Google Calendar API v3, conferenceDataVersion=1)│
        │              │ 2) из ответа: hangoutLink, event.id                │
        │              │ 3) UPDATE sessions SET meet_link, google_event_id  │
        │              └────────────────────────────────────────────────────┘
        ▼
клиенту в подтверждении/напоминании уходит ссылка
```

### 3.1 Какие поля нужны

| Сущность | Поле | Зачем |
|---|---|---|
| `sessions` | `meet_link` | уже есть (заполняется автоматически) |
| `sessions` | `google_event_id` | уже есть (для повторного использования/обновления события) |
| `sessions` | — | `video_platform` уже есть (`google_meet`) |
| `session_settings` | `google_calendar_id` (новое) | куда класть событие (по умолчанию `primary`) |
| `session_settings` | `google_oauth_refresh_token` (новое, **приватное**) | доступ к Calendar API от имени специалиста |
| `session_settings` | `auto_video_link` (boolean, новое) | включать ли автогенерацию (по умолчанию false) |

> Поля настроек — это изменение схемы: при старте реализации оформляется
> отдельная заявка SR-XXX в `docs/SCHEMA-REQUESTS.md` (сейчас не подана: сама
> реализация T-22 не входила в обязательный объём).

### 3.2 Требуемый OAuth-flow

1. В Google Cloud Console владелец создаёт OAuth-клиент (тип Web application) с
   redirect URI: `https://<pages-домен>/cabinet` (или отдельная страница-колбэк).
2. Кабинет психолога → кнопка «Подключить Google Calendar» → редирект на
   `https://accounts.google.com/o/oauth2/v2/auth` со `scope`:
   `https://www.googleapis.com/auth/calendar.events`
   (узкий scope — только события, не весь календарь), `access_type=offline`,
   `prompt=consent`.
3. Колбэк с `code` → Edge Function `google-oauth` обменивает code на
   `refresh_token` (нужен `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` в секретах
   Supabase) и сохраняет refresh token в `session_settings` **в зашифрованном
   виде** (ключ кабинета — см. `cryptoService`; в покое не должен читаться
   анонимом: колонка должна быть вне `public_settings`).
4. Дальше Edge Function `meet-link` по refresh token получает access token и
   создаёт событие.

**Что требуется от владельца:** проект в Google Cloud, OAuth-клиент, согласие на
хранение refresh token, при необходимости — подтверждение приложения Google
(для `calendar.events` обычно достаточно тестового режима со списком тестировщиков).

### 3.3 Точки интеграции в коде (когда дойдёт до реализации)

- новый сервис `js/services/meetService.js`: `ensureLink(sessionId)`,
  `revokeIfCancelled(sessionId)`;
- вызов при подтверждении сессии (`CabinetViewModel.confirmSession`) и при
  создании онлайн-записи с политикой «оплата = запись»;
- показ ссылки: экран «Заявка принята» (`renderSuccess`), карточка сессии,
  напоминание (Агент 4 — `reminderService` / `telegramService.bookingText`);
- отмена сессии → удаление события Google Calendar по `google_event_id`.

## 4. Быстрый путь (вариант B, полдня)

Шаги: сгенерировать `https://meet.jit.si/psyportal-<slug>-<8 случайных символов>`,
записать в `sessions.meet_link` при подтверждении, показать клиенту. Никаких
секретов и OAuth. Рекомендую сделать первым, если владелец ещё не готов
настраивать Google.

## 5. Что уже готово у смежных агентов

- `sessions.meet_link` и `sessions.google_event_id` есть в схеме (Агент 1);
- в кабинете есть выбор платформы и ручная ссылка (модалка сессии);
- «Добавить в Google Calendar» для клиента уже работает без OAuth —
  ссылка-шаблон (`calendarService.googleAddLink`);
- приватные поля настроек (например, iCal-адрес) уже хранятся вне
  `public_settings` — тем же способом можно спрятать и refresh token.
