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

> **Канон после #88 (коррекция #35 от 2026-09-25):** вход специалиста — только
> Google OAuth через Supabase Auth. Почтовый код входа отменён, поэтому
> `auth-code` **не деплоится**: единственная публикуемая функция —
> `telegram-notify` (серверные уведомления владельца). Если `auth-code` уже
> была задеплоена ранее — удалите её (Dashboard → Edge Functions → Delete, или
> `supabase functions delete auth-code --project-ref phiavtroybgwyjdhqqkh`):
> проверка в CI трактует отвечающую `auth-code` как возрождение отменённого
> пути входа и краснеет.

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
   Smoke check` — зелёные **не skipped**; в логе `telegram-notify -> HTTP 400`
   (400 = функция отвечает; 404/401 — ошибка) и `auth-code (снята) -> HTTP 404`
   (404 = снятой функции в проде нет, это норма).
   (Деплой функции до применения схемы безвреден: `telegram-notify` не зависит
   от схемы; Блок 2 нужен для записи и кабинета.)

Альтернатива без CI (если предпочитаете руками):
```bash
npm i -g supabase && supabase login        # откроет браузер для входа
supabase functions deploy telegram-notify --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt
# auth-code НЕ деплоим: снята по #35/#88. Если была задеплоена — удалить:
supabase functions delete auth-code --project-ref phiavtroybgwyjdhqqkh
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
4. **Временная мера, если нужен КОД в письме прямо сейчас (2 минуты, без деплоя).**
   Пока `auth-code` не задеплоена, клиент работает запасным каналом — встроенной
   почтой Supabase Auth, а её шаблон **Magic Link** по умолчанию рендерит только
   `{{ .ConfirmationURL }}`, то есть присылает ССЫЛКУ (именно так и было
   2026-09-25: ссылка пришла, кода в письме не было).
   Dashboard → **Authentication → Emails (Email Templates) → Magic Link** →
   добавьте в тело письма строку с `{{ .Token }}` (шестизначный код) и сохраните.
   После этого то же письмо содержит и ссылку, и код: код можно ввести на другом
   устройстве (получить на телефон → ввести на ПК) — поле ввода уже в форме.
   Проверка: `#/auth` → «Получить код» → в письме виден 6-значный код → ввести.
   Это НЕ замена Блокам 1–3: основной канал (`auth-code` + Resend) даёт код
   6–8 символов, одноразовость в БД и окно 2 минуты.

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

---

## Блок 7 — Production inspection SQL (issue #46, TASK 1) — read-only, 2 минуты

Зачем: канал исполнителя (PostgREST с публичным anon key) различает «объекта нет»
и «объект есть, но anon закрыт» не для всех случаев — в частности, он не видит
`pg_proc`, гранты EXECUTE и список RLS-политик. Этот блок закрывает разрыв.
**Все запросы только читают** — выполнять в SQL Editor проекта
`phiavtroybgwyjdhqqkh`, вывод можно целиком приложить к issue #46 (секретов и PII
в выводе нет, кроме email специалистов в п.7 — при необходимости замените).

