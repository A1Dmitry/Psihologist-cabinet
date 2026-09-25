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

**Вывод (INFERENCE, высокая уверенность):** production-схема — более ранняя
генерация `supabase/schema.sql`: SR-001/SR-003 применены, **SR-004 и SR-D1 не
применены**. Root cause: `supabase/schema.sql` не переприменялся целиком
(задокументировано в `docs/INFRA.md`, п.2 как «критично: переприменить») — теперь
подтверждено живыми ответами прода, а не только отсутствием доказательства.

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
| TASK 1: SQL для владельца | `docs/OWNER-CHECKLIST-E2E.md`, Блок 7 — `pg_proc`/гранты/RLS/ownership | документ |

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

## 5. Definition of Done #46 — честный статус

| Пункт DoD | Статус | Основание |
|---|---|---|
| production DB inspected | **ЧАСТИЧНО** (LIVE, anon-канал): drift найден и задокументирован; `pg_proc`/гранты/RLS — только SQL-каналом владельца | §2 |
| auth-code deployment proven | **FAIL / BLOCKED — OWNER ACTION REQUIRED** | §1 |
| real application origin configured | **PART**: клиентский канон — реальный origin (LIVE); Site URL/Redirect в Auth — UNKNOWN (владелец) | §3 |
| manual OTP production E2E PASS | **BLOCKED** (нет `auth-code`, нет SR-004 в проде, нет почтового ящика у исполнителя) | §1, §2 |
| email-link production E2E PASS | **BLOCKED** (тот же блокер + Site URL не подтверждён) | §1, §3 |
| both paths converge to one canonical session | **FACT** (repo): один `finishAuthenticatedLogin`/`claim` на оба входа | §4 |
| same psychologist ownership proven | **FACT** (repo, тесты); production — BLOCKED | §4 |
| reload + repeat login proven | **FACT** (repo, тесты на отдельном процессе); production — BLOCKED | §4 |
| duplicate profile prevented | **FACT** (repo + PostgreSQL) | §4 |
| inactive account cannot be reactivated by login | **FACT** (PostgreSQL + клиентские тесты) — исправлено в этой ветке | §4 |
| #21/#22 production gates checked | **ЧАСТИЧНО**: `client_risks` закрыт для anon (LIVE); `create_booking` для anon **недоступен** → публичная запись в проде не работает (LIVE) | §2 |
| independent Challenger PASS | **НЕ ВЫПОЛНЕНО** — требуется независимый Challenger (TASK 7) | — |
| Main Re-Audit PASS | **НЕ ВЫПОЛНЕНО** — после merge в main | — |
| CURRENT-STATE synchronized | **ВЫПОЛНЕНО** в этой ветке | `docs/CURRENT-STATE.md` |

## 6. Остаточные блокеры (единственный ответ, который требует #46)

**Приложение НЕ работает в production.** Конкретные внешние действия владельца,
которые остаются блокирующими (порядок строгий, детали и команды —
`docs/OWNER-CHECKLIST-E2E.md`):

1. **Применить `supabase/schema.sql` целиком** в SQL Editor (устраняет drift:
   SR-004 `auth_login_codes.*`, D1 `schedule_overrides` / колонки политик /
   `services.availability`, `create_booking` + гранты anon, `claim_psychologist_profile`).
2. **Задать секреты CI** `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID`
   → задеплоить `auth-code` и `telegram-notify` (`--no-verify-jwt`).
3. **Секреты Edge Functions**: `RESEND_API_KEY`, `MAIL_FROM`, `APP_URL`
   (= `https://a1dmitry.github.io/Psihologist-cabinet/`, не localhost).
4. **Supabase Auth → URL Configuration**: Site URL и Redirect URLs = тот же
   origin; там же — срок сессии не больше месяца (серверная граница, #40 п.7).
5. После 1–4: `node tools/prod-e2e.mjs --email <тестовый ящик>` → реальный E2E,
   затем повторный прогон `Production read-only probe` (drift должен исчезнуть)
   и независимый Challenger (TASK 7).

---

*Сформировано 2026-09-25 в ветке `arena/01a0d6b5-psihologist-cabinet` (PR #47).
Issue #46 исполнителем НЕ закрывается: по TASK 7 требуется независимый
Challenger и Main Re-Audit на новом SHA `main`.*
