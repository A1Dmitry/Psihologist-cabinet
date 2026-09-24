# Чек-лист владельца: довести прод до рабочего состояния и закрыть #14

> Составлен 2026-09-24 по итогам аудита. Ваше состояние: проект Supabase создан,
> схема/seed не применены, функции не деплоились, Resend не настроен, секреты CI
> не заданы. Порядок строгий: 1 → 2 → 3 → 4 → 5. Токены и ключи **в чат не
> вставлять** — только в соответствующие сервисы.
> Финальная цель: реальный E2E регистрации + закрытие issue #14 по факту.

---

## Блок 0 — GitHub: права на Issues (2 минуты)

Токен текущей интеграции Arena не может писать в ишью (нужно закрыть #7/#11/#15/#8,
оставить статус в #14; тексты готовы в `docs/ISSUE-TRIAGE-2026-09-24.md`).

1. Откройте настройки GitHub-соединения в Arena (Accounts / Connections).
2. Переподключите `A1Dmitry` с расширенными правами репозитория (**Issues: Read and write**;
   заодно проверьте: Contents: Read & write, Metadata: Read — уже есть).
3. Напишите в чат «GitHub переподключён» — я проверю права через API и применю триаж.

---

## Блок 1 — Секреты деплоя CI (5 минут) — `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID`

Без этого деплой-workflow всегда уходит в skip (проверено: все запуски, включая
последний 35979360714, — «Skip when credentials are not configured»).

1. **Взять токен Supabase:** откройте https://supabase.com/dashboard/account/tokens
   → **Generate new token** → имя, например `psi-cabinet-ci` → скопируйте
   токен `sbp_…` (показывается один раз; это полный доступ к вашим проектам —
   никому не пересылайте, в репо/чат не вставляйте).
2. **Secret:** откройте https://github.com/A1Dmitry/Psihologist-cabinet/settings/secrets/actions
   → **New repository secret** → Name: `SUPABASE_ACCESS_TOKEN`, Secret: `sbp_…` → Add secret.
3. **Variable:** там же вкладка **Variables** → **New repository variable** →
   Name: `SUPABASE_PROJECT_ID`, Value: `phiavtroybgwyjdhqqkh` → Add variable.
4. **Запустить деплой:** https://github.com/A1Dmitry/Psihologist-cabinet/actions/workflows/supabase-deploy.yml
   → **Run workflow** (ветка main) → дождаться завершения.
   ✅ Признак успеха: шаги `Checkout / Setup Supabase CLI / Deploy functions /
   Smoke check` — зелёные **не skipped**; в логе `auth-code -> HTTP 400` и
   `telegram-notify -> HTTP 400` (400 = функция отвечает; 404/401 — ошибка).
   (Деплой функций до применения схемы безвреден: функция ответит legacy-режимом,
   пока не применён Блок 2.)

Альтернатива без CI (если предпочитаете руками):
```bash
npm i -g supabase && supabase login        # откроет браузер для входа
supabase functions deploy auth-code --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt
supabase functions deploy telegram-notify --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt
```

---

## Блок 2 — Схема и данные (10 минут)

> До применения схемы RPC `claim_psychologist_profile` в проде **не существует** —
> это корневая причина неработавшей регистрации. Скрипт идемпотентен.

1. Откройте Supabase Dashboard → проект `phiavtroybgwyjdhqqkh` → **SQL Editor** → **New query**.
2. Вставьте **целиком** содержимое `supabase/schema.sql` (из репозитория) → **Run**.
   Ожидание: «Success. No rows returned». Ошибки `already exists` — норма
   (идемпотентность), любые другие — пришлите текст сюда.
3. Там же выполните `supabase/seed.sql` (целиком) — референс-профиль специалиста.
4. **Ловушка первого входа** (важно): seed-профиль имеет технический email. Если
   специалист будет входить с адреса `mikhailouskayanataliya@gmail.com`, выполните:
   ```sql
   update psychologists set email = 'mikhailouskayanataliya@gmail.com' where id = 'psy_catalog_19';
   ```
   Иначе её первый вход создаст НОВЫЙ пустой профиль-дубликат каталожного.

---

## Блок 3 — Resend и секреты почты (15–20 минут, DNS может занимать часы)

1. Аккаунт на https://resend.com → **Domains → Add Domain** → домен портала →
   добавить DNS-записи (SPF/DKIM, Resend покажет какие) → дождаться **Verified**.
   ⏳ Пока домен не верифицирован, Resend доставляет письма **только на email
   владельца аккаунта Resend** — для E2E этого достаточно (см. Блок 5).
2. **API-ключ:** Resend → **API Keys → Create API Key** → скопируйте `re_…`.
3. **Секреты в Supabase:** Dashboard → **Project Settings → Edge Functions → Secrets**
   (или CLI: `supabase secrets set …`):
   - `RESEND_API_KEY` = `re_…`
   - `MAIL_FROM` = до верификации домена: `PsyПортал <onboarding@resend.dev>`;
     после — `PsyПортал <login@ваш-домен>`.
   Секреты в чат/репозиторий не вставлять.

---

## Блок 4 — Контрольная диагностика (1 минута, на вашей машине)

```bash
cd Psihologist-cabinet && node tools/prod-e2e.mjs
```
Ожидание — все строки ✅: REST, public_profiles, новые колонки, create_booking,
claim_psychologist_profile, Edge Function auth-code, схема SR-004.
Если что-то ⛔ — подсказка печатается рядом; пришлите вывод в чат.

---

## Блок 5 — Реальный E2E регистрации (5 минут)

**Тестовый email (предлагаю):** `mikhailouskayanataliya+e2e@gmail.com`
— плюс-алиас вашего gmail: письма падают в тот же ящик, но для Supabase это
отдельный email → создаётся чистый тестовый профиль, каталожная запись
`psy_catalog_19` не затрагивается. ⚠️ Условие: этот адрес — владелец аккаунта
Resend (или домен уже верифицирован), иначе письмо не уйдёт.
Хотите другой — просто скажите, какой использовать.

```bash
node tools/prod-e2e.mjs --email mikhailouskayanataliya+e2e@gmail.com
```

Скрипт: запросит код → вы вводите его из письма (окно 2 минуты) → 20 проверок
(Auth-сессия, `owner_id == auth.uid()`, поля профиля, reload, повторный вход без
дубля, неверный/повторный код). Код из письма и токены не печатаются — вывод
можно целиком прислать в чат или приложить к issue #14.
SQL для удаления тестового профиля печатается в конце (по желанию).

Ожидание: `ИТОГ: 20 PASS, 0 FAIL`.

---

## Блок 6 — Финализация (на мне, после ваших блоков)

1. Проверяю CI-прогон деплоя через GitHub API (шаги не skipped, smoke — 400).
2. Применяю триаж: закрываю #7, #11, #15, #8 с комментариями аудита; в #14 —
   итоговый статус с вашим E2E-выводом и закрываю по факту.
3. Обновляю `docs/INFRA.md` (статусы ⏳/⛔ → ✅) и `docs/ISSUE-14-REPORT.md`.

Мини-реклама процесса: всё это — ровно цикл Toyota Quality Gate из RULES §6
(defect → root cause → fix → тесты → независимый Challenger → Main Re-Audit →
production-подтверждение), применённый к #14.
