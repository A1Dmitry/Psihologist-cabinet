# План исполнения задачи AUDIT-REG-DRY-001

> **HISTORICAL REPORT — NOT CURRENT MAIN STATE.** Документ описывает снимок цикла «план цикла AUDIT-REG-DRY-001»
> (2026-09-23, 2026-09-23) и сохранён как история — не переписывается.
> Актуальное состояние — [`CURRENT-STATE.md`](CURRENT-STATE.md).


> Задача: полный аудит main → починить регистрацию → убрать дублирование → укрепить
> DRY/DDD/SOLID. Без переписывания проекта: малые атомарные изменения.
> Источник истины: текущий `main`, `AGENTS.md`, `docs/RULES.md`, `supabase/schema.sql`.
> Составлен: 2026-09-23. Статусы обновляются по мере исполнения (раздел «Трекер»).

---

## 0. Что уже найдено на этапе инвентаризации (до правок)

Инвентаризация выполнена чтением всего `main` (64 файла, ~17.1k строк кода/доков),
а не только файлов предыдущего агента. Ключевые находки — в `docs/FULL-AUDIT-REPORT.md`.
Кратко, что определяет порядок работ:

| # | Находка | Класс |
|---|---------|-------|
| F1 | `supabaseApi.userToken` — модульная переменная, нигде не сохраняется; `authService.session` не сохраняется; refresh_token не используется. После reload `cabinetApi.enabled() === false`, при этом роут-гард `authService.isAuthenticated()` возвращает `true` (localStorage) → пустой кабинет и **тихий** отказ всех write-through | CRITICAL |
| F2 | `restoreAuthenticatedState` отсутствует как контракт | CRITICAL |
| F3 | RPC `claim_psychologist_profile` не принимает и не сохраняет `phone` и `about`; `authService.verifyCode` их даже не передаёт → обязательные поля регистрации теряются | CRITICAL |
| F4 | В `verifyCode` канал подтверждения разветвлён дважды (`fn`/`otp` + «канал неизвестен»-ветка с ещё одной цепочкой), claim/create и инициализация локального состояния написаны один раз, но в теле метода сервиса, а не в use case | HIGH |
| F5 | `loadServerCatalog()` → `supabaseSync.pullAll()` делает `db.psychologists = rows.map(mapPsy)` — после reload затирает массив, по которому `db.currentPsychologist` ищет текущего владельца | HIGH |
| F6 | Booking: `navigate('success')` и `successText` выставляются **до** `supabaseSync.pushBooking(...)`; ошибка сервера уходит только в `console.warn` | CRITICAL |
| F7 | `create_booking`: проверка занятости и `INSERT` не сериализованы (нет блокировки) → две параллельные записи на один слот проходят | CRITICAL |
| F8 | `session.timezoneOffset` не присваивается нигде в коде → `p_timezone_offset` всегда `''`; пояс клиента пишется текстом в `sessions.note` | HIGH |
| F9 | Три независимые реализации часовых поясов: `calendarService`, `timezoneService`, приватные хелперы `BookingViewModel` | HIGH |
| F10 | Три реализации календарных хелперов today/addDays/weekday: `timezoneService`, `BookingViewModel`, `CabinetViewModel`/`cabinetUi` | MEDIUM |
| F11 | Два имени одного бизнес-поля в `BookingViewModel`: геттеры `psychologistTimeZone` и `psychologistTimezone`; поле `this.clientTimezone` и геттер `clientTimeZone` | MEDIUM |
| F12 | Duration-default `60` независимо задан в 5+ местах (`schema.sql`, `supabaseSync`, `cabinetApi`, `BookingViewModel`, `clientCabinetService`) | MEDIUM |
| F13 | Два маппера сессий: `cabinetApi.mapSession` (DB→domain) и `clientCabinetService.mapSession` (domain→UI) без общего источника duration | MEDIUM |
| F14 | Совок-тест `verify_auth.mjs` мокает `fetch` и потому не проверяет ни SQL-контракт RPC, ни реальный код Edge Function, ни reload | HIGH |

---

## 1. Порядок исполнения (по важности)

