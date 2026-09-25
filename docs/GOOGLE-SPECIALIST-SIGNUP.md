# Вход и открытая регистрация специалиста через Google

> Статус: **код готов и проверен, production-включение — за владельцем.**
> Миграция `supabase/migrations/20260925_google_specialist_signup.sql`
> **подготовлена, но НЕ применена** (сознательно: см. раздел «Применение миграции»).
> **АУДИТОР: САМ** — проверки выполнены в том же конвейере, что и код
> (`tests/google-specialist-signup.mjs` на настоящем PostgreSQL, 66/66;
> `tests/google-oauth-client.mjs`, 57/57; `npm run verify` — 36 наборов зелёные).
> Браузерный E2E и реальный прогон OAuth **не выполнялись** — см. «Непроверено».

## 1. Что это и чем отличается от уже существующего Google-контура

В проекте два разных Google-контура. Их важно не перепутать:

| | `googleClientAuthService.js` | `googleAuthService.js` (**этот документ**) |
|---|---|---|
| Кто входит | **клиент** при онлайн-записи | **специалист** в кабинет |
| Зачем | прикрепить результат опроса к заявке | получить кабинет и работать в нём |
| Механика | GIS ID token → `signInWithIdToken` | OAuth redirect через Supabase (PKCE) |
| Где сессия | `sessionStorage`, изолирована от кабинета | обычная сессия владельца (`psy_auth_session_v1`) |
| Нужен ли Client ID в браузере | да (`window.PSY_GOOGLE_CLIENT_ID`) | **нет** — Supabase сам держит client id/secret |
| Документ | `docs/GOOGLE-CLIENT-AUTH.md` | этот файл |

Сессия специалиста **одна и та же** для входа по коду из письма и для входа
через Google: оба пути дают обычную сессию Supabase Auth, и RLS работает
одинаково. Существующий вход по коду не изменён.

## 2. Сценарий

1. Пользователь нажимает **«Войти через Google»** на `#/auth`.
2. Браузер генерирует PKCE `code_verifier`, сохраняет его и уходит на
   `https://phiavtroybgwyjdhqqkh.supabase.co/auth/v1/authorize?provider=google&…`.
3. Google аутентифицирует и возвращает на **callback Supabase**
   (`/auth/v1/callback`), который перенаправляет на `redirect_to` приложения
   с `?code=…`.
4. Приложение обменивает `code` + `code_verifier` на сессию
   (`POST /auth/v1/token?grant_type=pkce`), очищает URL.
5. Вызывается RPC `link_or_create_psychologist_for_google()` — **без аргументов**.
6. Профиль не заполнен → онбординг `#/onboarding`; заполнен → `#/cabinet`.

### Почему PKCE, а не implicit

Приложение работает в режиме Hash History (`#/cabinet`, `#/auth`). При
implicit-потоке GoTrue кладёт токены во **фрагмент** (`#access_token=…`) —
это затирает маршрут и ломает роутер. PKCE возвращает `?code=…` в query
string, фрагмент остаётся свободным.

### Почему `redirect_to` — это origin + base path БЕЗ hash

- `https://a1dmitry.github.io/Psihologist-cabinet/` — GitHub Pages отдаёт там
  `index.html`, поэтому возврат попадает в приложение, а не в 404.
- Если добавить в `redirect_to` хэш, GoTrue допишет `?code=` **после** `#`,
  и разбор сломается.

Локальная разработка: на `localhost`/`127.0.0.1` используется текущий origin
(`http://localhost:8765/`) — OAuth возвращается в тот же браузер, поэтому это
безопасно (в отличие от ссылок из письма, которые открывают на другом
устройстве; там по-прежнему работает `APPLICATION_URL`).

## 3. Контракт БД (миграция)

Файл: `supabase/migrations/20260925_google_specialist_signup.sql`

### Какие таблицу и поле email использовал

- **Таблица:** существующая `public.psychologists` — новая параллельная
  таблица не создавалась.
- **Поле email:** `psychologists.email` (`text not null unique`).
- **Владение:** `psychologists.owner_id uuid references auth.users(id)`.
- **Новое поле:** `psychologists.profile_completed boolean not null default false`
  — статус «профиль заполнен». Меняется только RPC.

