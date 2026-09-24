# Issue #23 — Implementation report (P0 Registration/Login E2E)

**АУДИТОР: САМ** (Producer of this fix), 2026-09-24.  
Независимый Challenger + production Main Re-Audit — **ещё не выполнены**.

**PR #24** = documentation/evidence only — **not** this implementation.

---

## 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Рабочий E2E: email → one-time credential → **real application URL** → verify/exchange → Supabase session → `access_token` → persist → reload → owned business data; different-device; no localhost/`otp_expired` silent failure.

## 2. РЕЗУЛЬТАТ (что изменено)

### Root cause (proven)

1. **OTP/magic-link fallback** when `auth-code` is missing (404/CORS) used Supabase Auth emails with **Site URL often = localhost**.
2. SPA **ignored** bare `#error=otp_expired…` / `#access_token=…` hashes (`routeFromUrl` only `#/…`).
3. **auth-code** letter had **code only** — no app deep-link → other device had no obvious entry; pending localStorage blocked cross-device code entry.
4. OTP request had **no `email_redirect_to`** → GoTrue defaulted to Dashboard Site URL.

### Fix (canonical path preserved)

| Layer | Change |
|-------|--------|
| `js/services/supabaseConfig.js` | `APPLICATION_URL`, `resolveApplicationUrl()`, `resolveAuthEntryUrl()` — never emit loopback for mail/redirect |
| `js/services/supabaseApi.js` | OTP sends `email_redirect_to` → real `#/auth`; `consumeAuthRedirectFromUrl()` parses success/error/PKCE; strips Auth params |
| `js/domain/registration.js` | `consumeAuthRedirect` / `finishAuthenticatedLogin`; cross-device FN verify without pending; expired local pending ≠ other device; friendlier `otp_expired` |
| `js/app.js` boot | **Before** routing: consume Auth redirect → cabinet or auth error UI |
| `js/viewmodels/AuthViewModel.js` | Deep-link `#/auth?email=` → code step on other device |
| `supabase/functions/auth-code` | Letter: code + button to `APP_URL#/auth?email=…`; loopback `APP_URL` rejected |
| `docs/INFRA.md` | `APP_URL` secret + Auth Site URL checklist |
| Tests | registration-flow #23 cases; auth-code-edge letter URL + localhost poka-yoke |

### What was NOT changed

- No new auth system; same `auth-code` → JWT → `auth.uid()` → claim → RLS.
- `key_verifier` / vault / booking / public catalog untouched as product scope.

## 3. ПРОВЕРКА (local)

```text
node tests/registration-flow.mjs   → ALL PASS (incl. cross-device, redirect error/success, OTP redirect)
node tests/auth-code-edge.mjs      → ALL PASS 71
node tests/auth-ui-pending.mjs     → ALL PASS
node tests/db-contract.mjs         → ALL PASS (after npm install)
```

Production E2E (real email / Resend / Dashboard Site URL): **NOT RUN** from this sandbox (no network to supabase.co mail). Owner must:

1. `supabase secrets set APP_URL=https://a1dmitry.github.io/Psihologist-cabinet/`
2. Auth → Site URL + Redirect URLs = same origin (not localhost)
3. Deploy `auth-code`
4. `node tools/prod-e2e.mjs --email …` from owner machine

## 4. E2E chain mapping

| Stage | Status |
|-------|--------|
| Email request | **local proven** (FN + OTP fallback) |
| Credential in mail | **local proven** (code + app link in FN letter) |
| Real application URL | **code proven** (`APPLICATION_URL` / APP_URL poka-yoke); **prod Dashboard Site URL = owner action** |
| Open on other device | **local proven** (no pending → FN verify; deep-link email) |
| Verify/exchange | **local proven** (code path + redirect hash path) |
| Session + access_token | **local proven** |
| Persist + reload | **local proven** (existing restore tests) |
| Owned data / auth.uid() | **local proven** (claim + owner_id) |
| otp_expired UX | **local proven** (consumeAuthRedirect → message, not silent portal) |
| Live production mail click | **unknown / owner** |

## 5. Definition of Done vs this PR

| DoD item | This PR |
|----------|---------|
| Correct application URL in code/mail path | Done (code) |
| Credential accepted / exchanged | Done (code + tests) |
| Session + token + reload | Done (code + tests) |
| Different-device | Done (tests) |
| Anonymous/identity boundary | Unchanged existing tests |
| Production real email E2E | **OPEN — owner / #18** |
| Challenger + Main Re-Audit | **OPEN** |

**#23 stays OPEN until production E2E + Challenger.** This PR is the **implementation** leg, not closure.

## 6. Почему не «только сменили Site URL»

Замена Site URL alone would still leave: silent `#error` hash, no cross-device code path, OTP without redirect_to, letter without app link. All four are fixed in code.
