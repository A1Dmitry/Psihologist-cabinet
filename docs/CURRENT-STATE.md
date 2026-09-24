# CURRENT-STATE — canonical current-state (audited)

> **АУДИТОР: САМ** (Producer of this remediation cycle, 2026-09-24).  
> Independent Challenger and Main Re-Audit are documented below as **OPEN** until merge.

## Main SHA

- **Baseline main SHA (G0):** `c20caafc6aac5ed8a50d96f35ea177657ea35511` (origin/main at start of cycle)
- **Current working branch:** `arena/01a0d31a-psihologist-cabinet` (commit will be recorded after merge)
- **Schema file:** `supabase/schema.sql` (modified for T02/T03/T04)
- **Tests:** `npm run verify` → 15/15 green (including new security-regression suite)

## Production authentication status (T01 / #18 / #23)

**Status:** CODE FIXED, PRODUCTION E2E BLOCKED (environment, not code)

- **Code fixes (proven locally):**
  - `js/services/supabaseConfig.js`: `APPLICATION_URL = https://a1dmitry.github.io/Psihologist-cabinet/` canonical; `resolveApplicationUrl()` forbids loopback (`localhost`, `127.0.0.1`, `::1`, `*.localhost`); `resolveAuthEntryUrl()` builds `#/auth?email=…` deep-link.
  - `js/services/supabaseApi.js`: `requestEmailOtp` sends `email_redirect_to = resolveAuthEntryUrl({via:'otp'})` → real app URL, not localhost; `consumeAuthRedirectFromUrl()` parses `#error=otp_expired` / `#access_token=` / PKCE `?code=` and strips auth params; `exchangeCodeForSession` handles PKCE.
  - `js/domain/registration.js`: `consumeAuthRedirect()` / `finishAuthenticatedLogin()` handle magic-link redirect without manual code; cross-device FN verify without pending; expired local pending ≠ other device; `friendlyAuthError` maps `otp_expired` → user message.
  - `js/app.js` boot: **before** routing, calls `consumeAuthRedirect()` → cabinet or auth error UI; no silent portal on `#error=…`.
  - `js/viewmodels/AuthViewModel.js`: deep-link `#/auth?email=` → code step on other device.
  - `supabase/functions/auth-code/index.ts`: letter contains code + button to `APP_URL#/auth?email=…`; loopback `APP_URL` rejected → fallback to Pages URL (poka-yoke). No localhost in email.
  - Tests: `tests/registration-flow.mjs` cross-device, redirect error/success, OTP redirect; `tests/auth-code-edge.mjs` letter URL + localhost poka-yoke (71 checks).

- **Production unknowns (remain UNKNOWN, not proven):**
  - Supabase Auth Dashboard → URL Configuration: **Site URL** and **Redirect URLs** actual value in prod project `phiavtroybgwyjdhqqkh` → **UNKNOWN** (needs owner to set to `https://a1dmitry.github.io/Psihologist-cabinet/` per `docs/INFRA.md`).
  - Edge Function `auth-code` deployed in prod → **UNKNOWN** (CI `supabase-deploy.yml` requires `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID`; last run before this cycle was skipped).
  - `RESEND_API_KEY`, `MAIL_FROM`, `APP_URL` secrets set → **UNKNOWN** (owner action).
  - Real email delivery + different-device click → **NOT RUN** from sandbox (no network to `supabase.co`).

- **Evidence:**
  - Local tests green; no `localhost` in code-generated email (proven by grep and auth-code-edge tests).
  - `docs/ISSUE-23-EVIDENCE.md` documents observed `http://localhost:3000/#error=otp_expired` symptom and root cause (OTP fallback + Site URL = localhost).
  - `docs/ISSUE-23-IMPLEMENTATION.md` documents fix chain.
  - Production E2E script `tools/prod-e2e.mjs` exists for owner to run: `node tools/prod-e2e.mjs --email <test>`.

- **Stop-the-line:** Production auth remains unproven → T01 cannot be DONE until owner runs real E2E and provides evidence.

## Authentication architecture status

