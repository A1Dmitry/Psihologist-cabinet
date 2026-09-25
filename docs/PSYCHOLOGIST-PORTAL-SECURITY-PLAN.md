# Безопасная регистрация и кабинет психолога — аудит и план

Дата: 2026-09-24

АУДИТОР: САМ — чтение репозитория, проверка SQL-контракта локальным набором; production Supabase не опрашивался.

## 1. Границы проверки

Проверены `supabase/schema.sql`, `supabase/functions/auth-code/index.ts`, `js/services/supabaseApi.js`, `js/domain/registration.js`, `js/viewmodels/AuthViewModel.js`, `index.html`, `.github/workflows/pages.yml`, `docs/INFRA.md`, `docs/SCHEMA-REQUESTS.md` и `tests/`.

Это аудит **текущих исходников**, а не фактической production-базы. В `docs/INFRA.md` снимок от 2026-09-23 помечает полное применение `schema.sql` и deploy `auth-code` как ожидающие владельца. Состояние Dashboard и развернутых функций на 2026-09-24 неизвестно; не выполнять выводов об их фактическом наличии.

## 2. Карта фактической схемы

- `public.psychologists` — существующая запись специалиста; `email` уникален, `is_active` есть. Связь с Auth уже представлена как `owner_id uuid references auth.users(id)`. Уникального ограничения/индекса на непустой `owner_id` в SQL-источнике нет.
- Таблицы invitation-кодов нет. `auth_login_codes` — отдельная короткоживущая таблица OTP-входа (хеш кода, TTL, attempts, used-state); использовать её для привязки профиля нельзя. `email_codes` также не является invitation-контрактом.
- Таблицы `requests` нет: текущие записи/заявки на приём находятся в `sessions`, связанные с `psychologist_id`. Связанные сущности включают `clients`, `services`, `session_settings`, `payments`, `waiting_items`, `booking_attempts`, `session_reminders`, `schedule_blocks`, `schedule_overrides`, `tasks`, `psy_notes`, `client_entries`. Отдельных таблиц сообщений/вложений в текущем `schema.sql` нет; `client_requests`, `client_materials`, `client_documents` существуют пока только как будущие SR-заявки.
- Для перечисленных приватных таблиц схема создаёт `owner_all` RLS-политики через `psychologists.owner_id = auth.uid()`. Индексы ведущего `psychologist_id` уже есть у `services`, `clients`, `sessions`, `schedule_blocks`, `tasks`, `psy_notes`, `client_entries`; `session_settings.psychologist_id` — PK, `schedule_overrides` индексирован по `(psychologist_id, date)`. В SQL-источнике не видно соответствующих индексов у `payments`, `waiting_items`, `booking_attempts`, `session_reminders`.
- `client_risks` закрыт RLS без пользовательских политик; `client_error_logs` имеет узкий INSERT grant; коды предназначены для серверной работы. Для production grants и default privileges нужна отдельная проверка из Dashboard/SQL Editor.
- Публичные views: `public_profiles`, `public_settings`, `public_schedule_blocks`, `public_schedule_overrides`, `public_booked_slots`. Они доступны anon/authenticated и созданы без `security_invoker`; `public_profiles` не фильтрует `is_active` в SQL. Поля `owner_id`, login `email` и `key_verifier` в это view не включены. Это публичный каталог, не интерфейс для claim; его набор колонок и active-фильтр следует зафиксировать отдельно.

## 3. Существенные дефекты текущего исходника

1. `claim_psychologist_profile(p_email, ...)` берёт владельца из `auth.uid()`, но целевую строку ищет по `p_email`, полученному от клиента, и не сравнивает его с email из `auth.users`. Если эта версия RPC развернута, пользователь со своим Auth JWT может указать email ещё не привязанного психолога; после присвоения `owner_id` owner-RLS потенциально откроет ему профиль и связанные данные. Это **потенциальный P1**, наличие функции в production не подтверждено.
2. Та же RPC создаёт новый профиль при отсутствии совпадения и устанавливает существующей записи `is_active = true`. `auth-code` `request` не проверяет активную запись `psychologists` перед выдачей кода/сессии. Это не соответствует allowlist/claim сценарию.
3. RLS `owner_all` не учитывает `is_active`; владельцу разрешены все операции по собственной строке `psychologists`, включая изменение `is_active`. Политики дочерних таблиц проверяют владение `psychologist_id`, но не активность психолога. Гранты и column-level permissions требуют фактической проверки в production.
4. Auth callback в SPA распознаёт `?code=`, но `exchangeCodeForSession()` не хранит и не отправляет PKCE `code_verifier`; одного распознавания authorization code недостаточно для завершения PKCE.
5. GitHub Pages workflow создаёт HTTP-200 маршруты `/auth`, `/cabinet`, `/booking-done`, `/reply`, но не `/auth/callback`. Для указанного callback нужен отдельный статический route в Pages build (одного fallback `404.html` недостаточно для требуемого HTTP 200).
6. Форма регистрации не имеет отдельного пароля Supabase Auth: поле `auth-password` — пароль сейфа клиентов. Стандартный `signUp` требует отдельный Auth-пароль; нельзя переиспользовать пароль сейфа без явного решения.

