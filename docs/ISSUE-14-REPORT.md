# Отчёт по issue #14 — Production activation + auth-flow hardening + verification

> **HISTORICAL REPORT — NOT CURRENT MAIN STATE.** Документ описывает снимок цикла «issue #14 (Producer)»
> (main @ `998561d`, 2026-09-23) и сохранён как история — не переписывается.
> Актуальное состояние — [`CURRENT-STATE.md`](CURRENT-STATE.md).


**Дата:** 2026-09-23 · **Ветка:** `arena/01a0d001-psihologist-cabinet` (от `main` @ `998561d`)
**Задача:** https://github.com/A1Dmitry/Psihologist-cabinet/issues/14
**Правила:** `AGENTS.md`, `docs/RULES.md` (12 разделов, маркер аудитора, запрет самосертификации).

> **АУДИТОР: САМ** (в рамках одного конвейера). Все числа и статусы ниже получены
> командами, перечисленными в разделе 10. Независимого внешнего верификатора
> привлечь не удалось (см. раздел 9) — по `docs/RULES.md` §3 это означает:
> «информация предоставлена исполнителем, не подтверждена независимыми источниками».
>
> **Главное правило задачи соблюдено: регистрация НЕ объявлена работающей.**
> Реального сценария «новый email → письмо → код → Auth → claim → кабинет → reload»
> выполнено не было — он заблокирован окружением (раздел 5).

---

## 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Довести `main` до проверенного production-ready состояния по трём направлениям:
(1) фактически запустить и доказать регистрацию в production; (2) устранить два
edge-case auth-flow — потерю выбранного OTP-канала после reload и сжигание OTP до
успешного создания Auth-сессии; (3) провести независимый Challenger-аудит.
Плюс пункты 5–10 задачи: security review, booking-регрессия, тесты, документация,
Definition of Done, отчёт.

## 2. РЕЗУЛЬТАТ

| Направление | Что сделано | Как проверено |
|---|---|---|
| **п.3 Pending OTP channel (P1)** | Ожидание `{email, channel, requestedAt, expiresAt}` сохраняется в `safeStorage` при `requestVerification`; `verifyVerification` берёт транспорт **только** из него; ветка перебора каналов удалена; при истёкшем окне — явное «Запросите новый код»; UI возвращает пользователя на шаг ввода кода после F5 (`AuthViewModel.resumePendingVerification()` → `renderAuth()`) | `tests/registration-flow.mjs` (75 PASS, из них блок «reload до ввода кода» выполняется **в отдельном процессе** — чистая память модулей, общим остаётся только localStorage), `tests/auth-ui-pending.mjs` (12 PASS) |
| **п.4 OTP consumption atomicity (P1)** | Порядок в Edge Function изменён на «атомарный захват строки → создание сессии → погашение `used_at`». Отказ Supabase Auth больше не сжигает код: захват снимается (компенсация), код можно ввести снова. Добавлены `action=recover` (перевыпуск сессии по `code_id` в пределах TTL) и `action=redeem` (браузер сообщил, что JWT получен → перевыпуск закрыт). Схема: SR-004 (`issued_token_hash`, `issues`, `consumed_at`) | `tests/auth-code-edge.mjs` (67 PASS) — исполняется **настоящий исходник** функции; `tests/db-contract.mjs` (47 PASS) на реальном PostgreSQL 18.4 |
| **п.1 Production activation (P0)** | Проверено всё, что проверяется без доступа к проекту: код функции, схема, CI-деплой, конфигурация клиента. Найдено и зафиксировано: CI-деплой функций **никогда не выполнялся** (нет `SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_ID`) | `gh api …/actions/runs/35850021571/jobs` — шаги `Deploy functions: skipped` (раздел 10) |
| **п.2 Real E2E registration (P0)** | **Не выполнено** — заблокировано окружением | раздел 5 |
| **п.5 Security review (P1)** | Пройден по коду (ownership только из `auth.uid()`, отсутствие логов кода/токенов/пароля сейфа, содержание ошибок) | grep-проверки + тесты, раздел 8 |
| **п.6 Booking regression (P1)** | Прогнан без изменений в booking-коде | `tests/booking-wizard.mjs` 47 PASS, `tests/db-contract.mjs` (гонка двух параллельных записей, интервальный overlap, 90 минут, RLS), `tests/timezone-domain.mjs` 46 PASS, `tests/session-mapper.mjs` 22 PASS |
| **п.7 Independent Challenger audit (P1)** | **Не выполнен в требуемом виде** (нет второго агента). Сделан отдельный проход «как челленджер» — раздел 9 | — |
| **п.8 Tests (P1)** | Добавлены/обновлены проверки всех перечисленных в задаче сценариев auth, кроме тех, что требуют прод (см. таблицу DoD) | `npm run verify` → 14/14 наборов зелёные |
| **п.9 Documentation** | `docs/INFRA.md`, `docs/SCHEMA-REQUESTS.md` (SR-004), `docs/PLAN-AUDIT-REG-DRY-001.md`, `README.md`, `docs/FULL-AUDIT-REPORT.md` | — |

