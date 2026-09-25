# Recovery orchestration — dependency ledger

> **АУДИТОР: САМ** — repo-level synchronization audit, 2026-09-25 UTC. Это маршрут выполнения, а не новый источник требований и не production-сертификация. Канонические критерии находятся в связанных Issues; актуальное состояние — `docs/CURRENT-STATE.md`.

**Current main:** `2d2897b160a903f2d9a0dff6fdc338de217439c7`

**Исторические baseline:** `03c6fa5`, `87e3951` и `4d490d2` относятся к предыдущим циклам.

| Очередь | Canonical issue | Условие перехода | Текущее состояние |
|---|---|---|---|
| P0 | #18 | Production schema/config, deployed functions, real email/OTP, claim, cabinet, reload, repeat login | OPEN / production blocked or unproven |
| P1 | #35 | `auth-code`/`telegram-notify` deployed; endpoint smoke; raw live evidence | OPEN / deployment not independently proven |
| P2 | #36 | Negative controls for async/import/bootstrap failures; positive path; independent Challenger | IMPLEMENTATION MERGED / VERIFICATION OPEN |
| P1 | #34 | Fresh Challenger + Main Re-Audit on current main and production evidence | OPEN |
| P1 | #21 | Production canonical `create_booking`, no overload ambiguity, server-owned money/status/duration/hold | REPO MERGED / PRODUCTION OPEN |
| P2 | #22 | Production tenant-isolation and anti-spam negative tests | REPO MERGED / PRODUCTION OPEN |
| P1 | #40 | Canonical dual-entry psychologist auth: manual OTP OR email link → one Supabase session | REQUIREMENTS OPEN |
| P1 | #41 | Client Google identity for optional triage attachment | REQUIREMENTS OPEN |

Issues #19, #30 and #33 are no longer execution queues: #19 documentation synchronization is complete; #30 was decomposed into the non-duplicating delta #31; #33 was superseded by merged recovery work and the independent verification chain #34/#36.

## Dependency rules

1. **#36 Challenger before closure.** Merge is not sufficient evidence.
2. **Production verification is a separate axis.** Local/embedded PostgreSQL, green CI, source files and merge are not production evidence.
3. **#21/#22 production gates depend on production schema verification.** First inspect `pg_proc`, tables, grants, policies/RLS and overloads; only then repair drift.
4. **#18/#35 require owner-side production credentials/configuration.** Agents must not invent or expose secrets.
5. **Authentication contract is dual-entry, not conflicting.** Manual OTP and email-link are two ways to reach the same canonical Supabase session and psychologist ownership path. Do not create two auth engines.
6. **Production email links must use the real application origin, never `localhost`.** Callback/token handling must converge on the same canonical session as manual OTP.
7. **No duplicate domain implementations.** Availability, booking policy, auth, payment, notification and calendar state each have one canonical owner.

## Next execution sequence

```text
CURRENT-STATE sync @ 2d2897b
        ↓
#36 independent Challenger
        ↓
production DB inspection (Supabase MCP / authorized SQL)
        ↓
implement corrected dual-entry #40 auth contract
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

*Синхронизировано: 2026-09-25 UTC; current main @ `2d2897b160a903f2d9a0dff6fdc338de217439c7`.*
