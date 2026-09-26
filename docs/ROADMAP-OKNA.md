# Роадмап: сжатие функционального разрыва с ОКОН (okna.one)

Цель этого документа — не просто перечислить функции, а организовать работы **по зависимостям**, чтобы параллельные работы не конфликтовали, не создавали вторые реализации одного домена и не опережали серверные инварианты.

> **Статус сверки (issue #50, 2026-09-26, main @ `9171cc1`):** статусы ниже
> проверены против текущего кода/`schema.sql` (grep + `npm run verify` на `9171cc1`;
> детали — `docs/ISSUE-50-REPORT.md`, `docs/ISSUE-64-REPORT.md`, `docs/MAIN-AUDIT-64.md`). Сверка #19 (2026-09-24, `87e3951`) закрыла
> свой scope, но её verification gate не был выполнен до закрытия — post-facto
> gate выполняется этой сверкой. **Канон входа специалиста — Google OAuth через
> Supabase Auth** (решение владельца 2026-09-25, #88); Email/OTP/`auth-code`
> для психолога CANCELLED и не восстанавливаются.
> Production-статус любого ✅ не означает production deployment — production
> только по фактическому evidence (`docs/INFRA.md`, `docs/CURRENT-STATE.md`).

> **Правило:** порядок ниже — dependency order, а не порядок номеров T-01…T-26.
> Реализация каждой существенной задачи: **Producer → Challenger → Merge → Main Re-Audit**.
> P0/P1 дефект останавливает затронутый контур до устранения или явного containment.

## 1. Что уже есть

| Возможность | Состояние |
|---|---|
| Публичная запись `/book/{slug}` | ✅ |
| Service → availability | ✅ |
| Duration-aware slots | ✅ T-02 |
| Client timezone | ✅ T-03 |
| Booking wizard | ✅ T-01 |
| Service → windows | ✅ T-04 |
| Public free/busy | ✅ |
| Google Calendar iCal groundwork | ✅ |
| Payment policy groundwork | ✅ server authority в main (PR #25; #21 закрыта 2026-09-25 — repo-часть + demo-pay honesty PR #56; production-гейт `create_booking`/anon отдельно) |
| Client reply token | ✅ / расширяется T-12 (мини-кабинет клиента: .ics «В календарь» ✅ #65) |
| Telegram psychologist notifications | ✅ T-16 (код; production-деплой `telegram-notify` — #35, LEAVE OPEN до не-404 ответа endpoint) |
| Клиентский .ics «В календарь» (Apple/Outlook) | ✅ #65 (PR #73/#75; `tests/ics-event.mjs`) |
| Вход специалиста Google OAuth | ✅ repo (#88, PR #89); production-активация — #40 |
| Consent checkbox | ✅ T-25: факт + `consent_at` на сервере (`clients`, `booking_attempts`, PR #9); версия текста — #29 |
| Waitlist storage | ⚠️ T-24 |
| Client portal | ⚠️ T-12 |
| Real client email delivery | ⬜ T-15 |
| Calendar event lifecycle | ⬜ D4 |
| Server booking policy engine | ✅ D1 в main (PR #32 + recovery #33; parity-матрица + E2E) |

## 2. Обязательный порядок выполнения

### PHASE 0 — Process / Quality Gate

**0. #15 — Toyota Quality Gate — ✅ формализован (PR #17; канон — `docs/RULES.md` §6)**

Общий процесс для всех следующих работ (сокращённая запись цикла; единый
канон — `docs/RULES.md` §6, входная точка `AGENTS.md`):

`MAIN → AUDIT → DEFECT/REQUIREMENT → ISSUE → PRODUCER → TESTS → CHALLENGER → MERGE → MAIN RE-AUDIT → STANDARDIZE`

Не считать зелёный CI, merge или Producer report доказательством production readiness.

### PHASE 1 — Production / Security Foundation

**0. TASK-P0-SUPABASE-PORTAL — безопасный портал психологов — P0 / НАИВЫСШИЙ ПРИОРИТЕТ**

Канон задачи и статус: [`docs/TASK-P0-SUPABASE-PORTAL.md`](TASK-P0-SUPABASE-PORTAL.md)
(сохранена 2026-09-24 по решению владельца, реализация не начата; параметры
раздела 4 по-прежнему не получены). Охватывает и поглощает цели #18/#23 в части
email-redirect, одноразовой привязки и RLS-изоляции:
`app_url + callback → подтверждение email → серверная привязка по коду →
owner_id = auth.uid() → только свои данные`. **Коррекция 2026-09-25 (канон #88):**
login-часть (email-подтверждение/код) пересмотрена — единственный вход специалиста
через Google OAuth; RLS-изоляция и неполученные параметры раздела 4 остаются
нерешёнными. Ниже идущие #21/#22 не переопределяют этот контракт
(`docs/RULES.md` §6.14 — один источник истины).

**1. #18 — Production Auth / Registration E2E — P0 — ✅ ЗАКРЫТА (2026-09-25)**

Преемник production-очереди — #46 (закрыта владельцем 2026-09-25, «historical»);
production-остаток текущего канона — **#40** (Google-вход: provider/миграция/E2E)
и **#35** (`telegram-notify` deploy). Реальный production E2E не проводился.

**2. #21 — Server-authoritative Booking — P1 — ✅ ЗАКРЫТА (2026-09-25)**

`create_booking` деривирует оплату/длительность/hold серверно, anti-spam по
`created_at`; п.4 (demo-pay honesty) закрыт PR #56. Production-гейт
(`create_booking` для anon — PGRST202 на срезе 2026-09-25) учтён в
`docs/CURRENT-STATE.md` и не даёт production-ready.

**3. #22 — Tenant Isolation / Anti-spam — P1 — ✅ ЗАКРЫТА (2026-09-25)**

`client_risks` без политик для `anon`/`authenticated` (только
`service_role`/security definer), `booking_attempts` tenant-scoped;
LIVE-срез 2026-09-25 подтверждает запрет anon на `client_risks`.

#18, #21 и #22 могли выполняться параллельно **только если они не изменяли один и
тот же участок schema/RPC без координации**. Перед следующим phase обязателен Main Re-Audit.

**4. #19 — Current-State Documentation — ✅ ЗАКРЫТА (2026-09-25), verification gate — post-facto #50**

Документационная часть выполнена на main @ `87e3951` (`docs/ISSUE-19-REPORT.md`);
закрыта **без** Challenger + Main Re-Audit вопреки собственному отчёту (§11) —
верификационный gate этой сверки выполняется issue #50 (настоящая сверка,
`docs/ISSUE-50-REPORT.md`). Kaizen-кандидат #19 §8 (ресинк CURRENT-STATE как
артефакт Main Re-Audit) — решение сопровождающего, зафиксировано в #50.

### PHASE 2 — Existing Booking Foundation

Уже реализовано, не перерабатывать без доказанного дефекта:

**5. T-01 — Wizard** ✅
**6. T-02 — Duration-aware slots** ✅
**7. T-03 — Client timezone** ✅
**8. T-04 — Service → windows** ✅

Эти задачи образуют базовый контракт:

`Service → Duration → Schedule → Timezone → Candidate Slots`

### PHASE 3 — Canonical Availability + Booking Policy Engine

**9. #31 / D1 — Availability + Booking Policy Engine — P1 — ✅ в main (2026-09-24)**

Статус: реализовано PR #32 (+ recovery #33): канонический клиентский engine
`js/domain/availability.js`, серверный близнец в `create_booking` (min-notice,
max-advance, буферы, increment, service availability, `schedule_overrides`,
дневные/недельные лимиты), SR-D1 в `schema.sql`; регрессия —
`tests/availability-policy.mjs`, `tests/availability-db.mjs`,
`tests/availability-parity.mjs`, `tests/booking-e2e.mjs`.
Production: схема SR-D1 применена владельцем 2026-09-25 (LIVE-срез); остаток —
`create_booking` для anon (PGRST202) → публичная запись в production не работает.

Канонический контракт:

`Service + BookingPolicy + Schedule + BusySources → CandidateSlots → PolicyFilter → BookableSlots`

Policy включает minimum scheduling notice, maximum booking horizon, buffer before/after, slot increment, service-specific availability, date overrides, holidays/exceptions и optional daily/weekly limits.

**Один engine** используется для public booking, psychologist calendar, reschedule, recurring sessions, waitlist и catalog availability.

Запрещено создавать UI-only или второй availability calculator.

### PHASE 4 — Booking Policy / Series

**10. #31 / D5 — Server-enforced Cancellation / Reschedule Policy — P1**

Контракт:

`BookingPolicy + BookingState + CurrentTime + Actor → AllowedAction`

До реализации переноса серии должны существовать серверные правила cancellation deadline, reschedule deadline, late cancellation, no-show, deposit retention/refund, client/psychologist permissions и explicit override + audit.

**11. T-05 — Session Series Model — P1**
Зависит от D1.

**12. T-06 — Move One Session / Whole Series — P1**
Зависит от T-05 + D1 + D5.

**13. T-07 — Pause / Resume Series — P1**
Зависит от T-05.

**14. T-08 — Client Recurring Request — P1/P2**
Зависит от T-05 и waitlist foundation.

Dependency: `D1 → D5 → T-05 → T-06`

### PHASE 5 — Waitlist

**15. T-24 — Waitlist Base / Specific Day — P1**

Довести существующий `waiting_items` до базового запроса клиента.

**16. #31 / D2 — Waitlist Matching + Exclusive Claim — P1**

Граф:

`released slot → match → notify → exclusive hold → claim/release → booking`

D2 обязан использовать D1.

Нужны preferred service/date/day/time, timezone, notification preference, recurring preference, automatic matching, exclusive hold, timeout, anti-race и audit.

Dependency: `D1 → T-24 → D2`

### PHASE 6 — Client Portal / Client Data

**17. T-12 — Client Portal — P1**

После #18, #21, D1 и D5. Портал должен использовать существующие серверные booking rules, а не создавать свои.

**18. T-10 — Permanent Client Links — P1**
После T-12.

**19. T-13 — Materials / Homework — P1**
После T-12.

**20. T-25 — Consent Persistence — P1**

Сохранение факта согласия с версией текста и временем.

**21. #31 / D3 — Configurable Intake / Forms — P1/P2**

После базового portal/consent boundary. Lifecycle: `not_started → incomplete → submitted`.

Intake отдельно от consent. Это сбор данных, не диагностика.

### PHASE 7 — Notifications

**22. T-15 — Real Client Delivery — P1**

Только после authoritative booking lifecycle:

`authoritative event → notification event → delivery`

Не показывать success до подтверждения критической серверной операции.

**23. T-16 — Psychologist Telegram — DONE (код)**

Не переделывать без дефекта. Production-деплой функции `telegram-notify` — #35
(после коррекции владельца #35 покрывает **только** telegram-notify; LEAVE OPEN
до не-404 ответа endpoint).

**24. T-19 — Payment Links in Notifications — P1/P2**

Зависит от T-15 и authoritative payment data.

### PHASE 8 — Calendar Lifecycle

**25. T-23 — Psychologist Timezone Scheduling — P1**

Зависит от T-03 и D1.

**26. #31 / D4 — Calendar Event Lifecycle — P1/P2**

Канонический граф:

`Authoritative Booking → Calendar Artifact → Sync/Retry → Client/Provider Calendar`

Требования: stable external event ID, create/update/cancel, .ics/provider invite, timezone correctness, idempotency, retry/reconciliation и `pending/synced/failed/retry`.

Не создавать отдельный booking state вне authoritative booking.

**27. T-22 — Auto Video Link — P2**

После D4. Google Meet/Jitsi link является артефактом session/calendar lifecycle, а не вторым booking engine.

### PHASE 9 — Payments

**28. T-09 — Per-client Price / Currency / Payment Method — P1**

Сначала персональная policy.

**29. T-17 — Payment Webhook / Authoritative Payment Status — P1**

`Provider → Webhook → Server → sessions.payment_status`

Зависит от #21.

**30. T-11 — Payment History UI — P2**

После authoritative payment events.

**31. T-18 — Stripe/PayPal — LATER**

Не блокирует текущий bePaid flow.

### PHASE 10 — Secondary Product Features

**32. T-14 — Documents / Signature — P2**
После portal + consent.

**33. T-20 — Analytics — P2**
Только после стабилизации authoritative sessions/payments/booking events.

**34. T-26 — Catalog Availability Strip — P1/P2**
Только consumer D1 Availability Engine. Никакого собственного расчёта availability.

**35. T-21 — PWA — P2**
Независимая инфраструктурная задача; не должна блокировать booking domain.

## 3. Dependency Graph

(✅ — узел закрыт; production-нога теперь — #35 telegram-notify + #40 Google-вход;
канон входа — Google OAuth, #88)

`#15` ✅
` ↓`
`#18` ✅ `+ #21` ✅ `+ #22` ✅
` ↓`
`#19` ✅ (verification gate post-facto — #50)
` ↓`
`T-01/T-02/T-03/T-04`
` ↓`
`D1 Availability Engine`
` ├──→ D5 Policy`
` │     └──→ T-06`
` ├──→ T-05 Series`
` │     ├──→ T-06`
` │     ├──→ T-07`
` │     └──→ T-08`
` ├──→ T-24`
` │     └──→ D2 Waitlist`
` ├──→ T-12 Portal`
` │     ├──→ T-10`
` │     └──→ T-13`
` ├──→ T-23`
` │     └──→ D4 Calendar`
` │            └──→ T-22`
` └──→ T-26`

Параллельные ветки после соответствующих prerequisites:

`T-25 → D3 Intake`
`#21 → T-17 → T-11`
`T-15 → T-19`

## 4. Правила параллельной работы — защита от конфликтов

### Правило 1 — один domain owner

Не допускается одновременная независимая реализация двух availability engines, booking policy calculators, waitlist mechanisms, notification pipelines, payment state machines или calendar booking states.

### Правило 2 — schema/RPC lock

Если задача меняет один и тот же `supabase/schema.sql`, RPC, RLS, Edge Function или domain service, она не выполняется параллельно с другой задачей, меняющей тот же контракт.

Сначала merge одной → Main Re-Audit → следующая.

### Правило 3 — UI не опережает domain contract

UI может готовиться параллельно только если он не создаёт собственную бизнес-логику.

Правильно: `UI → canonical service/domain API`

Неправильно: `UI calculator ≠ server calculator`

### Правило 4 — зависимость блокирует downstream

Если D1 меняет availability contract, T-05/T-06/D2/T-26 не должны одновременно создавать старую модель availability.

### Правило 5 — Producer + Challenger

Для каждого P0/P1:

`Producer → tests/evidence → Challenger → merge → Main Re-Audit`

Challenger обязан искать обход исходного инварианта, а не только запускать те же тесты.

### Правило 6 — production evidence отдельно

Local/PostgreSQL/CI ≠ production. Production-ready только после фактического production evidence.

### Правило 7 — после каждого merge

Проверить исходный дефект/требование, соседние сценарии, отсутствие дублирования, актуальный main SHA и состояние зависимых задач.

## 5. Definition of Done

Работа не считается завершённой только потому, что код написан, тесты зелёные, PR merged или Producer сказал DONE.

Для P0/P1 необходимы: implementation, regression tests, Challenger, проверка исходного сценария, Main Re-Audit, проверка DRY/DDD/SOLID, проверка отсутствия второго domain implementation и production evidence для production-critical функций.

## 6. Отложено

- T-18 Stripe/PayPal — позже;
- multi-provider routing из #30 — future;
- собственная видеоплатформа — не делать;
- автоматическая диагностика/терапевтические решения — не делать.

## 7. Ключевой принцип

**Номер задачи не определяет порядок. Зависимость определяет порядок.**

D1 (единый Availability + Booking Policy Engine) — **реализован в main**
(PR #32 + recovery #33, 2026-09-24). Следующие архитектурные узлы по
dependency order: **D5** (server-enforced cancellation/reschedule policy) и
**D2** (waitlist matching + exclusive claim); production-нога остаётся блокером:
**#35** (`telegram-notify` deploy, LEAVE OPEN до не-404) и **#40** (активация
Google-входа + production E2E; канон — #88) держат production-ready закрытым
до фактического production evidence.

Все остальные booking-capabilities должны потреблять D1, а не реализовывать собственную копию.