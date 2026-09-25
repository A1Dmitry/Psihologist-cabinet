# ISSUE-46 — Evidence package (P0 EXECUTOR: Unblock production)

> **АУДИТОР: ВНЕШНИЙ** для production-фактов: данные получены запросами к живому
> Supabase-проекту `phiavtroybgwyjdhqqkh` (PostgREST/GoTrue) и к опубликованному
> GitHub Pages, выполненные не из песочницы исполнителя, а из runner'а GitHub
> Actions (workflow `Production read-only probe`, инструмент
> `tools/prod-probe/probe.mjs`). **АУДИТОР: САМ** для repo-фактов (код/тесты
> проверены в этой же сессии).
>
> Секреты не использовались: канал — публичный anon key, опубликованный в
> собранном сайте. OTP, access/refresh-токены, service-role key и PII не
> публикуются.

## Паспорт прогона

| Поле | Значение |
|---|---|
| BASELINE SHA | `dcb4093606c0c3993c6632adabb8e2685077fc04` (main на момент начала) |
| CHECKED SHA (production probe) | см. комментарий PR #47 (прогон `Production read-only probe`) |
| PRODUCTION PROJECT | `phiavtroybgwyjdhqqkh` (`https://phiavtroybgwyjdhqqkh.supabase.co`) |
| Application origin | `https://a1dmitry.github.io/Psihologist-cabinet/` |
| DATE/UTC | 2026-09-25 |
| Инструмент | `tools/prod-probe/probe.mjs` (read-only, 26 зондов) |

Классификация по правилам issue #46: `FACT` — проверено в репозитории/GitHub;
`LIVE EVIDENCE` — проверено на живом проде; `INFERENCE` — вывод;
`UNKNOWN` — проверить недоступным каналом нельзя.

---

## 1. Edge Functions (TASK 2) — LIVE EVIDENCE

```text
GET https://phiavtroybgwyjdhqqkh.supabase.co/functions/v1/auth-code
  → HTTP 404 {"code":"NOT_FOUND","message":"Requested function was not found"}
GET https://phiavtroybgwyjdhqqkh.supabase.co/functions/v1/telegram-notify
  → HTTP 404 {"code":"NOT_FOUND","message":"Requested function was not found"}
```

- `auth-code` — **NOT_DEPLOYED** (LIVE EVIDENCE, gateway-404, а не ответ функции).
- `telegram-notify` — **NOT_DEPLOYED** (LIVE EVIDENCE).
- Следствие: основной путь регистрации (код в письме) в production **не работает**;
  клиент по 404/CORS переключается на запасной OTP Supabase Auth.
- Деплой не имитировался: у исполнителя нет `SUPABASE_ACCESS_TOKEN`, а egress до
  `*.supabase.co` из песочницы закрыт (TLS обрывается, `curl` → exit 35).
  **BLOCKED — OWNER ACTION REQUIRED**, точные команды — `docs/OWNER-CHECKLIST-E2E.md`, Блок 1.

## 2. Production schema (TASK 1) — LIVE EVIDENCE: найден drift

> **Обновление 2026-09-25 (см. §2bis):** таблица ниже — срез ~04:5xZ. Владелец
> применил схему между 04:55Z и 05:14Z, поэтому строки со статусом «отсутствует»
> закрыты. Актуальный список блокеров — в §2bis и §6.

Канал: PostgREST с anon key. Коды ошибок различают «объекта нет» (`PGRST205`,
`42703`) и «объект есть, но anon не имеет доступа» (`42501`).

