# Отчёт Агента 2 — «Публичная запись и SEO»

> Дата: 2026-09-23. Ветка: `arena/01a0cdd8-psihologist-cabinet`.
> Следующий: Агент 3 «Кабинет и клиенты».

## T-01 · Многошаговый wizard записи — сделано

Форма `/book/{slug}` разбита на шаги **Услуга → Время → Контакт**:
- индикатор прогресса (`#book-progress`) с переходом на пройденные шаги;
- «Далее» / «Назад» не затирают никнейм, телефон, контакт, заметку;
- валидация на шаге (услуга / время) с возвратом на нужный шаг при submit.

Старые ссылки:
- `?book={slug}` и `/psy/{slug}#book` по-прежнему открывают запись (роутер);
- `?service={id}`, `?step=time|contact`, `#slots` попадают на нужный шаг (`BookingViewModel.applyDeepLink`).

Файлы: `index.html#page-booking`, `js/viewmodels/BookingViewModel.js`, обвязка `renderBooking` в `js/app.js`.

## T-02 · Слоты по длительности услуги — сделано

`BookingViewModel.slots` и `freeCountInRange` учитывают `service.duration`:
- конец окна из `workHours` («… 10:00–19:00») или `slotEnd + slotStepMin`;
- слот закрыт, если `[start, start+duration)` вылезает за конец окна или пересекает занятость/блок;
- 90 мин в 18:00 при конце дня 19:00 — недоступен (проверено скриптом, см. ниже).

Серверная `public_booked_slots` пока без `duration_min` — для live-БД 90-мин чужая запись занимает только старт. Это **SR-001**. Локальный/демо-контур берёт duration услуги сессии.

## T-03 · Часовой пояс клиента — сделано (колонка — заявка)

- пояс: `Intl.DateTimeFormat().resolvedOptions().timeZone`;
- подпись `#book-tz-label` «Время в вашем поясе: …»;
- сетка остаётся в поясе специалиста, подписи конвертируются (`convertPsySlotToClient`);
- в заявке пишется `Пояс клиента: Area/City (UTC±HH:MM)` в `session.note` + поля на объекте сессии.

Колонки `sessions.client_timezone` / `client_utc_offset_min` / `starts_at` **не добавлялись** — **SR-001**, статус «очередь».

Домен для canonical/OG: `seoService.SITE_ORIGIN` (пусто = `location.origin`). Не зашит github.io.

## T-04 · «Выберите услугу — сразу окна» — сделано

Клик по услуге на `/book/{slug}` (`selectService(..., { revealSlots: true })`) переключает на шаг «Время» и скроллит к `#book-step-time`. На профиле услуга — ссылка `/book/{slug}?service=id`.

## T-22 · Автогенерация Meet — дизайн, не блокер

- `calendarService.meetEventDraft()` — тело Calendar API insert + Meet.
- Документ `docs/T-22-MEET.md` (OAuth flow, поля, что нельзя светить на клиенте).
- **SR-002** (можно позже): refresh_token в `session_settings`, `meet_created_at`/`meet_error` на сессии.

Реализовывать API без Google Cloud проекта владельца нельзя — задача по брифу считается выполненной.

## SR-заявки

| ID | Суть | Приоритет | Статус |
|----|------|-----------|--------|
| SR-001 | пояс клиента + duration_min в public_booked_slots + RPC | обычный | очередь |
| SR-002 | OAuth Google / auto Meet | можно позже | очередь |

## Ручные проверки

1. Node-скрипт слотов: 60 мин @ 18:00 — свободно; 90 мин @ 18:00 при конце 19:00 — `duration`; пересечение с 11:00/60 — 10:00/90 закрыт.
2. `python3 verify_pages.py` против `devserver.py` (порт 8765) — без регрессий маршрутов.
3. Демо-контур: wizard вперёд/назад, клик по услуге скроллит к окнам, подпись пояса видна.

## Merge с `main` (Агенты 1 и 3)

- Конфликт только в `docs/SCHEMA-REQUESTS.md`: оставлены SR-001/002 (Агент 2) и SR-101…109 (Агент 3); нумерация по диапазонам. **SR-108 покрыт SR-001** (`client_timezone` + `client_utc_offset_min` + `starts_at`, без `zone_offset_min`).
- Wizard / слоты / TZ записи сохранены. `timezoneService` Агента 3 — канон конвертации; `calendarService` делегирует T-03 туда.
- Клик по услуге на профиле снова передаёт `service` в `navigate('booking')`.
- Галочка «хочу постоянное время» (T-08 / SR-106) пишет лист ожидания + `clientCabinetService.setWaitingPref` без правок schema/entities.

## Зона

Изменены: `BookingViewModel.js`, `calendarService.js`, `seoService.js`, `psyMapper.js`, блоки `#page-booking`/`#page-profile` в `index.html`, обвязка записи в `js/app.js`, `docs/SCHEMA-REQUESTS.md`, этот отчёт, `docs/T-22-MEET.md`.
Не трогались: schema.sql, entities.js, dbContext.js, workflows, CabinetViewModel, telegram/payment/reminder, verify_*.
