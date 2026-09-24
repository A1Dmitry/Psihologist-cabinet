# Issue #23 — evidence sync: `otp_expired` + localhost email link

> **HISTORICAL REPORT — NOT CURRENT MAIN STATE.** Документ описывает снимок цикла «issue #23 (evidence)»
> (main @ `d41dd35c`, 2026-09-24) и сохранён как история — не переписывается.
> Актуальное состояние — [`CURRENT-STATE.md`](CURRENT-STATE.md).


**АУДИТОР: ВНЕШНИЙ** — Challenger session, 2026-09-24.  
**main SHA:** `d41dd35c12535b17909903665feb55c9530e31a0`  
**Issue:** [#23](https://github.com/A1Dmitry/Psihologist-cabinet/issues/23) (P0 email application URL + session token E2E)  
**Related:** [#18](https://github.com/A1Dmitry/Psihologist-cabinet/issues/18) (production registration E2E)

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

## 3. Root cause (proven in repo + observed URL)

### 3.1 Two email channels

Canonical design (`js/domain/registration.js` → `requestVerification`):

1. **Primary FN:** Edge Function `auth-code` + Resend.  
   Email body is **only a 6–8 character code** (no app hyperlink).  
   Source: `supabase/functions/auth-code/index.ts` `action === 'request'` HTML.
2. **Fallback OTP:** if FN returns **404** or **status 0** (network/CORS when function missing), client calls `POST /auth/v1/otp` (`supabaseApi.requestEmailOtp`).  
   Email content = **Supabase Auth templates** (often magic link → **Site URL**).

```text
auth-code missing/unreachable
        ↓
VerificationChannel.OTP
        ↓
Supabase email (magic link / OTP link)
        ↓
redirect to Site URL + #error=… or #access_token=…
```

INFRA already warns: undeployed `auth-code` surfaces as browser CORS, then silent OTP fallback.

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
| OTP fallback on FN 404/0 | **proven** (`registration.js`) |
| App ignores bare `#error=…` hash | **proven** (`js/app.js` `routeFromUrl`: only `#/…` paths) |
| Production Site URL actual value | **unknown** (needs Dashboard / #18) |
| Which channel sent *this* message | **unknown** without Resend/Auth logs |

### 3.3 Why `otp_expired`

GoTrue rejects the one-time link (TTL, already used, or malformed). Hash carries the error; SPA never exchanges a session.  
`friendlyAuthError` already maps `otp_expired` → «Код истёк…», but **nothing calls it** for URL hash errors on boot.

### 3.4 UX gap (same issue)

```text
User lands on http://localhost:3000/#error=access_denied&error_code=otp_expired&…
        ↓
routeFromUrl() → hash does not start with "/" → portal
        ↓
No toast / auth screen message
```

Poka-Yoke for #23: parse Auth error (and success) hashes once at boot.

---

## 4. What #23 must fix (sync checklist — do not expand scope)

Aligned with issue body; ordered by evidence:

1. **Find link source** — Dashboard Site URL + email templates + whether production hits OTP fallback (`auth-code` deploy). Do not “fix” only client text.
2. **Application URL** — single env-specific source (Pages URL / custom domain). Forbid localhost in any user-facing Auth email link. Document in `docs/INFRA.md` (Site URL + Redirect URLs).
3. **Prefer FN channel in prod** — deploy `auth-code`, `RESEND_API_KEY`, `MAIL_FROM` so users get **code entry in SPA** (`#/auth`), not magic-link to Site URL. OTP remains emergency only; if kept, templates must use real app URL + PKCE/verify path that SPA handles.
4. **Session token** — existing chain stays canonical:
   - FN: code → `verify` → `hashed_token` → `POST /auth/v1/verify` → `persistSession`
   - OTP/link success: parse hash/query → same `persistSession` → `claimOrCreatePsychologist` / `resumeSession`
   - Do **not** invent parallel auth; do **not** use `key_verifier` as login credential.
5. **Hash error handler** — on load/hashchange, detect `error` / `error_code` / `error_description`, show `friendlyAuthError`, strip hash, navigate `#/auth`.
6. **E2E** — registration + login + different-device + reload session + anonymous boundary (as in #23 DoD). Overlaps #18 production proof.

**Out of scope (per #23):** vault/`key_verifier`, booking (#21), `client_risks` (#22), docs rewrite (#19) beyond INFRA Site URL note.

---

## 5. Relation to #18

| #18 item | This evidence |
|----------|----------------|
| Deploy auth-code | If not deployed → OTP fallback → magic links → localhost risk |
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
- SPA **ignores** `#error=…` (`routeFromUrl` only `#/…`) → silent portal.

### Root cause (repo)
- `requestVerification`: FN 404/0 → OTP fallback (`requestEmailOtp`) → Supabase email templates → Site URL.
- `auth-code` Resend HTML is code-only (no link) — this URL shape ⇒ OTP/dashboard Auth path or expired Auth link.
- Full write-up: `docs/ISSUE-23-EVIDENCE.md` @ main (after merge of evidence commit).

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
