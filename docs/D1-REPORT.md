# D1 — Availability + Booking Policy Engine: итоговый отчёт (Producer + Challenger)

Дата: 2026-09-24. Ветка: `arena/01a0d32e-psihologist-cabinet` (от `42cfb65`).
ROADMAP-узел: PHASE 3 → D1 (порядок зависимостей, не T-номеров).
Процесс: Producer → Challenger → Merge → Main Re-Audit (RULES §§2, 6.6, 6.7).

## 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Реализовать следующий этап по `docs/ROADMAP-OKNA.md` — архитектурный узел D1:
канонический Availability + Booking Policy Engine (единый источник истины
«можно ли записаться»), перенос записи на нём, политики кабинета специалиста
и серверный enforcement в `create_booking`. Без расширения скоупа.

## 2. РЕЗУЛЬТАТ

Фактически получено (16 изменённых + 5 новых файлов, `git status` чист от мусора):

- `js/domain/availability.js` (NEW) — канонический engine:
  Service + BookingPolicy + Schedule + BusySources → CandidateSlots →
  PolicyFilter → BookableSlots. Повторное создание availability-калькуляторов
  запрещено шапкой модуля.
- Перенос записи (reschedule) переведён на канонический `suggestSlots`
  (`BookingViewModel`, `cabinetApi`, `clientCabinetService`).
- Кабинет политик: CRUD overrides расписания (+unique), 7 парсеров политик
  с null/0-фолбэками, учёт лимитов и доступности услуги.
- Серверный близнец: проверки политик внутри `public.create_booking`
  (`supabase/schema.sql`, security definer — единственный публичный путь записи).
- 4 новых набора тестов: `availability-policy` (домен), `suggest-slots`
  (перенос), `cabinet-policy` (кабинет), `availability-db` (enforcement на
  настоящем PostgreSQL через embedded-postgres). Все зарегистрированы
  в `tools/verify_all.mjs` — всего 19 наборов.
- D1.11: паритет engine↔server доказан на одном фикстуре (изолированный
  специалист на пробу): 10:00 F/F, 10:30 F/F, 11:00 T/T, 13:00 F/F.
- Попутно (Challenger-находка, stop-the-line): устранена маскировка провалов
  в DB-наборах (см. §§6–8). Затронуты `tools/dbtest/index.mjs` (+`finishSuite`),
  хвосты `db-contract`, `security-regression`, `availability-db`,
  `suggest-slots`, `cabinet-policy`.

## 3. ПРОВЕРКА

Способ и условия (все проверки воспроизводимы из корня репозитория):

- `npm run verify` — полный гейт, 19 наборов через `tools/verify_all.mjs`
  (успех набора = exit code 0 дочернего процесса).
- `python3 verify_pages.py` — дым страниц/ассетов на dev-сервере (порт 8765).
- Standalone-запуски каждого нового набора с проверкой exit code через
  редирект в файл + `$?` (НЕ через pipe в grep — там `$?` это код grep).
- Negative controls: форсированный FAIL (вставка `results.push([...false])`)
  в копии `db-contract` — обязан выйти 1; минимальный репро
  `embedded-postgres initialise/start/stop` с `exitCode=1` — обязан выйти 1.
- Root-cause охота: перехват `process.exit` с печатью стека, ловушки на
  `Promise.then/setTimeout/EventEmitter.on`, чтение кода
  `node_modules/embedded-postgres` и `node_modules/async-exit-hook`.

## 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

Подтверждённые факты:

- `npm run verify`: **19/19, «Все наборы зелёные (19)»**, exit 0.
- `verify_pages.py`: **ALL PASS** (все страницы и ассеты 200, missing.js 404).
- `cabinet-policy`: 20/20 PASS (overrides/unique/парсеры/round-trip услуги).
- `suggest-slots`: 11/11 PASS. `availability-policy`: зелёный.
- `availability-db`: зелёный, включая блок паритета D1.11 — 4/4 PASS.
- Negative control после ремонта: реальный проваленный чек в DB-наборе →
  exit 1 (раньше — exit 0). Гейт умеет краснеть: доказано двусторонне.

## 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

Ограничения — что не сделано / не утверждается:

- GitHub Issue на P1-дефект тест-инфры (§6) НЕ заведён: запись в Issues из
  песочницы недоступна/не проверена без создания шума. Готовый текст Issue —
  в Приложении A; завести — первый шаг Main Re-Audit.
- Исторические результаты DB-наборов (`db-contract`, `security-regression`)
  за период ДО ремонта недостоверны: любой их провал маскировался под успех.
  Ретроспективно подтвердить/опровергнуть старые провалы невозможно.
- Пауза flush 100 мс в `finishSuite` — эвристика, не формальная гарантия
  сброса pipe stdout (на практике потерь строк в логах не наблюдается).
- D1 покрывает engine/перенос/кабинет/server-enforcement; waitlist-подбор (D2)
  и полоса доступности каталога (T-26) — потребители engine, вне скоупа D1.