Побочно устранён дефект инфраструктуры проверок: `tests/db-contract.mjs` давал
**плавающий** результат — процесс падал с кодом 1 из-за unhandled FATAL `57P01`
(«terminating connection due to administrator command») от спящего клиента `pg`
в момент остановки сервера, причём событие прилетало во время `db.stop()`, то
есть **до** печати итога: в логе были все PASS и не было «ALL PASS». Замерено:
до правки `node tools/verify_all.mjs` → 1 провал из 3; после первой правки
(обработчики стояли после `db.stop()`) — 1 провал из 3 снова; после переноса
обработчиков до поднятия БД — **4/4 прогона `verify_all` зелёные, exit 0**.

## 3. ПРОВЕРКА (что именно запускалось и в каких условиях)

Условия: песочница без доступа к внешним сервисам, кроме GitHub API
(доказательство — раздел 5). Node v22.22.3, Python 3.11.2, PostgreSQL 18.4
(embedded, поднимается самим тестом).

```
npm install                                  # 17 пакетов (embedded-postgres, pg)
npm run verify                               # 14/14 наборов зелёные
node tests/db-contract.mjs                   # 47 PASS — реальный PostgreSQL + schema.sql дословно
node --no-warnings tests/auth-code-edge.mjs  # 67 PASS — настоящий исходник Edge Function
node tests/registration-flow.mjs             # 75 PASS — use case + reload в отдельном процессе
node tests/auth-ui-pending.mjs               # 12 PASS — UI-контракт ожидания кода
node verify_auth.mjs                         # 29 PASS — каналы, сессия, write-through
python3 devserver.py 8765 & python3 verify_pages.py   # ALL PASS (11 маршрутов + 404)
```

Что эти проверки **действительно** исполняют:
- `tests/auth-code-edge.mjs` загружает `supabase/functions/auth-code/index.ts`
  как есть (сняты только TS-аннотации) и вызывает полученный обработчик;
  подменяются лишь `Deno.env` и `fetch`. Проверяются: одноразовость, TTL,
  5 попыток, кулдаун 30 с, «в БД только хеш», отказ Auth → код не сожжён,
  гонка двух параллельных `verify` → ровно один `hashed_token` и один вызов
  `generate_link`, `recover`/`redeem`, лимит перевыпусков, legacy-схема.
- `tests/db-contract.mjs` применяет `supabase/schema.sql` к пустой БД и
  исполняет RPC от ролей `anon`/`authenticated`/`service_role`.
- `tests/registration-flow.mjs` исполняет настоящий `js/domain/registration.js`
  и `js/services/supabaseApi.js`; Supabase заменён контрактным фейком.
  Сценарий reload — **отдельный процесс** (`spawnSync`), общее с «прошлой
  загрузкой» только localStorage.

## 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ (подтверждённые факты)

1. Канал доставки переживает перезагрузку: после «F5» восстановлены email,
   канал `fn` и остаток окна; код принят тем же каналом; запасной OTP не
   вызывался (проверка по журналу исходящих запросов).