### Дополнение: CORS и 429 `/auth/v1/otp` (2026-09-24)

Проверены фактические участки `supabase/functions/auth-code/index.ts`, `supabase/config.toml` и `js/domain/registration.js`:

- CORS preflight **уже реализован в исходнике**: `OPTIONS` обрабатывается до method/body, возвращает 200 (успешный 2xx); `Access-Control-Allow-Methods` содержит `POST, OPTIONS`, разрешённые заголовки включают `authorization, x-client-info, apikey, content-type`, helper `json()` добавляет CORS к обычным ответам и ошибкам. `Access-Control-Allow-Origin` сейчас `*`: требуемый `https://a1dmitry.github.io` разрешён, но политика шире exact-origin варианта. Тест `tests/auth-code-edge.mjs` подтверждает `OPTIONS → 200 + CORS`. Локальный исходник не доказывает, что такая версия отвечает в production.
- `supabase/config.toml` уже задаёт `[functions.auth-code] verify_jwt = false`. Клиент до входа отправляет публичный `apikey`, не пользовательский JWT; если production gateway возвращает 401 до запуска кода, проверить фактический deploy/Verify JWT. Runbook-команда: `supabase functions deploy auth-code --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt`. Деплой из этой сессии не выполнялся.
- `requestVerification()` вызывал свой `auth-code`, а затем отправлял отдельный `/auth/v1/otp` fallback. Это два разных механизма; при CORS/потере ответа первая функция могла уже отправить свой код, а клиент — попросить второй. 429 на `/auth/v1/otp` означает отдельный Auth rate-limit, не причину CORS.
- Исправлено в frontend: `auth-code` теперь **единственный канал нового login-code request**; fallback на `/auth/v1/otp` удалён и для `status=0`, и для 404. При неопределённом результате пользователь проверяет почту; повторный запрос тому же email локально блокируется на 30 секунд, а explicit 404/429 показываются как ошибки. Legacy pending OTP можно завершить одним запросом к `/auth/v1/verify` с `type=email`; новые Auth OTP не запрашиваются. Регрессии обновлены в `tests/registration-flow.mjs` и `verify_auth.mjs`.
- Новый invitation-код первичной регистрации — отдельный bind flow после подтверждения email; он не вызывает `/auth/v1/otp` и не заменяет login-code из `auth_login_codes`.
- При `verify_jwt=false` функция публично достижима до входа. Сейчас в исходнике есть 30-секундный cooldown на email и лимит попыток кода, но нет IP-based rate limit/CAPTCHA. Добавить серверное ограничение по доверенному IP и CAPTCHA/эквивалент до включения публичного потока; `SUPABASE_SERVICE_ROLE_KEY` остаётся только на сервере.
- Edge Function и production deploy относятся к infra-exclusive зоне Agent 1. Текущий source CORS не переписывался; статус production CORS/JWT gate неизвестен до DevTools OPTIONS + function logs.

## 4. Целевая архитектура

