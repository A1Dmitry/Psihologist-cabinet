# Issue #88 — аудит точек входа психолога (до правок)

> Дата: 2026-09-25. Ветка `arena/01a0d8fc-psihologist-cabinet` @ `d049c17` (до правок этого цикла).
> **АУДИТОР: САМ.** CLAIM в GitHub Issue не опубликован (403 `issues:write`); карточка `.claims/issue-88.EXEC-6_k0M3IcS-.json`.

Канон #88: единственный вход специалиста — Google OAuth → Supabase Auth → `auth.uid()` → свой кабинет. Email/OTP/auth-code для психолога — obsolete, не чинить и не расширять. Клиентский Google при записи (#41, `googleClientAuthService.js`) — другой актор, не удалять.

## Активный продукт (на момент аудита)

| Точка | Файл | Класс | Решение #88 |
|---|---|---|---|
| Кнопка «Войти через Google» + PKCE callback | `js/services/googleAuthService.js`, `js/app.js` boot, `#btn-google-signin` | канон | оставить, сделать единственным UX |
| Онбординг профиля | `#page-onboarding`, RPC `complete_psychologist_profile` | канон | оставить |
| Привязка/создание кабинета | RPC `link_or_create_psychologist_for_google` | канон | оставить |
| Восстановление сессии / срок 30 дней / inactive-gate | `registration.restoreAuthenticatedState`, `loadOwnedProfile`, `signOut` | общее | оставить |
| GIS ID token клиента при записи | `googleClientAuthService.js`, `bookingTriageWizard.js` | #41 | не трогать |

## Obsolete psychologist email/OTP (удалить из активного потока)

| Точка | Потребители | Можно удалять из UX? |
|---|---|---|
| Форма email + «Получить код» + шаг кода + resend + вкладки Вход/Регистрация | `index.html` `#auth-step-email`, `#auth-step-code`, `data-auth-mode` | да |
| `AuthViewModel.requestCode` / `confirmCode` / `resumePendingVerification` | `js/app.js` bindEvents + `renderAuth`; тесты `auth-ui-pending`, часть `verify_auth` | да из UI; доменные методы остаются, пока живы серверные тесты leftover |
| `authService.requestCode` / `verifyCode` | только AuthViewModel | отключить от UI |
| `registration.requestVerification` / `verifyVerification` / `completeVerification` / pending-канал `fn`/`otp` | AuthViewModel, `tests/registration-flow.mjs`, `verify_auth.mjs` | не вызывать из приложения |
| `registration.consumeAuthRedirect` + `supabaseApi.consumeAuthRedirectFromUrl` | `js/app.js` boot (magic-link / `#access_token` / email PKCE без Google verifier) | убрать из boot |
| `supabaseApi.requestLoginCode` / `verifyLoginCode` / `requestEmailOtp` / `verifyEmailOtp` | только registration OTP | не вызывать из приложения |
| Edge Function `auth-code` | клиентский login (больше не должен), `tests/auth-code-edge.mjs`, CORS-контракт, deploy workflow | не вызывать для входа психолога; файл функции не удалять в этом цикле (деплой/удаление — владелец, #35) |
| Диагностика «если код не приходит» | `#auth-diag` | убрать с формы входа |

## Не удалять (другие потребители)

- `persistSession` / `readPersistedSession` / `refreshSession` — Google и reload.
- `exchangeCodeForSession(code, verifier)` — Google PKCE.
- `claim_psychologist_profile` в `schema.sql` и `tests/db-contract.mjs` — leftover SQL, не UI; Google использует другой RPC.
- Сейф клиентов (`initVaultPassword`) — не вход.
- `telegram-notify` — не auth.
