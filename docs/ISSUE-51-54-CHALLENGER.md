# ISSUE #51 + #54 — независимый Challenger + Main Re-Audit на `main @ 3ebce1c`

> **АУДИТОР: САМ** — сессия Arena `arena/01a0d75b-psihologist-cabinet` (2026-09-25,
> UTC). Сессия **не создавала** проверяемые исправления (коммит Producer
> `7c5c8c52`, влит PR #53 в 06:13Z) → независимость по RULES §6.6 есть.
> Все прогоны выполнены на **неизменённом актуальном `main`**
> (`HEAD = 3ebce1c80d6630832d084e9cc0d4de636f02e493`, merge PR #56;
> `git status --porcelain` пуст до аудита). Так как проверяемый SHA — это main
> **после** merge исправления, отчёт одновременно является Main Re-Audit (§6.7).
> **АУДИТОР: ВНЕШНИЙ** — для фактов из GitHub Actions (live-прогон probe на PR,
> runner вне песочницы). Секреты не использовались; канал прода — публичный anon key.

## Паспорт прогона

| Поле | Значение |
|---|---|
| CHECKED SHA | `3ebce1c80d6630832d084e9cc0d4de636f02e493` — `main` (merge PR #56), дерево не менялось |
| FIX SHA (Producer) | `7c5c8c52` «fix(#46,#51,#54): честность гейта, деплоя и probe…» — PR #53, merged 06:13Z |
| DATE/UTC | 2026-09-25, 07:0x–07:2xZ |
| Окружение | песочница Arena: node v22.22.3, npm 10.9.8, Python 3.11.2; `npm install` из devDependencies (embedded-postgres, pg) |
| Инструменты | `node tools/verify_all.mjs` (полный и REDUCED через `VERIFY_EXTRA_SUITE`), `node tools/prod-probe/probe.mjs` (шов `PROD_PROBE_URL`), `gh` REST API |
| Классификация | `FACT` — локальный прогон/чтение репозитория; `LIVE EVIDENCE` — прод через внешний канал (Actions) |

Проверялись два ишью одного класса «ложный зелёный канал контроля»:

- **#51** — Quality Gate: silent-набор (0 проверок, exit 0) проходит гейт зелёным;
- **#54** — prod-probe: сводка `drift 0` при полностью недоступной сети неотличима
  от «измерено и чисто» (включая подмену `NETWORK_ERROR` на `HTTP_0` в секции B).

Оба исправлены Producer-фиксом `7c5c8c52`; атакующий аудитор #51/#54 (сессия
`arena/01a0d700`) — третья сторона для этой проверки.

---

## Итоговый отчёт (RULES §5, 12 пунктов)

### 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Независимо подтвердить на актуальном `main`, что DoD #51 и #54 выполнены:
 silent-набор красит гейт; честное дерево зелёное без ложной красноты;
 negative-control закреплён в guard; probe-отчёт всегда различает «измерено»
 и «не измерено»; workflow probe краснеет при отсутствии измерений; live-прогон
 на проде читаем владельцем.

### 2. РЕЗУЛЬТАТ (FACT, кроме помеченного LIVE)

| # | Проверка | Факт |
|---|---|---|
| C2 (#51) | `VERIFY_EXTRA_SUITE=/tmp/c2/silent.mjs` (0 проверок, `process.exit(0)`) через **реальный** `tools/verify_all.mjs` | `❌ набор не предъявил ни одной проверки (exit 0, 0 маркеров PASS/✅)`; итог `1 набор(ов) упало`; **exit = 1** |
| F2 | то же с набором `   FAIL` (отступ 3) + `PASS` рядом, exit 0 | итог `❌ … (1 провалов)`; **exit = 1** |
| Positive | честный мини-набор (1 `PASS`, exit 0) | `проверок предъявлено: 1`; **exit = 0** |
| Полный гейт | `node tools/verify_all.mjs` на честном дереве | **26/26 зелёные, 1227 проверок, exit 0**; `verify_app` — «подтверждён маркером IMPORT OK/BOOT RAN» (ложной красноты нет — allowlist-форма `ALT_SUCCESS_MARKER` работает) |
| Negative control в guard | `tests/harness-guard.mjs` в составе полного гейта | 189 проверок PASS, включая negative C (silent), negative D (indented FAIL), positive C |
| Blackhole (#54) | `PROD_PROBE_URL=http://127.0.0.1:9 node tools/prod-probe/probe.mjs` | сводка `измерено: 0/26 · недоступно: 26` + явное `⚠️ прода НЕ измеряли: ни один зонд не получил ответа (сеть/адрес). Это не «drift 0».`; exit 0 (осознанно — диагностика, не гейт) |
| HTTP_0 | тот же blackhole-прогон | 26× `NETWORK_ERROR`, **0× `HTTP_0`** (`grep -c`) |
| Workflow-гейт (#54) | чтение `.github/workflows/prod-probe.yml` | шаг «Verify the probe actually measured production»: парсит сохранённый JSON-отчёт, при `summary.unreachable > 0` — `::error::` + `process.exit(1)` |
| Live-прод (#54, LIVE EVIDENCE) | комментарий Actions на PR #56, run `36105073072`, 06:55Z (позже фикса 06:05Z) | `измерено: 26/26 · недоступно: 0`; `probes: 26, drift/missing: 4` с перечислением пунктов — печатная сводка читаема владельцем и публикуется комментарием |
| Регресс-контроль #54 | `tests/prod-probe-report.mjs` в полном гейте | 15 проверок PASS (blackhole + живой локальный стенд + текст сводки + статика workflow) |

### 3. ПРОВЕРКА

- Атаки C2/F2 повторены в точности по киту ишью (silent-набор и `FAIL` с отступом
  ≥3), но через **боевую** логику `tools/verify_all.mjs` (шов `VERIFY_EXTRA_SUITE`),
  а не через отдельный упрощённый прогон — судит тот же код, что и CI.
- Честное дерево: полный `node tools/verify_all.mjs` без срезов — 26 наборов,
  шесть стартов embedded PostgreSQL 18.4, 1227 проверок.
- Probe: чёрный ящик через `PROD_PROBE_URL` на закрытый порт (`127.0.0.1:9`) —
  тот же приём, что в атаке из текста #54 (недоступный адрес), без изменения
  рабочего дерева; `HTTP_0` искали `grep` по полному выводу.
- Workflow: прямое чтение `prod-probe.yml` + LIVE-комментарий Actions на PR #56.
- Обязательный вопрос §6.3 для каждого пункта DoD — ниже, в §10.

### 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- Оба канала ложного зелёного устранены и **заперты** живыми негативными
  контролями внутри самого гейта (harness-guard 189 PASS, prod-probe-report 15 PASS),
  а не только статикой.
- Позитивное поведение не сломано: 26/26, ложной красноты на `verify_app`
  и DB-наборах нет (риск из текста #51 учтён `ALT_SUCCESS_MARKER`).
- «Измерения не было» теперь **не может** выглядеть как `drift 0`: отдельный
  счётчик `measured`/`unreachable` в JSON и первой строкой в печатной сводке,
  явное предупреждение при полном недоступе, гейт workflow на `unreachable > 0`.
- LIVE-прогон на проде (06:55Z) показывает новый формат сводки и читаемый
  список фактического drift (4 пункта — NOT_DEPLOYED функций и PGRST202
  `create_booking` — это зона владельца, #35/#46, а не дефект инструмента).

### 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ / ограничения

- Канал прода из песочницы недоступен (egress до `*.supabase.co` обрывается) —
  live-измерение подтверждено только через внешний канал (GitHub Actions на PR #56);
  собственный live-прогон probe из этой сессии **не выполнялся**.
- Красный прогон workflow `prod-probe.yml` на реальном недоступном проде
  (end-to-end red) не демонстрировался — подтверждён прямым чтением шага
  (`exit 1` при `unreachable > 0`) и локальным blackhole-прогоном на счётчиках,
  которые шаг потребляет.
- REDUCED-прогон (`VERIFY_EXTRA_SUITE`) помечен в выводе как **неполный гейт**;
  атаки выше не подменяют собой CI — полный гейт прогнан отдельно.

### 6. ТУФТА НАЙДЕНА

Нет. Атаки исполнялись против боевого кода без правок дерева; вывод сводился
по фактическим exit-кодам (`set -o pipefail`, код читался без пайпа), а не по
наличию строк в логе. Попыток подогнать ожидание под вывод не было: формат
сводки probe и счётчики читались из JSON-отчёта инструмента.

### 7. КОРЕННЫЕ ПРИЧИНЫ (зафиксировано, исторически)

- #51: гейт судил набор по exit-коду + отсутствию красных строк; требования
  «предъявить ≥1 проверку» не существовало в модели гейта.
- #54: сводка считала только «плохие» вердикты; «ответа не было» не имело
  вердикта/счётчика, а две ветки секции B печатали `HTTP_${status}` в своём
  `catch`, обходя классификацию.

### 8. РЕМОНТ (фактический, коммит `7c5c8c52`)

- `tools/verify_all.mjs`: правило «exit 0 ⇒ ≥1 маркер `PASS`/`✅` либо маркер из
  `ALT_SUCCESS_MARKER`», silent-набор помечается ❌ и красит гейт; FAIL/❌/BOOT-LOAD-IMPORT
  читаются с любым отступом.
- `tools/prod-probe/probe.mjs`: `summary.measured/unreachable/unreachable_items`,
  `status === 0 → NETWORK_ERROR` во всех ветках, первая строка сводки — покрытие
  измерения; `.github/workflows/prod-probe.yml`: гейт `unreachable > 0 → exit 1`.
- Negative controls: `tests/harness-guard.mjs` (negative C/D, positive C),
  `tests/prod-probe-report.mjs` (15 проверок, blackbox).

### 9. ОСТАВШИЕСЯ РИСКИ

- Новый набор без маркеров успеха, добавленный в `SUITES` одновременно с
  расширением `ALT_SUCCESS_MARKER` под себя, — осознанный allowlist-вектор;
  смягчается тем, что расширение видно в diff и ловится ревью, а guard требует
  наличия маркера у набора.
- Сводка probe по-прежнему exit 0 по дизайну: строгость — только в workflow-шаге;
  ручной локальный прогон без чтения предупреждения теоретически может быть
  неправильно процитирован (митигируется явной строкой «Это не drift 0»).

### 10. ДОКАЗАТЕЛЬСТВО (команды и фактические результаты, §6.3 ответ)

```text
$ git rev-parse HEAD
3ebce1c80d6630832d084e9cc0d4de636f02e493

# ── #51: повтор атаки C2 (silent-набор через боевой гейт)
$ VERIFY_EXTRA_SUITE=/tmp/c2/silent.mjs node tools/verify_all.mjs; echo $?
…❌ набор не предъявил ни одной проверки (exit 0, 0 маркеров PASS/✅)…
1 набор(ов) упало; проверок предъявлено: 0
1                                  # ← гейт обязан был краснеть → красный

# ── #51/F2: FAIL с отступом 3 при exit 0
$ VERIFY_EXTRA_SUITE=/tmp/c2/indented.mjs node tools/verify_all.mjs; echo $?
…❌ VERIFY_EXTRA (indented.mjs) (проверок: 1) (1 провалов)…
1

# ── positive control: честный мини-набор
$ VERIFY_EXTRA_SUITE=/tmp/c2/honest.mjs node tools/verify_all.mjs; echo $?
…проверок предъявлено: 1
0

# ── полный гейт на честном main
$ node tools/verify_all.mjs; echo $?
…Все наборы зелёные (26); проверок предъявлено: 1227
0                                  # (harness-guard: 189 PASS; prod-probe-report: 15 PASS внутри)

# ── #54: blackhole-прогон боевого probe
$ PROD_PROBE_URL=http://127.0.0.1:9 node tools/prod-probe/probe.mjs | tail -4
──── SUMMARY ────
измерено: 0/26 · недоступно: 26
⚠️  прода НЕ измеряли: ни один зонд не получил ответа (сеть/адрес). Это не «drift 0».
probes: 26, drift/missing: 0
$ PROD_PROBE_URL=http://127.0.0.1:9 node tools/prod-probe/probe.mjs | grep -c 'NETWORK_ERROR'
26                                 # HTTP_0: 0 вхождений по всему выводу

# ── #54 LIVE EVIDENCE: Actions run 36105073072 (PR #56, 2026-09-25T06:55Z)
# комментарий github-actions[bot], сводка:
измерено: 26/26 · недоступно: 0
probes: 26, drift/missing: 4
  A edge-functions :: GET /functions/v1/auth-code → NOT_DEPLOYED
  A edge-functions :: GET /functions/v1/telegram-notify → NOT_DEPLOYED
  D rpc :: create_booking(past date) — anon must be able to call → DRIFT: rpc missing
  D rpc :: create_booking — overload inventory (unknown arg) → DRIFT: rpc missing
```

Мог ли этап пройти, пока задача не решена (§6.3)? Нет:
- если бы verify_all не считал маркеры проверок, C2 дал бы exit 0 (факт: 1);
- если бы probe не различал unavailable, blackhole дал бы молчаливый
  `probes: 26, drift/missing: 0` без первой строки и предупреждения (факт: есть оба);
- если бы workflow не гейтовал, шаг «Verify the probe actually measured
  production» отсутствовал бы в файле (факт: присутствует, `exit 1` при `> 0`);
- если бы live-формат был старым, комментарий 06:55Z показал бы `drift/missing: 4`
  без строки покрытия (факт: `измерено: 26/26 · недоступно: 0`).

### 11. ОКОНЧАТЕЛЬНЫЙ СТАТУС

- **#51 — ЗАВЕРШЁННЫЙ.** Все пункты DoD независимо подтверждены на `main @ 3ebce1c`
  (Challenger PASS + Main Re-Audit этой сессией).
- **#54 — ЗАВЕРШЁННЫЙ.** Все пункты DoD подтверждены, включая live-прогон на
  проде через Actions (внешний аудитор по §3).

### 12. УВЕРЕННОСТЬ

Высокая по #51 (атаки и полный гейт исполнены локально на проверяемом SHA,
вывод по exit-кодам). Высокая по repo-части #54; live-пункт #54 — средне-высокая:
evidence внешнего канала (Actions runner) с прямыми цитатами, собственный
live-прогон из песочницы невозможен технически — отмечено в §5. Это не
самовнушение: каждое «зелёное» утверждение привязано к команде, которую
проверяющий может повторить, и к возможности получить контрпример (§6.3 ответы
выше показывают, как именно отчёт мог бы провалиться).

---

## Mapping на DoD ишью

**#51:**

- [x] Silent-набор (0 проверок, exit 0) красит гейт красным — повтор C2, exit 1.
- [x] Честное дерево — 26/26 зелёные, 1227 проверок, без ложных краснот
  (`verify_app` зелёный через `ALT_SUCCESS_MARKER`, DB-наборы зелёные).
- [x] Negative control в harness-guard — negative C/D + positive C, 189 PASS
  в полном гейте.
- [x] Независимый Challenger PASS + Main Re-Audit — этот отчёт (сессия
  `arena/01a0d75b`, main @ `3ebce1c`).

**#54:**

- [x] В JSON и печатной сводке есть счётчик зондов без ответа —
  `measured`/`unreachable`/`unreachable_items`.
- [x] `HTTP_0` больше не подменяет `NETWORK_ERROR` — 26/26 `NETWORK_ERROR`
  в blackhole, 0 `HTTP_0`.
- [x] Workflow probe краснеет при `unreachable > 0` — шаг в `prod-probe.yml`.
- [x] Negative control в гейте — `tests/prod-probe-report.mjs` (blackhole-прогон
  боевого probe), 15 PASS в полном гейте.
- [x] Прогон на живом проде: отчёт читаем владельцем — Actions run 36105073072,
  PR #56 comment 06:55Z (покрытие + список drift).

## Связь

- Producer-фикс: `7c5c8c52` (PR #53); аудит исходных дефектов:
  `docs/ISSUE-46-CHALLENGER.md` (F1/F2), ишью #51, #54.
- Открытые контуры этим отчётом **не трогаются**: #35/#46 (деплой функций,
  `create_booking` для anon — за владельцем), #36, #34, #50, #21, #40, #41.
