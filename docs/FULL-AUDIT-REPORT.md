# Полный технический аудит — AUDIT-REG-DRY-001

> **HISTORICAL REPORT — NOT CURRENT MAIN STATE.** Документ описывает снимок цикла «AUDIT-REG-DRY-001»
> (main @ `e7cc194`, 2026-09-23) и сохранён как история — не переписывается.
> Актуальное состояние — [`CURRENT-STATE.md`](CURRENT-STATE.md).


**Дата:** 2026-09-23 · **Ветка:** `arena/01a0cf7a-psihologist-cabinet` (от `main` @ `e7cc194`)
**Объект:** весь `main` — 64 файла, ~17.1k строк (код + доки), а не только файлы предыдущего агента.
**Правила:** `AGENTS.md`, `docs/RULES.md`. План работ — `docs/PLAN-AUDIT-REG-DRY-001.md`.

> **АУДИТОР: САМ** (в рамках одного конвейера). Проверки выполнены тем же агентом,
> который вносил правки; независимого внешнего верификатора не привлекалось.
> Все числа ниже получены прогоном команд, перечисленных в разделе «Доказательства».
> Формулировка «работает» без такой ссылки в этом документе не используется.

> **Обновление 2026-09-23 (issue #14).** Этот отчёт описывает цикл
> AUDIT-REG-DRY-001 и остаётся исторически точным, но два его вывода уточнены:
> 1. **Канал подтверждения кода терялся после перезагрузки страницы** и
>    `verifyVerification` подбирал транспорт перебором — исправлено
>    (`safeStorage`-ожидание `{email, channel, requestedAt, expiresAt}`,
>    перебор удалён). 2. **Код гасился до создания сессии** — временный отказ
>    Supabase Auth сжигал верный код; порядок изменён на «атомарный захват →
>    сессия → погашение» с компенсацией и действиями `recover`/`redeem`
>    (SR-004: `auth_login_codes.issued_token_hash` / `issues` / `consumed_at`).
>    Также устранён плавающий результат `tests/db-contract.mjs` (unhandled
>    FATAL 57P01 при остановке PostgreSQL менял код выхода после «ALL PASS»).
>    Подробности, статусы production-пунктов и Definition of Done —
>    **`docs/ISSUE-14-REPORT.md`**. Статус того цикла: **ЧАСТИЧНО ЗАВЕРШЕНО**
>    (production E2E заблокирован окружением, независимого аудитора не было).

---

## 1. Сильные стороны

- **RLS-контракт продуман.** Аноним видит только view (`public_profiles`,
  `public_settings`, `public_schedule_blocks`, `public_booked_slots`); запись
  клиента — только через `security definer` RPC. Проверено на живом PostgreSQL:
  аноним не читает `sessions`/`clients`, чужой владелец не читает чужие сессии.
- **Код входа спроектирован правильно**: хеш SHA-256 в БД, одноразовость
  (`used_at`), TTL 2 минуты, лимит 5 попыток, 30-сек кулдаун, алфавит без
  похожих символов. Код и токены не логируются (проверено grep'ом и тестом).
- **Честность к пользователю заложена в дизайн**: серверный каталог без
  локальной подмены, «Диагностика сервера», явная плашка ДЕМО.
- **`docs/RULES.md` — рабочий инструмент**, а не декорация: типология туфты
  реально помогает ловить самосертификацию (ниже она поймана дважды).
- Доменная модель (`entities.js`) и маппинг колонок документированы.

## 2. Слабые стороны

- **Ни одна проверка не доходила до SQL.** Все смоук-скрипты мокают `fetch`.
  Контракт RPC, RLS и ограничения схемы не проверялись ничем — поэтому критический
  дефект D1 жил в `main` незамеченным.
- **Один домен — несколько реализаций.** Часовые пояса были написаны трижды,
  календарные хелперы — трижды, маппер сессий — дважды, дефолт длительности — в 8 местах.
- **Документы расходились с кодом**: ROADMAP помечал T-02/T-03 «✅ сделано»,
  SCHEMA-REQUESTS — «ожидает Агента 1», а фактически поле `sessions.timezone_offset`
  не заполнялось нигде в коде, и `schema.sql` не применялся вовсе.
- **`schema.sql` — зона одного агента без автоматической проверки применения.**
  Идемпотентность декларировалась комментарием, не тестом.

## 3. Критические дефекты

| # | Дефект | Доказательство | Статус |
|---|--------|----------------|--------|
| **D1** | **`supabase/schema.sql` не применялся.** В `revoke/grant execute on function public.create_booking(...)` сигнатура была `(text×15, numeric, numeric, text, boolean, timestamptz)`, а функция объявлена как `(text×14, numeric, numeric, text, text, boolean, timestamptz)`. Postgres падал с `42883 function ... does not exist`, и **всё, что ниже по файлу, не создавалось**: `claim_psychologist_profile` и `client_error_logs`. | `node tests/db-contract.mjs` на `main`: `error: function public.create_booking(text ×15, ...) does not exist` | ✅ исправлено |
| **D2** | **Регистрация не могла работать в принципе.** D1 означает, что RPC привязки профиля в проде отсутствует: шаг «claim/создать психолога» падал. Плюс `claim_psychologist_profile` не принимал `phone` и `about`, а `authService.verifyCode` их даже не передавал — 2 из 6 обязательных полей терялись. Поле `#auth-about` в форме отсутствовало вовсе. | `grep -n "p_phone\|p_about" supabase/schema.sql` на `main` → пусто; `grep -c auth-about index.html` на `main` → 0 | ✅ исправлено |
| **D3** | **Аутентификация не переживала перезагрузку.** `supabaseApi.userToken` — модульная переменная; `authService.session` не сохранялся; `refresh_token` не использовался. После F5 роут-гард `authService.isAuthenticated()` возвращал `true` (localStorage), кабинет открывался, но `hasSession()` был `false` → `cabinetApi.push()` молча возвращался, и **ни одна мутация кабинета не уходила на сервер**. | `js/services/supabaseApi.js` на `main`: `let userToken = null` без персистентности; `js/services/cabinetApi.js`: `function push(...) { if (!on()) return; ... }` | ✅ исправлено |
| **D4** | **Успех записи показывался до серверной транзакции.** В `app.js`: `navigate('success')` → затем fire-and-forget `supabaseSync.pushBooking(...)`, отказ сервера — только в `console.warn`. Клиент видел «заявка отправлена», даже если записи в БД не было. | `git show e7cc194:js/app.js` — блок `$('#book-submit')` | ✅ исправлено |
| **D5** | **Гонка при записи.** `create_booking` проверял занятость и делал `INSERT` без сериализации: два параллельных вызова на один слот оба проходили проверку. | `tests/db-contract.mjs`, сценарий «гонка»: до правки обе транзакции принимались | ✅ исправлено |

## 4. Найденные дублирования

| Домен | Где дублировалось | Каноническая реализация |
|---|---|---|
| Часовые пояса (3 копии) | `calendarService.js` (`detectTimeZone`, `zoneOffsetMinutes`, `zonedTimeToUtc`, `formatInZone`, `dateInZone`, `convertWallClock`, `isPastMoment`), `timezoneService.js`, приватные хелперы `BookingViewModel` (`datePartsInTimeZone`, `zonedTimeToDate`, `detectClientTimezone`, `timezoneOffsetMinutes`) | **`js/services/timezoneService.js`**. `calendarService` оставил только Google Calendar/iCal; приватные хелперы удалены |
| Календарь today/addDays/weekday (3 копии) | `timezoneService.js`, `BookingViewModel` (`todayStr`, `addDays`), `CabinetViewModel` (`todayStr`, `addDays` + импорт `todayStr as zoneToday` рядом с локальной `todayStr`) | `timezoneService.todayStr / addDaysStr / daysFromToday / weekdayOf` |
| «HH:MM» ↔ минуты (2 копии в одном файле) | `BookingViewModel`: `toMinutes` (либеральный) и `timeToMinutes` (строгий) | `timezoneService.timeToMinutes / minutesToTime / addMinutesToTime` |
| Маппер сессий | `cabinetApi.mapSession` (DB→domain) и `clientCabinetService.mapSession` (свой расчёт duration/валюты) | **`js/services/sessionMapper.js`** (`sessionFromRow` / `sessionToRow`). UI-проекция клиента осталась — она другая по смыслу, но duration берёт из канонического резолвера |
| Дефолт длительности (8 мест) | `schema.sql` (`v_new_dur := 60`, view), `supabaseSync`, `cabinetApi` (×3), `BookingViewModel`, `clientCabinetService`, `cabinetStatsService`, `entities.js` (×2) | **`js/domain/duration.js` → `DEFAULT_DURATION_MIN`** + `resolveDurationMinutes`. На сервере — одна константа `v_default_dur` в `create_booking`, помеченная как зеркало клиентской |
| Имена одного поля | `BookingViewModel`: геттеры `psychologistTimeZone` **и** `psychologistTimezone`; геттер `clientTimeZone` **и** поле `this.clientTimezone` | Одно имя: `psychologistTimeZone`, `clientTimeZone` |
| Контракт пояса клиента | `sessions.timezone_offset text ('+02:00')`, `clientTimezone` (сейф), `clientTimezoneOffsetMin` (VM), `client_utc_offset` (SR-001), `zone_offset_min` (SR-108) | **`sessions.client_timezone` (IANA) + `sessions.client_utc_offset_min` (снимок)**. `timezone_offset` удалён из схемы, домена и кода |
| Sandbox-safe хранилище (2 копии) | `dbContext.StorageProvider`, `clientCabinetService` (`storeGet`/`storeSet` + свой `memory`) | **`js/core/safeStorage.js`** |

**Приёмка DRY** (требование задачи «поиск по репозиторию не выявляет параллельных реализаций»):

```
grep -rn "Intl.DateTimeFormat" js/ --include=*.js | grep -v timezoneService
```
→ остаётся только `BookingViewModel.formatDay` (формат подписи дня «ср, 24 сент.» —
представление, не арифметика поясов) и `cabinetUi`. Арифметики поясов вне
`timezoneService.js` в `js/` нет.

## 5. Прочие расхождения (high/medium/low)

| Уровень | Находка | Что сделано |
|---|---|---|
| HIGH | `loadServerCatalog()` → `pullAll()` делал `db.psychologists = rows.map(mapPsy)` и затира профиль текущего владельца при перезагрузке | `pullAll()` сохраняет профиль владельца, если его нет в публичном каталоге |
| HIGH | `session.timezoneOffset` не присваивался нигде → `p_timezone_offset` всегда `''`; пояс клиента писался текстом в `sessions.note` | Пояс и снимок смещения — отдельные поля записи; строка из `note` убрана |
| HIGH | `public_booked_slots.duration_min` во view был, но `supabaseApi.listBookedSlots` его не запрашивал → клиент считал чужую занятость по шагу сетки (SR-003) | `select=...,duration_min`; `remoteBusy` хранит длительность; проверено тестом |
| MEDIUM | `schedule_blocks` в `create_booking` сравнивались только по старту слота (SR-002) | Переведено на пересечение интервалов |
| MEDIUM | `claim_psychologist_profile` не создавал `session_settings` → у нового кабинета не определены сетка слотов и пояс | RPC создаёт стартовые настройки |
| MEDIUM | `AuthViewModel` и `authService` делили правила входа между собой; канал подтверждения разветвлялся дважды | Канонический use case `js/domain/registration.js`; ViewModel — только UI-состояние |
| LOW | `sessionZoneLabel` использовал `toISOString()` для расчёта времени клиента — корректно, но неявно | Оставлено поведение, добавлен комментарий о причине |

## 6. Dependency map (после правок)

```
index.html
  └─ js/app.js ─────────────── boot: restore → guard → catalog
       ├─ viewmodels/AuthViewModel ──(только UI)──► domain/registration  ◄── ЕДИНСТВЕННЫЙ use case
       │                                              ├─ services/supabaseApi (транспорт + персистентность сессии)
       │                                              ├─ core/safeStorage
       │                                              └─ services/psyMapper
       ├─ viewmodels/BookingViewModel ─► services/timezoneService  ◄── ЕДИНСТВЕННЫЕ пояса/календарь
       │                              ─► domain/duration           ◄── ЕДИНСТВЕННАЯ длительность
       │                              ─► services/supabaseSync ─► supabaseApi.rpc/create_booking
       ├─ viewmodels/CabinetViewModel ─► services/cabinetApi ─► services/sessionMapper ◄── ЕДИНСТВЕННЫЙ маппер
       └─ views/cabinetUi
supabase/schema.sql ──(применяется дословно)──► tests/db-contract.mjs (настоящий PostgreSQL)
supabase/functions/auth-code/index.ts ──► таблица auth_login_codes
```

## 7. Что изменено

**Новые файлы**
- `js/domain/registration.js` — канонический use case (`requestVerification`, `verifyVerification`, `ensureAuthenticatedSession`, `claimOrCreatePsychologist`, `restoreAuthenticatedState`, `completeVerification`, валидация, `signOut`)
- `js/domain/duration.js` — `DEFAULT_DURATION_MIN`, `resolveDurationMinutes`, `formatDuration`
- `js/services/sessionMapper.js` — `sessionFromRow` / `sessionToRow`
- `js/core/safeStorage.js` — единственное sandbox-safe хранилище
- `tools/dbtest/index.mjs` — embedded PostgreSQL + применение `schema.sql` дословно
- `tools/verify_all.mjs` — единый прогон всех проверок
- `tests/db-contract.mjs`, `tests/registration-flow.mjs`, `tests/timezone-domain.mjs`, `tests/session-mapper.mjs`
- `docs/FULL-AUDIT-REPORT.md`, `docs/PLAN-AUDIT-REG-DRY-001.md`

**Изменённые**
- `supabase/schema.sql` — исправлена сигнатура грантов `create_booking` (D1); новая сигнатура RPC с `p_client_timezone`, `p_client_utc_offset_min`, `p_duration_min`; advisory-lock; интервалы для `schedule_blocks`; `sessions.client_timezone/client_utc_offset_min/duration_min`, `timezone_offset` удалён; `claim_psychologist_profile` с `p_phone`/`p_about`, дозаполнением, `owner_id` в ответе, отказом на перехват и стартовыми настройками; `public_booked_slots` предпочитает снимок длительности
- `js/services/supabaseApi.js` — персистентность сессии, `refreshSession`, `userIdFromToken`, `fetchOwnedPsychologist`, новый payload `claimPsychologist`, `duration_min` в `listBookedSlots`
- `js/services/authService.js` — тонкая обёртка над use case (+ сейф клиентов)
- `js/viewmodels/AuthViewModel.js` — только UI-состояние и оркестрация
- `js/viewmodels/BookingViewModel.js` — приватные хелперы удалены, успех только после сервера, канонические поля пояса и снимок длительности
- `js/viewmodels/CabinetViewModel.js`, `js/services/{calendarService,cabinetApi,supabaseSync,clientCabinetService,cabinetStatsService}.js`, `js/models/entities.js`, `js/core/dbContext.js` — переход на канонические модули
- `index.html` — поле «О себе» + отметки обязательных полей регистрации
- `tests/booking-wizard.mjs`, `tools/verify_cabinet.mjs` — под новый (единый) контракт
- `package.json`, `.gitignore` — только dev-инструменты проверок

## 8. Выполненные проверки

`npm run verify` — 12 наборов, все зелёные:

| Набор | Что проверяет |
|---|---|
| `tests/timezone-domain.mjs` (46) | конвертация, **граница DST** (ЕС 25.10.2026, «провал» 08.03.2026 в Нью-Йорке), полуторачасовые смещения, переход суток, round-trip, 90 мин, канонический дефолт |
| `tests/session-mapper.mjs` (22) | DB↔domain round-trip, приоритет источников длительности, частичные строки |
| `tests/booking-wizard.mjs` | шаги wizard'а, слоты 90 мин, пояса, **отказ сервера → успех не показан**, контракт RPC |
| `tests/registration-flow.mjs` (44) | новый email → authenticated user; один психолог; `owner_id == auth.uid()`; все 6 полей; **reload в отдельном процессе**; повторный вход без дубля; неверный/просроченный/повторно использованный код; нет Edge Function; нет mail-конфига; ошибка RPC; код не в логах |
| `tests/auth-code-edge.mjs` (39) | **настоящий исходник `supabase/functions/auth-code/index.ts`** (подменены только `Deno` и `fetch`): код 8 знаков без I/O/0/1, в БД только SHA-256-хеш, TTL 120 с, кулдаун 30 с, одноразовость, лимит 5 попыток (6-я отказывает даже верным кодом), истечение, создание пользователя в `auth.users`, отказ Resend → 502, нет `RESEND_API_KEY` → 500, **код и `hashed_token` не попадают в логи**, `service_role`-ключ не уходит в письмо |
| `tests/db-contract.mjs` (36) | **настоящий PostgreSQL 18.4 + `schema.sql` дословно**: схема применяется, RPC существуют, claim/owner_id/дубли/перехват, перекрытие 90 мин, снимок длительности, **гонка двух транзакций → одна запись**, RLS, `public_booked_slots` |
| `tools/verify_cabinet.mjs` (107) | регрессия кабинета |
| `verify_auth.mjs` (25), `verify_profile.mjs` (29), `verify_telegram.mjs` (57), `test_routing.mjs` (36), `verify_app.mjs` | регрессия |
| `python3 verify_pages.py` против `devserver.py` | 11 маршрутов, все 200 (обязательно по `AGENTS.md` при правке UI) |

## 9. Регистрация: результат E2E

Проверено `tests/registration-flow.mjs` (контрактный фейк Supabase, проверяемый код — настоящий)
и `tests/db-contract.mjs` (настоящий PostgreSQL, настоящая `claim_psychologist_profile`):

- новый email → создан ровно один пользователь Auth и ровно один психолог;
- `psychologists.owner_id == auth.uid()`;
- `email/full_name/phone/specialization/city/about` сохранены (проверено чтением строки из БД);
- повторный вход тем же email (в другом регистре) → тот же `id`, `created=false`, дублей 0;
- чужой привязанный профиль не отбирается; `anon` не может вызвать RPC вовсе;
- reload (отдельный процесс, общая только `localStorage`) → аутентификация восстановлена,
  тот же психолог, `hasSession() === true`;
- неверный / просроченный / повторно использованный код отклоняются, сессия не выдаётся;
- нет Edge Function → запасной канал, но тот же use case и тот же `owner_id`;
- нет `RESEND_API_KEY` → честная ошибка без тихого fallback; ошибка RPC → ошибка пользователю.

**Что НЕ проверено:** реальный прод (`phiavtroybgwyjdhqqkh.supabase.co`) из этой
песочницы недоступен — `curl` до `supabase.co` возвращает `000`. Поэтому
«письмо реально пришло» и «прод-БД обновлена» подтвердить нельзя; см. раздел 11.

## 10. Запись: результат E2E

- клиентская сетка и серверная проверка сходятся на интервалах с учётом длительности;
- `create_booking` атомарна: две параллельные транзакции на один слот → ровно одна запись в БД;
- успех показывается только после подтверждения сервера; при отказе локальная запись
  откатывается, а ошибка показывается пользователю;
- снимок `duration_min` и пояс клиента сохраняются в сессии.

## 11. Остаточные риски

1. **`schema.sql` нужно переприменить в проде.** Без этого правки RPC не действуют.
   Шаг за владельцем (`docs/INFRA.md`): SQL Editor → выполнить `schema.sql` целиком.
   **Внимание:** миграция удаляет колонку `sessions.timezone_offset` и меняет
   сигнатуру `create_booking`. Проект pre-production (seed не накатан), но если в
   проде уже есть записи — сначала сделайте дамп.
2. **Edge Function `auth-code` не задеплоена, `RESEND_API_KEY` не задан** — оба
   блокеры на владельце. До этого работает запасной OTP-канал Supabase Auth
   (требует `{{ .Token }}` в шаблоне письма).
3. **Прод-регистрация не проверена от начала до конца** из-за отсутствия сети до `supabase.co`.
   Проверено: SQL-контракт на настоящем PostgreSQL и клиентский контракт на
   контрактном фейке. Не проверено: реальная доставка письма и реальный GoTrue.
4. **`auth-code/index.ts` не покрыт тестом напрямую** — его политика OTP
   (одноразовость/TTL/лимит) проверена косвенно, через фейк с теми же правилами
   и через SQL-контракт `auth_login_codes`. Прямой прогон настоящего обработчика
   под шимом Deno — в follow-up.
5. **Ловушка первого входа** (`docs/INFRA.md`): seed-email каталожной записи
   технический; без его замены вход создаст новый профиль рядом с каталожным.
6. **Заявки SR-101…SR-107 не закрыты** (серии, условия клиента, мини-кабинет на
   сервере, документы) — вне скоупа этой задачи.

## 12. Follow-up

| # | Задача | Приоритет |
|---|---|---|
| 1 | Переприменить `schema.sql` в проде и прогнать «Диагностику сервера» | P0 (владелец) |
| 2 | Задеплоить `auth-code`, задать `RESEND_API_KEY`, верифицировать домен | P0 (владелец) |
| 3 | ~~Прямой тест настоящего `auth-code/index.ts` под шимом Deno~~ — **сделано**: `tests/auth-code-edge.mjs` (39 проверок) | закрыто |
| 4 | `scheduled_at timestamptz`, вычисляемый сервером из `session_settings.timezone` (из SR-001) | P1 |
| 5 | Убрать пояс клиента из `sessions.note` в старых записях, если такие появятся | P2 |
| 6 | Закрыть SR-101…SR-107 (серии, условия, мини-кабинет, документы) | P2 |
| 7 | `sitemap.xml`: решить вопрос `/book/{slug}` (canonical или добавление) | P2 |

## Доказательства (воспроизводимо)

```bash
npm install                                  # только dev-инструменты проверок
npm run verify                               # 12 наборов, все зелёные
npm run verify:db                            # SQL-контракт на настоящем PostgreSQL
npm run verify:registration                  # регистрация E2E
npm run verify:authcode                       # OTP: настоящий auth-code/index.ts
python3 devserver.py 8765 &                  # для смоука маршрутов
BASE_URL=http://127.0.0.1:8765 python3 verify_pages.py
```

Дефект D1 на `main` воспроизводится так:

```bash
git stash && node -e "import('./tools/dbtest/index.mjs').then(async ({startTestDatabase}) => {
  const db = await startTestDatabase(); await db.stop(); })"
# → error: function public.create_booking(text, text, ... , timestamptz) does not exist
git stash pop
```

---

# Итог цикла — строго по 12 разделам `docs/RULES.md` §5

### 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ
Полный технический аудит `main`; починить регистрацию; свести дублирующуюся бизнес-логику
к одной канонической реализации; усилить DRY/DDD/SOLID — **без переписывания проекта**.
Спецификация: `AUDIT-REG-DRY-001`, фазы P1…P7. План: `docs/PLAN-AUDIT-REG-DRY-001.md`.

### 2. РЕЗУЛЬТАТ
- P1 аудит выполнен, отчёт — этот файл (12 разделов задания + доказательства).
- P2 регистрация: найден и устранён корневой дефект (D1); реализован канонический use case
  `js/domain/registration.js`; `AuthViewModel` сведён к UI-слою; поле `about` добавлено в форму.
- P3 DRY/DDD/SOLID: канонические `timezoneService.js`, `domain/duration.js`,
  `services/sessionMapper.js`, `core/safeStorage.js`; приватные копии удалены.
- P4 запись: интервальная занятость + advisory lock на сервере, server-first успех на клиенте.
- P5 часовой пояс: `sessions.client_timezone` (IANA) + `client_utc_offset_min` (снимок);
  альтернативное имя `timezone_offset` удалено.
- P6 тесты: 5 новых наборов (187 проверок) + отремонтированы существующие.
- P7 доки: `SCHEMA-REQUESTS.md`, `ROADMAP-OKNA.md`, `INFRA.md`, `AGENT-1-REPORT.md` синхронизированы.

### 3. ПРОВЕРКА
`npm run verify` → 12/12 наборов зелёные; `node tests/db-contract.mjs` → 36/36 на
настоящем PostgreSQL 18.4 с `schema.sql` дословно; `node tests/registration-flow.mjs` → 44/44;
`node tests/timezone-domain.mjs` → 46/46; `node tests/session-mapper.mjs` → 22/22;
`python3 verify_pages.py` против `devserver.py` → ALL PASS (11 маршрутов). Условия — раздел
«Доказательства». Маркер: **АУДИТОР: САМ** — проверял тот же агент, что правил;
независимого внешнего верификатора не было.

### 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ (подтверждено прогоном)
- `schema.sql` применяется на реальном PostgreSQL целиком; до правки — падал (42883).
- `claim_psychologist_profile` существует и привязывает `owner_id` к `auth.uid()`;
  повторный вызов тем же uid не создаёт дубль (проверено SQL-запросом, не моком).
- Перехват чужого профиля невозможен: при чужом `owner_id` → `ok=false`.
- Гонка двух одновременных транзакций записи → ровно одна сессия (advisory lock).
- 90-минутная запись перекрывает соседний слот и на сервере, и в сетке клиента.
- Регистрация проходит путь «ввод → код → authenticated session → профиль → reload → тот же психолог»
  на проверяемом коде; reload моделируется отдельным процессом Node.
- Граница DST и перелёт суток считаются каноническим модулем (тест с «провалом» 08.03.2026 в Нью-Йорке).

### 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ
- **Прод не проверен.** Сети до `*.supabase.co` из песочницы нет (HTTP 000), поэтому
  реальный Supabase Auth, реальный Resend и реальный Edge Function не задействованы.
- Прод-деплой `schema.sql`, деплой `auth-code`, секрет `RESEND_API_KEY` — за владельцем
  (п.2/4/5/6 `docs/INFRA.md`). До этого регистрация в проде не заработает, какой бы
  корректной ни была клиентская часть.
- `tests/auth-code-edge.mjs` исполняет настоящий исходник Edge Function, но в
  процессе Node: снимается только TypeScript-аннотация, `Deno` и `fetch` подменены.
  Реальный рантайм Deno Deploy и реальный Resend не задействованы.
- SR-101…SR-107 (серии, условия, мини-кабинет, документы) остались в очереди.
- `scheduled_at timestamptz` из SR-001 не добавлен (следует отдельной заявкой).
- `clientCabinetService.mapSession` сохранён как UI-проекция; длительность в нём берётся
  из канонического резолвера, но сам маппер не слит с `sessionMapper`.

### 6. ТУФТА НАЙДЕНА
- В **предыдущем** состоянии репозитория: (а) заявка SR-001 числилась «ждёт Агента 1»,
  хотя поле `sessions.timezone_offset` уже существовало; (б) поле `timezoneOffset` в
  `Session` не присваивалось нигде, а пояс клиента писался текстом в `sessions.note`;
  (в) `verify_auth.mjs` подписывал «ALL PASS», будучи полностью моковым (RPC `claim…`
  заглушён на постоянный `{ok:true}`) — как доказательство регистрации он не годился.
- В **своих** действиях: первая версия `tests/registration-flow.mjs` имела самопроверяющуюся
  ассерцию повторного использования кода (моки возвращали `ok` независимо от состояния) —
  переписана так, чтобы фейк хранил состояние кода и реально отклонял повтор;
  «reload» изначально выполнялся в том же процессе и не доказывал восстановление —
  заменён отдельным дочерним процессом.

### 7. КОРЕННЫЕ ПРИЧИНЫ (5 Почему)
1. Почему регистрация не работала? → в проде не было функции `claim_psychologist_profile`.
2. Почему её не было? → `schema.sql` не применялся целиком.
3. Почему не применялся? → PostgreSQL прерывал файл на `revoke/grant execute` с неверной арностью `create_booking`.
4. Почему арность разъехалась? → сигнатуру RPC правили, а блок грантов под ней — нет;
   проверки применения `schema.sql` в процессе не было.
5. Почему не было проверки? → в репозитории отсутствовала БД-проверка как класс:
   ни одного теста, который выполнял бы `schema.sql` на настоящем сервере.
   **Первопричина: контракт БД не проверялся ничем, поэтому расхождение жило незамеченным.**

### 8. РЕМОНТ (системный, по первопричине)
- Добавлен `tools/dbtest/` (embedded PostgreSQL 18.4, `schema.sql` дословно) и
  `tests/db-contract.mjs` — теперь любое расхождение арности/колонок валит прогон,
  а не прод. Подключено к `npm run verify` и `npm run verify:db`.
- Добавлен `tools/verify_all.mjs` (`npm run verify`) — единая точка прогона 12 наборов,
  чтобы «проверил один тест» не выглядел как «проверил всё».
- Правило «одна бизнес-правило — один модуль» закреплено кодом, а не декларацией:
  `timezoneService`, `duration`, `sessionMapper`, `safeStorage`; приватные копии удалены,
  и их возвращение ломает тесты на дубли.
- В `docs/SCHEMA-REQUESTS.md` внесено замечание о конфликте нумерации SR-001/SR-002,
  чтобы параллельные агенты не создавали два контракта одного поля.

### 9. ОСТАВШИЕСЯ РИСКИ
1. Прод-миграция: удаление `sessions.timezone_offset` и смена арности `create_booking`
   требуют переприменения `schema.sql`; при частичном применении возможны ошибки.
2. Пока `RESEND_API_KEY` не задан, основной канал кода возвращает 500 и клиент уходит
   в OTP-фолбэк Supabase — поведение корректное, но не то, которое задумано.
3. Канонический контракт пояса проверен на клиенте и в БД, но реальные письма/уведомления
   (T-15) ещё не подписывают время в поясе клиента.
4. Третье представление пояса (`clientVaultService.CONDITION_KEYS`,
   `session_series.clientTimezone`) не приведено к каноническому.
5. Независимого верификатора нет: все прогоны выполнены тем же агентом (маркер «АУДИТОР: САМ»).

### 10. ДОКАЗАТЕЛЬСТВО
Команды и фактические результаты — разделы «8. Выполненные проверки» и «Доказательства».
Ключевые воспроизводимые факты: `tests/db-contract.mjs` → `ALL PASS (36)`;
`tests/registration-flow.mjs` → `ALL PASS (44)`; `tests/timezone-domain.mjs` → `ALL PASS (46)`;
`tests/session-mapper.mjs` → `ALL PASS (22)`; `tools/verify_all.mjs` → `Все наборы зелёные (11)`;
`verify_pages.py` → `ALL PASS` (11 маршрутов). Воспроизведение дефекта D1 на `main` —
скрипт в разделе «Доказательства».

### 11. ОКОНЧАТЕЛЬНЫЙ СТАТУС
**ЧАСТИЧНО ЗАВЕРШЕНО.** Код, схема, тесты и документация закрыты и проверены;
сквозная проверка на проде и деплой — вне возможности исполнителя (нет сети до
`supabase.co`, деплой и секреты — действия владельца). Статус станет «ЗАВЕРШЁННЫЙ»
после пунктов 1–2 из раздела «12. Follow-up».

### 12. УВЕРЕННОСТЬ
**Средне-высокая для кода и схемы, низкая для прода.** Основание: утверждения о поведении
опираются на прогон настоящего PostgreSQL и на выполнение реального клиентского кода
(включая перезагрузку в отдельном процессе), а не на заглушки; каждое число в отчёте
получено командой. Основание для снижения: prod-контур не трогался, независимой проверки
не было, а часть выводов о почте/уведомлениях сделана по коду, а не по факту доставки.
