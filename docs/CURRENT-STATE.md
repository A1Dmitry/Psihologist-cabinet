# CURRENT-STATE — canonical current-state (audited)

> Единственный current-state source of truth по issue #19. Все остальные
> документы описывают снимки прошлых циклов (см. раздел «Исторические
> документы»). Конфликт с этим файлом решается в пользу настоящего файла
> до новой аудированной правки.
>
> **АУДИТОР: САМ** (сессия исполнения #19, Producer + self-check, 2026-09-24 UTC).
> Независимый Challenger по этому документационному циклу и Main Re-Audit —
> **OPEN** (следующий независимый агент; см. `docs/ISSUE-19-REPORT.md`).

## Main SHA

- **Актуальный `main` (origin/main):** `87e3951241fd18f2cc24afa2b6502247a7fee73b`
  (merge PR #37, 2026-09-24 14:25 UTC). Рабочая копия чистая:
  `HEAD == origin/main`, `git status` — без локальных изменений.
- **Проверено в этой сессии:** `git rev-parse HEAD origin/main` (оба = `87e3951`),
  `npm run verify` → **22/22 набора зелёные, exit 0**,
  `verify_pages.py` против живого `devserver.py :8765` → **ALL PASS (12/12 маршрутов)**.

## Фактически merged изменения (по PR, до `87e3951` включительно)

| PR | Дата | Что вошло в main |
|----|------|------------------|
| #20 | 2026-09-24 | fix(auth): пароль сейфа применяется к сейфу, `key_verifier` синхронизируется с сервером (issue #14, challenger-находки) |
| #24 | 2026-09-24 | docs: evidence `otp_expired` + localhost URL (issue #23) |
| #25 | 2026-09-24 | **fix: server-authoritative booking** — `create_booking` не принимает клиентские `p_status`/`p_payment_*`/`p_amount_*`/`p_duration_min`; серверная деривация оплаты, `hold_expires_at`; **tenant isolation** — `client_risks` только `service_role`/security definer; **anti-spam по `created_at`** (не `session_date`); **domain validation** — дата/время/прошлое/service ownership/schedule (issues #21, #22, #23) |
| #26 | 2026-09-24 | docs: Toyota Quality Gate final report + синхронизация CURRENT-STATE (тогдашний main `8d64d94`) |
| #32 | 2026-09-24 | **D1: Availability + Booking Policy Engine** (issue #31/D1): `js/domain/availability.js` — канонический engine; серверный близнец в `create_booking` (min-notice, max-advance, буферы, slot-increment, service availability, `schedule_overrides`, дневные/недельные лимиты, advisory lock); SR-D1 в `schema.sql`; recovery (issue #33): grace `end ≤ slot_end + шаг`, кламп длительности (0,480], parity-матрица, E2E, harness-guard |
| #37 | 2026-09-24 | docs(issue-34): независимый Challenger-аудит main @ `4d490d2e` — отчёт + карта доказательств (только документы; код не менялся) |

## Production: что доведено (честно)

**Ничего не подтверждено production-контуром из этой сессии.**

- Из песочницы нет egress до `*.supabase.co` / `*.github.io` (доказано в #34, E1:
  TLS-обрыв на handshake; в этой сессии не повторялось, но сетевая конфигурация
  не менялась). Live-пробы «A-пакета» предыдущей сессии остаются **заявленными**
  (AUDITOR: САМ того конвейера), не подтверждёнными.
- **Production schema: UNKNOWN.** В репозитории `supabase/schema.sql` содержит
  SR-001…SR-004, SR-108, SR-D1 и фиксы #21/#22 — владелец обязан **переприменить
  файл целиком** в SQL Editor (чек-лист `docs/INFRA.md`, п.2). Факт применения
  не проверен.
- **Edge Functions `auth-code` / `telegram-notify` в проде: не задеплоены**
  (CI `supabase-deploy.yml` — `deploy=skipped` во всех прогонах: нет
  `SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_ID`; issue #35, P1).
- **Resend/APP_URL/Auth Site URL: UNKNOWN** (блокеры на владельце, `docs/INFRA.md`
  п.6–7b; issue #18).

## Только локально верифицировано (этой сессией, main @ `87e3951`)

- `npm run verify` → 22/22 (домены, D1 engine/parity/E2E/cabinet-policy, wizard,
  регистрация, auth-code edge, SQL-контракт на встроенном PostgreSQL 18.4,
  security-regression, harness-guard, кабинет, UI, роутер, Tailwind, SPA).
- `verify_pages.py` → ALL PASS против живого `devserver.py :8765` (12/12).
- Схема применяется вербатим к настоящему PostgreSQL (идемпотентно, через
  `tests/db-contract.mjs` / `tests/availability-db.mjs`).
- `create_booking` читан целиком: серверная деривация оплаты/длительности/hold,
  anti-spam по `created_at`, D1-политика — как в main (совпадает с выводами
  независимого аудита #34, TASK 2/8).

## Открытые issue (P0/P1/P2), по состоянию 2026-09-24

| Issue | Приоритет | Статус по фактам |
|-------|-----------|------------------|
| #18 | P0 | Production activation + real registration E2E — **ЗАБЛОКИРОВАНО доступами владельца** (секреты, deploy функций, re-apply schema, Resend). Кодовая часть готова |
| #35 | P1 | Edge Functions не задеплоены (child of #34) — **ЗАБЛОКИРОВАНО владельцем** (CI secrets) |
| #33 | P1 | PR32 Recovery — локальные гейты закрыты (recovery + parity-матрица + E2E + harness-guard; независимый Challenger #34 выполнен по repo-части), **Main Re-Audit production не выполнен**; Stop-the-Line держится через #35 |
| #21 | P1 | Код merged (#25); независимый Challenger repo-части — в отчёте #34 (TASK 8); **production re-apply + закрытие гейтов — не выполнены** |
| #22 | P1 | Код merged (#25); repo-проверки зелёные (security-regression, db-contract); **Main Re-Audit/production — не выполнены** |
| #19 | P1 | Этот цикл (docs sync) — см. `docs/ISSUE-19-REPORT.md` |
| #36 | P2 | Harness: каналы ложного зелёного (async-крах → exit 0; `verify_app` без красного канала) — child of #34 |
| #27–#31 | BA | Backlog продуктовых требований (не дефекты); #31 — delta после #30 |
| #15 | P1 (процесс) | Toyota Quality Gate формализован (PR #17); Main Re-Audit выполнен независимым агентом (триаж 2026-09-24) — ожидается закрытие на GitHub (нет прав Issues: write в токене сессии) |

## Активные schema-requests (SR)

- **Applied в `supabase/schema.sql` (проверено grep по main @ `87e3951`, 2026-09-24):**
  SR-001 (`sessions.client_timezone`/`client_utc_offset_min`/`duration_min`),
  SR-002 (интервальный overlap + advisory lock в `create_booking`),
  SR-003 (`public_booked_slots.duration_min`), SR-004
  (`auth_login_codes.issued_token_hash`/`issues`/`consumed_at`), SR-108
  (закрыт единым контрактом с SR-001), SR-D1 (политика D1 + `schedule_overrides`
  + `public_schedule_overrides`). **В проде НЕ подтверждено — требуется
  переприменение `schema.sql` целиком** (INFRA п.2).
- **Открытые (ждут Агента 1):** SR-101…SR-107, SR-109 (кабинет/клиенты, T-05…T-24),
  SR-002-«Google Meet» (Агент 1) — design-only.

## Исторические документы (не переписывать; помечены баннером)

Описывают старые SHA/циклы; актуальное состояние — только этот файл:

- `docs/FULL-AUDIT-REPORT.md` — аудит AUDIT-REG-DRY-001 (main @ `e7cc194`).
- `docs/ISSUE-14-REPORT.md` — Producer-отчёт #14 (main @ `998561d`).
- `docs/ISSUE-14-CHALLENGER.md` — Challenger #14 (main @ `d578c08`).
- `docs/ISSUE-15-REPORT.md` — Producer-отчёт #15 (до merge PR #17).
- `docs/AGENT-1-REPORT.md`, `docs/AGENT-2-REPORT.md`, `docs/AGENT-3-REPORT.md` —
  циклы 2026-09-23 (PR #2/#4/#3).
- `docs/QUALITY-GATE-REPORT.md` — T07 final report (baseline `c20caaf`, после PR #25).
- `docs/D1-REPORT.md` — recovery-отчёт PR #32 (ветка, до merge; независимый
  challenger — `docs/ISSUE-34-REPORT.md`).
- `docs/ISSUE-23-EVIDENCE.md`, `docs/ISSUE-23-IMPLEMENTATION.md` — цикл #23
  (main @ `d41dd35c`).
- `docs/PLAN-AUDIT-REG-DRY-001.md` — план цикла AUDIT-REG-DRY-001.
- `docs/ISSUE-TRIAGE-2026-09-24.md` — триаж против main @ `d578c08`;
  рекомендации по закрытию #7/#11/#15/#8 остаются исполнимыми, статусы сверять
  с этим файлом.
- `docs/ISSUE-34-REPORT.md` / `docs/ISSUE-34-TRIAGE.md` — независимый аудит
  main @ `4d490d2e`; актуален для repo-выводов (PR #37 добавил только эти
  документы), production-выводы — UNKNOWN/BLOCKED.

## Статус регистрации (T-01 / #18 / #23)

- **Код: готов.** Единый use case (`js/domain/registration.js`), канал OTP
  переживает reload, атомарное погашение кода (SR-004), `email_redirect_to` на
  реальный URL (без localhost), deep-link `#/auth?email=`, применение пароля
  сейфа, синхронизация `key_verifier` (PR #20).
- **Production: НЕ подтверждена.** Реальный сценарий
  `new email → real email → OTP → Auth → claim → cabinet → reload` **не выполнен**
  (нет deploy `auth-code`, нет Resend, Site URL/Redirect URLs — UNKNOWN).
  Инструмент владельца: `node tools/prod-e2e.mjs --email <тестовый@email>`.
  Регистрация **не** помечена production-ready.

## Статус Toyota Quality Gate

- Канон: `docs/RULES.md` §6 (единый источник правил). `AGENTS.md` — краткая
  входная точка, не расходит с §6. Issue Form
  (`.github/ISSUE_TEMPLATE/significant-defect.yml`) реализует §6.9.
  (Сверка выполнена в этом цикле — `docs/ISSUE-19-REPORT.md`, раздел ПРОВЕРКА.)
- #15 (процесс) — исполнен (PR #17), независимый Main Re-Audit — в триаже 2026-09-24.
- **Открытые гейты:** P0 #18 (production), P1 #35 (deploy функций) держат
  Stop-the-Line на production-контуре; #33 закрыт локально, ждёт production
  Main Re-Audit; #36 (harness-каналы ложного зелёного) — open P2; независимый
  Challenger по настоящему документационному циклу — open.

## Next actions (без дублей)

1. Владелец: secrets CI (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`),
   deploy `auth-code`/`telegram-notify`, Resend (`RESEND_API_KEY`, `MAIL_FROM`),
   `APP_URL` + Auth Site URL/Redirect URLs, **ре-apply `schema.sql` + `seed.sql`
   целиком**, затем `node tools/prod-e2e.mjs` → evidence в #18 (закрывает #35
   и production-ногу #18/#21/#22/#33).
2. Независимый Challenger: повторить `npm run verify` + `verify_pages.py` на
   main после этого цикла, сверить настоящий файл с кодом, опубликовать отчёт
   с `АУДИТОР: ВНЕШНИЙ`.
3. Main Re-Audit: проверить актуальный `main` SHA и факт применения schema в
   проде после п.1.
4. #36: закрыть каналы ложного зелёного в харнесе (child of #34).

---
*Синхронизировано: 2026-09-24 (UTC), main @ `87e3951241fd18f2cc24afa2b6502247a7fee73b`,
цикл #19 (ветка `arena/01a0d3db-psihologist-cabinet`).*
