# Инфраструктура продакшена — runbook и статус

> Владелец процесса: Агент 1 (инфраструктура и интеграция).
> Обновлено: 2026-09-23; сверено с main @ `87e3951` 2026-09-24 (issue #19) —
> чек-лист без изменений по фактам (production-проверок из песочницы нет).
> Вопросы/заявки на схему — `docs/SCHEMA-REQUESTS.md`.
> Актуальное состояние проекта — `docs/CURRENT-STATE.md`.
> Фактическое состояние прода (LIVE) снимается read-only зондом
> `tools/prod-probe/probe.mjs` (workflow `Production read-only probe`, отчёт —
> комментарием в PR); интерпретация и полный отчёт — `docs/ISSUE-46-EVIDENCE.md`.

## Архитектура

- **Фронтенд:** статический SPA на GitHub Pages (`A1Dmitry/Psihologist-cabinet`),
  деплой — `.github/workflows/pages.yml`.
- **Бэкенд:** Supabase (Postgres + RLS + Auth + Edge Functions), проект
  `phiavtroybgwyjdhqqkh` (URL и anon key — в `js/services/supabaseConfig.js`;
  anon key публичный by design, секретом не является). Роадмап и регламент
  подключения к БД через официальный Supabase MCP Server см. в
  `docs/ROADMAP-DATABASE-CONNECTION.md`.
- **Почта:** ~~Resend через Edge Function `auth-code` (вход по одноразовому коду)~~
  — **СНЯТО** (#88, коррекция #35 от 2026-09-25): вход специалиста только
  Google OAuth через Supabase Auth, почтовый код входа отменён. Функция
  `auth-code` не деплоится и не должна отвечать в проде; SMTP/Resend для входа
  больше не требуется.
- **Telegram:** Edge Function `telegram-notify` (токен бота только на сервере) —
  единственная функция, которая деплоится.

## Статус продакшена (чек-лист)

| # | Элемент | Статус | Комментарий |
|---|---------|--------|-------------|
| 1 | Проект Supabase | ✅ подтверждён декларативно | ref `phiavtroybgwyjdhqqkh`; anon key выпущен 2026-09-21 (см. `iat` в JWT) — проект свежесозданный. Дашборд-проверку выполняет владелец (у агента песочницы нет сети до supabase.co и access-токена) |
| 2 | `supabase/schema.sql` в проде | ⛔ **критично: переприменить** (drift подтверждён LIVE 2026-09-25: в проде НЕТ SR-004 `auth_login_codes.issued_token_hash/issues/consumed_at`, НЕТ SR-D1 — `schedule_overrides`, `public_schedule_overrides`, `session_settings.min_notice_minutes`, `services.availability`; `create_booking` для anon недоступен → публичная запись не работает. SR-001/SR-003 при этом применены. См. `docs/ISSUE-46-EVIDENCE.md` §2) | идемпотентен, применять целиком в SQL Editor. До 2026-09-23 файл **не применялся целиком**: `revoke`/`grant execute` для `create_booking` описывали старую арность → PostgreSQL обрывал выполнение на 42883, поэтому `claim_psychologist_profile` и `client_error_logs` в проде не существовали (это и есть причина неработающей регистрации). 2026-09-23 исправлено + добавлены `sessions.client_timezone` / `client_utc_offset_min` / `duration_min` (SR-001/108), интервальная занятость + advisory lock в `create_booking` (SR-002), `public_booked_slots.duration_min` (SR-003), `auth_login_codes.issued_token_hash` / `issues` / `consumed_at` (SR-004 — атомарное погашение кода входа, нужно Edge Function `auth-code`). **2026-09-24 (issue #19, main @ `87e3951`): в файл дополнительно вошли SR-D1 (D1: политика/`schedule_overrides`/`public_schedule_overrides`) и фиксы #21/#22 (серверная деривация оплаты/hold в `create_booking`, RLS `client_risks` без политик для `anon`/`authenticated`, `booking_attempts`)** — re-apply по-прежнему обязателен целиком. Проверено на PostgreSQL 18.4: `node tests/db-contract.mjs` (в составе `npm run verify` 22/22, 2026-09-24). **Внимание: миграция удаляет колонку `sessions.timezone_offset` и меняет арность RPC** — подробности в `docs/FULL-AUDIT-REPORT.md` |
| 3 | `supabase/seed.sql` в проде | ✅ решение: накатывать | это реальный референс-профиль Наталии Михайловской, не фиктивное демо. См. «Ловушка первого входа» ниже |
| 4 | Edge Function `auth-code` | ⛔ **не задеплоена** (LIVE 2026-09-25: `GET /functions/v1/auth-code` → `404 NOT_FOUND` gateway; preflight `OPTIONS` → 404 без CORS-заголовков) | см. «Деплой функций». **verify_jwt=false обязателен** (config.toml уже в репо). 2026-09-23 (issue #14): функция переработана — код гасится **после** создания сессии, появились actions `recover` и `redeem`; для атомарного погашения нужны колонки SR-004 (п.2). Без них функция работает в legacy-режиме (ответ `legacy_schema: true`, восстановление сессии недоступно) |
| 5 | Edge Function `telegram-notify` | ⛔ **не задеплоена** (LIVE 2026-09-25: `404 NOT_FOUND`) | то же |
| 6 | Секрет `RESEND_API_KEY` | ⛔ блокер на владельце | нужен аккаунт Resend + **верифицированный домен** (иначе письма уходят только владельцу аккаунта Resend — блокирует T-15) |
| 7 | Секрет `MAIL_FROM` | ⏳ после домена | напр. `PsyПортал <login@ваш-домен>`; без домена — `onboarding@resend.dev` (только на email владельца Resend) |
| 7b | Секрет `APP_URL` + Auth Site URL | ⏳ **обязательно для email links** | Кандидат из исходников `APP_URL=https://a1dmitry.github.io/Psihologist-cabinet/` (не localhost), но production-домен нужно подтвердить у владельца до установки. Dashboard → Authentication → URL Configuration: **Site URL** и **Redirect URLs** = подтверждённый origin. Клиентский канон: `APPLICATION_URL` в `js/services/supabaseConfig.js` |
| 8 | GitHub Pages CI | ✅ готов (исправлено 2026-09-23) | сборка `_site`, `%BASE%`, статические маршруты (200 для deep-links), `404.html`-fallback, post-deploy смоук. ⚠️ 2026-09-23: PR #9 случайно склеил строки в YAML (`- name: … run: |` в одну строку) — деплой молча падал (0s, workflow file issue), сайт показывал устаревшую сборку PR #6. Проверка YAML теперь часть смоука: `npx js-yaml .github/workflows/*.yml` |
| 9 | Логирование ошибок фронтенда | ✅ код готов | `js/services/errorLogService.js` → `client_error_logs` (после применения п.2) |
| 10 | Кастомный домен | ⚪ опционально | инструкция ниже |

Легенда: ✅ готово · ⏳ ждёт действия владельца/настройки · ⛔ блокер · ⚪ опция.

## Развёртывание продакшена с нуля (порядок действий владельца)

1. **Supabase → SQL Editor:** выполнить целиком `supabase/schema.sql`, затем `supabase/seed.sql`.
   Порядок важен: сначала схема, потом деплой функций (п.5) — функции `auth-code`
   нужны колонки SR-004 из схемы. Если функция задеплоена раньше, она не сломается,
   но будет отвечать в legacy-режиме (`legacy_schema: true`) до переприменения схемы.
2. **Ловушка первого входа** ⚠️: в seed email записи — технический
   `catalog+наталья-михайловская-19@example.invalid`. Привязка кабинета при входе
   идёт по email (`claim_psychologist_profile`). Поэтому **до первого входа**
   подставить настоящий email специалиста:
   ```sql
   update psychologists set email = 'mikhailouskayanataliya@gmail.com'
   where id = 'psy_catalog_19';
   ```
   Иначе вход создаст НОВЫЙ пустой профиль дубликатом каталожного.
   (Публичный контактный email `public_email` менять не нужно — он уже настоящий.)
3. **Resend:** завести аккаунт → Domains → Add domain (домен портала/почты) →
   прописать DNS-записи (SPF/DKIM) → дождаться Verified. Без верифицированного
   домена Resend доставляет письма ТОЛЬКО на адрес владельца аккаунта — коды
   входа до специалистов не дойдут (прямой блокер T-15 уведомлений).
4. **Секреты Supabase** (Dashboard → Project Settings → Edge Functions → Secrets,
   или CLI). Важно: URL из исходников ниже — только кандидат `https://a1dmitry.github.io/Psihologist-cabinet/`; подтвердить production-домен у владельца **до** установки секрета или Dashboard URL (не применять placeholder/старый домен вслепую):
   ```bash
   supabase secrets set RESEND_API_KEY=re_...
   supabase secrets set MAIL_FROM="PsyПортал <login@ваш-домен>"
   # Только после подтверждения домена владельцем; значение ниже — не шаблон для копирования:
   supabase secrets set APP_URL="<подтверждённый-владельцем-production-root-url>"
   ```
   `APP_URL` — куда ведёт кнопка «Открыть страницу входа» в письме `auth-code`
   (issue #23). **Не** `http://localhost:…`: письмо открывают на телефоне/другом
   ПК. Если секрет не задан, функция подставляет Pages URL из кода; значение
   `localhost` в секрете отбрасывается (poka-yoke).
   Значения — только здесь. В коде/репозитории секретов Resend не храним.

   **Supabase Auth → URL Configuration** (важно для отдельного `signUp` confirmation-link и legacy Auth links; это не fallback для текущего login-code):
   - Site URL = подтверждённый владельцем production root URL.
   - Redirect URLs allowlist = только точные подтверждённые callback/route URL, которые реально использует приложение; не включать широкий wildcard до отдельного обоснования.
5. **Деплой функций** (один из двух путей):
   - **Из CI (рекомендуется):** в репозитории задать Secret `SUPABASE_ACCESS_TOKEN`
     (supabase.com/dashboard/account/tokens) и Variable `SUPABASE_PROJECT_ID=phiavtroybgwyjdhqqkh`.
     Дальше workflow `.github/workflows/supabase-deploy.yml` деплоит сам при
     каждом изменении `supabase/functions/**` (и умеет ручной запуск).
   - **Вручную:**
     ```bash
     npm i -g supabase && supabase login
     supabase functions deploy telegram-notify --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt
     # auth-code СНЯТА (#35/#88) — не деплоим. Если была задеплоена ранее:
     supabase functions delete auth-code --project-ref phiavtroybgwyjdhqqkh
     ```
     (`verify_jwt=false` зашит и в `supabase/config.toml` — флаг дублирует его на случай старого CLI.
     Секции `[functions.auth-code]` в `config.toml` больше нет: случайный деплой
     снятой функции уедет с `verify_jwt=true`, то есть fail-closed.)
     Функция доступна без пользовательского JWT по назначению; до публичного
     использования нужны server-side IP rate limit и CAPTCHA/эквивалент поверх
     существующих лимитов. Не помещать service-role key
     во frontend или в этот request.

   > **Симптом «функция не задеплоена» в браузере — CORS-ошибка, а не 404.**
   > Preflight-запрос OPTIONS к несуществующей функции получает 404 БЕЗ
   > CORS-заголовков, поэтому консоль показывает
   > `blocked by CORS policy: Response to preflight request doesn't pass access
   > control check: It does not have HTTP ok status`, а `fetch` бросает
   > `TypeError: Failed to fetch`. Проверить напрямую:
   > Если функция не найдена, проверить фактический JSON/HTTP response, production
   > version и function logs; preflight 404 без CORS тоже может отобразиться как
   > browser `TypeError`/status=0. Текущий frontend **fail-closed**: он не вызывает
   > Supabase Auth `/auth/v1/otp` ни при 404, ни при status=0, ни при другой ошибке.
   > Status=0 неоднозначен: POST мог отправить письмо, поэтому сначала проверить
   > почту и не повторять запрос немедленно. Пункт «Диагностика сервера» → «Edge
   > Function auth-code» подсвечивает проблему красным.
   >
   > **Как снять фактический статус и заголовки опубликованного `auth-code`**
   > (браузер их не показывает — только «blocked by CORS policy»):
   > зонд `tools/prod-probe/probe.mjs` повторяет точный запрос браузера
   > (`OPTIONS` + `Origin: https://a1dmitry.github.io` + `Access-Control-Request-*`)
   > и печатает статус ответа и `allow-origin` / `allow-methods` / `allow-headers`.
   > Три неотличимых в консоли состояния он различает:
   > `NOT_DEPLOYED` (gateway 404 без CORS), `PREFLIGHT_BLOCKED(HTTP 401 — verify_jwt?)`
   > и `PREFLIGHT_BAD_CORS` (2xx без нужных заголовков). Ожидание для здорового
   > деплоя — `PREFLIGHT_OK` (200 + `Allow-Origin` + `Allow-Methods: POST, OPTIONS`),
   > см. `supabase/functions/auth-code/index.ts` и `verify_jwt = false`
   > в `supabase/config.toml`. Отчёт публикуется комментарием в PR
   > (workflow `Production read-only probe`), тот же гейт встроен в
   > `supabase-deploy.yml` (шаги «Verify CORS preflight» и «Production reachability»).
   >
   > **Третья причина той же консольной ошибки — слишком узкий allow-list.**
   > Supabase требует, чтобы `Access-Control-Allow-Headers` покрывал ВСЕ заголовки
   > вызывающего клиента (<https://supabase.com/docs/guides/functions/cors>):
   > `x-retry-count` (авто-ретраи postgrest-js) и `traceparent` / `tracestate` /
   > `baggage` (client-side tracing). Функция, задеплоенная с узким списком,
   > перестаёт вызываться из браузера после обновления SDK — лечится только
   > редеплоем, а в консоли выглядит как та же CORS-ошибка. Канонический список
   > объявлен в обеих функциях и запинен: `tests/cors-contract.mjs` (список,
   > равенство контрактов двух функций, покрытие заголовков фронтенда —
   > с falsification-контролем) + поведенческая проверка `OPTIONS`
   > в `tests/auth-code-edge.mjs`.
   >
   > **Единственный ключ в клиентском бандле — publishable/anon.** В панели
   > Supabase `anon public` и `service_role` лежат рядом и отличаются одной
   > подписью JWT; `service_role` в статическом SPA = полный обход RLS (P0,
   > `docs/RULES.md` §6.10). Поэтому `tests/no-committed-secrets.mjs` декодирует
   > КАЖДЫЙ JWT в `index.html` / `js/**` / `css/**` и требует `role=anon` того же
   > проекта, что `SUPABASE_URL` (grep по литералу `service_role` бесполезен:
   > payload закодирован в base64url — первая версия теста содержала именно эту
   > дыру и falsification её не поймал).

   > **Симптом после клика по ссылке из письма (issue #23):**
   > ```
   > http://localhost:…/#error=access_denied&error_code=otp_expired
   > &error_description=Email+link+is+invalid+or+has+expired&sb=
   > ```
   > Это **не** письмо Resend `auth-code` (там только код 6–8 символов, без
   > hyperlink). Так выглядит **magic-link / OTP-redirect Supabase Auth**:
   > Такой адрес означает Auth-generated link (первичный `signUp`/legacy Auth email),
   > а не Resend-код входа; фактический источник и Site URL требуют production logs/
   > Dashboard-проверки. Текущий локальный SPA уже разбирает `#error=…`, но production
   > сборка и signup callback/PKCE остаются непроверенными (см. `docs/ISSUE-23-EVIDENCE.md`).
   >
   > **Обязательная настройка Auth (один раз на проект):**
   > 1. Dashboard → Authentication → URL Configuration:
   >    - **Site URL** = production root URL, подтверждённый владельцем; не `http://localhost:…`.
   >    - **Redirect URLs** — только точные подтверждённые callback/route URL приложения; не добавлять широкий wildcard без отдельного обоснования.
   > 2. Убедиться, что в проде отвечает `auth-code` (п.5), чтобы login-код из
   >    `auth_login_codes` пользователь получил и ввёл на `#/auth`. Если функция
   >    ошибается, приложение показывает ошибку; Supabase Auth OTP не вызывается.
   > 3. Первичная регистрация `signUp` — отдельный поток. Письмо подтверждения
   >    должно поддерживать и ручной signup-код (`type=signup`), и confirmation
   >    link на опубликованный PKCE callback; оба пути продолжают одну регистрацию
   >    и один invitation bind. Production callback/PKCE E2E пока не подтверждены
   >    (см. SR-006); это не fallback для последующего login-code.

6. **Production E2E-проверка legacy auth-code login (issue #14, п.1–2)** — с машины владельца
   (у песочницы агента нет сети до supabase.co):
   ```bash
   node tools/prod-e2e.mjs                         # шаг 1: только диагностика (письма не шлёт)
   node tools/prod-e2e.mjs --email <тестовый@email> # шаг 2: полный E2E, код вводится из письма
   ```
   Скрипт исполняет настоящий текущий `auth-code` login-code path (`js/domain/registration.js →
   supabaseApi`): письмо → собственный код → Auth-сессия → legacy claim/session checks →
   reload и ошибки. Он **не** является доказательством invitation-only `signUp`, PKCE callback,
   безопасного bind или RLS DoD SR-006. Вывод (20 проверок, PASS/FAIL) можно приложить к #14;
   код и токены не печатаются.
   Очистка тестового профиля печатается в конце. Неинтерактивно: `E2E_CODES="код1,код2"`.
   Подробный evidence по localhost/`otp_expired`: `docs/ISSUE-23-EVIDENCE.md`.
7. **Открыть сайт** → нажать «Диагностика сервера» на странице входа — все пункты
   должны быть зелёными; бейдж «Данные: сервер». Для #40 проверить оба варианта из
   email-письма: ручной код и direct одноразовая ссылка должны открыть одну и ту же
   практику; после успеха второй вариант не должен повторно аутентифицировать. До
   реализации server-side link flow текущая кнопка письма лишь открывает `#/auth?email=…`.
   Пункты диагностики, относящиеся к входу:
   - «Edge Function auth-code» — функция задеплоена и отвечает (не 404);
   - «Схема auth_login_codes (SR-004: атомарность кода входа)» — в БД есть
     колонки `issued_token_hash` / `issues` / `consumed_at`. Красный пункт
     означает, что `schema.sql` не переприменён: вход работает, но в
     legacy-режиме (код гасится до создания сессии, восстановление сессии
     после обрыва сети недоступно). Проверка «холостая»: письмо не отправляется,
     данные не меняются.
   - Auth **Site URL** (Dashboard) — реальный production origin, не localhost;
     он нужен confirmation-link отдельного `signUp`/legacy Auth email, но не
     является резервным каналом текущего ручного входа через `auth-code`.
8. **(Опционально) мгновенные Telegram-уведомления:** в `js/services/supabaseConfig.js`
   заполнить `NOTIFY_WEBHOOK_URL = 'https://phiavtroybgwyjdhqqkh.supabase.co/functions/v1/telegram-notify'`.
   Без него уведомления уходят из открытого кабинета (outbox-режим) — не блокер.

## GitHub Pages (`.github/workflows/pages.yml`)

- Сборка: `_site/index.html` с подстановкой `%BASE% → /<repo>/`, `js/`.
- **Deep-links с HTTP 200:** для маршрутов `/cabinet`, `/auth`, `/booking-done`,
  `/reply` и для `/psy/<slug>` + `/book/<slug>` каждого **активного** специалиста
  (view `public_profiles`) создаются реальные папки с `index.html`. Это важно для
  SEO: `404.html`-fallback от GitHub Pages отдаёт статус 404 — страницы
  специалистов из индекса бы выпадали.
- Fallback `404.html` = копия `index.html` остаётся для новых слагов между
  деплоями и прочих неизвестных путей.
- Post-deploy смоук `verify_pages.py` против задеплоенного URL — advisory
  (`continue-on-error`), результат в логе job'а.
- Опциональные GitHub Secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY` — включают
  выгрузку слагов (статические страницы + sitemap). Без них деплой работает,
  но страницы специалистов обслуживаются только 404-fallback'ом.

### Кастомный домен (опционально)

1. Добавить в шаг сборки `_site/CNAME` с доменом, DNS: `CNAME` → `a1dmitry.github.io`.
2. Заменить в `pages.yml` `%BASE%`-подстановку с `/${GITHUB_REPOSITORY#*/}/` на `/`
   и `SITE` на `https://<домен>` (иначе sitemap/ссылки укажут на github.io-пути).
3. Не забыть: адрес сайта меняется для SEO (canonical в БД/страницах формируется
   динамически из `location`, но sitemap — из workflow).

## Логирование ошибок фронтенда (`client_error_logs`)

- Пишут: inline-обработчики `index.html` (boot/runtime/rejection) и `js/app.js`
  (падение загрузки каталога) через `js/services/errorLogService.js`.
- RLS: только `insert` для anon/authenticated; чтение — SQL Editor/дашборд.
- Лимит 5 репортов на загрузку страницы + дедупликация — таблица не зафлудится.
- Просмотр: `select created_at, level, message, route from client_error_logs order by id desc limit 50;`
- Рекомендуемая чистка (раз в квартал, SQL Editor):
  `delete from client_error_logs where created_at < now() - interval '90 days';`

## Известные наблюдения (не блокеры, к следующим агентам)

- `telegram-notify` принимает произвольный `text` от любого анонима (спам в чат
  психолога теоретически возможен; токен не раскрывается). Смягчение —
  rate-limit/валидация события — предложено агенту уведомлений в его задачах.
- Supabase Auth email template (`{{ .Token }}` и confirmation URL) относится к отдельному signup-подтверждению и legacy Auth-письмам. Для последующего login это **не** резервный транспорт: новый код запрашивается только через `auth-code`, GoTrue `/auth/v1/otp` fallback запрещён при любой ошибке функции.