Всё аддитивно; удаления и перезаписи существующих данных нет.

### Поиск, привязка, создание

Функция `public.link_or_create_psychologist_for_google()` — `security definer`,
`search_path = public`, **без аргументов**. Email и подтверждённость берутся
из `auth.users` (`email`, `email_confirmed_at`), имя — из
`raw_user_meta_data`. Передать «чужой» email из браузера невозможно как по
замыслу, так и технически (аргументов у функции нет).

Порядок шагов (две `pg_advisory_xact_lock` по email и по `auth.uid()` —
гонка двух параллельных входов не создаёт дублей):

| Ситуация | Результат | `code` |
|---|---|---|
| У `auth.uid()` уже есть кабинет | вернуть его, ничего не создавая | `already_linked` |
| Найдена ровно одна запись с тем же email, `owner_id` свободен, `is_active` | **привязка**: меняются только `owner_id`, `updated_at` и вычисленный `profile_completed` | `linked` |
| Записей с таким email нет | **создание**: новая запись с `owner_id = auth.uid()`, `is_active = true`, `profile_completed = false` + стартовые `session_settings` | `created` |
| Несколько записей с тем же email | отказ, ничего не выбрано | `duplicate_email` |
| Запись привязана к другому `auth.uid()` | отказ, владелец не изменён | `email_taken` |
| Запись отключена (`is_active = false`) | отказ; вход не реактивирует аккаунт | `profile_inactive` |
| Email не подтверждён / отсутствует | отказ, кабинет не создаётся | `email_unconfirmed` / `no_email` |
| Нет сессии | отказ | `not_authenticated` |

**Сравнение email:** `lower(trim(email)) = lower(trim(auth.users.email))` —
без учёта регистра и окружающих пробелов. Уникальность колонки
регистрозависимая, поэтому «двойники» `A@b.com` / `a@b.com` распознаются
именно как дубли.

**Привязка не перезаписывает данные:** UPDATE затрагивает `owner_id`,
`updated_at` и вычисленный `profile_completed`. `full_name`, `phone`,
`city`, `about`, `slug`, услуги, клиенты и сессии не трогаются.

**`profile_completed` при привязке вычисляется из самой записи:** если
обязательные поля уже заполнены — профиль Completed, и повторный онбординг
не потребуется (иначе форма онбординга затерла бы реальные данные повторным
вводом).

### Дубли и занятые записи

Автоматически **не выбирается и не перезаписывается ничего**. Функция
возвращает `ok:false`, `code`, внятный `error` и `resolution` — что именно
сделать. Клиент показывает `error` рядом с кнопкой Google, а `resolution` —
мелким шрифтом под ним. Примеры:

- `duplicate_email` → «Найдено несколько записей специалиста с таким email… /
  Оставьте одну запись… затем повторите вход».
- `email_taken` → «…уже привязана к другой учётной записи. Доступ не выдан. /
  Войдите тем способом, которым кабинет привязывался…».
- `profile_inactive` → «Учётная запись отключена… / Реактивация — только
  явным действием администратора».

### Онбординг

`public.complete_psychologist_profile(p_full_name, p_phone, p_specialization,
p_city, p_about)` — `security definer`. Пишет **только эти пять полей**
(все они уже есть в схеме) и выставляет `profile_completed = true`.
`email`, `is_active`, `owner_id`, `slug`, `id`, `created_at` не трогает.
Пустые поля отклоняются кодом `validation`.

## 4. RLS и права (проверено тестами на PostgreSQL)

Проверено в `tests/google-specialist-signup.mjs` (роль `authenticated`,
настоящий `auth.uid()`):

**Существующие политики (не изменялись):**
- `owner_select` / `owner_modify` / `owner_update` / `owner_delete` на
  `psychologists`;
- `owner_all` + канонический предикат `is_active_own_psychologist()` — на
  `services`, `clients`, `sessions`, `session_settings`, `payments`,
  `waiting_items`, `booking_attempts`, `session_reminders`,
  `schedule_blocks`, `schedule_overrides`, `tasks`, `psy_notes`,
  `client_entries`. Изоляция между специалистами обеспечивается ими же:
  предикат требует `psychologists.owner_id = auth.uid()` **и**
  `psychologists.is_active`.