```sql
-- 1) RPC: фактические сигнатуры и overload-набор (снимает вопрос «единственная
--    ли signature у create_booking»). Ожидание после Блока 2: ровно одна строка
--    на каждую функцию, у create_booking — 22 аргумента.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_booking','claim_psychologist_profile','is_active_own_psychologist')
order by p.proname, args;

-- 2) Гранты EXECUTE. Ожидание: create_booking → anon_exec = true,
--    claim_psychologist_profile → anon_exec = false, auth_exec = true.
--    ВАЖНО: проверяем по pg_proc.proacl / has_function_privilege, а НЕ по
--    information_schema.routine_privileges — этот view фильтруется по текущему
--    пользователю и гранты anon/authenticated не показывает (проверено на
--    PostgreSQL 18.4: выдаёт только service_role, хотя anon EXECUTE имеет).
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       coalesce(array_to_string(p.proacl, ' | '), '(proacl NULL = EXECUTE у PUBLIC)') as acl,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_booking','claim_psychologist_profile','is_active_own_psychologist')
order by p.proname;

-- 3) SR-004: колонки auth_login_codes (без них auth-code работает в legacy-режиме).
--    Ожидание: issued_token_hash, issues, consumed_at присутствуют.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'auth_login_codes'
order by ordinal_position;

-- 4) D1: объекты политики доступности. Ожидание: schedule_overrides (BASE TABLE)
--    и public_schedule_overrides (VIEW) присутствуют.
select table_name, table_type
from information_schema.tables
where table_schema = 'public'
  and table_name in ('schedule_overrides','public_schedule_overrides',
                     'booking_attempts','client_error_logs')
order by table_name;

-- 5) RLS: включён ли и какие политики. Ожидание: у приватных таблиц relrowsecurity=t
--    и политики owner_select/owner_modify/... ; у client_risks — RLS без политик.
select c.relname,
       c.relrowsecurity,
       coalesce(string_agg(p.polname || ' [' || p.polcmd || ']', '; ' order by p.polname),
                '(нет политик)') as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public' and c.relkind in ('r','v','m')
group by c.relname, c.relrowsecurity
order by c.relname;

-- 6) Гранты на таблицы для anon/authenticated. Ожидание: у anon НЕТ select на
--    clients/sessions/payments/client_risks/booking_attempts; есть — только на
--    public_* и client_error_logs (insert).
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated')
group by table_name, grantee
order by table_name, grantee;

-- 7) Ownership: каждый кабинет привязан к auth.uid() и активен ли он.
--    Ожидание: owner_id заполнен у тех, кто входил; owner_id IS NULL = кабинет
--    ещё не привязан (вход создаст привязку, а не дубль).
select p.id, p.is_active, p.owner_id, u.email as auth_email, u.created_at as auth_created
from public.psychologists p
left join auth.users u on u.id = p.owner_id
order by p.created_at;

-- 8) Серверный срок сессии (issue #40, п.7): конфигурация GoTrue, если доступна.
--    Ожидание: jwt_exp ≤ 2592000 (30 дней) либо включённый session timebox.
select * from auth.config;
```

Интерпретация «до/после»: фактическое состояние **до** применения схемы зафиксировано
в `docs/ISSUE-46-EVIDENCE.md` (прогон `Production read-only probe`): SR-004 и D1
отсутствуют, `create_booking` для anon недоступен. После Блока 2 повторите Блок 7
и прогон probe — drift должен исчезнуть.

---

## Блок 8 — Срок сессии не больше месяца (issue #40, п.7 / #46)

Клиентская граница уже реализована (`js/domain/registration.js`:
`MAX_SESSION_AGE_DAYS = 30`, отсчёт от первой выдачи, refresh его не удлиняет).
Серверную границу задаёт владелец:

1. Dashboard → **Authentication → Providers → Email** (или **Auth → Settings**):
   **JWT expiry / session timebox** — не больше 30 дней.
2. Проверка — запросом 8 в Блоке 7.
3. Если настройка недоступна в вашем тарифе/версии — зафиксируйте это в issue #46:
   клиентская граница остаётся единственной, и это нужно отметить как остаточный риск.

---

## Блок 9 — Что осталось, чтобы закрыть #46 (пошагово, ~15 минут)

Срез прода 2026-09-25 05:53Z (`Production read-only probe`): **схема применена**
(SR-004 и SR-D1 появились в 05:14Z), блокеров осталось два — Edge Functions и
`create_booking` для anon. Порядок строгий.

### Шаг 1. Деплой функций (Блок 1) — снимает 2 из 4 drift-зондов

```bash
# secrets/variables: Settings → Secrets and variables → Actions
#   Secret   SUPABASE_ACCESS_TOKEN   (supabase.com/dashboard/account/tokens)
#   Variable SUPABASE_PROJECT_ID     = phiavtroybgwyjdhqqkh
# затем: Actions → «Deploy Supabase Edge Functions» → Run workflow
# Вручную то же самое:
supabase functions deploy auth-code      --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt
supabase functions deploy telegram-notify --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt
```