### P0-A · Инфраструктура честной проверки (разблокирует всё остальное)

Без неё любой «тест» — самосертификация (форма 6 туфты по `docs/RULES.md`).

1. `tools/dbtest/` — поднимаем **настоящий PostgreSQL** (embedded, npm) и применяем
   `supabase/schema.sql` **дословно** + минимальный шим Supabase-окружения
   (`auth.users`, `auth.uid()`, роли `anon`/`authenticated`/`service_role`).
   Это тестовая обвязка, не продуктовый код; `node_modules` — в `.gitignore`.
2. Возможность исполнять **настоящий** `supabase/functions/auth-code/index.ts`
   в Node через type-stripping + шим `Deno` (без второй реализации логики кодов).
3. Единый раннер: `node tools/verify_all.mjs`.

**Проверка:** `schema.sql` применяется к пустой БД без ошибок; `select create_booking(...)` исполняется.

### P0-B · Регистрация (Phase 2)

1. **Канонический use case** `js/domain/registration.js` с контрактом из задачи:
   `requestVerification`, `verifyVerification`, `ensureAuthenticatedSession`,
   `claimOrCreatePsychologist`, `restoreAuthenticatedState`.
   Вся валидация и весь порядок шагов — только здесь (единая реализация).
2. **Персистентность сессии**: `access_token`/`refresh_token`/`expires_at` в
   sandbox-safe хранилище; `supabaseApi.refreshSession()` (`/auth/v1/token`,
   `grant_type=refresh_token`); восстановление до роут-гарда в `boot()`.
3. **Ownership только по `auth.uid()`**: `fetchOwnedPsychologist()`
   (`psychologists?owner_id=eq.<uid>`), никакого поиска по email на клиенте.
4. **RPC `claim_psychologist_profile`**: `p_phone`, `p_about`; дозаполнение пустых
   полей существующего профиля; возврат `owner_id` и `created` для проверки инварианта.
5. **Единый канал для нового login-кода**: только `auth-code`; любая ошибка
   закрывается без GoTrue OTP fallback. Уже сохранённый legacy pending OTP можно
   проверить только исходным каналом, без переключения транспорта.
6. **`pullAll()` не затирает текущего владельца**; порядок в `boot()`:
   restore → guard → catalog.
7. `AuthViewModel` — только UI-состояние и оркестрация (никакой доменной логики).
8. `app.js`: поля `phone`/`about` реально собираются и уезжают на сервер.

**Definition of done проверяется тестом `tests/registration-flow.mjs`** (список ниже).

### P0-C · Тесты контракта (Phase 6)

| Тест | Что проверяет (фактический контракт, не наличие функции) |
|------|----------------------------------------------------------|
| `tests/db-contract.mjs` | реальный Postgres + реальный `schema.sql`: claim по новому email, повторный вход → тот же id и **ни одного дубля**, `owner_id = auth.uid()`, phone/about сохранены, overlap 90 мин, **две параллельные транзакции на один слот → ровно одна запись**, колонки пояса клиента |
| `tests/auth-code-edge.mjs` | настоящий обработчик Edge Function: одноразовость, TTL, лимит попыток, кулдаун, в БД только хеш, код не логируется |
| `tests/registration-flow.mjs` | use case целиком: новый email → аутентифицированный пользователь; повторный вход → тот же психолог; неверный/просроченный/повторно использованный код; отсутствие Edge Function; отсутствие mail-конфига; ошибка RPC; **reload сохраняет аутентификацию** |
| `tests/timezone-domain.mjs` | конвертация, граница DST, переход даты, 90-минутная длительность |
| `tests/session-mapper.mjs` | канонический маппер DB↔domain, round-trip без потерь |
| существующие `verify_*.mjs`, `tests/booking-wizard.mjs`, `tools/verify_cabinet.mjs`, `test_routing.mjs` | регрессия — должны остаться зелёными |

### P1-A · DRY: часовые пояса и календарь (Phase 3 + Phase 5)

