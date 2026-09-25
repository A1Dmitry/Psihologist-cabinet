# CURRENT-STATE — canonical current-state

> Единственный current-state source of truth. Исторические отчёты не переписываются и не заменяются этим документом.
>
> **АУДИТОР: САМ** — независимая production-сертификация в этой сессии невозможна: live Supabase не подтверждался. Repo-факты проверены по актуальному `main`, GitHub Issues и каноническим документам.

## Main SHA

- **Актуальный `main`:** `0320c40682805a4730fa03b93176b14098ceea75`
- **Последний sync-коммит:** обновление recovery orchestration и исправленного auth-контракта.
- **Merge PR #44:** `5d5636db74ba41fbbb19fb7ad358181f4fcdc327` — recovery Quality Gate #36.
- **Merge PR #43:** `03c6fa57e1a53f5be9e450eeebf389865f4cc51d` — Supabase MCP roadmap.
- `87e3951`, `4d490d2` и более ранние SHA — исторические baseline.

## Статус документационного цикла #19

`#19 = COMPLETED / DOCUMENTATION SYNCHRONIZED`.

Текущий-state синхронизирован с актуальным main. Production verification и Quality Gate не входят в незавершённый остаток #19; они ведутся отдельными #18/#21/#22/#34/#36.

## Что изменилось после предыдущего current-state

### PR #44 / Issue #36

В `main` вошёл recovery harness:

- `finishSuite` не должен затирать `process.exitCode` после async failure;
- `verify_app` имеет красный канал для IMPORT/BOOT/LOAD ошибок;
- `verify_all` получил дополнительную защиту от false-green;
- `harness-guard` расширен на наборы из `SUITES`;
- negative controls и parity/E2E gate сохранены.

**Статус:** implementation merged; независимый Challenger/Main Re-Audit ведутся через #36/#34.

### PR #43 / Supabase MCP roadmap

Добавлен roadmap read-only Supabase MCP для проверки production schema/RPC/RLS drift.

**Статус:** roadmap есть; это не доказательство фактического production-подключения.

## Production — честный статус

**Production readiness НЕ подтверждена этим аудитом.**

Без свежего live evidence не считать доказанными:

- production schema == repository `supabase/schema.sql`;
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

По текущему `main` подтверждено наличие:

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
- dependency-driven roadmap;
- Supabase MCP verification roadmap.

Это **repo evidence**, а не production evidence.

## Открытые критические контуры

| Issue | Priority | Current status |
|---|---:|---|
| #18 | P0 | Production activation + real registration E2E — OPEN / blocked or unproven |
| #35 | P1 | Edge Functions deployment — OPEN; production deployment not independently proven |
| #34 | P1 | Challenger recovery + fresh Main Re-Audit — OPEN |
| #21 | P1 | Server-authoritative booking — repo implementation merged; production gate open |
| #22 | P2 | Tenant isolation / anti-spam — repo implementation merged; production verification open |
| #36 | P2 | Harness false-green — implementation merged; Challenger/Main Re-Audit open |
| #40 | P1 | Psychologist auth: manual OTP + optional email-link entry — requirements open |
| #41 | P1 | Client Google identity for optional triage attachment — requirements open |
| #27–#31 | BA | Product backlog; not defects |

Issues #19, #30 and #33 are no longer active implementation queues: #19 documentation sync is complete; #30 was decomposed into the non-duplicating delta #31; #33 recovery implementation was superseded by the merged fixes and the independent verification chain #34/#36.

## Canonical authentication contract — corrected

There is **no conflict** between manual OTP and an email link. They are two entry methods into the same canonical authentication/session flow.

```text
EMAIL / TELEGRAM
       │
       ├── manual one-time code ──────┐
       │                              │
       └── email confirmation link ───┤
                                      ▼
                              canonical Supabase session
                                      │
                                      ▼
                              psychologist account
                                      │
                                      ▼
                                  own cabinet
```

Rules:

- Manual code entry remains supported.
- Email link is also supported and must establish the same canonical Supabase session.
- The link must never point to `localhost`; it must use the production application origin and correct callback/token contract.
- Both methods resolve the same `auth.uid()` → psychologist ownership path.
- Do not create a second authentication engine.
- Issue #40 now defines the link as an additional entry method, not as a forbidden alternative.

This is a specification correction, not a reason to duplicate implementation.

## Schema / SR status

Repository `supabase/schema.sql` contains merged SR contracts for existing booking/auth/D1 work. Their presence in the repository does **not** prove production application.

Production schema remains **UNKNOWN** until verified through an authorized production channel, preferably the planned read-only Supabase MCP / SQL path.

## Registration status

- **Repository:** registration/OTP code path exists and is covered by local tests from the previous verified cycle.
- **Production:** NOT PROVEN.
- Required proof remains:

```text
manual code OR email link
        → canonical Supabase Auth session
        → claim/owner binding
        → own cabinet
        → reload
        → repeat login
```

No production-ready label may be added without this evidence.

## Quality Gate status

Canonical process:

```text
MAIN → AUDIT → DEFECT/REQUIREMENT → ISSUE → PRODUCER → TESTS → CHALLENGER → MERGE → MAIN RE-AUDIT → STANDARDIZE
```

Current blockers:

1. production activation / registration (#18/#35);
2. independent verification of merged harness recovery (#36);
3. fresh Main Re-Audit;
4. production schema/RPC/RLS drift verification;
5. corrected auth contract implementation and E2E (#40).

## Next actions — dependency order, no duplicate implementation

1. **Independent Challenger #36** on the current main, including negative controls for async/import/bootstrap failures.
2. **Production DB verification** through the planned Supabase MCP/read-only path: `pg_proc`, schema objects, grants, RLS/policies, `create_booking` overloads.
3. **Implement the corrected dual-entry auth contract**: manual OTP + email-link, one canonical session/ownership path.
4. Owner-side production activation for #35/#18; then real registration and booking E2E.
5. Verify #21/#22 production security/booking behavior.
6. **Main Re-Audit** on the resulting main SHA with fresh evidence.
7. After every subsequent merge, synchronize this current-state document again.

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

*Синхронизировано: 2026-09-25 UTC; current main @ `0320c40682805a4730fa03b93176b14098ceea75`. Эта запись синхронизирует repo-state и известные verification gaps; она не сертифицирует production.*
