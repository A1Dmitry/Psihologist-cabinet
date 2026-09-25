# Issue #88 — статус (2026-09-25)

## DEBUG PASS (репозиторий)

- `#/auth` — только Google. Формы email/кода, resend, вкладки Вход/Регистрация сняты.
- `js/app.js` не вызывает `requestCode()` / `consumeAuthRedirect()`.
- Возврат OAuth: PKCE, ожидаемые ошибки без stack, unexpected — сообщение + код обращения.
- Клиентский Google при записи (`googleClientAuthService`, #41) не тронут.
- `npm run verify`: зелёный после правки смоука Telegram (outbox после Google-входа).

## PRODUCTION PASS

**BLOCKED — OWNER ACTION REQUIRED.** Агент не меняет Dashboard и не симулирует E2E.

Нужно владельцу:

1. Google Cloud → Authorized redirect URI  
   `https://phiavtroybgwyjdhqqkh.supabase.co/auth/v1/callback`
2. Supabase → Authentication → Providers → Google: включить, Client ID + Secret.
3. Site URL и Redirect URLs = `https://a1dmitry.github.io/Psihologist-cabinet/`
4. SQL Editor: `supabase/migrations/20260925_google_specialist_signup.sql`

LIVE-срез на момент работы: `external.google=false`. DEBUG PASS ≠ PRODUCTION PASS.

Секреты в репозиторий и в чат не класть.

## Не удалялось намеренно

- `js/domain/registration.js` и Edge Function `auth-code` — leftover-тесты (`registration-flow`, `auth-code-edge`, `verify_auth`) ещё гоняют контракт сервера. UI психолога на них не опирается.
