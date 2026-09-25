# Recovery orchestration — dependency ledger

> **АУДИТОР: САМ** — repo-level synchronization audit, 2026-09-25 UTC. Это маршрут выполнения, а не новый источник требований и не production-сертификация. Канонические критерии находятся в связанных Issues; актуальное состояние — `docs/CURRENT-STATE.md`.

**Current main:** `03c6fa57e1a53f5be9e450eeebf389865f4cc51d`

**Исторические baseline:** `87e3951` и `4d490d2` относятся к предыдущим циклам и не должны использоваться как current main.

| Очередь | Canonical issue | Условие перехода | Текущее состояние |
|---|---|---|---|
| P0 | #18 | Production schema/config, deployed functions, real email/OTP, claim, cabinet, reload, repeat login | OPEN / production blocked or unproven |
| P1 | #35 | `auth-code`/`telegram-notify` deployed; endpoint smoke; failure propagation; raw live evidence | OPEN / deployment not independently proven |
| P1 | #36 | Negative controls for async/import/bootstrap failures; positive path; independent Challenger | IMPLEMENTATION MERGED / VERIFICATION OPEN |
| P1 | #34 | Fresh Challenger + Main Re-Audit on current main and production evidence | OPEN |
| P1 | #33 | D1 recovery independently verified on current main + production gate | IMPLEMENTATION MERGED / MAIN RE-AUDIT OPEN |
| P1 | #21 | Production canonical `create_booking`, no overload ambiguity, server-owned money/status/duration/hold | REPO MERGED / PRODUCTION OPEN |
| P2 | #22 | Production tenant-isolation and anti-spam negative tests | REPO MERGED / PRODUCTION OPEN |
| P1 | #19 | Current-state synchronized with current main; independent Challenger + Main Re-Audit | SYNCHRONIZED / VERIFICATION OPEN |
| P1 | #40 | Canonical psychologist auth contract agreed and implemented | REQUIREMENTS OPEN |
| P1 | #41 | Client Google identity contract implemented and production E2E verified | REQUIREMENTS OPEN |

## Dependency rules

1. **#36 Challenger before closure.** PR #44 being merged is not sufficient evidence.
2. **Production verification is a separate axis.** Local/embedded PostgreSQL, green CI, source files and merge are not production evidence.
3. **#21/#22 production gates depend on production schema verification.** First inspect `pg_proc`, tables, grants, policies/RLS and overloads; only then repair drift.
4. **#18/#35 require owner-side production credentials/configuration.** Agents must not invent or expose secrets.
5. **Authentication contract must be reconciled before implementation.** `TASK-P0-SUPABASE-PORTAL.md` and Issue #40 currently describe different entry semantics (email confirmation/redirect vs manual OTP code entry). Resolve this once; do not create two auth engines.
6. **#19 synchronization follows every subsequent main merge.** Never restore an historical SHA as current.
7. **No duplicate domain implementations.** Availability, booking policy, auth, payment, notification and calendar state each have one canonical owner.

## Next execution sequence

```text
CURRENT-STATE sync @ 03c6fa5
        ↓
#36 independent Challenger
        ↓
production DB inspection (Supabase MCP / authorized SQL)
        ↓
resolve P0/#40 auth contract
        ↓
owner-side #35/#18 production activation
        ↓
real registration + booking E2E
        ↓
#21/#22 production security/booking verification
        ↓
#34 Main Re-Audit on the new main
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

*Синхронизировано: 2026-09-25 UTC; current main @ `03c6fa57e1a53f5be9e450eeebf389865f4cc51d`.*