**Добавлено миграцией:**

1. **Прямой `INSERT` в `psychologists` для `authenticated` запрещён.**
   При открытой регистрации иначе любой вошедший смог бы через PostgREST
   создать сколько угодно кабинетов. Единственный создатель — RPC.
2. **Колоночные гранты `UPDATE`** — роль `authenticated` может менять только
   публичные поля профиля. **Нельзя** изменить:
   - `email` — подтверждённый адрес входа (identity);
   - `is_active` — статус доступа;
   - `owner_id` — `auth.uid()` владельца;
   - `profile_completed` — статус заполнения (только через RPC);
   - `id`, `created_at`.
3. `public_profiles` скрывает кабинеты с `profile_completed = false`
   (существующие профили не затронуты — им на шаге 1 миграции выставлено
   `true`).
4. Обе новые функции: `revoke … from public, anon`, `grant … to authenticated`.

> Про «роль»: отдельной колонки роли в схеме **нет**. Права владельца
> выводятся из `owner_id = auth.uid()` и `is_active`, а не из `profession`
> (это публичный discriminator профессии). Если позже появится колонка роли,
> её нужно добавить в список защищённых и **не** включать в колоночные гранты.

### Сопутствующая правка клиента

`js/services/supabaseSync.js` (`toPsyRow`) больше не отправляет `email` и
`is_active` при сохранении профиля. Раньше отправлял — после применения
миграции такой PATCH завершался бы `42501`. Поля эти никогда не должны
меняться правкой профиля, так что это исправление, а не обход блокировки.

## 5. Что нужно сделать вручную (Supabase и Google Cloud)

### Google Cloud Console

1. Открыть **тот же** проект Google Cloud / OAuth-клиент типа
   *Web application*, что уже используется для GIS-контура клиента
   (см. `docs/GOOGLE-CLIENT-AUTH.md`), либо создать отдельный.
2. **Authorized redirect URIs** — добавить callback Supabase:
   ```
   https://phiavtroybgwyjdhqqkh.supabase.co/auth/v1/callback
   ```
   Это единственный redirect, который нужен новому контуру: браузер уходит
   на Google через Supabase, а не напрямую.
3. `Authorized JavaScript origins` новому контуру **не нужны** — они нужны
   только GIS (кнопка/One Tap клиента при записи).
4. Скопировать **Client ID** и **Client Secret**.

> ⚠ Client Secret — только в Supabase Dashboard. Ни в репозиторий, ни в
> браузерный код, ни в чат он не попадает. В браузере живёт только `anon key`,
> который и так публичен.

### Supabase Dashboard

1. **Authentication → Sign In / Providers → Google** — включить провайдер,
   вставить Client ID и Client Secret из Google Cloud.
   > LIVE-срез 2026-09-25: `external.google = false`, то есть провайдер
   > **выключен**. Без этого шага кнопка будет возвращать ошибку провайдера.
2. **Authentication → URL Configuration**:
   - **Site URL** = `https://a1dmitry.github.io/Psihologist-cabinet/`
   - **Redirect URLs** — добавить точно:
     ```
     https://a1dmitry.github.io/Psihologist-cabinet/
     ```
     Для локальной разработки — `http://localhost:8765/` (и
     `http://127.0.0.1:8765/`, если открываете так).
   Значение обязано **точно** совпадать с `redirect_to`, который отправляет
   приложение, иначе Supabase подставит Site URL или вернёт ошибку.
3. **SQL Editor** — применить миграцию (см. ниже).
4. *(опционально, рекомендуется)* **Authentication → Settings** — проверить
   срок сессии: в репозитории действует клиентское ограничение «сессия не
   старше 30 дней», серверная настройка остаётся за владельцем
   (`docs/INFRA.md` → «Срок сессии»).

### Применение миграции

