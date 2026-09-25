# ISSUE-36 — Producer-отчёт: каналы ложного зелёного в харнесе

> **АУДИТОР: САМ** (тот же конвейер, что внёс правки; 2026-09-24 UTC).
> Независимый Challenger и Main Re-Audit — **OPEN**.
> Канон: GitHub issue #36. Маршрут: `docs/RECOVERY-ORCHESTRATION.md` (P1 после docs-гейта).

## 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Закрыть каналы ложного зелёного гейта `npm run verify`, не меняя продуктовый код:

- **A.** stray async-крах вне try/catch в DB-наборах → `ALL PASS`, exit 0
  (`finishSuite(0)` затирает `process.exitCode = 1`).
- **B.** `verify_app.mjs` печатает IMPORT/BOOT/LOAD ERROR без `process.exit(≠0)`.
- **C.** `harness-guard.mjs` смотрит только `tests/*.mjs`; root/tools-наборы вне инвариантов.

Negative controls закрепить в гейте. Полный `npm run verify` остаётся зелёным на честном пути.

Заказчик просил идти по ошибкам сборки/гейта, начиная с наименее зависимых задач.
В этом репозитории CI Pages зелёный; канонический независимый дефект гейта — #36
(не требует production-секретов, в отличие от #35/#18).

## 2. РЕЗУЛЬТАТ

Сделано в ветке `arena/01a0d50c-psihologist-cabinet`:

1. `finishSuite` выходит ненулевым, если `failedCount > 0` **или** уже выставлен
   `process.exitCode` (перечитывается после паузы 100 мс).
2. `verify_app.mjs`: IMPORT/LINK ERROR и BOOT/LOAD ERROR → `process.exit(1)`;
   шов `VERIFY_APP_ENTRY` только для негативного контроля.
3. `tools/verify_all.mjs`: набор красный при ненулевом коде **или** строках
   `FAIL` / `❌` / `BOOT ERROR` / `LOAD ERROR` / `IMPORT/LINK ERROR`.
   Голое `ERROR:` **не** матчится (Postgres RLS пишет `ERROR: permission denied`).
4. `tests/harness-guard.mjs`: инварианты на все файлы SUITES; negative A/B
   гоняются живыми дочерними процессами.
5. `tools/verify_cabinet.mjs`: BOOT/LOAD ERROR увеличивает `fail` (тот же класс B).
6. Попутно (блокировало доказательство гейта в 20:xx UTC): P11-control / P14
   в `tests/availability-parity.mjs` переведены на слоты, не зависящие от часа
   запуска. Продуктовый engine не менялся.

Стандарт: `docs/TEST-HARNESS.md`.

## 3. ПРОВЕРКА

- `node tests/harness-guard.mjs` → ALL PASS, exit 0 (включая negative A/B).
- `node verify_app.mjs` → IMPORT OK / BOOT RAN, exit 0.
- `node tests/availability-parity.mjs` → ALL PASS, exit 0 (прогон ~20:21 UTC).
- `npm run verify` → **22/22, exit 0** (node v22.22.3, 2026-09-24 UTC).

Окружение: локальная песочница Arena, embedded PostgreSQL 18.4 для DB-наборов.
Production не вызывался (не в скоупе #36).

## 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- Negative A: скелет `finishSuite(0)` после stray `throw` → exit ≠ 0, в выводе `STRAY CRASH`.
- Negative B: битый модуль → `IMPORT/LINK ERROR`, exit ≠ 0; boot-throw → `BOOT ERROR`, exit ≠ 0.
- Честный путь SPA: `verify_app` по-прежнему 0.
- Defence-in-depth не краснеет на Postgres `ERROR:` и на PASS-строках guard со словом ERROR.
- Guard покрывает root-наборы (`verify_app.mjs`, `verify_auth.mjs`, …).

## 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- Независимый Challenger (#36 DoD) не выполнялся.
- Main Re-Audit на `origin/main` после merge не выполнялся (правки ещё в рабочей ветке).
- Issue #36 на GitHub не закрыт (нет Issues: write в токене сессии; закрытие — после Challenger).
- Каналы A/B закрыты в **тестовой инфраструктуре**; это не доказывает отсутствие
  других ложно-зелёных путей (например, набор, который молчит без FAIL-строк и без exit).
- #35 / #18 / production E2E по-прежнему BLOCKED секретами владельца.

## 6. ТУФТА НАЙДЕНА

- **Почти метрическая:** первая версия `verify_all` матчила `\bERROR:` и покрасила
  честно зелёные DB-наборы (RLS `ERROR: permission denied`) плюс PASS-строки guard.
  Поймано тем же прогоном, сужено до BOOT/LOAD/IMPORT ERROR. Не оставлено в дереве.
- **Не выдаём DONE по зелёному `npm run verify`:** RULES §6.1 — merge/CI ≠ завершение issue.
- Пример из другого репозитория (Ricis3 `describe is not defined`) сюда не переносился:
  это другой канон; Goal Drift был бы чинить Ricis3 из сессии Psihologist-cabinet.

## 7. КОРЕННЫЕ ПРИЧИНЫ

См. 5 Why в теле #36. Кратко:

- **A.** Контракт «красная ошибка процесса» был разделён между обработчиком
  (`exitCode=1`) и `finishSuite(exit(failedCount))`; явный `exit(0)` побеждает.
- **B.** Smoke импорта вырос как «посмотреть», а не как гейт.
- **C.** Guard специфицировали только для `tests/`.
- **Flake P11/P14:** контроль «будущее/прошлое» строился от `Date.now()` без
  инварианта «слот внутри окна приёма».

## 8. РЕМОНТ

Канон из #36, с одним уточнением matcher'а `verify_all` (не голое `ERROR:`).
Poka-Yoke: negative A/B в `harness-guard.mjs` (часть `npm run verify`).
Kaizen: `docs/TEST-HARNESS.md` §4.

## 9. ОСТАВШИЕСЯ РИСКИ

- Наборы с `process.exitCode` без `process.exit` вне DB (нет async-exit-hook) —
  не дыра A, но слабее, чем явный exit.
- `VERIFY_APP_ENTRY` теоретически может быть выставлен в CI; в workflows репозитория
  не используется. Риск низкий.
- P11 past по-прежнему `plusMinutes(-120)` при окне 00:00–23:00; около полуночи UTC
  дата уходит на вчера — это всё ещё прошлое внутри окна. Не пинилось отдельно.
- Downstream (#35 deploy, #18 E2E) не разблокированы этим фиксом.

## 10. ДОКАЗАТЕЛЬСТВО

- Код: `tools/dbtest/index.mjs` (`finishSuite`), `verify_app.mjs`,
  `tools/verify_all.mjs`, `tests/harness-guard.mjs`, `tools/verify_cabinet.mjs`,
  `tests/availability-parity.mjs`, `docs/TEST-HARNESS.md`.
- Команда: `npm run verify` → «Все наборы зелёные (22)», exit 0, 2026-09-24 UTC.
- Negative controls — в stdout `tests/harness-guard.mjs` (PASS negative A/B).

SHA рабочей ветки фиксируется коммитом этого цикла (не SHA `main`).

## 11. ОКОНЧАТЕЛЬНЫЙ СТАТУС

**ЧАСТИЧНО ЗАВЕРШЕНО**

Кодовые пункты DoD #36 исполнены локально. Не закрыто: независимый Challenger,
Main Re-Audit на актуальном `main`, закрытие GitHub issue.

## 12. УВЕРЕННОСТЬ

Средняя для repo-гейта (прямые negative controls + полный verify в этой сессии).
Низкая для заявления «дефект закрыт в main»: правки не в `main`, внешний аудитор
не смотрел. Это не самосертификация завершения issue.