| Объект из `supabase/schema.sql` | Факт в production | Класс |
|---|---|---|
| `auth_login_codes.issued_token_hash` | `42703 column auth_login_codes.issued_token_hash does not exist` → **колонки SR-004 нет** | LIVE, DRIFT |
| `session_settings.min_notice_minutes` (и остальные D1-колонки) | `42703 column session_settings.min_notice_minutes does not exist` | LIVE, DRIFT |
| `services.availability` | `42703 column services.availability does not exist` | LIVE, DRIFT |
| `schedule_overrides` (таблица D1) | `PGRST205 Could not find the table 'public.schedule_overrides'` | LIVE, DRIFT |
| `public_schedule_overrides` (вью D1) | `PGRST205 Could not find the table 'public.public_schedule_overrides'` | LIVE, DRIFT |
| `public_settings.min_notice_minutes` | `42703 column public_settings.min_notice_minutes does not exist` | LIVE, DRIFT |
| `public_booked_slots.duration_min` (SR-003) | читается, строка есть (`psy_a1dmitry`, 2099-12-01, 60) | LIVE, OK |
| `psychologists(id,owner_id,is_active,key_verifier)` | `42501 permission denied` → колонки резолвятся, грант anon отозван | LIVE, OK |
| `sessions(hold_expires_at,duration_min,client_timezone,client_utc_offset_min,payment_policy)` | `42501` → колонки существуют | LIVE, OK |
| `client_risks(phone_key,blocked)` | `42501 permission denied for table client_risks` → кросс-тенантного чтения anon нет (#22) | LIVE, OK |
| `booking_attempts`, `clients(consent,consent_at)`, `payments` | `42501` → существуют, anon закрыт | LIVE, OK |
| `client_error_logs` | читается anon, строк 0 (insert-only by design) | LIVE, OK |
| `auth_login_codes` (строки) | anon получает `[]` → RLS без политик = default deny | LIVE, OK |
| `public_profiles` | 2 активные анкеты: `наталия-михайловская-19`, `a1dmitry` | LIVE, OK |

Полный инвентарь объектов этим каналом снять нельзя: `GET /rest/v1/` (корневой
OpenAPI-спец) Supabase закрывает для anon —
`{"message":"Invalid API key","hint":"Only the service_role API key can be used for this endpoint."}`
(LIVE). Поэтому перечень объектов/сигнатур/политик — только SQL-каналом владельца
(Блок 7); зонд закрывает то, что видно с публичным ключом.

**Вывод (INFERENCE, высокая уверенность):** production-схема — более ранняя
генерация `supabase/schema.sql`: SR-001/SR-003 применены, **SR-004 и SR-D1 не
применены**. Root cause: `supabase/schema.sql` не переприменялся целиком
(задокументировано в `docs/INFRA.md`, п.2 как «критично: переприменить») — теперь
подтверждено живыми ответами прода, а не только отсутствием доказательства.

### 2bis. Обновление LIVE-состояния прода (2026-09-25, внешний канал) — дрейф схемы закрыт владельцем

Прогоны `Production read-only probe` в GitHub Actions (runner вне песочницы
исполнителя; отчёты — комментарии к PR #47/#48/#52/#53):

| Время (UTC) | SHA прогона | drift/missing | Что изменилось |
|---|---|---:|---|
| 04:55:28 | `0f4ffc1f` | 10 | SR-004 и SR-D1 отсутствуют (срез §2) |
| **05:14:23** | `dfdc4334` | **4** | владелец применил схему: SR-004 и SR-D1 **появились** |
| 05:42:19 | `1902f8b8` | 4 | состояние стабильно |
| 05:53:11 | `047e64d9` | 4 | состояние стабильно |

**FACT (LIVE, канал anon):** `auth_login_codes.issued_token_hash/issues/consumed_at`
резолвятся; `session_settings.min_notice_minutes` и остальные D1-колонки резолвятся;
`services.availability` существует (`null`); `public_settings.min_notice_minutes`
читается (`Europe/Minsk`, `0`); `schedule_overrides` и `public_schedule_overrides`
существуют (`public_schedule_overrides` отдаёт 0 строк, а не 404).

**Что осталось в drift (4 зонда, стабильно с 05:14Z):**

1. `GET /functions/v1/auth-code` → `404 NOT_FOUND` (**не задеплоена**);
2. `GET /functions/v1/telegram-notify` → `404 NOT_FOUND` (**не задеплоена**);
3. `POST /rest/v1/rpc/create_booking` (anon, дата в прошлом) → `PGRST202`;
4. `create_booking` overload-инвентаризация → `PGRST202`.

Пункты 3–4 — **LIVE-дефект приложения**: публичная запись клиентов в проде не
работает. Причина по-прежнему `UNKNOWN` без SQL-канала (нет функции / нет EXECUTE
у `anon` / не та сигнатура). Если владелец применил схему целиком, то по
`schema.sql` грант `anon` на каноническую сигнатуру есть — значит первым делом
проверяются `pg_proc` + `apy_key`-кэш PostgREST (Блок 7, запросы 1–2; при
необходимости — `notify pgrst, 'reload schema'`).

**Прочие LIVE-факты того же среза:** `client_risks`/`clients`/`payments`/
`booking_attempts` для anon — `42501`; `auth_login_codes` для anon — 0 строк
(RLS без политик = deny); `public_profiles` — 2 активные анкеты; GoTrue:
`external.email=true`, `external.google=false`, `disable_signup=false`,
`mailer_autoconfirm=false`.

**Честность самого отчёта (issue #54, исправлено в этой ветке):** сводка probe
раньше не считала зонды без ответа, поэтому «drift 0» при мёртвой сети читался
как «чисто». Теперь `summary` содержит `measured`/`unreachable`, печатная сводка
начинается с покрытия измерения, а workflow краснеет при `unreachable > 0`
(контроль — `tests/prod-probe-report.mjs`).

### RPC (TASK 1 / TASK 5) — LIVE EVIDENCE

```text
POST /rest/v1/rpc/create_booking {p_psychologist_id:'__probe__', p_session_date:'1900-01-01', p_session_time:'00:00'}
  → PGRST202 "Searched for the function public.create_booking with parameters
     p_psychologist_id, p_session_date, p_session_time … but no matches were
     found in the schema cache."
POST /rest/v1/rpc/claim_psychologist_profile {}            → PGRST202
POST /rest/v1/rpc/claim_psychologist_profile {zz_…:1}      → PGRST202
```

- **Факт (LIVE):** тот самый вызов, которым пишет публичная страница записи
  (`js/services/supabaseApi.js` → `POST /rest/v1/rpc/create_booking` с именованными
  аргументами), в production **не резолвится для anon** → **публичная запись
  клиентов в проде не работает**.
- **Причина — UNKNOWN без SQL-канала**, три неразличимых варианта (все три
  дают одинаковый `PGRST202`): (а) функции нет вовсе; (б) функция есть, но у
  anon нет EXECUTE — исторически `grant execute` падал на неверной арности
  (42883, задокументировано в `docs/INFRA.md`); (в) функция есть в старой
  сигнатуре, где не все параметры имеют defaults. Различает запрос 1–2 в
  `docs/OWNER-CHECKLIST-E2E.md`, Блок 7 (`pg_proc` + `routine_privileges`).
- `claim_psychologist_profile` для anon невидима — это **ожидаемо** (EXECUTE
  отозван у anon), поэтому наличие функции этим каналом не доказывается и не
  опровергается: `UNKNOWN` до SQL-проверки владельцем.
- Зонд `create_booking` датой в прошлом гарантированно не пишет: отклоняется на
  шаге 0 функции, до advisory lock и до любых INSERT.

### TASK 2 подтверждён со стороны владельца — LIVE EVIDENCE, 2026-09-25

Владелец выполнил вход на проде и сообщил: письмо пришло, в нём **ссылка**, по
ней вход состоялся; **короткого кода в письме не было**.

- **FACT:** это ровно тот сценарий, который предсказывает зонд §1: `auth-code`
  не задеплоена → `requestVerification` ловит 404/CORS → запасной канал
  `POST /auth/v1/otp` (`js/domain/registration.js`) → письмо шлёт Supabase Auth.
- **FACT (механика):** шаблон **Magic Link** в Supabase Auth по умолчанию
  рендерит `{{ .ConfirmationURL }}` и не рендерит `{{ .Token }}`, поэтому в
  письме ссылка, а не код (задокументировано и в `docs/INFRA.md`,
  «Известные наблюдения»).
- **Дефект UI, найденный на этом месте и исправленный:** `renderAuth()` писал
  подсказку «Код отправлен: 6–8 букв и цифр» в элемент `#auth-code-hint`,
  которого в `index.html` **не существовало** (мёртвая ссылка — в DOM-заглушке
  тестов любой селектор возвращает объект, поэтому проверка не ловила). Плюс
  текст обещал код в канале, где приходит ссылка. Теперь: элемент добавлен,
  текст строится каноническим `registration.verificationHint(channel, email)`
  и различает каналы, сообщение use case в запасном канале говорит про ссылку.
  Доказательство: `tests/auth-ui-pending.mjs` (21 проверка, включая статическую
  проверку разметки) и `tests/registration-flow.mjs` §11; контроль
  фальсификации выполнен (удаление элемента → 6 FAIL, neutralize ветки otp → 2 FAIL).
- **Что это НЕ меняет:** кодовый вход 6–8 символов с одноразовостью в БД и окном
  2 минуты невозможен без деплоя `auth-code` (Блоки 1–3 чек-листа). Промежуточная
  мера без деплоя — `{{ .Token }}` в шаблоне Magic Link (Блок 3, п.4): тогда
  запасной канал присылает и ссылку, и 6-значный код, который форма умеет
  принимать (`verifyEmailOtp`).

### Подтверждение дрифта из браузера владельца — LIVE EVIDENCE, 2026-09-25

Независимый канал: консоль браузера владельца (приложение открыто против
production Supabase). Совпадает с зондом §2, но снят не из CI:

```text
GET /rest/v1/public_schedule_overrides?psychologist_id=eq.psy_catalog_19&select=*&order=date.asc → 404
GET /rest/v1/public_schedule_overrides?psychologist_id=eq.psy_a1dmitry&select=*&order=date.asc  → 404
```

- **FACT:** оба запроса — это `supabaseSync.pullAll()` → `supabaseApi.listOverrides(psyId)`
  (`js/services/supabaseSync.js`); идентификаторы совпадают с двумя активными
  анкетами из `public_profiles` (`psy_catalog_19`, `psy_a1dmitry`).
- **INFERENCE (высокая уверенность):** 404 на коллекционном запросе = объект
  отсутствует в schema cache (PostgREST `PGRST205`), а не «пустой список»:
  пустой список отдаётся как `200 []`. Совпадает с кодом `PGRST205`, который
  зонд получил тем же запросом (§2).
- **FACT:** каталог при этом грузится нормально (`listPsychologists` → 2 анкеты),
  поэтому UI не показывал владельцу никакой проблемы: дрифт был виден только в
  DevTools.
- **FACT (дефект клиента, найден на этом месте и исправлен):** `pullAll()`
  сбрасывал `services/clients/sessions/settings/scheduleBlocks`, но НЕ
  `scheduleOverrides`, а ошибка чтения глоталась пустым `catch`. Следствия:
  (1) строки overrides накапливались в localStorage на каждой загрузке
  (контроль фальсификации: 6 строк после двух pull'ов вместо 2);
  (2) однажды прочитанный с сервера «закрытый день» оставался закрытым
  навсегда, даже когда слой перестал отвечать. Плюс отсутствие слоя было
  неотличимо от пустого списка.
- **Что сделано:** `db.scheduleOverrides` сбрасывается вместе с остальными
  серверными слоями; недоступный слой возвращается в `pullAll()` как
  `degraded: [{relation, status, code}]` и логируется одним `console.warn`
  с лечением (переприменить `supabase/schema.sql`).
  Доказательство: `tests/sync-degradation.mjs` — 17 проверок, контроль
  фальсификации выполнен (без сброса 5 проверок краснеют).
- **Остаётся за владельцем:** сам дрифт (отсутствие `schedule_overrides` /
  `public_schedule_overrides` / D1-колонок) клиентом не лечится — только
  переприменением схемы (Блок 2 `docs/OWNER-CHECKLIST-E2E.md`).

## 3. Application origin (TASK 2/3) — LIVE EVIDENCE

- `https://a1dmitry.github.io/Psihologist-cabinet/` отдаёт приложение (HTTP 200,
  каталог рендерится данными из production Supabase).
- Опубликованный `js/services/supabaseConfig.js` совпадает с репозиторным:
  `APPLICATION_URL = 'https://a1dmitry.github.io/Psihologist-cabinet/'`,
  `NOTIFY_WEBHOOK_URL = ''` → **ссылки из писем не ведут на localhost**
  (клиентский канон). Проверено фактическим файлом на Pages, не сборкой в CI.
- `GET /auth/v1/settings` (LIVE): `external.email = true`, `disable_signup = false`,
  `mailer_autoconfirm = false`, `passkeys_enabled = false`, `external.google = false`
  (последнее относится к #41). Поля `jwt_exp` / session timebox эндпоинт не отдаёт →
  **серверный срок сессии: UNKNOWN**, требуется проверка владельцем в Dashboard.

## 4. Что исполнено в репозитории в рамках #46 (FACT, с тестами)

| Требование #46 | Что сделано | Чем доказано |
|---|---|---|
| TASK 3: inactive account не реактивируется входом | `claim_psychologist_profile` больше не ставит `is_active = true`; отключённому аккаунту возвращается `{ok:false, inactive:true}` | `tests/db-contract.mjs` → секция «ОТКЛЮЧЁННЫЙ АККАУНТ» на настоящем PostgreSQL |
| TASK 3: доступ закрывается при деактивации (RLS) | канонический предикат `public.is_active_own_psychologist(text)`; 13 политик переведены на него; `psychologists` разделён на чтение (своё) и запись (своё **и активное**) | там же: RLS закрывает сессии/запись отключённого владельца |
| TASK 3: одна canonical-сессия на оба входа | путь «код» и путь «ссылка из письма» сходятся в `finishAuthenticatedLogin` → `claimOrCreatePsychologist` (owner = `auth.uid()`); второй auth-engine не создавался | `tests/registration-flow.mjs` (код, reload, повторный вход, ссылка) |
| TASK 3: срок сессии не больше месяца | `MAX_SESSION_AGE_DAYS = 30`, `issued_at` сохраняется при выдаче и не сбрасывается refresh'ем, fail-closed без отметки; клиентская граница + требование серверной настройки владельцем | `tests/registration-flow.mjs` → 29 дней жива / 31 день закрыт |
| TASK 3: дубль профиля не создаётся | без изменений (уже канон), дополнительно проверено после реактивации | `tests/db-contract.mjs`, `tests/registration-flow.mjs` |
| TASK 5: client не подменяет оплату/статус/длительность | без изменений (уже server-derived), но проверка **перестала быть ложно-зелёной**: сценарий T02 раньше отклонялся расписанием и не выполнялся | `tests/security-regression.mjs` → T02 теперь реально исполняется |
| TASK 5: анти-спам не обходится будущими датами | сценарий переведён на будущие даты (счётчик по `created_at`) | `tests/db-contract.mjs`, `tests/security-regression.mjs` T03 |
| TASK 1: канал инспекции прода | `tools/prod-probe/probe.mjs` + workflow `prod-probe.yml` (read-only, без секретов) | прогон в GitHub Actions, отчёт комментарием в PR #47 |
| TASK 1: SQL для владельца | `docs/OWNER-CHECKLIST-E2E.md`, Блок 7 — `pg_proc`/гранты/RLS/ownership (гранты — через `pg_proc.proacl`, т.к. `information_schema.routine_privileges` гранты anon/authenticated не показывает) | документ |
| TASK 5: единственная сигнатура `create_booking` после миграции | схема снимает перегрузки динамически (по `pg_proc`), а не списком 4 известных: `create or replace` при другой арности создаёт ВТОРУЮ функцию, и прод остаётся сломанным при зелёном применении | `tests/schema-convergence.mjs` — 21 проверка на настоящем PostgreSQL, включая повторное применение схемы+seed |
| TASK 3: оба входа → один профиль | сценарий «два входа»: тот же `sub` приходит по ссылке → тот же `psychologist.id`, тот же `owner_id`, дубля нет (прежний тест брал другой email и инвариант не покрывал) | `tests/registration-flow.mjs`, 6 проверок |
| TASK 4/5: чем владелец докажет прод | `tools/prod-e2e.mjs`: сценарий tenant isolation своей живой сессией + флаг `--link` (вход по ссылке, origin не localhost, тот же профиль; токены не печатаются) | инструмент (запуск на машине владельца) |
| TASK 7: независимый Challenger | `docs/ISSUE-46-CHALLENGER-KIT.md` — 9 атак (A–I) с командами, критериями FAIL и формой отчёта; исполнителем НЕ сертифицирован | документ |
| TASK 1: дрифт прода виден без DevTools | `pullAll()` больше не глотает недоступные слои: возвращает `degraded[{relation,status,code}]` + один `console.warn` с лечением; кэш `scheduleOverrides` не переживает отказ слоя (иначе закрытый день оставался закрытым навсегда, а строки дублировались на каждой загрузке) | `tests/sync-degradation.mjs` — 17 проверок + контроль фальсификации (без сброса 5 краснеют) |
| «green CI маскирует failure» | CI раньше не запускал проверки проекта вовсе: добавлен workflow `Quality Gate` (`node tools/verify_all.mjs` + смоук маршрутов), деплой Pages ждёт его через `needs: quality-gate` | прогон в Actions: шаги `Install dev dependencies` / `Run project gate` / `Smoke routes` — success |

### Красные наборы на старте (найдено и исправлено)

На baseline `dcb4093` три набора были **красными** (`npm run verify` → 3 падения),
т.е. гейт не защищал от регрессий:

| Набор | Симптом | Root cause | Фикс |
|---|---|---|---|
| `tests/db-contract.mjs` | «анти-спам: 4-я запись отклонена» — FAIL | заявки ставились на 08:00/09:00 при окне приёма 10:00–18:00 → отклонялись расписанием, до счётчика не доходили | сценарий на свободные слоты 11:00–14:00 + обязательная проверка, что первые три прошли |
| `tests/security-regression.mjs` | T02 «paid-state injection» — FAIL (`В этот день недели приёма нет`) | даты `tomorrow/+2/+3` попадали на выходные при `work_days = [1..5]` | фиксированные будни в будущем (детерминированно в любой день запуска) |
| `tests/availability-db.mjs` | `weekLimit: первая на неделе → ok` — FAIL (`Это время только что заняли`) | неделя недельного лимита совпадала с датой dayLimit-сценария (коллизия данных, зависит от дня запуска) | неделя лимита вынесена за пределы всех дат набора |

После фикса: `node tools/verify_all.mjs` → **22/22 набора зелёные, exit 0**;
`BASE_URL=http://127.0.0.1:8765 python3 verify_pages.py` → **ALL PASS** (12 проверок).

**Внешнее подтверждение гейта (АУДИТОР: ВНЕШНИЙ):** тот же гейт выполнен в
GitHub Actions (workflow `Quality Gate`, job `verify`) — шаги `Install dev
dependencies`, `Run project gate (node tools/verify_all.mjs)` (14 с, как локально,
т.е. с тремя запусками настоящего PostgreSQL) и `Smoke routes against a real
devserver` — `success`. Проверено через API jobs, а не по «зелёной галочке».

**Контроль фальсификации гейта:** подмена канонической константы
(`DEFAULT_DURATION_MIN 60 → 45`) даёт `node tools/verify_all.mjs` → **exit 1**,
2 красных набора (`timezone-domain`, `availability-parity`); после отката — снова
22/22. Т.е. гейт реагирует на регрессию, а не всегда зелёный.

## 5. Definition of Done #46 — честный статус

| Пункт DoD | Статус | Основание |
|---|---|---|
| production DB inspected | **ЧАСТИЧНО** (LIVE, anon-канал): дрейф схемы закрыт владельцем (§2bis), блокеры сузились до Edge Functions и `create_booking`; `pg_proc`/гранты/RLS — только SQL-каналом владельца | §2, §2bis |
| auth-code deployment proven | **FAIL / BLOCKED — OWNER ACTION REQUIRED** (LIVE 05:53Z: `404 NOT_FOUND`) | §1, §2bis |
| real application origin configured | **PART**: клиентский канон — реальный origin (LIVE); Site URL/Redirect в Auth — UNKNOWN (владелец) | §3 |
| manual OTP production E2E PASS | **BLOCKED** (нет `auth-code` в проде, нет почтового ящика у исполнителя) | §1 |
| email-link production E2E PASS | **BLOCKED** (тот же блокер + Site URL не подтверждён) | §1, §3 |
| both paths converge to one canonical session | **FACT** (repo): один `finishAuthenticatedLogin`/`claim` на оба входа; Challenger-атака B на `d28ae94` — PASS | §4, `ISSUE-46-CHALLENGER.md` |
| same psychologist ownership proven | **FACT** (repo, тесты); production — BLOCKED | §4 |
| reload + repeat login proven | **FACT** (repo, тесты на отдельном процессе); production — BLOCKED | §4 |
| duplicate profile prevented | **FACT** (repo + PostgreSQL) | §4 |
| inactive account cannot be reactivated by login | **FACT** (PostgreSQL + клиентские тесты); мутация «гейт снят + `is_active = true`» → 5 FAIL | §4, Challenger §2.1 |
| #21/#22 production gates checked | **ЧАСТИЧНО**: `client_risks`/`clients`/`payments` закрыты для anon (LIVE); `create_booking` для anon **недоступен** → публичная запись в проде не работает (LIVE) | §2bis |
| independent Challenger PASS | **ВЫПОЛНЕНО** в ветке `arena/01a0d702` (атаки A–I, 8 мутационных контролей); отчёт — `docs/ISSUE-46-CHALLENGER.md`, PR #53. Формально закрывается после merge и Main Re-Audit | `ISSUE-46-CHALLENGER.md` |
| Main Re-Audit PASS | **ОЖИДАЕТ MERGE**: проверка выполнена на `main @ d28ae94` (гейт 24/24, pages ALL PASS); после merge нужен Re-Audit нового SHA владельцем/следующим проверяющим | Challenger §1 |
| CURRENT-STATE synchronized | **ВЫПОЛНЕНО** (main SHA, прод-таблица, контуры); остаток #50 — RECOVERY-ORCHESTRATION/ROADMAP | `docs/CURRENT-STATE.md` |
| «green CI masks failure» (TASK 7) | **ИСПРАВЛЕНО в этой ветке**: silent-набор и `FAIL` с отступом красят гейт (issue #51, F2); `supabase-deploy.yml` больше не бывает зелёным без деплоя (F4); probe не отчитывается «drift 0» без измерений (#54) | `tools/verify_all.mjs`, `tests/harness-guard.mjs`, `tests/prod-probe-report.mjs` |

## 6. Остаточные блокеры (единственный ответ, который требует #46)

**Приложение НЕ работает в production.** После среза §2bis схема применена,
поэтому список блокеров сократился до четырёх внешних действий владельца
(детали и команды — `docs/OWNER-CHECKLIST-E2E.md`):

1. **Задать секреты CI** `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID` →
   задеплоить `auth-code` и `telegram-notify` (`--no-verify-jwt`). Проверка:
   `Production read-only probe` больше не показывает `NOT_DEPLOYED`, а
   `supabase-deploy.yml` даёт зелёный **по факту доступности** функций
   (а не по факту отсутствия секретов, как раньше).
2. **Секреты Edge Functions**: `RESEND_API_KEY`, `MAIL_FROM`, `APP_URL`
   (= `https://a1dmitry.github.io/Psihologist-cabinet/`, не localhost).
3. **SQL-подтверждение `create_booking` и грантов** (Блок 7, запросы 1–2):
   публичная запись в проде не работает (`PGRST202` для anon). Если сигнатура и
   грант в порядке — перезагрузить кэш схемы PostgREST, затем повторить probe.
4. **Supabase Auth → URL Configuration**: Site URL и Redirect URLs = тот же
   origin; там же — срок сессии не больше месяца (серверная граница, #40 п.7).
5. После 1–4: `node tools/prod-e2e.mjs --email <тестовый ящик>` → реальный E2E
   (код и ссылка), затем повторный прогон `Production read-only probe`
   (должно остаться `drift 0` при `измерено: 26/26`).

### 6.1. Чек-лист закрытия #46

- [x] production DB inspected (LIVE, anon-канал; §2bis) — SQL-инвентарь остаётся за владельцем;
- [ ] auth-code deployment proven (LIVE: `NOT_DEPLOYED` → ожидает Блок 1);
- [x] real application origin configured на клиенте — [ ] Site URL/Redirect в Auth — UNKNOWN;
- [ ] manual OTP production E2E — BLOCKED (нет `auth-code`);
- [ ] email-link production E2E — BLOCKED (то же + Site URL);
- [x] both paths converge to one canonical session (FACT + Challenger);
- [x] same psychologist ownership proven (repo + PostgreSQL);
- [x] reload + repeat login proven (repo, отдельный процесс);
- [x] duplicate profile prevented;
- [x] inactive account cannot be reactivated by login (+ мутационный контроль);
- [x] #21/#22 production gates checked (LIVE: `client_risks` закрыт; `create_booking` — дефект зафиксирован);
- [x] independent Challenger PASS (TASK 7) — отчёт `ISSUE-46-CHALLENGER.md`, PR #53;
- [ ] Main Re-Audit PASS — после merge проверок этой ветки;
- [x] CURRENT-STATE synchronized (main SHA и прод-таблица);
- [x] «green CI masks failure» закрыто по факту: silent-набор, `FAIL` с отступом,
      зелёный «Deploy …» без деплоя и «drift 0» без измерений — исправлены с контролями.

**Вывод по закрытию:** issue закрывается после шага 5 (§6) — то есть после
внешних действий владельца и Main Re-Audit нового `main`. До этого «зелёной»
формулировки быть не может: production E2E не проведён.

---

*Сформировано 2026-09-25; обновлено в ветке `arena/01a0d702-psihologist-cabinet`
(PR #53) после Challenger-аудита `main @ d28ae94`. Issue #46 не закрывается до
production E2E (§6.1): это не отчёт исполнителя, а чек-лист владельца.*