## 6. ТУФТА НАЙДЕНА

Три подтверждённые находки (две — в тест-харнесе, одна — моя собственная):

1. **(P1, чужая, критическая) DB-наборы всегда выходили 0.** Любой провал
   в `db-contract`, `security-regression`, `availability-db` печатал FAILED,
   но процесс завершался кодом 0 → `verify_all` ставил ✅. Качество гейта
   было имитацией: «успех» не означал прохождения. Доказано форсированным
   FAIL → exit 0 (до ремонта).
2. **(Моя) `failed ? 1 : 0`, где `failed` — массив.** В хвостах трёх новых
   наборов массив всегда truthy → exit 1 при «ALL PASS». Обратная туфта:
   ложная краснота. Гейт показал 17/19 при фактически зелёной логике.
3. **(P1-соучастник) `setTimeout(..., 200).unref?.()` как placebo-контроль.**
   Unref-таймер не держит цикл и не гарантирует код выхода; создавал видимость
   «аккуратного завершения», не делая ничего. Удалены все три экземпляра.

## 7. КОРЕННЫЕ ПРИЧИНЫ

5 Why для находки №1 (маскировка провалов DB-наборов):

1. Почему процесс выходил 0 при `exitCode=1`? — Потому что асинхронно
   вызывался `process.exit(0)` (перехвачено подменой `process.exit`, стек —
   `node:internal/process/task_queues`, пользовательских фреймов нет).
2. Почему вызывался `process.exit(0)`? — `async-exit-hook` (зависимость
   `embedded-postgres`) при первом `add(hook)` подписывается на `beforeExit`
   с кодом 0: `add.hookEvent('beforeExit', 0)` → `exit(true, 0)` → хуки →
   `process.nextTick(process.exit.bind(null, 0))`. Наш `exitCode` игнорируется.
3. Почему хук срабатывал? — Любая инстанциация `EmbeddedPostgres`
   регистрирует shutdown-хук; при естественном дренировании цикла всегда
   стреляет `beforeExit`. Минимальный репро: один `initialise()` — уже exit 0.
4. Почему не срабатывал `setTimeout(...,200).unref()` хвост? — Unref-таймер
   не удерживает цикл: `beforeExit` стреляет раньше/независимо, хук форсит 0.
   Даже удаление таймера не помогает — хук всё равно форсит 0 (доказано
   NOTIMER-пробой: `exitCode=1` на конце скрипта и после sleep 800 мс,
   shell видит 0).
5. Почему дефект жил незамеченным? — Гейт проверяет только exit code;
   DB-наборы были зелёными по тексту, красных прецедентов не зафиксировали,
   а механизм (транзитивная зависимость перехватывает `beforeExit`) неочевиден
   без чтения `node_modules`. Системная причина: отсутствие negative control —
   никто никогда не проверял, что failing DB-тест вообще способен выйти 1.

Корень находки №2: копипаст хвоста без `.length` + проверка «по тексту ALL
PASS», а не по exit code. Корень №3: cargo-cult таймер из старых наборов.

## 8. РЕМОНТ

Системные исправления, ликвидирующие первопричину (Poka-Yoke):

- `tools/dbtest/index.mjs`: новый экспорт `finishSuite(failedCount)` с JSDoc,
  документирующим ловушку. Явный `process.exit(code)` НЕ триггерит `beforeExit`
  (подтверждено кодом async-exit-hook: explicit exit идёт через событие `exit`
  с `exit=false` → без пере-exit), поэтому код сохраняется. Перед выходом —
  ref-пауза 100 мс для flush pipe stdout.
- Применён во всех трёх DB-наборах (`db-contract`, `security-regression`,
  `availability-db`): `await finishSuite(failed)` вместо exitCode + unref-таймера.
- В двух не-DB наборах (`suggest-slots`, `cabinet-policy`): `failed.length ? 1 : 0`.
- Poka-Yoke на будущее: любой новый DB-набор обязан завершаться через
  `finishSuite` (JSDoc-предупреждение в модуле); шаблон «exitCode + unref»
  запрещён; negative control (forced FAIL → exit 1) — обязательный элемент
  приёмки новых DB-наборов.
- Проверка ремонта двусторонняя: зелёные наборы → 0; реальный провал → 1;
  полный гейт — 19/19.

## 9. ОСТАВШИЕСЯ РИСКИ

- `async-exit-hook` остался в дереве зависимостей: новый DB-набор без
  `finishSuite` молча вернётся к маскировке. Митигация — JSDoc + этот отчёт;
  идеал (вне D1): lint-правило на запрещённые хвосты или обёртка-раннер.
- Неизвестно, скрывал ли дефект реальные провалы в прошлом (см. §5).
  Рекомендация Main Re-Audit: считать все исторические ✅ DB-наборов
  неподтверждёнными до первого красного/зелёного цикла на новом харнесе.
- Шум остановки PostgreSQL (57P01) по-прежнему существует как явление;
  обработка `isTeardownNoise` сохранена и не затрагивалась ремонтом.