```bash
# вариант 1: SQL Editor в Dashboard — вставить содержимое файла целиком
supabase/migrations/20260925_google_specialist_signup.sql

# вариант 2: CLI
supabase db push --project-ref phiavtroybgwyjdhqqkh
# или
psql "$DATABASE_URL" -f supabase/migrations/20260925_google_specialist_signup.sql
```

Миграция идемпотентна; бэкфилл `profile_completed = true` для существующих
записей выполняется **только при первом применении** (иначе повторный прогон
«дозаполнил» бы новые Google-кабинеты).

**Проверка после применения** (read-only, в SQL Editor):

```sql
select proname from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('link_or_create_psychologist_for_google','complete_psychologist_profile');

select count(*) filter (where profile_completed)     as completed,
       count(*) filter (where not profile_completed) as pending
  from public.psychologists;

-- колоночные права: ожидается только список публичных полей
select string_agg(column_name, ', ' order by column_name)
  from information_schema.column_privileges
 where table_schema='public' and table_name='psychologists'
   and grantee='authenticated' and privilege_type='UPDATE';
```

### Если миграцию не применять

Кнопка «Войти через Google» появится, OAuth-сессия создастся, но RPC
`link_or_create_psychologist_for_google` не найдётся (PostgREST `PGRST202`).
Клиент распознаёт этот случай отдельно (`code = migration_missing`) и пишет
прямым текстом, что миграция не применена — **без «успешного входа» без
кабинета**. Остальной сайт и вход по коду продолжают работать.

## 6. Непроверено / остаточные риски

1. **Реальный OAuth-прогон не выполнялся.** Нет подтверждённого Google-аккаунта
   и включённого провайдера; в песочнице браузер недоступен (загрузка Chrome
   для Puppeteer заблокирована сетью). Проверены только контракты:
   SQL-логика на настоящем PostgreSQL и клиентский обмен с моком сети.
2. **Браузерный E2E интерфейса не выполнялся** по той же причине. Проверено
   статически: разметка, наличие обработчиков, маршруты, защита `#/onboarding`.
3. **Открытая регистрация — сознательное решение владельца**, которое
   противоречит ранее зафиксированному в репозитории курсу на
   invitation-only (`docs/PSYCHOLOGIST-PORTAL-SECURITY-PLAN.md`, SR-006,
   `docs/CURRENT-STATE.md`). Любой Google-аккаунт теперь может создать
   кабинет. Если это нежелательно — либо не применяйте миграцию, либо
   добавьте allowlist внутри `link_or_create_psychologist_for_google()`
   (проверка email по таблице приглашений перед созданием).
4. **Недозаполненные кабинеты занимают slug** и создают строки в
   `psychologists` до прохождения онбординга. Очистка «брошенных» кабинетов
   не реализована (нужна отдельная задача с явным критерием — например,
   `profile_completed = false` и `created_at` старше N дней).
5. **`public_profiles` пересоздаётся** миграцией. Если после этого применить
   `supabase/schema.sql` целиком, фильтр `profile_completed` исчезнет —
   миграцию нужно применить повторно (или перенести изменение в `schema.sql`
   после согласования).
6. **Supabase automatic linking**: если в настройках Auth включено
   автоматическое связывание аккаунтов по email, Google-вход с email
   существующего пользователя может привязаться к已有 учётной записи.
   Проверьте эту настройку осознанно — поведение по умолчанию у Supabase
   менялось между версиями.

## 7. Тесты

| Набор | Что проверяет | Команда |
|---|---|---|
| `tests/google-specialist-signup.mjs` | SQL-контракт на настоящем PostgreSQL: создание, идемпотентность, гонка, привязка без перезаписи, дубли, занятые/отключённые записи, неподтверждённый email, deny для anon, колоночные права, `public_profiles` | `node tests/google-specialist-signup.mjs` |
| `tests/google-oauth-client.mjs` | клиент: `redirect_to` (Pages/localhost, без hash), PKCE, обмен с `code_verifier`, очистка URL, `?error=`, потерянный verifier, «в RPC не уходит email», PGRST202, онбординг, выход, DOM-контракт | `node tests/google-oauth-client.mjs` |

Оба набора входят в `npm run verify`.
