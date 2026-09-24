# Issue #19 — итоговый отчёт цикла (12 разделов по RULES §5)

**АУДИТОР: САМ** (Producer + self-check, сессия Arena Agent Mode,
ветка `arena/01a0d3db-psihologist-cabinet`, 2026-09-24 UTC).
Независимый Challenger по этому документационному циклу и Main Re-Audit —
**не выполнены** (открытый гейт; см. раздел 11).

Задача: https://github.com/A1Dmitry/Psihologist-cabinet/issues/19
«P1: Synchronize project documentation with current main and remove stale
historical claims». Выбран как ишью без зависимостей (не «child of» других
открытых ишью; зависит только от уже merged PR #12/#13/#17/#20/#25/#32/#37).

---

## 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Привести все актуальные MD-документы в соответствие с текущим `main`,
не переписывая исторические отчёты: один current-state source of truth,
зафиксированный SHA, явные historical-метки, ROADMAP/SR/RULES-сверка,
регистрация не помечена production-ready без реального E2E.

## 2. РЕЗУЛЬТАТ

Документационная часть задачи **выполнена полностью** (все 8 пунктов DoD):

1. **Current-state:** `docs/CURRENT-STATE.md` переписан под актуальный
   main @ `87e3951241fd18f2cc24afa2b6502247a7fee73b`: merged PR (#20/#24/#25/#26/
   #32/#37), production-статус (честно: ничего не подтверждено production-контуром),
   локально верифицированное (22/22 + verify_pages), открытые issue P0/P1/P2,
   активные SR, список исторических документов, статус регистрации и Quality Gate.
2. **История не переписана:** 12 документов прошлых циклов получили короткий
   баннер `HISTORICAL REPORT — NOT CURRENT MAIN STATE` + ссылку на
   CURRENT-STATE.md (FULL-AUDIT-REPORT, ISSUE-14-REPORT, ISSUE-14-CHALLENGER,
   ISSUE-15-REPORT, AGENT-1/2/3-REPORT, QUALITY-GATE-REPORT, D1-REPORT,
   ISSUE-23-EVIDENCE, ISSUE-23-IMPLEMENTATION, PLAN-AUDIT-REG-DRY-001);
   в ISSUE-TRIAGE-2026-09-24 добавлена контекстная строка (триаж против
   `d578c08`, main сменился).
3. **ROADMAP** (`docs/ROADMAP-OKNA.md`) сверен с кодом/schema:
   - «Server booking policy engine | ⬜ D1» → **✅ в main** (PR #32 + recovery #33);
   - «Payment policy groundwork | ⚠️ требует #21» → **✅ server authority в main**
     (PR #25; гейты #21 открыты — это не production, а status кода);
   - «Consent checkbox | ⚠️ T-25» → **✅ факт + `consent_at` на сервере**
     (`clients`, `booking_attempts`; версия текста — #29);
   - PHASE 1 (#21/#22/#19) и PHASE 3 (D1) — статусы по фактам;
   - §7: «следующий узел D1» → D1 реализован, далее D5/D2, production-нога P0;
   - PHASE 0: цикл Quality Gate помечен ссылкой на канон RULES §6
     (убрано «второе описание» — только сокращённая запись).
4. **SCHEMA-REQUESTS:** все SR с пометкой `applied` сверены grep'ом с
   фактическим `supabase/schema.sql` main @ `87e3951` (SR-001/002/003/004/108/
   SR-D1 — на месте); каждому applied добавлен явный production-статус
   «НЕ подтверждено, re-apply `schema.sql`» (INFRA п.2); superseded-секция
   (черновики SR-001/002 Агента 1) помечена как superseded с указанием
   итогового контракта.
5. **RULES ↔ AGENTS ↔ Issue Form ↔ current-state:** сверены — расхождений нет
   (AGENTS — входная точка на §6; форма реализует §6.9: goal/defect/priority/
   stop-the-line/root-cause/canonical-solution/architecture/tests/challenger/
   DoD/main-re-audit/kaizen; RULES §6.1 — единый канон цикла).
6. **README:** исправлена устаревшая строка «пояс клиента — в заметке (до SR-001)»
   → `sessions.client_timezone` (SR-001 в main); production-ready-claims в
   README отсутствуют (регистрация production-ready НЕ помечена).
7. **INFRA.md:** чек-лист подтверждён актуальным (production-факты не менялись —
   песочница без egress); п.2 дополнен записью, что в файл вошли SR-D1 и фиксы
   #21/#22 (re-apply обязателен целиком); добавлены кросс-ссылки на
   CURRENT-STATE.md и дата сверки.

## 3. ПРОВЕРКА

- `git rev-parse HEAD origin/main` → оба `87e3951241fd18f2cc24afa2b6502247a7fee73b`,
  `git status` до изменений — чистый (доказывает, что сверка идёт именно по
  актуальному main, а не по локальному снимку).
- `npm run verify` → **22/22 набора зелёные, exit 0** (прогноз до и после
  документационных правок — документы не затрагивают JS-контракты, прогон
  повторён после).
- `verify_pages.py` против живого `devserver.py :8765` → **ALL PASS (12/12
  маршрутов)** (UI не затронут; прогон — правило целостности превью).
- grep-аудит `supabase/schema.sql` по каждому applied SR:
  `client_timezone`/`client_utc_offset_min`/`duration_min` (149–157),
  advisory lock/интервальный overlap (SR-002), `public_booked_slots.duration_min`
  (585), `issued_token_hash`/`issues`/`consumed_at` (326+), `min_notice_minutes`/
  `max_advance_days`/`buffer_*`/`slot_increment_min`/`max_bookings_per_day`
  (281–286), `services.availability` (291), `schedule_overrides` (184+),
  `public_schedule_overrides` (575), `client_risks` без политик для
  `anon`/`authenticated` (537–541), `booking_attempts` (372).
- Сверка текстов: RULES §6.1 ↔ AGENTS.md п.6 ↔ Issue Form ↔ ROADMAP PHASE 0
  (по строкам).

## 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- Один current-state source of truth с актуальным SHA (`87e3951`) и датой.
- 12 исторических документов явно помечены; история не переписана.
- ROADMAP больше не заявляет D1 как «следующий узел» и payment authority как
  «требует #21» — обе вещи уже в main; статусы соответствуют коду.
- Каждый applied SR имеет явный production-статус (все — «НЕ подтверждено»).
- Расхождение README («до SR-001») устранено.
- RULES/AGENTS/Issue Form/ROADMAP описывают Quality Gate единым каноном
  (ROADMAP — со ссылкой на §6).
- Гейт после изменений: 22/22 + verify_pages ALL PASS (regression-отсутствие).

## 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- Production-статусы (schema в проде, deploy функций, Resend, Site URL)
  **не проверены** — из песочницы нет egress до `*.supabase.co`; это честно
  зафиксировано как UNKNOWN, а не «проверено».
- Независимый Challenger и Main Re-Audit по этому циклу — **не выполнены**
  (§6.6/§6.7): статус цикла — ЧАСТИЧНО ЗАВЕРШЕНО (раздел 11).
- `docs/ISSUE-TRIAGE-2026-09-24.md` описывает main @ `d578c08`; его
  рекомендации по закрытию #7/#11/#15/#8 исполнимы, но GitHub-интеграция
  сессии не имеет Issues: write (зафиксировано в самом документе), поэтому
  закрытия не исполнены — это блокер вне scope #19.
- Локальный git-репозиторий — shallow (1 commit); полная история PR взята
  через `gh pr list` (GitHub), а не из локального `git log`.

## 6. ТУФТА НАЙДЕНА

- **Риск метрической туфты** (подмена «сверки» пересказом старых документов)
  исключён: каждый статус ROADMAP/SR подтверждён grep'ом по фактическому
  `schema.sql`/коду main @ `87e3951`, а не переносом формулировок из
  CURRENT-STATE.md 11:13 UTC.
- **Риск самосертификации**: отчёт несёт `АУДИТОР: САМ`; «ЗАВЕРШЁННЫЙ»
  не присвоен (гейты #6.6/#6.7 открыты) — см. раздел 11.
- **Риск «локально = production»**: в ROADMAP добавлено явное правило
  «production только по фактическому evidence»; все production-статусы
  помечены UNKNOWN/НЕ подтверждено.
- **Найдено и исправлено**: устаревшая строка README «(до SR-001)» — факт,
  что SR-001 уже в main, но документ ещё описывал доработку.
- **Форма 3 (тавтология)** не обнаружена: утверждения CURRENT-STATE.md
  опираются на собственные прогоны этой сессии (verify, grep, git), а не
  на повтор прошлого текста.

## 7. КОРЕННЫЕ ПРИЧИНЫ

Почему документы расхождение с main накапливалось (5 Why):
1. **Симптом:** после PR #25/#32/#37 main ушёл вперёд на два архитектурных
   узла (server-authority, D1), но CURRENT-STATE.md застрял на `c20caaf`,
   ROADMAP — на «D1 ⬜», баннеры historical отсутствовали.
2. **Why 1:** Каждый цикл (PR #25/#26) синхронизировал CURRENT-STATE.md на
   момент своего merge — документ живой, и «забыть» его в следующем цикле —
   естественный исход, если нет явного owner'а.
3. **Why 2:** В RULES нет обязательства «после merge любого PR с изменением
   main синхронизировать current-state» — Main Re-Audit (§6.7) проверяет
   исправление, но не обновляет current-state.
4. **Why 3:** Циклы велись параллельно (PR #25, #26, #32, #37 за один день) —
   каждый «текущий» снимок мгновенно устаревал к следующему merge.
5. **Системная причина:** current-state не был включён в обязательный выход
   цикла (§6.1 «СТАНДАРТИЗАЦИЯ» не перечисляет синхронизацию
   current-state-документа как артефакт перехода).
**Почему контроль пропустил:** ни один harness (`npm run verify`) не
проверяет согласованность MD-документов с кодом — для документов нет
автоматического red-канала (это ограничение зафиксировано; #36 касается
аналогного класса риска в harness-прогонах).

## 8. РЕМОНТ

- Документация синхронизирована (пункты раздела 2) — устранён симптом.
- Системное: в CURRENT-STATE.md зафиксировано, что файл — единственный
  current-state, конфликт решается в его пользу, и Next actions включают
  Main Re-Audit с обязательной сверкой этого файла после каждого
  production-изменения.
- Kaizen-кандидат (вне scope #19, зафиксирован для сопровождающего):
  добавить в RULES §6.1/§6.7 явную строку «после merge, изменившего main,
  синхронизировать `docs/CURRENT-STATE.md` (SHA, merged PR, статусы)» —
  как артефакт перехода Main Re-Audit → СТАНДАРТИЗАЦИЯ. Не вносился в
  RULES.md в этом цикле: это изменение правил — самостоятельная задача
  (scope-граница #19).

## 9. ОСТАВШИЕСЯ РИСКИ

- **Документы снова устареют** при следующем merge до новой синхронизации
  (риск, пока Kaizen-кандидат не принят). Митигция: баннеры + явное
  «актуальный SHA» в шапке CURRENT-STATE.md.
- **Production-факты UNKNOWN:** если владелец уже применил `schema.sql`/
  задеплоил функции после 2026-09-24 14:25 UTC, CURRENT-STATE.md
  (раздел «Production») устарел в сторону консерватизма — это безопасно
  (запрет ложного success), но требует уточнения при re-audit.
- **Challenger по циклу не проведён:** до его отчёта этот файл —
  `АУДИТОР: САМ`.

## 10. ДОКАЗАТЕЛЬСТВО

- SHA: `git rev-parse HEAD origin/main` = `87e3951241fd18f2cc24afa2b6502247a7fee73b`
  (2026-09-24, сессия).
- `npm run verify` → «Все наборы зелёные (22)», exit 0 (до и после правок).
- `python3 verify_pages.py` против `devserver.py :8765` → ALL PASS (12/12).
- Grep-строки `schema.sql` по SR — раздел 3 (номера строк).
- `gh pr list --state all` — список merged PR (раздел 2/ CURRENT-STATE.md).
- Diff цикла: только `README.md` + `docs/*` (18 файлов), кодовые файлы не
  затронуты (`git status --short`).

## 11. ОКОНЧАТЕЛЬНЫЙ СТАТУС

**ЧАСТИЧНО ЗАВЕРШЕНО.**

Документационная цель #19 достигнута в полном объёме (все пункты DoD).
Терминальный «ЗАВЕРШЁННЫЙ» не присвоен: по §6.6/§6.7 для P1-цикла открыты
независимый Challenger и Main Re-Audit (второй агент сверяет этот документ
с кодом на актуальном main и публикует отчёт с `АУДИТОР: ВНЕШНИЙ`).
Для чисто процессного изменения production-проверка не выдумывается:
продуктового кода не менялось, UI-гейт (verify_pages) пройден.

## 12. УВЕРЕННОСТЬ

Высокая для пунктов 2–4 (каждое утверждение имеет команду и фактический
вывод этой сессии: grep/verify/git — не пересказ). Нулевая для
production-фактов (объявлены UNKNOWN явно — egress блокирован, это
доказательство из #34 E1, в этой сессии не перепроверялось).
Это не самовнушение: (1) статусы ROADMAP/SR получены из кода, а не из
старых документов; (2) найден и исправлен реальный stale-факт (README
«до SR-001»); (3) «ЗАВЕРШЁННЫЙ» не присвоен при открытых гейтах.

---

## Приложение — готовый комментарий для GitHub issue #19

> GitHub-интеграция сессии не имеет Issues: write (попытка `gh issue comment`
> 2026-09-24 → `Resource not accessible by integration`; прецедент —
> `docs/ISSUE-TRIAGE-2026-09-24.md`). При переподключении GitHub с правом
> Issues: write — публикуется как есть.

```markdown
## Статус цикла #19 (ветка `arena/01a0d3db-psihologist-cabinet`, коммит 7757a03)

Документационная часть #19 выполнена на main @ `87e3951241fd18f2cc24afa2b6502247a7fee73b`:

- `docs/CURRENT-STATE.md` — единственный current-state source of truth: SHA main, merged PR (#20/#24/#25/#26/#32/#37), production-статус (честно UNKNOWN — egress), локально верифицированное (22/22 + verify_pages ALL PASS), открытые P0/P1/P2, активные SR, исторические документы, статус регистрации и Quality Gate.
- 12 отчётов прошлых циклов помечены баннером `HISTORICAL REPORT — NOT CURRENT MAIN STATE` (история не переписана); `ISSUE-TRIAGE-2026-09-24` — контекстная строка (триаж против `d578c08`).
- `ROADMAP-OKNA.md` сверен с кодом: D1 ✅ в main (PR #32 + recovery #33), server-authority оплаты ✅ (PR #25), T-25 consent fact ✅ (`clients`/`booking_attempts`), PHASE 1/3 и §7 обновлены, QG-цикл — со ссылкой на канон RULES §6.
- `SCHEMA-REQUESTS.md`: applied SR (001/002/003/004/108/D1) сверены grep'ом с `schema.sql`; у каждого явный production-статус «НЕ подтверждено, re-apply schema.sql»; superseded-черновики помечены.
- `README.md`: исправлена stale-строка «(до SR-001)»; `INFRA.md`: чек-лист подтверждён, п.2 дополнен SR-D1 + фиксами #21/#22.
- Гейт после изменений: `npm run verify` 22/22 exit 0; `verify_pages.py` ALL PASS (12/12).

Итоговый отчёт: `docs/ISSUE-19-REPORT.md` (АУДИТОР: САМ). **Независимый Challenger и Main Re-Audit по циклу — OPEN** (второй агент; status ЧАСТИЧНО ЗАВЕРШЕНО, не ЗАВЕРШЁННЫЙ).
```
