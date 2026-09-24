# Инфраструктура продакшена — runbook и статус

> Владелец процесса: Агент 1 (инфраструктура и интеграция).
> Обновлено: 2026-09-23. Вопросы/заявки на схему — `docs/SCHEMA-REQUESTS.md`.

## Архитектура

- **Фронтенд:** статический SPA на GitHub Pages (`A1Dmitry/Psihologist-cabinet`),
  деплой — `.github/workflows/pages.yml`.
- **Бэкенд:** Supabase (Postgres + RLS + Auth + Edge Functions), проект
  `phiavtroybgwyjdhqqkh` (URL и anon key — в `js/services/supabaseConfig.js`;
  anon key публичный by design, секретом не является).
- **Почта:** Resend через Edge Function `auth-code` (вход по одноразовому коду).
- **Telegram:** Edge Function `telegram-notify` (токен бота только на сервере).

## Статус продакшена (чек-лист)

| # | Элемент | Статус | Комментарий |
|---|---------|--------|-------------|
| 1 | Проект Supabase | ✅ подтверждён декларативно | ref `phiavtroybgwyjdhqqkh`; anon key выпущен 2026-09-21 (см. `iat` в JWT) — проект свежесозданный. Дашборд-проверку выполняет владелец (у агента песочницы нет сети до supabase.co и access-токена) |
| 2 | `supabase/schema.sql` в проде | ⏳ **критично: переприменить** | идемпотентен, применять целиком в SQL Editor. До 2026-09-23 файл **не применялся целиком**: `revoke`/`grant execute` для `create_booking` описывали старую арность → PostgreSQL обрывал выполнение на 42883, поэтому `claim_psychologist_profile` и `client_error_logs` в проде не существовали (это и есть причина неработающей регистрации). 2026-09-23 исправлено + добавлены `sessions.client_timezone` / `client_utc_offset_min` / `duration_min` (SR-001/108), интервальная занятость + advisory lock в `create_booking` (SR-002), `public_booked_slots.duration_min` (SR-003), `auth_login_codes.issued_token_hash` / `issues` / `consumed_at` (SR-004 — атомарное погашение кода входа, нужно Edge Function `auth-code`). Проверено на PostgreSQL 18.4: `node tests/db-contract.mjs` → 36/36 PASS. **Внимание: миграция удаляет колонку `sessions.timezone_offset` и меняет арность RPC** — подробности в `docs/FULL-AUDIT-REPORT.md` |
| 3 | `supabase/seed.sql` в проде | ✅ решение: накатывать | это реальный референс-профиль Наталии Михайловской, не фиктивное демо. См. «Ловушка первого входа» ниже |
| 4 | Edge Function `auth-code` | ⏳ задеплоить | см. «Деплой функций». **verify_jwt=false обязателен** (config.toml уже в репо). 2026-09-23 (issue #14): функция переработана — код гасится **после** создания сессии, появились actions `recover` и `redeem`; для атомарного погашения нужны колонки SR-004 (п.2). Без них функция работает в legacy-режиме (ответ `legacy_schema: true`, восстановление сессии недоступно) |
| 5 | Edge Function `telegram-notify` | ⏳ задеплоить | то же |
| 6 | Секрет `RESEND_API_KEY` | ⛔ блокер на владельце | нужен аккаунт Resend + **верифицированный домен** (иначе письма уходят только владельцу аккаунта Resend — блокирует T-15) |
| 7 | Секрет `MAIL_FROM` | ⏳ после домена | напр. `PsyПортал <login@ваш-домен>`; без домена — `onboarding@resend.dev` (только на email владельца Resend) |
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
   или CLI):
   ```bash
   supabase secrets set RESEND_API_KEY=re_...
   supabase secrets set MAIL_FROM="PsyПортал <login@ваш-домен>"
   ```
   Значения — только здесь. В коде/репозитории секретов не храним.
5. **Деплой функций** (один из двух путей):
   - **Из CI (рекомендуется):** в репозитории задать Secret `SUPABASE_ACCESS_TOKEN`
     (supabase.com/dashboard/account/tokens) и Variable `SUPABASE_PROJECT_ID=phiavtroybgwyjdhqqkh`.
     Дальше workflow `.github/workflows/supabase-deploy.yml` деплоит сам при
     каждом изменении `supabase/functions/**` (и умеет ручной запуск).
   - **Вручную:**
     ```bash
     npm i -g supabase && supabase login
     supabase functions deploy auth-code --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt
     supabase functions deploy telegram-notify --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt
     ```
     (`verify_jwt=false` зашит и в `supabase/config.toml` — флаг дублирует его на случай старого CLI.)

   > **Симптом «функция не задеплоена» в браузере — CORS-ошибка, а не 404.**
   > Preflight-запрос OPTIONS к несуществующей функции получает 404 БЕЗ
   > CORS-заголовков, поэтому консоль показывает
   > `blocked by CORS policy: Response to preflight request doesn't pass access
   > control check: It does not have HTTP ok status`, а `fetch` бросает
   > `TypeError: Failed to fetch`. Проверить напрямую:
   > `curl -i https://phiavtroybgwyjdhqqkh.supabase.co/functions/v1/auth-code`
   > → `{"code":"NOT_FOUND","message":"Requested function was not found"}`.

6. **Production E2E-проверка регистрации (issue #14, п.1–2)** — с машины владельца
   (у песочницы агента нет сети до supabase.co):
   ```bash
   node tools/prod-e2e.mjs                         # шаг 1: только диагностика (письма не шлёт)
   node tools/prod-e2e.mjs --email <тестовый@email> # шаг 2: полный E2E, код вводится из письма
   ```
   Скрипт исполняет НАСТОЯЩИЙ use case приложения (`js/domain/registration.js →
   supabaseApi`): новый email → письмо → код → Auth-сессия → claim → поля профиля →
   reload → повторный вход → ошибки (неверный/повторный код). Вывод (20 проверок,
   PASS/FAIL) можно целиком приложить к issue #14 — код и токены не печатаются.
   Очистка тестового профиля печатается в конце. Неинтерактивно: `E2E_CODES="код1,код2"`.
   > Фронтенд в этом случае автоматически переключается на запасной канал
   > (встроенная почта Supabase OTP), пункт «Диагностика сервера» → «Edge
   > Function auth-code» подсвечивает проблему красным.
6. **Открыть сайт** → нажать «Диагностика сервера» на странице входа — все пункты
   должны быть зелёными; бейдж «Данные: сервер». Проверить «Получить код» —
   письмо приходит на подставленный email, вход открывает кабинет.
   Пункты диагностики, относящиеся к входу:
   - «Edge Function auth-code» — функция задеплоена и отвечает (не 404);
   - «Схема auth_login_codes (SR-004: атомарность кода входа)» — в БД есть
     колонки `issued_token_hash` / `issues` / `consumed_at`. Красный пункт
     означает, что `schema.sql` не переприменён: вход работает, но в
     legacy-режиме (код гасится до создания сессии, восстановление сессии
     после обрыва сети недоступно). Проверка «холостая»: письмо не отправляется,
     данные не меняются.
7. **(Опционально) мгновенные Telegram-уведомления:** в `js/services/supabaseConfig.js`
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
- Резервный OTP-канал Supabase Auth (на время отсутствия `auth-code`) требует
  шаблона письма с `{{ .Token }}` (Auth → Emails в дашборде), иначе придёт magic-link.