2. Перебор каналов удалён: при потерянном ожидании `verifyVerification`
   возвращает ошибку, **не сделав ни одного сетевого запроса**.
3. Код, отправленный на один email, нельзя проверить, введя другой: отказ до
   обращения к серверу.
4. Временный отказ Supabase Auth не сжигает код: `used_at` остаётся `null`,
   захват снят, повторный ввод того же кода после «оживания» Auth выдаёт сессию.
5. Гонка закрыта: два параллельных `verify` → один токен, один `generate_link`,
   второй запрос получает 409.
6. Replay закрыт: после `redeem` (`consumed_at`) `recover` отказывает; лимит
   перевыпусков — 3; `recover` без `code_id` и с чужим `code_id` — 400.
7. Обратная совместимость: если в БД нет колонок SR-004, вход продолжает работать
   (legacy-режим с компенсацией), а клиентская «Диагностика сервера» показывает
   красный пункт «Схема auth_login_codes (SR-004)».
8. Booking не тронут и зелёный: 47 + 46 + 22 проверки и SQL-контракт
   (интервальный overlap, advisory lock, «ровно одна из двух параллельных
   записей», RLS, длительность 90 минут во view).
9. Секреты не логируются: в auth-цепочке (`registration`, `authService`,
   `AuthViewModel`, `supabaseApi`, Edge Function) нет ни одного `console.*`;
   тесты проверяют, что код и `hashed_token` не появляются в логах функции,
   а `service_role`-ключ — в письме.

## 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ (что не сделано и почему)

### 5.1 Production E2E — ЗАБЛОКИРОВАНО (п.1 и п.2 задачи)

Из песочницы недоступны все хосты, кроме GitHub API. Измерено в этой сессии:

```
$ curl -sv -m 20 -X POST https://phiavtroybgwyjdhqqkh.supabase.co/functions/v1/auth-code …
* Connected to phiavtroybgwyjdhqqkh.supabase.co (172.64.149.246) port 443
* OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to …:443     # exit 35
$ curl -s -o /dev/null -w '%{http_code}' https://phiavtroybgwyjdhqqkh.supabase.co/rest/v1/   → 000
$ curl -s -o /dev/null -w '%{http_code}' https://a1dmitry.github.io/Psihologist-cabinet/     → 000
$ curl -s -o /dev/null -w '%{http_code}' https://supabase.com                                → 000
$ curl -s -o /dev/null -w '%{http_code}' https://resend.com                                  → 000
$ curl -s -o /dev/null -w '%{http_code}' https://api.github.com/repos/A1Dmitry/Psihologist-cabinet → 200
```

Следовательно, физически не выполнены: проверка `auth.users`, реальной доставки
письма Resend, выдачи access/refresh-токенов, `auth.uid()` внутри RPC на проде,
сценарии «новый email», «повторный вход», «ошибки на проде». Почтовый ящик для
приёма OTP в песочнице также отсутствует. **Это блокер на окружении, а не на коде.**

### 5.2 Что удалось установить о проде без доступа к нему

- **Edge Function через CI не деплоилась ни разу.** Единственный запуск
  `.github/workflows/supabase-deploy.yml` (run `35850021571`, 10 ч назад,
  «success») прошёл по ветке пропуска: аннотация
  «SUPABASE_ACCESS_TOKEN (secret) или SUPABASE_PROJECT_ID (variable) не заданы»,
  шаги `Checkout / Setup Supabase CLI / Deploy functions / Smoke check` — `skipped`.
  «Success» этого workflow **не означает** задеплоенную функцию.
- **Схема в проде не переприменена** (п.2 `docs/INFRA.md` — статус «⏳ критично»
  ещё до этого цикла). Значит колонок SR-004 в проде сейчас нет, и после деплоя
  функции она ответит в legacy-режиме, пока схему не применят.
- **Секреты Resend** (`RESEND_API_KEY`, `MAIL_FROM`) — на стороне владельца;
  проверить их из песочницы нельзя.

### 5.3 Независимый Challenger-аудит — не выполнен в требуемом виде