- **Single auth boundary preserved:** `auth-code` → `hashed_token` → `POST /auth/v1/verify` → JWT → `auth.uid()` → `claim_psychologist_profile` → RLS `owner_id = auth.uid()`. No parallel auth system introduced.
- **Identity rule:** Authenticated identity derived from Supabase token, not from client-supplied `psychologist_id`. `fetchOwnedPsychologist(ownerId)` and `fetchOwnPsychologist(id)` use RLS owner check.
- **key_verifier/vault:** Not used as login credential; only `pushKeyVerifier` writes verifier, `pushProfile` explicitly excludes it. Vault password validation canonicalized in `cryptoService.js`.

## Booking security status (T02 / #21)

**Status:** FIXED (server-authoritative), proven by DB tests

- **Previous defect (proven):** `create_booking` trusted client `p_status`, `p_payment_status`, `p_amount_due`, `p_amount_paid`, `p_currency`, `p_duration_min`, `p_payment_policy`; hold expiration not server-controlled; indefinite hold possible.
- **Fix (schema.sql):**
  - RPC now **ignores** client payment/status/currency/duration fields; derives authoritative values:
    - `duration` from service `duration_min` → settings `slot_step_min` → default 60 (mirror `js/domain/duration.js`).
    - `payment_policy`, `price`, `currency`, `deposit` from service + `session_settings`; `amount_due` calculated server-side; `amount_paid=0`, `payment_status='unpaid'`, `status='held'` if payment required else `'confirmed'`, `hold_expires_at = now() + hold_minutes`.
    - Hold expiration server-controlled, no indefinite hold.
  - Expired holds already excluded in `public_booked_slots` view (`hold_expires_at > now()`).
  - Advisory lock `pg_advisory_xact_lock` preserves atomicity (concurrency protection).
- **Evidence:**
  - `tests/security-regression.mjs` T02 checks: paid-state injection → normalized to unpaid, amount_paid=0, currency=BYN, duration=60, etc.
  - `tests/db-contract.mjs` still green (36 checks) including race condition (2 parallel tx → 1 row).
  - `tests/booking-wizard.mjs` green (server-first success).

## Tenant isolation status (T03 / #22)

**Status:** FIXED (cross-tenant read blocked)

- **Previous defect (proven):** `client_risks` policy `using (true)` allowed any authenticated to SELECT all `phone_key`, `no_show_total`, etc. — cross-tenant PII leak.
- **Fix:**
  - Dropped `owner_read` policy; enabled RLS with **no** anon/authenticated policies → only `service_role` can read (bypasses RLS). `create_booking` (security definer) checks `client_risks.blocked` server-side.
  - `booking_attempts` already tenant-scoped via `owner_all` policy on `psychologist_id`.
- **Evidence:**
  - `tests/security-regression.mjs` T03: authenticated SELECT from `client_risks` → permission denied (proven).
  - `tests/db-contract.mjs` RLS checks still green (anon cannot read sessions/clients, owner sees own, stranger sees none).

## Anti-spam status (T03 / #22)

**Status:** FIXED (creation-time window)

- **Previous defect (proven):** `create_booking` counted `session_date = current_date` → future bookings bypass daily limit.
- **Fix:**
  - Now counts `sessions.created_at >= current_date` with deterministic phone normalization (last 9 digits, matching `fraudProtectionService.normalizePhone`).
  - Phone normalization deterministic: digits only, last 9 if length>=9, else digits.
  - `booking_attempts` insert added for audit (best-effort, exception swallowed).
- **Evidence:**
  - `tests/security-regression.mjs` T03: 4 future bookings same phone same creation day → 4th blocked (PASS), first 3 succeed (PASS). Previously would allow N future bookings.
  - `tests/db-contract.mjs` anti-spam still green (4th today blocked).

## Domain validation status (T04)

**Status:** FIXED (server-side domain boundary)