1. Существующая активная запись в `psychologists` заранее создаётся администратором. Email этой записи должен быть актуальным и подтверждаемым. Репозиторий содержит заметку о seed-профиле с placeholder email; такой адрес необходимо исправить до выдачи приглашения.
2. Администратор/сервер выпускает случайный high-entropy invitation-код для конкретного `psychologist_id`. В БД хранится только хеш, срок действия, дата отзыва/использования, попытки и `used_by`; прямые SELECT/INSERT/UPDATE grants для anon/authenticated отсутствуют. Выпуск/отзыв не делается публичным поиском. Для неверных кодов без найденной строки нужен отдельный server-side rate-limit по uid и доверенному edge IP/bucket, с нейтральным ответом и без длительного хранения сырого IP/PII.
3. На первичной регистрации пользователь вводит email и invitation-код; приложение вызывает Supabase Auth `signUp`. Письмо подтверждения должно предлагать два способа продолжения: ввести Auth signup-код вручную (`type='signup'`) либо нажать confirmation link. Это альтернативные способы подтвердить одну Auth-регистрацию, не два аккаунта. Invitation-код хранить только кратковременно в `sessionStorage`, не добавлять в URL/Auth metadata. Если письмо открылось на другом устройстве/без исходного browser state, попросить повторно ввести invitation-код.
4. Ручной signup-код (GoTrue `/auth/v1/verify`, `type='signup'`) и confirmation link (реальный PKCE callback `/auth/callback`) должны оба установить обычную проверенную Supabase Auth session и перейти к одному bind-процессу. Только после этого сервер по проверенному JWT сам определяет uid, требует `email_confirmed_at`, берёт email из Auth, проверяет соответствие `psychologists.email`, активность, отсутствие другого владельца, срок/отзыв/использование invitation-кода. Ни один из этих способов не создаёт профиль до подтверждения и не обходит атомарный bind.
5. В одной транзакции сервер блокирует код и психолога, связывает существующую запись и погашает код. Все ошибки нейтральны. Повтор того же uid может быть идемпотентным; чужой или уже использованный код не должен менять данные.
6. После привязки используется стандартная Supabase session; клиентский фильтр — только UX. Профиль читается через owner RLS; заявки читаются из `sessions` по связке с собственным психологом.
7. По #40 **последующий вход** в email сохраняет ручной код из `auth_login_codes` и добавляет direct одноразовую ссылку из того же письма; оба способа должны вести к одной Supabase Auth session/практике и конкурировать за атомарное погашение одной challenge (кто первый прошёл — инвалидирует второй). Ссылка в `auth-code` письме сейчас только открывает `#/auth?email=…` и не аутентифицирует; для настоящего direct link нужны server-side issue/redeem и, возможно, аддитивная схема Agent 1. Telegram destination берётся только из серверной настройки, Telegram остаётся ручным кодом. Supabase Auth `/auth/v1/otp` не используется как fallback при ошибках `auth-code`.

## 5. Предлагаемые изменения БД/RLS (не применены)

Через Agent 1 / `docs/SCHEMA-REQUESTS.md` подготовить аддитивную миграцию и RPC:

- Новая закрытая таблица `psychologist_invitation_codes` с FK на `psychologists`, уникальным `code_hash`, expiry/revoked/used timestamps, `used_by`, attempts и audit timestamps. Название — проектное предложение, финальное имя определяет Agent 1 после сверки Code First.
- Уникальный частичный индекс на `psychologists.owner_id IS NOT NULL`; до создания выполнить preflight на дубли. Проверить нормализацию email и дубли без автоматического изменения имеющихся записей.
- Транзакционный RPC/Edge Function bind: не принимать user id/profile id/email как доказательство identity; получить uid из проверенной сессии, сверить подтверждённый Auth email и погасить код атомарно. Никаких `INSERT psychologists` или reactivation в bind.
- Разделить RLS/привилегии: profile SELECT — собственная активная запись; обновляемые публичные поля перечислить явно; `owner_id`, login `email`, `is_active` и состояние кода доступны на изменение только серверному/административному пути. Для дочерних таблиц проверять и старую, и новую принадлежность `psychologist_id`.
- Все приватные таблицы должны иметь включённый RLS и минимальные grants. Кодовые таблицы — без пользовательских политик. Для view, которые должны соблюдать caller RLS, выставить `security_invoker`; публичный каталог оставить отдельным узким контрактом с `WHERE is_active = true`, без login email/служебных полей.
- Добавить только отсутствующие индексы для RLS-связей после проверки актуальной production схемы. Не удалять поля/таблицы/данные.

Конкретная SR-006 заявка в `docs/SCHEMA-REQUESTS.md` обновлена. Исполняемая миграция здесь не приложена и не запускалась: schema.sql/RPC/Edge Functions/Pages deployment принадлежат Agent 1; production preflight недоступен из этой среды.

## 6. Frontend и callback

