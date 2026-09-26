# Recovery orchestration — dependency ledger

> **АУДИТОР: САМ** — repo-level synchronization audit, 2026-09-26 UTC (issue #50,
> `EXEC-_k1zAnZrvi`). Это маршрут выполнения, а не новый источник требований
> и не production-сертификация. Канонические критерии находятся в связанных Issues;
> актуальное состояние — `docs/CURRENT-STATE.md`.

**Current main:** `9171cc1090564346b7208b4a7e5dfe7b906e9394` (merge PR #98, 2026-09-26T12:12Z)

**Исторические baseline:** `03c6fa5`, `87e3951`, `4d490d2`, `2d2897b`, `b1dbf1a`, `b0313e8`, `a8953d1`, `a467553`
относятся к предыдущим циклам (см. `docs/CURRENT-STATE.md`).

| Очередь | Canonical issue | Условие перехода | Текущее состояние |
|---|---|---|---|
| P0 | #67 | TASK 1: production re-check без баннера + live-стек; TASK 2–5: UPDATE услуг до public booking, «Настройки», error contract, сейф UX; Challenger + Main Re-Audit по каждому TASK | OPEN / TASK 1 repo-фикс merged (PR #77/#85); TASK 2–5 не начаты |
| P0 | #63 | Bottom tab bar + все 15 разделов со смартфона + карточные действия; `verify_pages.py` + `npm run verify`; Challenger + Main Re-Audit | OPEN / не начат |
| P1 | #64 | Sheets вместо prompt/confirm, sticky CTA, safe-area, `submitting`-guard; двойной submit — негативный тест; Challenger + Main Re-Audit | OPEN / **реализовано в main** (PR #97, merge `a467553`; остаток: Challenger + устройство владельца) |
| P1 | #35 | `telegram-notify` задеплоен; endpoint smoke не-404; raw live evidence (**только** telegram-notify — коррекция владельца 2026-09-25; LEAVE OPEN до не-404) | OPEN / деплой не подтверждён; блокер — секреты владельца |
| P1 | #40 | Google provider включён (Client ID/Secret, Site URL/Redirects), миграция применена, реальный Google-вход E2E | OPEN / repo-канон закрыт (#88); production — OWNER ACTION REQUIRED |
| P1 | #41 | Production E2E настоящего Google/Supabase + независимый Challenger (local mocks не закрывают) | OPEN / repo-часть merged (PR #62) |
| P2 | #66 | DoD выполнен в main (PR #83) → закрытие по evidence | OPEN / к закрытию |
| P2 | #69 | Реализован + Main Re-Audit (PR #70/#71) → закрытие; остаток: CLAIM-маркеры не публикуются (нет `issues:write`) — блокер зафиксирован в `docs/EXECUTOR-CLAIMS.md` §6 | OPEN / к закрытию |
| P2 | #50 | Ресинк доков + verification gate #19 + решение Kaizen-кандидата | PR #99 `aff869f` — ресинк к 9171cc1 выполнен, Main Re-Audit → `docs/MAIN-AUDIT-50.md`; ожидает merge + независимый Challenger |

Issues #18, #19, #21, #22, #30, #33, #34, #36, #46 больше не execution queues:
#18 закрыта (преемник #46, закрыт 2026-09-25; production-остаток — #35/#40);
#19 закрыта без verification gate → post-facto gate выполняется #50 (этот ресинк);
#21/#22 закрыты после repo-фиксов и триажа; #30 декомпозирована в delta #31;
#33/#34/#36 закрыты после Challenger-цепочки; #46 закрыта владельцем
(коррекция в #67: «#46 is historical/closed»).

## Dependency rules

1. **Merge ≠ DONE.** Challenger + Main Re-Audit до закрытия существенного Issue (RULES §6.7).
2. **Production verification is a separate axis.** Local/embedded PostgreSQL, green CI, source files and merge are not production evidence.
3. **Production-гейты зависят от владельца:** Google provider (#40), деплой `telegram-notify` (#35), SQL-канал по `create_booking` для anon. Агенты не выдумывают и не раскрывают секреты.
4. **Канон входа специалиста — Google OAuth через Supabase Auth** (решение владельца 2026-09-25; #88). Email/OTP/`auth-code`/email-link для психолога **CANCELLED** — не восстанавливать и не реализовывать заново (коррекция владельца в #67).
5. **Production-ссылки — реальный origin приложения, никогда `localhost`.** Callback/token-обработка сходится в каноническую Supabase-сессию Google-входа.
6. **No duplicate domain implementations.** Availability, booking policy, auth, payment, notification and calendar state each have one canonical owner.
7. **Claim-протокол (RULES §6.17):** перед работой над Issue — `node tools/claim.mjs take <N>`; конфликт владения запрещает параллельную работу над тем же Issue.

## Next execution sequence

```text
CURRENT-STATE sync @ 9171cc1 (issue #50 — этот ресинк)
        ↓
владелец: Google provider + миграция (#40) + деплой telegram-notify (#35)
        ↓
production DB inspection (SQL-канал владельца: create_booking для anon)
        ↓
реальный вход/регистрация E2E (tools/prod-e2e.mjs)
        ↓
#67 TASK 2 → TASK 3 → TASK 4 (owner cabinet; TASK 5 — P2)
        ↓
#63 (bottom tab bar) → #64 (sheets/CTA) — мобильный пакет
        ↓
#41 production E2E + Challenger; закрытие #66/#69 по evidence
        ↓
BA-очередь #27–#31 (после production-разблокировки)
        ↓
STANDARDIZE / close only the gates whose DoD is actually satisfied
```

## Challenger / Main Re-Audit contract

For every significant gate classify evidence as:

- `FACT` — directly inspected repository/GitHub state;
- `LIVE EVIDENCE` — directly reproduced in production;
- `INFERENCE` — derived from verified facts;
- `UNKNOWN` — not independently verifiable in the current environment.

The final report must contain exact SHA, date, environment, commands/scenarios, actual result, limitations and raw failure evidence where safe. Never include OTPs, access/refresh tokens, service-role keys or private clinical data.

## Closure rule

```text
MAIN
→ AUDIT
→ DEFECT / REQUIREMENT
→ ISSUE
→ PRODUCER
→ TESTS
→ CHALLENGER
→ MERGE
→ MAIN RE-AUDIT
→ STANDARDIZE
```

A merge or green CI does not close a production/security gate. If a required P0/P1 condition remains `UNKNOWN`, `BLOCKED` or `FAIL`, keep the relevant gate open.

---

*Синхронизировано: 2026-09-26 UTC (issue #50 — ресинк + QA-Challenger 14:25Z, исполнитель
`EXEC-_k1zAnZrvi`); current main @ `9171cc1090564346b7208b4a7e5dfe7b906e9394` (PR #98), голова PR #99 `aff869f`. Production-строки — по LIVE-срезу
2026-09-25 (см. `docs/CURRENT-STATE.md`), без свежей перепроверки. Main Re-Audit → `docs/MAIN-AUDIT-50.md`.*