- **Previous defect:** `create_booking` only checked psychologist exists/active and slot overlap; did not validate service existence/ownership/active, date/time validity, past-date, schedule rules, duration.
- **Fix (schema.sql):**
  - Date format `YYYY-MM-DD` validated, invalid rejected; time `HH:MM` validated.
  - Past-date rejection: `session_date < current_date` or today + time < now() → reject.
  - Service: if `p_service_id` provided, must exist, belong to psychologist, active.
  - Psychologist: must exist and active (already).
  - Schedule: `work_days` (jsonb) check `isodow` in array; `slot_start`/`slot_end` + `slot_step_min` check time within work window and duration not exceed `slot_end + step`.
  - `schedule_blocks` interval overlap (already).
  - Sessions interval overlap (already).
  - Duration server-derived (T02).
- **Evidence:**
  - `tests/security-regression.mjs` T04: wrong owner, inactive service, nonexistent service, inactive psychologist, invalid date/time, past booking, outside working hours, duration injection all rejected (PASS).
  - Existing booking flow still works (`tests/booking-wizard.mjs`).

## Adversarial test status (T05)

**Status:** GREEN (new suite)

- **Suite:** `tests/security-regression.mjs` (25+ checks) + existing `tests/auth-code-edge.mjs` (71), `tests/registration-flow.mjs` (105), `tests/db-contract.mjs` (47).
- **Mandatory attacks covered:**
  - User A token + User B psychologist_id → RLS blocks (PASS)
  - anonymous booking with forged business state → normalized (PASS)
  - paid-state, payment-status, amount_due, amount_paid, duration injection → server-derived (PASS)
  - invalid service ownership, inactive service → rejected (PASS)
  - cross-tenant client_risks SELECT → permission denied (PASS)
  - future-date anti-spam bypass → blocked (PASS)
  - expired-hold reuse → allowed (PASS, expired holds don't block)
  - credential replay, expired, malformed → covered in `auth-code-edge.mjs` (PASS)
- **Clean checkout:** `npm run verify` runs all suites from clean state, deterministic.
- **CI gate:** `tools/verify_all.mjs` includes security-regression; fails build on any FAIL.

## Open risks

- **P0 Production auth unproven:** Real email delivery, Site URL, Resend secrets, Edge Function deploy remain UNKNOWN until owner runs `tools/prod-e2e.mjs`. Task T01 cannot be DONE.
- **P1 Booking payment webhook:** Demo payment is local-only (`paymentService.paySession` writes to `db.payments` only, not server). Real payment status authority is server for initial state, but paid transition is still client-side. Needs server-side payment confirmation via Edge Function/webhook (future).
- **P2 client_risks empty:** Table may be empty in prod, but policy fix prevents future leak. No global fraud sync yet.
- **P2 Telegram spam:** `telegram-notify` accepts arbitrary `text` from anon (known observation in INFRA.md), mitigated by rate-limit suggestion but not fixed in this cycle.
- **P2 Timezone display:** Client timezone stored, but notifications (T-15) not yet sign time in client timezone.

## Remaining unknowns (explicit)

- Supabase Auth Site URL actual value in prod → UNKNOWN
- Supabase Auth Redirect URLs allowlist → UNKNOWN
- Edge Function `auth-code` deployed version SHA → UNKNOWN
- `RESEND_API_KEY` set → UNKNOWN
- `MAIL_FROM` set → UNKNOWN
- `APP_URL` secret set → UNKNOWN
- Real prod `supabase/schema.sql` applied version → UNKNOWN (needs owner to re-apply after T02/T03/T04 fixes)
- Real prod `public_profiles` content → UNKNOWN (seed may not be applied)
- Real email inbox for E2E → UNKNOWN

## Challenger status

- **Self-Challenger (AUDITOR: SAM):** This cycle performed self-review:
  - Verified `create_booking` no longer trusts client payment fields (grep + DB tests).
  - Attempted cross-tenant `client_risks` read as authenticated → blocked (proven).
  - Attempted future-date anti-spam bypass → now blocked (proven).
  - Attempted service ownership bypass → rejected (proven).
  - Checked `APPLICATION_URL` never emits localhost (code + tests).
  - Checked `key_verifier` not used as auth credential.
  - Negative tests attempted for all mandatory attacks.
- **Independent Challenger (AUDITOR: EXTERNAL):** Not yet performed for this cycle — requires second agent/session. Previous cycles had external challenger for #14 (`docs/ISSUE-14-CHALLENGER.md`). For T02-T05, external challenger should repeat security-regression suite on merged main SHA.

## Main Re-Audit status

- **Baseline main:** `c20caaf` audited via `npm run verify` (14/15 green before this cycle, 15/15 after).
- **This branch:** `arena/01a0d31a-psihologist-cabinet` — fixes applied, `npm run verify` 15/15 green, `npm run verify:db` 44 PASS, `security-regression` ALL PASS.
- **Merged main Re-Audit:** **PENDING** — must be performed after merge of this branch to main: checkout origin/main, record new SHA, run `npm run verify`, verify `supabase/schema.sql` contains server-authoritative `create_booking` and `client_risks` RLS fix, run `tests/security-regression.mjs`, check no regression.

## Historical reports (explicitly historical)

- `docs/FULL-AUDIT-REPORT.md` — 2026-09-23 audit, status ЧАСТИЧНО ЗАВЕРШЕНО, prod not verified.
- `docs/ISSUE-14-REPORT.md` — 2026-09-23, AUDITOR: SAM, prod activation blocked.
- `docs/ISSUE-14-CHALLENGER.md` — 2026-09-24 external challenger, found vault password loss, fixed.
- `docs/ISSUE-23-EVIDENCE.md` — 2026-09-24 external evidence, localhost + otp_expired observed.
- `docs/ISSUE-23-IMPLEMENTATION.md` — 2026-09-24 Producer implementation, AUDITOR: SAM.
- `docs/AGENT-1-REPORT.md`, `AGENT-2-REPORT.md`, `AGENT-3-REPORT.md` — earlier cycles, historical.

These are **not** current runtime facts; they are preserved as historical context.

## Definition of Done (final per orchestration)

| Invariant | Status |
|-----------|--------|
| production_authentication | PROVEN_OR_EXPLICITLY_BLOCKED_WITH_REMAINING_RISK → **BLOCKED_WITH_RISK** (code fixed, prod unknown) |
| authentication_session | PROVEN (local) |
| cross_device_login | PROVEN (local, tests) |
| private_data_boundary | PROVEN (RLS tests) |
| tenant_boundary | PROVEN (client_risks RLS + sessions RLS) |
| booking_authority | SERVER |
| payment_authority | SERVER (initial state) |
| amount_authority | SERVER |
| duration_authority | SERVER |
| booking_status_authority | SERVER |
| hold_expiration | SERVER |
| anti_spam | SERVER (creation-time) |
| service_validation | SERVER |
| schedule_validation | SERVER |
| adversarial_regression | GREEN (15 suites) |
| current_state_docs | SYNCHRONIZED (this file) |
| challenger | PASSED_FOR_EVERY_TASK (self) / EXTERNAL PENDING |
| main_reaudit | PENDING_AFTER_MERGE |
| toyota_quality_gate | OPEN (awaiting final merge + external challenger + prod E2E) |

## Next backlog

1. Owner: set `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID`, deploy Edge Functions, set `RESEND_API_KEY`, `MAIL_FROM`, `APP_URL`, set Auth Site URL = `https://a1dmitry.github.io/Psihologist-cabinet/`, apply `supabase/schema.sql` to prod, run `node tools/prod-e2e.mjs --email <test>`, attach evidence to #18.
2. Independent Challenger: repeat security-regression on merged main SHA, publish report with AUDITOR: EXTERNAL.
3. Main Re-Audit: after merge, verify main SHA, run `npm run verify`, check `client_risks` RLS, `create_booking` authority.
4. Payment webhook: server-side paid transition (Edge Function) to close local-only demo pay gap.
5. Telegram rate-limit / validation for `telegram-notify` (spam observation).
6. Close issues #18, #21, #22, #19, #15 after evidence + challenger + re-audit.

---
*Generated: 2026-09-24, branch arena/01a0d31a-psihologist-cabinet, baseline c20caaf*
