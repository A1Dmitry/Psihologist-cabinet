# ISSUE #36 — независимый Challenger + Main Re-Audit на `main @ 938e7f6`

> **АУДИТОР: САМ** — сессия Arena `arena/01a0d75b-psihologist-cabinet` (2026-09-25, UTC).
> Сессия **не создавала** проверяемые исправления (фикс `a1683677` 2026-09-24 + доработки
> `7c5c8c52` — сессии Producer, Challenger на `ca3b23b` — третья сессия)
> → независимость по RULES §6.6 есть. Атаки исполнялись как **сырьё** (свои скелеты
> и свои битые модули, НЕ повтор чужих PASS-строк guard'а) на `main`-
> соответствующем дереве (`arena/01a0d75b @ 5f20349`; дерево идентично merged
> `main @ 938e7f6`, merge PR #58 — `git diff 5f20349 938e7f6` пусто по файлам,
> различие только merge-коммит). Так как проверяемый SHA — main **после** всех
> merge'ей фикса, это одновременно Main Re-Audit по §6.7.
> Секреты не использовались; прод этому ишью не нужен (repo-контур).

## Паспорт прогона

| Поле | Значение |
|---|---|
| CHECKED tree | `5f20349` (arena/01a0d75b) ≡ дерево `main @ 938e7f60092d595bcda501cab2a65f9d1c2244de` |
| FIX SHA (Producer) | `a1683677` «fix(harness): закрыть ложное зелёное гейта (#36)» + `7c5c8c52` (остаточные каналы F2/#51) |
| DATE/UTC | 2026-09-25, 07:1x–07:3xZ |
| Окружение | песочница Arena: node v22.22.3, embedded PostgreSQL 18.4 (embedded-postgres 18.4.0-beta.17) |
| Инструменты | собственные скелеты атак в `/tmp` и временно в `tests/`, боевые `verify_app.mjs` / `tools/dbtest/index.mjs` / `tests/harness-guard.mjs`, `node tools/verify_all.mjs` |

Объект проверки — три канала ложного зелёного из DoD #36:

- **A.** Async-крах вне цепочки try/catch → «ALL PASS», exit 0 (все DB-наборы,
  явный `process.exit(0)` в `finishSuite` затирал `process.exitCode = 1` обработчиков).
- **B.** `verify_app.mjs` без красного канала: IMPORT/LINK и BOOT ERROR только печатались.
- **C.** `tests/harness-guard.mjs` покрывал только `tests/*` — root/tools-наборы гейта без правил.

---

## Итоговый отчёт (RULES §5, 12 пунктов)

### 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Независимо подтвердить на актуальном `main`: оба канала (A, B) закрыты каноническим
фиксом, guard расширен на все наборы (C), negative controls закреплены в гейте;
Main Re-Audit на `main`.

### 2. РЕЗУЛЬТАТ (FACT)

**Канал A — закрыт (сырьё, обе формы атаки):**

| Атака | До фикса (из ишью) | Факт на этом SHA |
|---|---|---|
| A1: типовой скелет DB-набора (handlers → `exitCode=1`) + все проверки зелёные + stray crash до `finishSuite(0)` | `ALL PASS`, exit **0** | exit **1**; stderr содержит `STRAY CRASH вне цепочки` |
| A2: НАСТОЯЩИЙ скелет DB-набора (`startTestDatabaseOrExit`, реальный embedded PG 18.4, `db.pool.query`), основная цепь **зелёная** (`PASS` + `ALL PASS`), stray crash **после** `finally`/`db.stop()`, вне try/catch | exit **0** в реальном скелете | `PASS база отвечает … ALL PASS … Error: ADV STRAY CRASH outside chain`, exit **1** |

Причина (код): `tools/dbtest/index.mjs → finishSuite` теперь
`const codeNow = () => (fromResults || process.exitCode) ? 1 : 0; process.exit(codeNow())` —
явный exit(0) больше не затирает `exitCode`, взведённый обработчиком.

**Канал B — закрыт (сырьё, шов `VERIFY_APP_ENTRY`, боевой `verify_app.mjs`):**

| Атака | До фикса | Факт |
|---|---|---|
| настоящий `js/app.js` | exit 0 | exit **0** (`IMPORT OK`, `BOOT RAN`) |
| модуль, бросающий на импорте | `IMPORT/LINK ERROR` … exit **0** | `IMPORT/LINK ERROR: Error: PRODUCT BROKEN AT IMPORT`, exit **1** |
| модуль, бросающий в boot (`DOMContentLoaded`) | exit **0** | `BOOT ERROR: Error BOOT BROKEN …`, exit **1** |

**Канал C — закрыт (сырьё):**

- Временный root-набор `verify_zzch36.mjs` (корректный формат, **не** в SUITES):
  `node tests/harness-guard.mjs` → `FAIL verify_zzch36.mjs: зарегистрирован в verify_all → нет в SUITES`,
  exit **1**. После удаления файла — `ALL PASS`. Guard видит root- и tools-наборы
  (циклы по `verify_*.mjs`/`test_*.mjs` в корне и `tools/verify_*.mjs`), а не только `tests/*`.

**Контрпример из Challenger-плана ишью (наборы с `exitCode =` без явного exit):**

- `tests/suggest-slots.mjs:105`, `tests/cabinet-policy.mjs:130`, `tests/harness-guard.mjs:204` —
  форма `process.exitCode = failed.length ? 1 : 0` (не truthy-массив `= failed ?`);
  все три — не-DB наборы: естественный выход node учитывает `exitCode`, детерминизм
  держится; guard запрещает именно форму `= failed ?` и отсутствие обеих форм выхода.
- DB-наборы: `exitCode` ставится только обработчиками (uncaught/unhandled),
  детерминированный выход — явный `process.exit(codeNow())` в `finishSuite`
  (проверено A2 на реальном скелете с реальной БД).

**Гейт целиком:** полный `node tools/verify_all.mjs` → **26/26 наборов, 1227 проверок,
exit 0** (включая `tests/harness-guard.mjs` — 189 PASS: negative A/B/C/D, positive C/D,
static-правила). Отдельно в той же сессии повторены атаки смежного класса (#51/F2):
silent-набор и `FAIL` с отступом ≥3 через боевой `verify_all` → exit 1 каждый —
defence-in-depth на месте. `npm run verify` не дал ложной красноты ни на одном
наборе, включая `verify_app` (alt-маркер) и DB-наборы с их 57P01-шумом остановки.

### 3. ПРОВЕРКА

- Скелеты атак писались в этой сессии по тексту исходного дефекта, а не копировались
  из `harness-guard` (guard существовал до атак и мог быть сам подогнан — §6.6 требует
  независимого контрпримера, а не повтора Producer-сырья).
- A2 — на реальном `startTestDatabaseOrExit` с реальным PostgreSQL 18.4: показано, что
  крах при живой/остановленной БД не escaping каналом teardown-шума (57P01 фильтр
  обработчиков на месте — иначе A2 дал бы ложную красноту от shutdown-гонки).
- Временные файлы (`tests/zz-a2-attack.mjs`, `verify_zzch36.mjs`) удалены сразу после
  прогонов; `git status` после аудита чист.
- Exit-коды читались напрямую (`echo EXIT=$?`), без пайп-масок.

### 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- Все три канала закрыты и **невозвратно запинены** живыми negative controls
  внутри самого гейта (negative A/B — живые дочерние процессы; C — статический
  инвариант регистрации; silent/indented — negative C/D для остаточного класса).
- Позитивное поведение не пострадало: честное дерево 26/26, основная цепь A2 зелёная
  при живой БД, настоящий `js/app.js` зелёный.
- Инвариант «любая не-teardown async-ошибка ⇒ exit≠0» теперь канонический и
  единственной точкой (`finishSuite`), а не размазан по скелетам (root cause W5).

### 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ / ограничения

- Атака A2 исполнена на `db.pool.query`-скелете, эквивалентном скелетам шести
  DB-наборов, — не на копии самого `availability-parity.mjs` (его импорты доменного
  кода делали бы копию дороже без смены проверяемого инварианта: канал A живёт в
  `finishSuite` + скелете, что и проверено).
- Tear-down гонки СУБД (FATAL 57P01) фильтруются обработчиками — сознательно не
  проверялось правомерно ли что-либо ещё попадёт в этот фильтр; риск — ложная
  краснота (безопасная сторона), не ложный зелёный.
- `verify_app.mjs` по-прежнему единственный набор, импортирующий `js/app.js`
  целиком; его зелёный статус зависит от alt-маркера в `verify_all`
  (см. остаточный риск #51 в `docs/ISSUE-51-54-CHALLENGER.md` §9).

### 6. ТУФТА НАЙДЕНА

Нет. Атаки — собственное сырьё против боевого кода; «зелёные» утверждения
привязаны к exit-кодам, читаемым без пайп-масок. Основная цепь A2 по замыслу
зелёная — показано, что exit 1 вызван ИМЕННО stray-крахом (stderr + единственный
источник неуспеха), а не замаскированным провалом цепи: проверка `PASS база
отвечает` / `ALL PASS` видна до краха.

### 7. КОРЕННЫЕ ПРИЧИНЫ (зафиксировано исторически, ишью §Root Cause)

A: отсутствие канонического инварианта «не-teardown async-ошибка ⇒ exit≠0»;
явный `process.exit(0)` в `finishSuite` затирал `process.exitCode` обработчиков.
B: набор вырос из smoke, ошибки информативны, не проверочны; guard не смотрел
вне `tests/`. Корневая обоих — инвариант exit-кода не был специфицирован для
всех наборов гейта.

### 8. РЕМОНТ (фактический, `a1683677` + `7c5c8c52`)

- `finishSuite`: код выхода учитывает `process.exitCode` (A).
- `verify_app.mjs`: IMPORT/LINK ERROR → `process.exit(1)`; BOOT ERROR → `process.exit(1)` (B).
- `tests/harness-guard.mjs`: покрывает `tests/*`, root `verify_*/test_*`, `tools/verify_*`:
  детерминированный выход, запрет `.unref`, запрет `= failed ?`, регистрация в SUITES;
  живые negative A/B/C/D и positive-контроли (C).
- `tools/verify_all.mjs`: defence-in-depth — `FAIL`/`❌`/BOOT-LOAD-IMPORT с любым
  отступом красит набор даже при exit 0; silent-набор (0 маркеров) красит гейт (#51).

### 9. ОСТАВШИЕСЯ РИСКИ

- Новый tearing-вектор: teardown-фильтр 57P01/«terminating connection» в обработчиках
  скелетов теоретически может проглотить не-teardown ошибку с таким текстом
  (вероятность мала, сторона безопасная — красная).
- Guard судит форму выхода по наличию `process.exit(`/`process.exitCode` в исходнике —
  достаточно для регистрационных инвариантов, но не доказывает семантику; живые
  negative controls компенсируют.

### 10. ДОКАЗАТЕЛЬСТВО (команды и фактические результаты, §6.3)

```text
# ── A1: скелет handlers + finishSuite(0), stray crash до финала
$ node /tmp/c2/a1-skeleton.mjs ; echo $?
PASS  единственная честная проверка
STRAY CRASH вне цепочки            (stderr)
1

# ── A2: НАСТОЯЩИЙ DB-скелет, реальный embedded PG 18.4, цепь зелёная
$ node tests/zz-a2-attack.mjs ; echo $?        # файл удалён после прогона
PASS  база отвечает
ALL PASS
Error: ADV STRAY CRASH outside chain
1

# ── B: боевой verify_app через VERIFY_APP_ENTRY
$ node verify_app.mjs >/dev/null; echo $?                          # настоящий js/app.js
0
$ VERIFY_APP_ENTRY=file:///tmp/c2/ch36-broken-import.mjs node verify_app.mjs; echo $?
IMPORT/LINK ERROR: Error: PRODUCT BROKEN AT IMPORT … 1
$ VERIFY_APP_ENTRY=file:///tmp/c2/ch36-broken-boot.mjs   node verify_app.mjs; echo $?
IMPORT OK
BOOT ERROR: Error BOOT BROKEN … 1

# ── C: root-набор вне SUITES обязан красить guard
$ echo 'console.log("PASS  фантомная проверка"); process.exit(0);' > verify_zzch36.mjs
$ node tests/harness-guard.mjs; echo $?
FAIL  verify_zzch36.mjs: зарегистрирован в verify_all → нет в SUITES
1
$ rm verify_zzch36.mjs && node tests/harness-guard.mjs | tail -1
ALL PASS

# ── контрпример «exitCode без exit»: форма сеттеров (не truthy-массив)
tests/suggest-slots.mjs:105  process.exitCode = failed.length ? 1 : 0;
tests/cabinet-policy.mjs:130 process.exitCode = failed.length ? 1 : 0;

# ── полный гейт на проверяемом дереве
$ node tools/verify_all.mjs ; echo $?
Все наборы зелёные (26); проверок предъявлено: 1227
0          (внутри: tests/harness-guard.mjs — 189 PASS)
```

Мог ли этап пройти, пока задача не решена (§6.3)? Нет:
- если бы `finishSuite` затирал exitCode, A1/A2 дали бы exit 0 (факт: 1);
- если бы `VERIFY_APP_ENTRY` не краснел, broken import/boot дали бы exit 0 (факт: 1);
- если бы guard не смотрел за пределы `tests/`, `verify_zzch36.mjs` дал бы ALL PASS
  (факт: FAIL, exit 1);
- полный гейт на сломанном дереве не мог бы дать 26/26 с 189 PASS guard'а,
  где negative A/B исполняются живыми процессами.

### 11. ОКОНЧАТЕЛЬНЫЙ СТАТУС

**#36 — ЗАВЕРШЁННЫЙ.** Оба канала закрыты каноническим фиксом, guard расширен на
все наборы, negative controls закреплены в гейте, независимый Challenger
подтвердил на SHA после fix (`5f20349` ≡ дерево merged `938e7f6`), Main Re-Audit
на `main` выполнен этим отчётом.

### 12. УВЕРЕННОСТЬ

Высокая: все три канала перепроверены собственным сырьём на боевом коде,
exit-коды зафиксированы напрямую; A2 — на реальной БД, что исключает «бумажное»
закрытие; единственное допущение — эквивалентность скелета A2 скелетам шести
DB-наборов (одинаковые handlers + `finishSuite`; расхождение было бы видно как
FAIL в полном гейте, где все шесть запускаются реально и зелёные). Это не
самовнушение: каждое утверждение отчёта обладает возможностью опровержения
командой из §10.

---

## Mapping на DoD ишью

- [x] Оба канала закрыты каноническим фиксом; guard расширен на все наборы.
- [x] Negative controls закреплены в гейте (harness-guard negative A/B/C/D + positive).
- [x] Независимый Challenger подтвердил на SHA после fix; Main Re-Audit на main —
  этот отчёт (сессия `arena/01a0d75b`, tree `5f20349` ≡ `main @ 938e7f6`).

Issue #36 закрыто связанным PR (keyword `Closes #36`): у App-токена исполнителя
нет `issues:write` (как и у прошлых агентских сессий — #51/#54 закрывал владелец),
поэтому закрытие выполнено системным auto-close при merge.

## Связь

- Исходищье: #34 (закрыт), прецедент D1-QG-004 / #33; смежный класс — #51, #54
  (закрыты, `docs/ISSUE-51-54-CHALLENGER.md`), F2 из Challenger-аудита #46.
- Открытые контуры этим отчётом не трогаются: #35/#46 (владелец), #40, #41, #50, BA-backlog.