- Канонический модуль — `js/services/timezoneService.js` (уже самый полный).
- `calendarService.js` теряет собственные копии (`detectTimeZone`, `zoneOffsetMinutes`,
  `zonedTimeToUtc`, `formatInZone`, `dateInZone`, `convertWallClock`, `isPastMoment`)
  и оставляет только интеграцию Google Calendar/iCal.
- Приватные хелперы `BookingViewModel` (`datePartsInTimeZone`, `zonedTimeToDate`,
  `detectClientTimezone`, `timezoneOffsetMinutes`, `todayStr`, `addDays`) удаляются.
- `convertWallClock` — одна сигнатура, возвращает `{date, time, weekday, dayShift}`.
- Одно имя поля: `psychologistTimeZone` (дубль `psychologistTimezone` удаляется),
  `clientTimeZone` (поле `this.clientTimezone` удаляется).
- Канонический контракт пояса клиента: `sessions.client_timezone` (IANA) +
  `sessions.client_utc_offset_min` (снимок). Несовместимый `timezone_offset`
  (строка «+02:00») из домена и кода убирается; offset не используется вместо зоны.

### P1-B · DRY: duration и маппер сессий (Phase 3)

- `js/domain/duration.js` — единственный `DEFAULT_DURATION_MIN` и `resolveDurationMinutes`.
- `js/services/sessionMapper.js` — единственный маппер строка БД ↔ `Session`
  (`sessionFromRow`, `sessionToRow`). `cabinetApi` использует его.
  `clientCabinetService` оставляет только UI-проекцию (она действительно другая
  по смыслу), но duration берёт из канонического резолвера.

### P1-C · Целостность записи (Phase 4)

- `create_booking`: `pg_advisory_xact_lock` по (психолог, дата) → проверка занятости
  и `INSERT` становятся атомарными; снимок `duration_min` в сессию.
- Фронтенд: success показывается **только** после подтверждения серверной транзакции;
  ошибка сервера — пользователю, а не в консоль.

### P2 · Документация (Phase 7)

`docs/FULL-AUDIT-REPORT.md`, синхронизация `docs/ROADMAP-OKNA.md` и
`docs/SCHEMA-REQUESTS.md` (SR закрываются только после фактической интеграции),
`docs/AGENT-4-REPORT.md` — только фактические результаты с маркером аудитора.

---

## 2. Трекер

| Шаг | Что | Статус |
|-----|-----|--------|
| 0 | Инвентаризация + dependency map | ✅ |
| 1 | `tools/dbtest/` (настоящий Postgres + schema.sql) | ✅ PostgreSQL 18.4, `schema.sql` дословно |
| 2 | `docs/FULL-AUDIT-REPORT.md` | ✅ 12 разделов + итог по структуре `RULES.md` §5 |
| 3 | Канонический use case `registration` + персистентность сессии | ✅ `js/domain/registration.js`; `AuthViewModel` — только UI; добавлено поле `about` |
| 4 | RPC `claim_psychologist_profile`: phone/about/owner_id | ✅ 6 аргументов, `owner_id` только из `auth.uid()`; починены гранты `create_booking` (корневая причина) |
| 5 | `tests/registration-flow.mjs`, `tests/db-contract.mjs`, `tests/auth-code-edge.mjs` | ✅ 44 + 36 + 39 проверок, все зелёные |
| 6 | DRY: timezone / calendar / duration / session mapper | ✅ `timezoneService`, `domain/duration`, `sessionMapper`, `safeStorage`; копии удалены |
| 7 | Booking: атомарность + success после сервера | ✅ advisory lock + интервальный overlap; `submit()` — server-first, откат локальной записи |
| 8 | `tests/timezone-domain.mjs`, `tests/session-mapper.mjs` | ✅ 46 + 22 проверки, все зелёные |
| 9 | Синхронизация ROADMAP / SCHEMA-REQUESTS / отчёт | ✅ SR-001/002/003/108 закрыты с фактическими именами; T-02/T-03/T-23 и `INFRA.md` п.2 обновлены |
| 10 | Прогон всех verify + регрессия | ✅ `npm run verify` → 12/12; `verify_pages.py` → ALL PASS (11 маршрутов) |

---

## 4. Продолжение: issue #14 «Production activation + auth-flow hardening» (2026-09-23)