Второго агента/процесса в распоряжении нет. Проведён отдельный проход
«как челленджер» (раздел 9), но по `docs/RULES.md` §3 он остаётся
самопроверкой: маркер **АУДИТОР: САМ**.

## 6. ТУФТА НАЙДЕНА (в том числе в собственной работе)

1. **Плавающий тест как имитация зелёного прогона.** `tests/db-contract.mjs`
   печатал «ALL PASS» и завершал процесс кодом 1 (unhandled FATAL 57P01 при
   остановке PostgreSQL). Любой, кто смотрел только на текст, видел успех;
   любой, кто смотрел только на код выхода, видел провал. Воспроизведено 2/3
   до правки, 0/5 после. (Форма 1 — метрика, не отражающая реальность.)
2. **`advanceTime()` в тесте Edge Function не сдвигал `expires_at`**
   (`… - 0`), то есть «промотка времени» не проматывала TTL. На старых проверках
   это не сказывалось (TTL задавался напрямую), но новый тест на истечение окна
   ловил бы не то. Исправлено вместе с переписыванием harness'а.
3. **Собственная ошибка в ходе работы:** первая версия `pendingVerification()`
   удаляла истёкшую запись из хранилища, из-за чего UI не мог показать
   «окно истекло — запросите новый код» (тест `tests/auth-ui-pending.mjs` это
   поймал: `FAIL истёкшее окно: явное сообщение`). Исправлено: чтение для UI
   (`peekPendingVerification`) не разрушает состояние.
4. **Риск, который я сам создал и снял:** первоначальный вариант SR-004
   требовал колонок и ломал бы вход в проде (где схема не применена). Добавлен
   legacy-путь с явной подсказкой, чтобы «починка атомарности» не превратилась
   в «регистрация не работает вовсе».
5. **Самосертификация в отчётах предыдущих циклов** в этом цикле не
   воспроизводится: статус «ЗАВЕРШЁННЫЙ» не присваивался, «production-ready»
   и «verified» в отношении прода не пишутся.

## 7. КОРЕННЫЕ ПРИЧИНЫ (5 Почему)

**A. Код сгорал при временном отказе Auth**
1. Почему пользователь терял регистрацию? → `used_at` ставился до `generate_link`.
2. Почему так было написано? → одноразовость понималась как «отметить при
   проверке», а не «отметить при выдаче сессии».
3. Почему порядок не проверили? → тест фиксировал существующее поведение
   («код уже погашен» при отказе сессии), то есть закреплял дефект.
4. Почему тест так написали? → не было сценария «Auth временно недоступен»
   как отдельного требования.
5. **Первопричина:** отказ внешнего сервиса не рассматривался как часть
   контракта регистрации; не было инварианта «код расходуется только вместе
   с успешно созданной сессией».

**B. Канал терялся после reload**
1. Почему после перезагрузки код проверялся «не тем» транспортом? → канал жил
   в переменной модуля.
2. Почему в переменной? → состояние не считалось частью пользовательского сценария.
3. Почему не считалось? → сценарий «F5 между шагами» не был описан ни в доках, ни в тестах.
4. Почему не был описан? → требования к регистрации формулировались по happy path.
5. **Первопричина:** отсутствие требования «состояние шага переживает
   перезагрузку» и отсутствие теста на него.

**C. Прод-активация не происходит**
1. Почему функция не задеплоена? → CI-деплой пропускается без токена.
2. Почему workflow при этом «success»? → пропуск оформлен как успешный шаг
   с `::notice`, а не как ошибка.
3. Почему так оформлено? → чтобы не ломать сборку до настройки секретов.
4. Почему настройка не сделана? → это действие владельца (секреты репозитория).
5. **Первопричина:** ответственность за прод-конфигурацию не передана явно,
   а «зелёный» CI создаёт ложное ощущение задеплоенности.

## 8. РЕМОНТ (системный, по первопричине)

