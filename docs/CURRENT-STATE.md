# CURRENT-STATE — canonical current-state

> Единственный current-state source of truth по issue #19. Исторические отчёты не переписываются и не заменяются этим документом.
>
> **АУДИТОР: САМ** — независимая production-сертификация в этой сессии невозможна: live Supabase не подтверждался. Repo-факты проверены по актуальному `main`, GitHub Issues и каноническим документам.

## Статус цикла #19

```text
#19 implementation: COMPLETE
#19 verification gate: OPEN
#19 independent challenger: OPEN
#19 main re-audit: OPEN
#19 terminal state: PARTIALLY_COMPLETED
```

`implementation COMPLETE` не означает `quality gate passed`.

## Main SHA

- **Актуальный `main`:** `03c6fa57e1a53f5be9e450eeebf389865f4cc51d`
- **Merge PR #44:** `5d5636db74ba41fbbb19fb7ad358181f4fcdc327` — исправления Quality Gate #36.
- **Merge PR #43:** `03c6fa57e1a53f5be9e450eeebf389865f4cc51d` — roadmap Supabase MCP.
- `87e3951` и более ранние SHA — исторические baseline, не текущий main.

## Что изменилось после предыдущего current-state

### PR #44 / Issue #36

В `main` вошёл recovery harness:

- `finishSuite` больше не должен затирать `process.exitCode` после async failure;
- `verify_app` имеет красный канал для IMPORT/BOOT/LOAD ошибок;
- `verify_all` получил дополнительную защиту от false-green;
- `harness-guard` расширен на наборы из `SUITES`;
- negative controls и parity/E2E gate сохранены.

**Статус:** implementation merged. Независимый Challenger + Main Re-Audit после merge ещё не закрыли #36.

### PR #43 / Supabase MCP roadmap

Добавлен roadmap подключения read-only Supabase MCP для проверки production schema/RPC/RLS drift.

**Статус:** roadmap есть; это не доказательство фактического подключения к production.

## Production — честный статус

**Production readiness НЕ подтверждена этим аудитом.**

Не считать доказанными без свежего live evidence:

- production `supabase/schema.sql` == repository schema;
- canonical `create_booking` signature и отсутствие overload ambiguity;
- production RLS/policies/grants;
- deployment `auth-code` / `telegram-notify`;
- Resend delivery;
- production `APP_URL` / Site URL / Redirect URLs;
- реальный registration E2E;
- production booking E2E;
- production tenant-isolation regression.

Issue #18 остаётся P0, #35 — P1 deployment blocker.

## Repo-level состояние

По текущему `main` подтверждено наличие следующих контуров в репозитории:

- registration domain / OTP flow;
- server-authoritative booking contract;
- tenant-isolation/security groundwork;
- canonical D1 availability engine;
- server-side D1 enforcement;
- parity matrix;
- booking E2E;
- security-regression;
- harness guard;
- Toyota Quality Gate / Producer + Challenger process;
- current-state / dependency-driven roadmap;
- Supabase MCP verification roadmap.

Это **repo evidence**, а не production evidence.

## Открытые критические контуры

| Issue | Priority | Current status |
|---|---:|---|
| #18 | P0 | Production activation + real registration E2E — OPEN / blocked by owner-side production access and configuration |
| #35 | P1 | Edge Functions deployment — OPEN; production deployment not independently proven |
| #34 | P1 | Challenger recovery — repo audit exists; fresh main + production re-audit remains open |
| #33 | P1 | D1 recovery — implementation merged; production/Main Re-Audit remains open |
| #21 | P1 | Server-authoritative booking — repo implementation merged; production schema/live gate open |
| #22 | P2 | Tenant isolation / anti-spam — repo implementation merged; production verification open |
| #19 | P1 | Current-state synchronization — this document is the new audited synchronization point; independent gate remains open |
| #36 | P2 | Harness false-green — implementation merged in PR #44; Challenger/Main Re-Audit open |
| #40 | P1 | Psychologist manual OTP auth + active-account/session policy — requirements open |
| #41 | P1 | Client Google identity for optional triage attachment — requirements open |
| #27–#31 | BA | Product backlog; not defects |

## Important contract conflict requiring resolution before implementation

`docs/TASK-P0-SUPABASE-PORTAL.md` describes an email-confirmation/redirect-oriented onboarding contract, while Issue #40 explicitly requires **manual OTP code entry** and says an email link must not replace that step.

Therefore no agent may silently choose one flow. Before implementing the P0 portal/auth work, the canonical authentication contract must be reconciled and recorded once. This is a specification dependency, not a reason to create a second authentication engine.

## Schema / SR status

Repository `supabase/schema.sql` contains the merged SR contracts for the existing booking/auth/D1 work. Their presence in the repository does **not** prove production application.

Production schema status remains **UNKNOWN** until verified through an authorized production channel (preferably the planned read-only Supabase MCP / SQL verification path).

## Registration status

- **Repository:** registration/OTP code path exists and is covered by local tests from the previous verified cycle.
- **Production:** NOT PROVEN.
- Required proof remains:

```text
real email → real OTP → Supabase Auth session → claim/owner binding → cabinet → reload → repeat login
```

No production-ready label may be added without this evidence.

## Quality Gate status

Canonical process remains:

```text
MAIN → AUDIT → DEFECT/REQUIREMENT → ISSUE → PRODUCER → TESTS → CHALLENGER → MERGE → MAIN RE-AUDIT → STANDARDIZE
```

Current blockers:

1. production activation / registration (#18/#35);
2. independent verification of the merged harness recovery (#36);
3. fresh Main Re-Audit on `03c6fa5`;
4. production schema/RPC/RLS drift verification;
5. authentication contract reconciliation (#40 vs P0 portal specification).

## Next actions — dependency order, no duplicate implementation

1. **Independent Challenger #36** on the actual merged `main` `03c6fa5`, including negative controls for async/import/bootstrap failures.
2. **Production DB verification** through the planned Supabase MCP/read-only path: `pg_proc`, schema objects, grants, RLS/policies, `create_booking` overloads.
3. **Resolve auth contract** between P0 portal specification and #40 before implementation.
4. Owner-side production activation for #35/#18; then real registration and booking E2E.
5. **Main Re-Audit** after the above changes, using the new main SHA and fresh evidence.
6. After each subsequent merge, repeat the current-state synchronization rather than restoring historical SHA references.

## Historical documents

Do not rewrite historical reports merely to make their SHA current. They remain evidence of their original cycle. Relevant examples include:

- `docs/ISSUE-14-REPORT.md`
- `docs/ISSUE-14-CHALLENGER.md`
- `docs/ISSUE-15-REPORT.md`
- `docs/QUALITY-GATE-REPORT.md`
- `docs/D1-REPORT.md`
- `docs/ISSUE-34-REPORT.md`
- `docs/ISSUE-34-TRIAGE.md`
- `docs/ISSUE-19-REPORT.md`

The current state is this file, not a historical report.

---

*Синхронизировано: 2026-09-25 UTC; main @ `03c6fa57e1a53f5be9e450eeebf389865f4cc51d`. This synchronization records repo facts and known verification gaps; it does not certify production.*