- Финальный merge и Main Re-Audit не выполнены в этом цикле (см. §11).

## 10. ДОКАЗАТЕЛЬСТВО

Проверяемые факты (воспроизводимо из корня, ветка `arena/01a0d32e-…`):

- `npm run verify` → «Все наборы зелёные (19)», exit 0 (лог: 19 строк ✅,
  включая 4 новых D1-набора и оба отремонтированных старых).
- `python3 verify_pages.py` → ALL PASS (9 страниц/ассетов 200 + 404-контроль).
- Паритет D1.11: `node tests/availability-db.mjs` → 10:00 F/F, 10:30 F/F,
  11:00 T/T, 13:00 F/F (engine `isSlotBookable` vs серверный `create_booking`).
- Negative control: копия `tests/db-contract.mjs` + `results.push(
  ['FORCED-FAIL-PROBE', false])` → печатает «1 FAILED», exit **1**
  (до ремонта тот же приём давал exit **0**).
- Minimal repro root cause: `initialise()`-only и `start/stop`-only скрипты
  с `exitCode=1` → exit 0; `pg`-only и `sleep`-spawn контроли → exit 1.
  Перехват `process.exit` показал асинхронный вызов с 0 из task_queues.
- Smoking gun в коде библиотеки: `node_modules/async-exit-hook/index.js` —
  `add.hookEvent('beforeExit', 0)` → `process.nextTick(process.exit.bind(null, code))`;
  импортируется из `node_modules/embedded-postgres/dist/index.js`.
- `node --check` по всем изменённым JS — чисто; `git status` — 16 M + 5 NEW,
  мусора (`.pgdata*`, `zz-forced-*`) нет — удалены.
- Файлы: M `docs/SCHEMA-REQUESTS.md`, `index.html`, `js/app.js`,
  `js/core/dbContext.js`, `js/models/entities.js`, `js/services/cabinetApi.js`,
  `js/services/clientCabinetService.js`, `js/services/supabaseApi.js`,
  `js/services/supabaseSync.js`, `js/viewmodels/BookingViewModel.js`,
  `js/viewmodels/CabinetViewModel.js`, `supabase/schema.sql`,
  `tests/db-contract.mjs`, `tests/security-regression.mjs`,
  `tools/dbtest/index.mjs`, `tools/verify_all.mjs`;
  NEW `js/domain/availability.js`, `tests/availability-db.mjs`,
  `tests/availability-policy.mjs`, `tests/cabinet-policy.mjs`,
  `tests/suggest-slots.mjs`.

## 11. ОКОНЧАТЕЛЬНЫЙ СТАТУС

**ЗАВЕРШЁННЫЙ.** Цель D1 достигнута, гейт 19/19 зелёный, независимое
подтверждение получено Challenger-аудитом с двусторонними контролями
(позитивным и негативным). Merge и Main Re-Audit — следующие шаги по RULES
§6.7 (merge — начало проверки, а не её конец), но сам цикл
Producer→Challenger→Merge(подготовка) завершён.

## 12. УВЕРЕННОСТЬ

**Высокая.** Обоснование, почему это не самовнушение:

- Каждое утверждение о зелёности подкреплено независимым механизмом —
  shell exit code дочернего процесса, а не самопальным «ALL PASS».
- Ключевое свойство гейта («краснеет при провале») доказано negative
  control, а не предположено: форсированный провал даёт exit 1.
- Root cause подтверждён чтением кода транзитивной зависимости и
  минимальными репро, отделяющими переменные (init-only vs start/stop-only
  vs pg-only vs sleep-spawn), а не угадыванием.
- Обратный контроль честности: собственные дефекты Producer (array-хвосты)
  найдены и задекларированы в §6, а не заметены.
- Остаточная неопределённость честно вынесена в §§5, 9 вместо замалчивания.

---

## Приложение A. Готовый текст GitHub Issue (P1, тест-инфра)

> **Title:** [P1] DB-наборы маскировали провалы: async-exit-hook форсил exit 0
> (исправлено в D1, требуется Main Re-Audit)
>
> **Факт:** до ремонта в ветке D1 (`finishSuite`, `tools/dbtest/index.mjs`)
> любой провал в `tests/db-contract.mjs` и `tests/security-regression.mjs`
> завершался exit code 0 — `verify_all` показывал ✅ при FAILED-строках.
> **Причина:** `embedded-postgres` → `async-exit-hook` перехватывает
> `beforeExit` с кодом 0 (`add.hookEvent('beforeExit', 0)`), игнорируя
> `process.exitCode`. **Ремонт:** явный `process.exit(code)` через
> `finishSuite()` (не триггерит `beforeExit`), negative control: forced
> FAIL → exit 1. **Требуется:** (1) подтвердить на main после merge;
> (2) признать исторические ✅ DB-наборов неподтверждёнными;
> (3) рассмотреть lint на запрещённые хвосты (`exitCode` + `unref` без
> `finishSuite` в DB-наборах). Детали: `docs/D1-REPORT.md` §§6–8.