Проверка (без секретов, можно из браузера):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://phiavtroybgwyjdhqqkh.supabase.co/functions/v1/auth-code \
  -H "Content-Type: application/json" -d '{}'
# ожидание: 400 (валидация функции). 404 = всё ещё не задеплоена.
```

### Шаг 2. Секреты функций: `RESEND_API_KEY`, `MAIL_FROM`, `APP_URL` (Блок 3)

Задайте `APP_URL` как подтверждённый владельцем production root URL (не localhost; функция localhost отбрасывает). `https://a1dmitry.github.io/Psihologist-cabinet/` встречается в исходниках, но считать его лишь кандидатом и подтвердить перед установкой секрета.

### Шаг 3. SQL по `create_booking` (Блок 7, запросы 1–2) — снимает 2 из 4 drift-зондов

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'create_booking';
```

- **Ровно одна строка, 22 аргумента, `anon_exec = true`** → сигнатура и грант в
  порядке, а PostgREST просто помнит старый кэш. Выполните:

  ```sql
  notify pgrst, 'reload schema';
  ```

  затем повторите probe (Шаг 5). Если `PGRST202` остался — приложите вывод
  запроса к issue #46: значит арность/дефолты расходятся с репозиторием.
- **Строк больше одной или арность ≠ 22** → схема применена не целиком: снова
  примените `supabase/schema.sql` целиком (он снимает перегрузки динамически).
- **`anon_exec = false`** → грант не доехал: примените схему целиком.

### Шаг 4. Auth → URL Configuration (Блоки 4 и 8)

Site URL и Redirect URLs = подтверждённый production origin и точный callback; не копировать URL-кандидат из исходников до подтверждения владельцем. JWT expiry / session timebox ≤ 30 дней.

### Шаг 5. Доказательства (в этом порядке)

```bash
# 5.1 внешний срез прода: ждём «измерено: 26/26» и drift 0
#     Actions → «Production read-only probe» → Run workflow (или любой PR/расписание в 06:35 UTC)
# 5.2 текущий production E2E ручного auth-code (нужен доступ к ящику)
node tools/prod-e2e.mjs --email <тестовый@ящик>
```

Ожидание ручного сценария: `ИТОГ: N PASS, 0 FAIL`, правильный `psychologist.id` и
`owner_id` из проверенного Auth token. Токены/коды в issue не вставлять.

**Direct sign-in link — пока BLOCKED:** текущая CTA в `auth-code` письме лишь
открывает `#/auth?email=…` и не аутентифицирует. Не считать её успешным link E2E и
не запускать `tools/prod-e2e.mjs --link` на ней. После реализации серверного
одноразового link-flow выполнить отдельный реальный E2E: code и direct link из
того же письма должны привести к одной practice identity, а второй способ после
погашения challenge не должен создать повторную сессию.

### Шаг 6. Закрытие

- приложить к #46 вывод Шагов 1, 3, 5 (класс `LIVE EVIDENCE`);
- закрыть #46, #36 и #51 по готовому evidence (`docs/ISSUE-46-EVIDENCE.md` §6.1,
  `docs/ISSUE-46-CHALLENGER.md`, PR #53);
- если Шаг 3 показал расхождение арности/гранта — `create_booking` остаётся
  P1-дефектом: открыть отдельный issue с выводом SQL, #46 не закрывать.

### Что изменилось в репозитории (облегчает закрытие)

- `supabase-deploy.yml` теперь **краснеет**, если функции не отвечают в проде
  (раньше был зелёным без деплоя), и запускается после проектного гейта;
- `Production read-only probe` **краснеет**, если измерений не было
  (`unreachable > 0`), и печатает покрытие «измерено: N/26»;
- гейт краснеет на набор без проверок (silent) и на `FAIL` в любом отступе —
  «зелёный CI» больше не может маскировать провал.