Фактическое приложение — статическая SPA на vanilla JavaScript с hash-router, не Next/React. Целевая база URL из текущего `js/services/supabaseConfig.js` и runbook: `https://a1dmitry.github.io/Psihologist-cabinet/`; пользовательский JSON содержит placeholder домена, поэтому подтвердить смену на кастомный домен нужно до Dashboard-настройки.

Заданный путь `/auth/callback` должен стать реальным Pages route. Callback должен хранить verifier до `signUp`, обменять полученный `code` с `code_verifier`, безопасно очистить параметры URL, проверить Auth session и только затем показать форму invitation-кода/вызвать bind. Нельзя автоматически вызывать текущий `claim_psychologist_profile`.

## 7. Supabase Dashboard (ручные действия после согласования)

Для текущего URL-кандидата:

- **Authentication → URL Configuration → Site URL:** `https://a1dmitry.github.io/Psihologist-cabinet/`.
- **Redirect URLs:** точный `https://a1dmitry.github.io/Psihologist-cabinet/auth/callback`; dev localhost добавлять только как отдельные точные URL для разработки. Не добавлять широкий production wildcard.
- В signup вызывать `signUp` с `emailRedirectTo` равным точному callback.
- Проверить confirmation email template: штатный `{{ .ConfirmationURL }}`/redirect flow, без жёсткого `localhost`; не заменять штатный confirmation URL прямой самодельной ссылкой.
- `auth-code` secret `APP_URL` оставить на корне опубликованного приложения, без localhost. Он относится к существующим OTP-письмам, а не заменяет `emailRedirectTo` для signup.

Site URL, Redirect URLs, email template и развернутую Edge Function из песочницы подтвердить невозможно; секреты присылать не нужно.

## 8. Приёмочные проверки

После изменения Agent 1 добавить тесты/DB harness:

- два разных активных психолога A/B: A видит только свой профиль и свои `sessions`; подмена URL/filter/id не открывает B;
- anon и неподтверждённый/подтверждённый, но не привязанный Auth-пользователь читают ноль приватных строк;
- клиент не может вызвать claim с чужим email, owner id, `psychologist_id`, `is_active` или переназначить `sessions`;
- invite-код: корректный, неверный, истёкший, отозванный, повторный и два параллельных погашения; только один владелец получает связь;
- неактивный психолог не получает код и теряет RLS-доступ сразу после деактивации;
- anon не читает коды/private tables; public views возвращают только утверждённый публичный контракт;
- callback PKCE на same-browser session, неверный/истёкший code, повторный reload, корректная очистка URL;
- проверить production email link и реальную production функцию отдельно от локальных mocks.

Текущие тесты SQL/Auth не доказывают новый invite flow и не покрывают подмену `p_email` при claim; production E2E не выполнен.

## 9. Необходимые решения / блокеры

1. Supabase Auth credentials: добавить отдельный password + confirmation (пароль сейфа не использовать) либо выбрать passwordless flow, который не является буквальным `signUp`. Без этого signup UI не специфицирован.
2. Подтвердить, что production URL остаётся текущим GitHub Pages URL. Если нет — передать только публичный домен и callback path, не ключи.
3. Подтвердить, что issue #40 manual email/Telegram OTP остаётся способом **последующих** входов; в этом плане он сохранён.
4. Определить, как владелец выпускает/отзывает приглашения: доверенная server-only операция без админ-панели предполагается как минимальный вариант.

## 10. Выполнено в этом цикле

- Обновлена заявка SR-006 в `docs/SCHEMA-REQUESTS.md` с invitation-table, atomic bind, allowlist/RLS и callback требованиями.
- Миграции, Edge Functions, Supabase Dashboard, Pages workflow и frontend signup не менялись; production E2E не запускался.
- `npm run verify` после `npm install --no-save --no-package-lock` прошёл: 24 набора зелёные. Первоначальный запуск без локальных devDependencies останавливался на отсутствующем `embedded-postgres`; это было устранено установкой devDependencies без изменения manifest/lockfile.
- `git diff --check` прошёл.
- Попытка обновить GitHub issue #40 комментарием не прошла: `Resource not accessible by integration`; риск зафиксирован локально в SR-006.

## 11. Текущий статус

**ЗАБЛОКИРОВАНО** до решения по Auth password/passwordless и подтверждения production URL, а также интеграции миграции/RPC/Edge/Pages Agent 1. Не использовать текущий `claim_psychologist_profile` для нового signup; если этот вариант функции уже доступен в production, считать регистрацию остановленной до серверного исправления.