Отчёт по циклу — `docs/ISSUE-14-REPORT.md`. Что сделано в этом цикле и чем проверено:

| Шаг | Что | Статус |
|-----|-----|--------|
| 11 | Pending-канал переживает reload: ожидание `{email, channel, requestedAt, expiresAt}` в `safeStorage`, перебор каналов удалён, при истёкшем окне — явное «Запросите новый код» | ✅ `js/domain/registration.js`, `AuthViewModel.resumePendingVerification()`, `renderAuth()`; проверки: `tests/registration-flow.mjs` (10 проверок «reload до ввода кода» + «потерянное состояние» + «чужой email» + «истёкшее окно»), `tests/auth-ui-pending.mjs` (12 проверок) |
| 12 | Атомарность погашения кода: захват → сессия → `used_at`, компенсация при отказе Auth, `recover`/`redeem`, SR-004 (`issued_token_hash` / `issues` / `consumed_at`) | ✅ `supabase/functions/auth-code/index.ts`, `supabase/schema.sql`; проверки: `tests/auth-code-edge.mjs` → 67 PASS (в т.ч. гонка двух параллельных verify, отказ Auth, legacy-схема), `tests/db-contract.mjs` → 47 PASS (3 из них — колонки SR-004) |
| 13 | Диагностика SR-004 в клиенте («Диагностика сервера» → «Схема auth_login_codes») | ✅ `supabaseApi.serverDiagnostics()` + проверка холостого `recover` в `tests/auth-code-edge.mjs` |
| 14 | Починен плавающий результат `tests/db-contract.mjs` (unhandled FATAL 57P01 при остановке PostgreSQL обрывал процесс до печати итога) | ✅ `node tools/verify_all.mjs` → 4/4 прогона зелёные, exit 0 |
| 15 | Production E2E (новый email → письмо → код → сессия → claim → кабинет → reload) | ⛔ **ЗАБЛОКИРОВАНО**: из песочницы нет сети до `supabase.co` (TLS-рукопожатие обрывается, `curl` exit 35), почтовый ящик для приёма OTP недоступен, секреты Resend/Supabase — у владельца. См. `docs/ISSUE-14-REPORT.md`, разделы 3/5/11 |
| 16 | Независимый Challenger-аудит другим агентом | ⛔ не выполнен: доступен один конвейер. Сделан отдельный проход «как челленджер» (поиск дублей, логирование секретов, reload/replay-сценарии) — его результаты и ограничения в `docs/ISSUE-14-REPORT.md`, раздел 9. Маркер: **АУДИТОР: САМ** |
| 17 | Независимый Challenger-аудит (другой агент, отдельная сессия) | ✅ 2026-09-24, отчёт: `docs/ISSUE-14-CHALLENGER.md`. Найден и исправлен дефект: пароль сейфа с формы регистрации собирался, но нигде не использовался (`authVm.password` терялся) — сейф оставался незадатым при «обязательном» поле. Исправление: `authService.verifyCode(..., vaultPassword)` применяет пароль до/после серверной части честно; валидация пароля сейфа — одна (`cryptoService.vaultPasswordError`); `supabaseSync.pushKeyVerifier` — единственный легитимный писатель `key_verifier` на сервер (раньше `pushProfile` его вырезал, и вопреки комментарию в UI verifier не покидал устройство). Проверки: `tests/registration-flow.mjs` блок 8 (30 проверок, вкл. «другое устройство» — verifier восстанавливается с сервера, сейф открывается прежним паролем), `npm run verify` → 14/14 зелёные, `verify_pages.py` → ALL PASS |

## 3. Границы (что НЕ делаем)

- Не переписываем архитектуру: MVVM, `dbContext`, `entities.js` остаются.
- Не вводим абстракции «ради SOLID»: максимум один use case на регистрацию,
  один маппер сессий, один доменный модуль часовых поясов.
- `schema.sql` меняется только там, где это наша зона (см. `docs/SCHEMA-REQUESTS.md`),
  идемпотентно, с записью SR.
- UI не считается доказательством готовности backend-flow; mock/localStorage не
  считается успешной регистрацией production-пользователя.