- **Инвариант «код расходуется только с сессией» закреплён кодом и тестом**,
  а не комментарием: атомарный захват (условный UPDATE), компенсация,
  `recover`/`redeem`, SR-004. Тест `tests/auth-code-edge.mjs` теперь содержит
  сценарии «Auth временно недоступен» и «два параллельных verify».
- **Требование «состояние шага переживает reload» стало проверяемым:**
  `tests/registration-flow.mjs` запускает перезагрузку отдельным процессом,
  `tests/auth-ui-pending.mjs` проверяет UI-связку (safeStorage → ViewModel →
  `renderAuth`). Подключено к `npm run verify` (14 наборов).
- **Ложная «задеплоенность» закрыта документально:** в `docs/INFRA.md` прямо
  записано, что `success` у `supabase-deploy.yml` без секретов означает пропуск,
  и добавлен порядок «сначала схема, потом функции».
- **Диагностика прода доступна владельцу без агента:** пункт «Схема
  auth_login_codes (SR-004)» в клиентской «Диагностике сервера» (холостой
  `recover`: письмо не уходит, данные не меняются).
- **Плавающий тест устранён**: обработчики `uncaughtException`/`unhandledRejection`
  в `tests/db-contract.mjs` поставлены **до** поднятия БД (событие 57P01
  возникает внутри `db.stop()`), итог печатается всегда, код выхода определяется
  только результатами проверок. Проверено 4/4 прогонами `node tools/verify_all.mjs`.

## 9. Security review (п.5) и Challenger-проход (п.7)

Проверки выполнены в этом цикле отдельным проходом по текущему дереву
(**АУДИТОР: САМ**):

| Проверка | Как | Результат |
|---|---|---|
| Ownership только из `auth.uid()` | чтение `claim_psychologist_profile` в `supabase/schema.sql` (`v_owner uuid := auth.uid()`, отказ при `null`, чужой профиль не отбирается) + `fetchOwnedPsychologist(ownerId)` | подтверждено; тесты `tests/db-contract.mjs` и «без аутентификации профиль не создаётся» |
| Email не является источником авторизации | grep по клиенту: email используется только как аргумент поиска профиля | подтверждено |
| Дубли доменной логики | grep: кто ходит в `/auth/v1/verify` и `/functions/v1/auth-code` | только `js/services/supabaseApi.js` (2 и 3 вхождения); `normalizeCode/validateCode/normalizeEmail/validateEmail` вне `domain/registration.js` — **0 вхождений**; канал читают только `authService.channel` (делегирование) и `AuthViewModel` (UI) |
| Код/токены не в логах | grep `console.*` по auth-цепочке; тесты Edge Function | 0 вхождений; тесты «код не печатается в логи функции», «hashed_token не печатается» |
| Пароль сейфа не в логах | grep `console.*` в `cryptoService.js` | 0 вхождений |
| Токены не в URL/истории | grep `history.pushState`/`location.hash` | только hash-маршруты без токенов |
| Ошибки не раскрывают секретов | чтение обработчика: в 502 уходит `msg/error_description` от GoTrue и `code/message` от PostgREST; `service_role`-ключ не покидает заголовки (тест) | подтверждено |
| Reload/resume | `tests/registration-flow.mjs` (отдельный процесс), `tests/auth-ui-pending.mjs` | подтверждено |
| Concurrent/replay | гонка двух `verify`, `recover` после `redeem`, лимит `issues`, `recover` с чужим `code_id` | подтверждено |

**Остаточные риски безопасности (честно):**
1. `recover` принимает `email + code_id` без самого кода. `code_id` — capability
   (uuid, выдаётся только подтвердившему код), но в пределах TTL (≤2 мин,
   ≤3 выпусков) знающий `code_id` может выпустить сессию до того, как это сделал
   пользователь. После `redeem` окно закрыто. Ослабление признано осознанным:
   без `recover` обрыв сети после погашения кода означал потерю регистрации.
2. `verifyEmailOtp` (запасной канал) по-прежнему перебирает `type`
   (magiclink → signup → recovery) — это перебор **типа токена внутри одного
   транспорта**, а не перебор каналов; требование задачи не нарушает, но
   остаточная неаккуратность сохранена (не правил без доказанного дефекта).
