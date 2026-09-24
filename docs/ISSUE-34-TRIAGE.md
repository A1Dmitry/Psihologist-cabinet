# ISSUE-34 — карта доказательств (evidence map)

> Назначение: единая карта фактов по аудиту #34, чтобы следующий агент не повторял
> проверки с нуля. Каждое утверждение имеет класс: **FACT** (проверено прямо),
> **LIVE** (воспроизведено в production), **INFERENCE**, **UNKNOWN**.
> Основной отчёт — `docs/ISSUE-34-REPORT.md`.

Дата обновления: 2026-09-24 (UTC).
Проверенный SHA: `4d490d2efb6f5aa88604c2b7e2ae9296dd57785a` (main после PR #32).
Дерево: `git write-tree == HEAD^{tree} == d7ee7ca07a9ff820a35e6fa684cbca6a30fc07e0` — чистое, байт-в-байт.

## Аудиторы

- **A-пакет (предыдущая сессия, АУДИТОР: САМ — тот же конвейер, что Producer PR #32):**
  live-пробы L1–L10 выполнены из другой песочницы с egress, GET-only, 0 записей,
  2026-09-24 ~13:45 UTC. Переданы в миссионном пакете #34. Эта сессия их
  подтвердить не могла (см. E1) и не опровергает.
- **B-пакет (эта сессия, независимый Challenger — отдельный агентный процесс,
  ответвление `arena/01a0d3a7-psihologist-cabinet`; АУДИТОР: ВНЕШНИЙ по отношению
  к Producer PR #32):** все проверки выполнены заново на машине этой сессии.

## E-пакет: среда и границы (B-пакет)

- **E1. Egress.** TLS до `*.supabase.co` и `*.github.io` обрывается на handshake
  (`SSL_ERROR_SYSCALL`, curl exit 35; node fetch ECONNRESET; python
  SSLZeroReturnError). npm registry и GitHub API доступны. **FACT.**
- **E2. Окружение:** node v22.22.3, npm 10.9.8, python 3.11.2, свежий
  `npm install` (embedded-postgres 18.4.0-beta.17, pg 8.23.0). **FACT.**
- **E3. Baseline:** `origin/main` = `4d490d2e` (merge PR #32, 2026-09-24 12:40:18
  UTC) — HEAD не ушёл вперёд, staleness-перегон гейта не требуется. **FACT (git/gh).**

## G-пакет: гейт на main (B-пакет)

- **G1.** `npm run verify` → 22/22 наборов зелёные, exit 0. **FACT.**
- **G2.** `verify_pages.py` против живого `devserver.py :8765` → ALL PASS, exit 0
  (12/12 маршрутов). **FACT.**
- **G3.** Тот же прогон показал ожидаемое поведение SPA smoke каталога
  оффлайн: `[Supabase] catalog load failed` → локальный seed-путь
  (`js/core/dbContext.js _seed()`, `enableDemoData()`). **FACT (код+лог).**

## D1-пакет: независимый аудит D1 (B-пакет; атаки, а не перечитывание отчёта)

- **D1-a. Канон.** Все решения «можно ли записаться» идут через
  `js/domain/availability.js` (`computeBookableSlots`/`isSlotBookable`) —
  потребители: `BookingViewModel.js:352`, `clientCabinetService.js:743`;
  `resolveCandidateDurationMinutes` — ровно 3 точки вызова (VM 230/945, CCS 676-677).
  Второго решателя доступности нет (grep-аудит); `dayWindowEndMinutes` в VM —
  только подпись диапазона (строка 254–263). **FACT.**
- **D1-b. Серверный enforcement.** `public.create_booking` (schema.sql:612) читан
  целиком: формат/прошлое (пояс кабинета), service ownership/active, duration
  только серверная с клампом (0,480], min-notice, max-advance, закрытые дни и особые
  окна (override > услуга > настройки), рабочие дни, окно + grace
  `slot_end+step`, инкремент только для сгенерированной сетки, буферы
  симметричны (блоки жёсткие), advisory lock день (+неделя при week-лимите),
  client_risks, интервальный overlap с длительностями чужих записей,
  дневной/недельный лимиты, anti-spam по created_at, серверная деривация оплаты.
  **FACT (чтение кода).**
- **D1-c. Parity-матрица (атаки мутантами, эта сессия):**
  - форсированный FAIL → `1 FAILED`, exit **1** (негативный контроль честен);
  - мутант engine «grace до фикса» (`windowEndMin = slotEnd`) → ровно
    `P12-REGRESS` FAIL, exit 1;
  - мутант resolver «без клампа» → ровно 2×`P13-REGRESS` FAIL, exit 1.
  Вывод: матрица ловит исторические баги точечно; fail-before-fix
  воспроизведён независимо. **FACT (эксперименты, node v22.22.3).**
- **D1-d. E2E (`tests/booking-e2e.mjs`):** реальный BookingViewModel + реальный
  RPC; подменён только транспорт (PostgREST-форма над embedded PG) —
  задекларировано в шапке файла; PostgREST-слой вне скоупа (см. N3/UNKNOWN).
  **FACT.**
- **D1-e. Документированная граница контракта:** явный `slot_times` НЕ является
  enforcement (SR-D1: «явный список побеждает [инкремент]», матрица P10 пинит
  «10:15 → ok» при сетке 10:00/14:00; availability-db D1.10 пинит «10:07 → ok»
  без инкремента). Прямой RPC может писать на любое время окна. По контракту —
  не дефект; продуктовый вопрос владельцу (см. R-пакет). **FACT+INFERENCE.**

## H-пакет: целостность харнеса (B-пакет) → issue #36

- **H1.** Async-крах ВНЕ цепочки try/catch маскируется: обработчики ставят
  `process.exitCode=1` без провала в `results`; `finishSuite(0)` → `exit(0)`
  затирает его. Воспроизведено на минимальной модели и на копии реального
  parity-набора: `ALL PASS`, **exit 0**. **FACT (сырьё в #36).**
- **H2.** `verify_app.mjs` не имеет красного канала: `IMPORT/LINK ERROR`,
  `BOOT ERROR` только печатаются; всегда exit 0. Воспроизведено: битый импорт →
  печать ошибки, **exit 0**. `js/app.js` целиком импортирует только этот набор.
  **FACT.**
- **H3.** `harness-guard.mjs` покрывает только `tests/*.mjs`; root/tools-наборы
  вне статических инвариантов. **FACT.**
- **H4.** Честные пути проверены: `verify_all` судит по exit-коду дочерних
  процессов (spawn, timeout 300с → 124, signal → не-зелёный); наборы домена/
  UI заканчиваются `process.exit(failed?1:0)`. **FACT.**

## S-пакет: схема и авторизация как данные (B-пакет, embedded PG 18.4, verbatim schema.sql)

- **S1.** После применения: ровно 1 overload `create_booking` (22 параметра);
  `execute` у anon+authenticated; `claim_psychologist_profile`: anon denied,
  authenticated allowed. **FACT (pg_proc, has_function_privilege).**
- **S2.** `schema.sql` идемпотентен: второе применение без ошибок; overload не
  плодится. **FACT.**
- **S3.** RLS-пробы (anon/authenticated/foreign owner):
  anon видит только `is_active` услуги; владелец — все свои; ID-guessing
  неактивной услуги → пусто; `psychologists`/`sessions`/`client_risks`/
  `booking_attempts` для anon закрыты (permission denied); чужой владелец не
  видит чужие sessions; anon не пишет services. **FACT (10/10 PASS).**
- **S4.** Публичные view: `public_profiles` без email/key_verifier/owner_id;
  `public_booked_slots` без client_id/оплат/статусов. Дефолтные security-definer
  view намеренны (каталог); `public_profiles` отдаёт и неактивные профили —
  UI каталога фильтрует `is_active=eq.true` (`supabaseApi.listPsychologists`);
  API-потребитель видит всех (см. R-пакет). **FACT.**

## P-пакет: #21 (payment authority) (B-пакет)

- **P-1. Fixed in repo:** клиентские `p_status/p_amount_*/p_payment_*/p_duration_min`
  игнорируются сервером (P17/E3/security-regression T02/T04). **FACT.**
- **P-2. Fixed in repo:** просроченный hold не держит слот
  (`hold_expires_at > now()` в overlap/лимитах; T05: бронь поверх expired hold
  проходит). Серверной джобы, переключающей статус `held→expired`, нет —
  статус остаётся `held` навечно (поведение слотов корректно). **FACT.**
- **P-3. NOT fixed (repo):** «оплата на сайте» по-прежнему local-only:
  `paymentService.paySession`/`completePayment` пишут в localStorage-мirror и
  шлют Telegram «Оплата прошла (сайт)» **без серверной записи** (pushPayment
  отсутствует; таблица `payments` в схеме есть). Успех-показ без серверного
  факта — исходный дефект #21 п.4 жив. **FACT (чтение кода).**
- **P-4. Production-часть: UNKNOWN** (нет egress + prod-записи только с
  разрешения владельца).

## L-пакет: live production (смешанные источники)

- **L1/L2/L5/L6–L10 (A-пакет, GET-only, ~13:45 UTC):** PostgREST жив; cabinet
  таблицы закрыты для anon (42501); публичные view живы и наполнены; 5 услуг
  `is_active:true`; GoTrue v2.197.0 жив; страница отдаётся, каталог 13+.
  **LIVE (метка: предыдущая сессия; эта — не подтверждает, не опровергает).**
- **L3/L4 (A-пакет):** `functions/v1/auth-code` и `functions/v1/telegram-notify`
  → `NOT_FOUND`. **LIVE (та же метка) → issue #35.**
- **L-CI (B-пакет):** все прогоны `supabase-deploy.yml` = success через
  skip-шаг; `Deploy functions` всегда `skipped` (последний run 35990183772,
  gh api 2026-09-24). **FACT** — подтверждает: CI функции не деплоил.
- **L5′ (B-пакет):** все live-пробы этой сессии = UNKNOWN (E1).

## N-пакет: открытые production-проверки (передать дальше)

- **N1 (R2/TASK 3):** `POST /rest/v1/rpc/create_booking {}` с ключом → ожидать
  400 missing-params; без ключа → key-error; PGRST203/2xx-запись = новый P1.
  PostgREST-разрешение overload не проверено нигде (локальные наборы смотрят
  plpgsql, не HTTP). **BLOCKED (E1).**
- **N2 (R3/TASK 4):** OTP request/verify + регистрация→сессия→кабинет.
  Требует prod-записей → только с разрешения владельца. **BLOCKED (E1+разрешение).**
- **N3 (R4/TASK 6-live):** JWT-негативы в проде (owner/cross-tenant/enum).
  Repo-часть доказана S-пакетом. **BLOCKED (E1+тестовый пользователь).**
- **N4:** повтор L3/L4 после деплоя (приёмка #35).

## R-пакет: остаточные риски / вопросы владельцу (не блокеры)

- **R-a.** Явный slot_times без membership-enforcement (D1-e): владелец решает,
  является ли список только UI-сеткой.
- **R-b.** `public_profiles` анонимно отдаёт неактивные профили (S4) — UX-контур
  фильтрует; API-контур — вопрос ожиданий приватности «скрытого» кабинета.
- **R-c.** P3-пробы parity имеют минутный запас (±60с) по документированной
  границе clock-чтений; теоретическая flaky-полоса <0.1% суток.
- **R-d.** Гейт только локальный (CI в репозитории нет; рекомендация из
  D1-REPORT R5 актуальна).
- **R-e.** Teardown-шум 57P01 фильтруется по regex в 6 наборах — при смене
  текста драйвера фильтр споткнётся (низкая вероятность).
