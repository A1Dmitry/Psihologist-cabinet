# Issue #23 — evidence sync: `otp_expired` + localhost email link

> **HISTORICAL REPORT — NOT CURRENT MAIN STATE.** Документ описывает снимок цикла «issue #23 (evidence)»
> (main @ `d41dd35c`, 2026-09-24) и сохранён как история — не переписывается.
> Актуальное состояние — [`CURRENT-STATE.md`](CURRENT-STATE.md).


**АУДИТОР: ВНЕШНИЙ** — Challenger session, 2026-09-24.  
**main SHA:** `d41dd35c12535b17909903665feb55c9530e31a0`  
**Issue:** [#23](https://github.com/A1Dmitry/Psihologist-cabinet/issues/23) (P0 email application URL + session token E2E)  
**Related:** [#18](https://github.com/A1Dmitry/Psihologist-cabinet/issues/18) (production registration E2E)

> **Historical implementation note (updated 2026-09-24):** the original audit below captured a frontend version that had an Auth OTP fallback. That fallback has since been removed for every `auth-code` error, including 404 and status=0. Current behavior is fail-closed; do not use the historical fallback description as current operational guidance. The user-observed localhost URL remains evidence, but its actual email sender is still unknown without production logs.
>
> GitHub integration token cannot comment on Issues (`Resource not accessible by integration`).
> Paste the block «Ready-to-paste comment» into #23 / #18 after reconnecting GitHub write access.

---

## 1. Observed URL (user)

```text
http://localhost:3000/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=
```

| Fragment / part | Value | Meaning |
|-----------------|-------|---------|
| Origin | `http://localhost:3000` | Link target is a **local dev** host — not reachable from another device/email client in the general case |
| `error` | `access_denied` | Supabase Auth denied the redirect session |
| `error_code` | `otp_expired` | OTP / email link invalid or past TTL |
| `error_description` | `Email link is invalid or has expired` | GoTrue human message |
| `sb` | (empty marker) | Supabase Auth redirect fingerprint |

**Status:** **observed** (user-supplied). Not reproduced from this sandbox against live mail.

---

## 2. Mapping to #23 goal chain

| #23 step | This URL |
|----------|----------|
| Email contains URL of real app | **FAIL** — host is `localhost:3000` |
| User opens link | Done (user opened it) |
| App accepts credential | **FAIL** — Auth returned error hash, no tokens |
| Exchange → session access token | **FAIL** — no `access_token` in hash |
| Persist session + cabinet + reload | Not reached |
| Different-device test | **FAIL by construction** — localhost origin |

This is exactly the failure mode #23 describes; it is not a separate defect number.

---

## 3. Evidence and historical implementation (not a proven sender for this email)

### 3.1 Channels present in the repository at the original audit

At the time the observed URL was audited, `js/domain/registration.js → requestVerification` had this behavior:

1. **Primary FN:** Edge Function `auth-code` + Resend. Email body is **only a 6–8 character code** (no app hyperlink). Source: `supabase/functions/auth-code/index.ts` `action === 'request'` HTML.
2. **Historical fallback OTP:** if FN returned **404** or **status 0** (network/CORS), that frontend version called `POST /auth/v1/otp` (`supabaseApi.requestEmailOtp`). Supabase Auth templates could send a magic link to the configured **Site URL**.

```text
Historical frontend only:
auth-code error (404/status=0)
        ↓
VerificationChannel.OTP
        ↓
Supabase email template → Site URL
```

This fallback has now been removed for **all** errors; the current flow fails closed and never makes a second `/auth/v1/otp` request. The historical code path proves a possible source at that revision, **not** which channel sent the particular user-observed message. Production sender requires Auth/Resend logs.

### 3.2 Why `localhost:3000`

Magic-link / confirm redirects use **Supabase Auth → URL configuration → Site URL** (and Redirect URLs allowlist), **not** `window.location` from our SPA at send time.

If Site URL is `http://localhost:3000` (or a leftover local preview), every Auth email link points there — matching the observed URL.

`auth-code` path does **not** embed Site URL in the Resend HTML (code only). Therefore this particular URL shape strongly indicates:

- OTP / dashboard Auth email path, **or**
- an Auth-generated link opened after expiry,

**not** the Resend “code only” template as shipped in repo.

| Claim | Marker |
|-------|--------|
| Resend auth-code HTML has no localhost link | **proven** (function source) |
| OTP fallback on FN 404/0 | **proven in the historical audit revision; removed in current frontend** |
| App ignores bare `#error=…` hash | **proven** (`js/app.js` `routeFromUrl`: only `#/…` paths) |
| Production Site URL actual value | **unknown** (needs Dashboard / #18) |
| Which channel sent *this* message | **unknown** without Resend/Auth logs |

### 3.3 Why `otp_expired`

GoTrue rejects the one-time link (TTL, already used, or malformed). In the original observation the hash carried the error and no session token was issued. Production Auth configuration/channel remain unknown.

### 3.4 UX gap at observation time (local fix exists; production unverified)

```text
Original behavior:
error hash → routeFromUrl() ignores it → no auth error message
```

The current SPA boot parses Auth error/success redirects, displays a friendly error, strips Auth parameters and routes to auth; local regression tests cover this. Production email → callback/session remains unverified. The custom psychologist login flow now fails closed and does not request Supabase Auth OTP after an `auth-code` error.

---

## 4. What #23 must fix (sync checklist — do not expand scope)

Aligned with issue body; ordered by evidence:

1. **Find link source** — Dashboard Site URL + email templates + Auth/Resend/function logs. The current frontend has no OTP fallback; determine whether the observed link came from a historical/stale frontend or the separate signup/legacy Auth flow. Do not “fix” only client text.
2. **Application URL** — single env-specific source (Pages URL / custom domain). Forbid localhost in any user-facing Auth email link. Document in `docs/INFRA.md` (Site URL + Redirect URLs).
3. **Use the canonical login-code function in prod** — deploy `auth-code`, `RESEND_API_KEY`, `MAIL_FROM` so the existing `auth_login_codes` code is entered in the SPA (`#/auth`). If the function fails, fail closed; do not switch to Supabase Auth OTP. Supabase Auth confirmation for the separate `signUp` flow must use the real app callback and PKCE.
4. **Session token** — existing manual-login chain stays canonical:
   - `auth-code`: code → `verify` → `hashed_token` → `POST /auth/v1/verify` → `persistSession`
   - Signup confirmation: Auth callback/PKCE → verified session → secure invitation bind (not yet complete).
   - Do **not** invent parallel auth; do **not** use `key_verifier` as login credential or Auth OTP as a login fallback.
5. **Hash error handler** — locally implemented: detect `error` / `error_code` / `error_description`, show `friendlyAuthError`, strip Auth params, navigate to auth. Keep the production callback/session E2E open until proven.
6. **E2E** — registration + login + different-device + reload session + anonymous boundary (as in #23 DoD). Overlaps #18 production proof.

**Out of scope (per #23):** vault/`key_verifier`, booking (#21), `client_risks` (#22), docs rewrite (#19) beyond INFRA Site URL note.

---

## 5. Relation to #18

| #18 item | This evidence |
|----------|----------------|
| Deploy auth-code | If missing/misconfigured → fail-closed login error; current frontend does not send a Supabase Auth OTP fallback |
| Resend real OTP | FN path avoids Auth magic-link URL entirely |
| Real E2E to cabinet | Blocked while email links die on localhost / otp_expired |
| Reload session | Not reachable until token obtained |

#18 remains the production activation umbrella; **#23 is the concrete auth-link/session defect** proven by this URL. Do not close either on “docs only”.

---

## 6. Ready-to-paste comment for GitHub #23

```markdown
## Observed evidence (sync 2026-09-24)

User opened after email:

`http://localhost:3000/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=`

### Proves
- Email used **Auth redirect link** (not only Resend 6–8 char code from `auth-code`).
- **Site URL / redirect = localhost:3000** → breaks different-device and production.
- GoTrue: `otp_expired` → **no session token**.
- At the time of the observation, SPA **ignored** `#error=…` (`routeFromUrl` only `#/…`); the current local code parses the Auth error and shows a message, but production E2E remains open.

### Repository context (historical vs current)
- The original audit revision had `auth-code` 404/status=0 → Supabase Auth OTP fallback; this code path is now removed for all errors. Current `requestVerification` fails closed and never calls `/auth/v1/otp`.
- `auth-code` Resend HTML is code-only (no link). The observed localhost URL indicates an Auth-generated link, but the exact email channel and production Site URL need Auth/Resend logs and Dashboard confirmation.
- Full write-up: `docs/ISSUE-23-EVIDENCE.md` (includes the historical behavior note).

### DoD unchanged
Full E2E session + non-localhost application URL + different-device — not only “message says expired”.
```

---

## 7. Ready-to-paste comment for GitHub #18

```markdown
## Cross-link: live email→session failure

`localhost:3000/#error=access_denied&error_code=otp_expired&…`

Blocks registration E2E leg (email → token → cabinet). Detail and code map: **#23** + `docs/ISSUE-23-EVIDENCE.md`.
Does not replace schema/deploy/Resend checklist; it is concrete failure evidence for the mail/session step.
```

---

## 8. Implementation (follow-up)

Code fix for the chain above: **`docs/ISSUE-23-IMPLEMENTATION.md`** (same branch / later PR).  
PR #24 remains **evidence-only** and must not be treated as DoD.

Closing #23 still requires: production E2E (real mail) + Challenger + Main Re-Audit on post-fix `main` SHA.