3. Email хранится в localStorage в составе ожидания (≤2 мин, удаляется при
   входе/выходе/истечении). На общем устройстве это тот же уровень раскрытия,
   что и уже заполненное поле email в форме.

**Что Challenger-проход НЕ покрыл:** фактическое состояние прод-БД и секретов,
реальную доставку писем, поведение GoTrue (в тестах — фейк Admin API),
поведение PostgREST на ошибках колонок (эмулировано по кодам 42703/PGRST204).

## 10. ДОКАЗАТЕЛЬСТВО (команды и фактические результаты)

```
$ npm run verify                       → «Все наборы зелёные (14)»
$ node tests/db-contract.mjs           → ALL PASS (47 PASS)
$ node --no-warnings tests/auth-code-edge.mjs → ALL PASS: 67 passed, 0 failed
$ node tests/registration-flow.mjs     → ALL PASS (75 PASS)
$ node tests/auth-ui-pending.mjs       → ALL PASS (12 PASS)
$ node verify_auth.mjs                 → ALL PASS (29 PASS)
$ python3 verify_pages.py              → ALL PASS (11 маршрутов + ожидаемый 404)
$ gh api repos/A1Dmitry/Psihologist-cabinet/actions/runs/35850021571/jobs \
    --jq '.jobs[].steps[] | "\(.name): \(.conclusion)"'
  Set up job: success
  Skip when credentials are not configured: success
  Checkout: skipped
  Setup Supabase CLI: skipped
  Deploy functions: skipped
  Smoke check functions are reachable: skipped
  Complete job: success
```

Ключевые строки тестов (проверяют именно новые контракты):

```
PASS ОТП НЕ сожжён: used_at пуст после отказа Auth
PASS захват снят: issued_token_hash снова null (компенсация)
PASS тот же код после восстановления Auth → сессия выдана
PASS два параллельных verify → ровно один hashed_token
PASS гонка: сессия в Auth создана один раз
PASS после redeem recover отказывает (один код = одна сессия)
PASS legacy: вход по-прежнему работает (регистрация не заблокирована)
PASS reload до ввода кода: канал восстановлен (fn)
PASS reload: канал не переключился на запасной OTP
PASS потерянное состояние: на сервер не ушёл ни один запрос (перебор каналов удалён)
PASS auth_login_codes.issued_token_hash (SR-004: атомарность погашения кода)
```

Изменённые файлы: `js/domain/registration.js`, `js/services/supabaseApi.js`,
`js/viewmodels/AuthViewModel.js`, `js/app.js`,
`supabase/functions/auth-code/index.ts`, `supabase/schema.sql`,
`tests/auth-code-edge.mjs`, `tests/registration-flow.mjs`,
`tests/auth-ui-pending.mjs` (новый), `tests/db-contract.mjs`,
`tools/verify_all.mjs`, `verify_auth.mjs`, `README.md`, `docs/INFRA.md`,
`docs/SCHEMA-REQUESTS.md`, `docs/PLAN-AUDIT-REG-DRY-001.md`,
`docs/FULL-AUDIT-REPORT.md`.

## 11. Definition of Done из задачи — честный статус

