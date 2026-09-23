# T-22 · Автогенерация ссылки Google Meet

Статус: **дизайн готов, реализация за владельцем (OAuth)**. Клиентская запись (T-01…T-04) от этого не зависит.

Сейчас: кнопка «Добавить в Google Calendar» (`calendarService.googleAddLink`) и односторонний iCal → блокировки. `sessions.meet_link` и `sessions.google_event_id` уже есть, заполняются вручную в кабинете.

Полноценный Meet через Calendar API требует Google Cloud проект и OAuth психолога — это вне контроля агента.

## Что уже в коде

- `calendarService.meetEventDraft({ title, date, time, durationMin, timezone, attendees })` — тело `POST .../calendars/primary/events?conferenceDataVersion=1` с `conferenceData.createRequest`.
- Заявка **SR-002**: refresh-token и флаги в `session_settings` (не публиковать!), `meet_created_at` / `meet_error` на сессии.

## Рекомендуемый flow

```
Кабинет → «Подключить Google Calendar»
  → Edge Function gcal-oauth-start  (verify_jwt=true)
  → Google consent: calendar.events + calendar.events.freebusy
  → callback сохраняет refresh_token в session_settings (RLS-владелец)

Публичная запись / подтверждение сессии
  → Edge Function gcal-create-event
     вход: session_id (владелец или security definer после create_booking)
     читает refresh_token, делает events.insert + conferenceDataVersion=1
     пишет sessions.meet_link, google_event_id, meet_created_at
     при ошибке — sessions.meet_error, кабинет показывает «создать вручную»

Клиенту
  → meet_link в письме/Telegram (Агент 4, T-15) и в кнопке «Добавить в календарь»
```

## Поля (контракт)

| Где | Поле | Зачем |
|-----|------|--------|
| session_settings | google_oauth_refresh_token | секрет, только владелец/Edge |
| session_settings | google_oauth_account_email | подпись «подключено как …» |
| session_settings | google_calendar_id | default `primary` |
| session_settings | auto_create_meet | выключатель в кабинете |
| sessions | meet_link, google_event_id | уже есть |
| sessions | meet_created_at, meet_error | диагностика |

Альтернатива без Google: Jitsi-комната `https://meet.jit.si/{sessionId}` — не требует OAuth, можно включить как fallback, если `auto_create_meet` и нет токена. Продуктовое решение — за владельцем.

## Что не делать в клиентском JS

Не хранить OAuth client secret, не звать Calendar API с anon-ключа, не класть refresh_token в `public_settings`.