| Пункт | Статус | Основание |
|---|---|---|
| Актуальная schema применена/сверена с production | ⛔ нет доступа | сеть до `supabase.co` отсутствует; сверка выполнена только с репозиторием |
| `auth-code` задеплоен и реально доступен | ❌ **не задеплоен** | CI-запуск `35850021571`: `Deploy functions: skipped` |
| Resend production configuration работает | ⛔ не проверено | нет сети и секретов |
| Новый email получает реальный OTP | ⛔ не проверено | то же |
| OTP создаёт authenticated Supabase session | ⛔ на проде не проверено | локально контракт проверен (`tests/auth-code-edge.mjs`, `tests/registration-flow.mjs`) |
| `auth.uid()` корректно используется при claim | ✅ на реальном PostgreSQL | `tests/db-contract.mjs` (RPC от роли `authenticated` с `request.jwt.claim.sub`) |
| Создаётся один psychologist / `owner_id == auth.uid()` | ✅ на реальном PostgreSQL | там же (дубль не создаётся при повторном входе) |
| Все обязательные поля сохраняются | ✅ на реальном PostgreSQL | `tests/db-contract.mjs`, `tests/registration-flow.mjs` |
| После reload кабинет восстанавливается | ✅ локально (контракт + отдельный процесс) | `tests/registration-flow.mjs` |
| Повторный вход не создаёт duplicate | ✅ на реальном PostgreSQL | `tests/db-contract.mjs` |
| **Pending OTP channel переживает reload** | ✅ | `tests/registration-flow.mjs`, `tests/auth-ui-pending.mjs` |
| **Транспорт не переключается самовольно** | ✅ | «потерянное состояние: на сервер не ушёл ни один запрос» |
| **OTP не сжигается при временном Auth failure** | ✅ | «ОТП НЕ сожжён: used_at пуст после отказа Auth» |
| Replay protection сохранена | ✅ | `redeem` → `recover` отказывает; лимит `issues`; `used_at` |
| Booking regression tests проходят | ✅ | 47 + 46 + 22 + SQL-контракт |
| Security review пройден | ✅ по коду (АУДИТОР: САМ) | раздел 9 |
| Independent Challenger review пройден | ❌ **не выполнен** | нет второго агента; сделан самопроход |
| Документация соответствует фактическому состоянию | ✅ | обновлены INFRA / SCHEMA-REQUESTS / PLAN / README / FULL-AUDIT |
| Новых дублирующих domain-реализаций нет | ✅ | grep-проверки раздела 9 |

### Что осталось сделать владельцу (порядок)

1. Supabase → SQL Editor: выполнить `supabase/schema.sql` (включая SR-004), затем `seed.sql`.
2. Задать секреты/переменные репозитория: `SUPABASE_ACCESS_TOKEN` (secret),
   `SUPABASE_PROJECT_ID=phiavtroybgwyjdhqqkh` (variable) — либо задеплоить руками:
   `supabase functions deploy auth-code --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt`.
3. `supabase secrets set RESEND_API_KEY=re_...` и `MAIL_FROM` (верифицированный домен).
4. Открыть страницу входа → «Диагностика сервера»: все пункты зелёные
   (включая «Схема auth_login_codes (SR-004)»).
5. Прогнать реальный E2E по чек-листу задачи (новый email → письмо → код →
   кабинет → reload → повторный вход) и только после этого считать регистрацию
   работающей.

## 12. ОКОНЧАТЕЛЬНЫЙ СТАТУС И УВЕРЕННОСТЬ

**ОКОНЧАТЕЛЬНЫЙ СТАТУС: ЧАСТИЧНО ЗАВЕРШЕНО.**

- Решены и проверены оба edge-case auth-flow из задачи (п.3 и п.4) — это
  единственные пункты, которые можно было решить кодом и проверить без прода.
- Пункты п.1/п.2 (production activation и реальный E2E) и п.7 (независимый
  Challenger-аудит) **не выполнены**: первые заблокированы отсутствием сети до
  `supabase.co`, почтового ящика и секретов, второй — отсутствием второго агента.
- Регистрация **не объявлена работающей**: статус «ЗАВЕРШЁННЫЙ» будет возможен
  только после реального сценария «новый email → OTP → Auth → claim → кабинет → reload».

**УВЕРЕННОСТЬ: высокая — для кода и локальных контрактов, низкая — для прода.**
Основание (почему это не самовнушение): утверждения о поведении опираются на
исполнение настоящего исходника Edge Function и настоящего PostgreSQL с
дословным `schema.sql`, а перезагрузка страницы моделируется отдельным процессом,
а не сбросом переменной; каждое число получено командой из раздела 10; каждое
«не проверено» помечено явно. Основание для снижения: прод-контур не проверялся
вовсе, независимой проверки не было, поведение GoTrue/PostgREST в тестах
эмулировано, а `recover`-механика не проходила через реальную доставку писем.
