# Recovery orchestration — dependency ledger

> АУДИТОР: САМ — сверка GitHub Issues, PR и `origin/main`, 2026-09-24 UTC. Это **маршрут выполнения**, не новый источник требований или свидетельство завершения. Канонические критерии находятся в связанных Issues; актуальное состояние проекта — в `CURRENT-STATE.md` после синхронизации #19.

**Baseline:** `origin/main` = `87e3951241fd18f2cc24afa2b6502247a7fee73b` при проверке 2026-09-24. На этом SHA `CURRENT-STATE.md` описывает прежний цикл; открытый PR #38 обновляет его для #19, но на момент сверки не merged. После каждого merge перечитать фактический HEAD; этот SHA не следует считать неизменным.

| Очередь | Canonical issue | Условие перехода (не заменяет DoD Issue) | На момент сверки |
|---|---|---|---|
| P0 | [#19](https://github.com/A1Dmitry/Psihologist-cabinet/issues/19) | Review/merge [PR #38](https://github.com/A1Dmitry/Psihologist-cabinet/pull/38), сверить документацию с новым main; исторические отчёты не переписывать | OPEN; PR OPEN |
| P1 | [#36](https://github.com/A1Dmitry/Psihologist-cabinet/issues/36) | Отрицательные контроли async/import/bootstrap дают nonzero, положительные проходят; независимая проверка | OPEN |
| P2 | [#35](https://github.com/A1Dmitry/Psihologist-cabinet/issues/35) | Деплой не skipped; endpoint и failure propagation подтверждены live. Нет доступа/credentials → BLOCKED | OPEN; production сейчас не подтверждён |
| P3 | [#18](https://github.com/A1Dmitry/Psihologist-cabinet/issues/18) | Реальная доставка, deployed URL без localhost, session после reload, logout/login и запрет private data без авторизации | OPEN; зависит от #35 |
| P4 | [#21](https://github.com/A1Dmitry/Psihologist-cabinet/issues/21) | Live canonical RPC без overload ambiguity; сервер владеет money/status/duration/hold; forged fields и duplicate/expired-hold атаки | OPEN; local schema/tests ≠ production |
| P5 | [#22](https://github.com/A1Dmitry/Psihologist-cabinet/issues/22) | Live отрицательные anonymous/cross-tenant read/write проверки на итоговом контракте #21 | OPEN |

#21 можно разрабатывать параллельно с #18 после #35, но его live gate зависит от применения production schema. #22 проверять после #21. **Не объявлять закрытие #19 по одному PR и не объявлять production success по зелёному CI.** Последний найденный run `supabase-deploy.yml`: `35990183772` (`success`, SHA `c20caaf…`); #35 документирует skipped deploy, но текущий live-статус в этой сессии не проверен.

## Последующие гейты без дублирования задач

- **Challenger:** уже предусмотрен [#34](https://github.com/A1Dmitry/Psihologist-cabinet/issues/34) (TASK 2–9, 11–12). Независимый от авторов изменений проверяющий повторяет false-green, missing deployment, localhost redirect, expired token, unauthorized/private and cross-tenant access, forged payment, duplicate booking, expired hold и broken endpoint. Для каждого: PASS / FAIL / BLOCKED / UNKNOWN, SHA, дата, среда и raw evidence без секретов. FAIL возвращается в соответствующий canonical issue.
- **Main Re-Audit:** #34 TASK 10: fresh main HEAD после исправлений, quality gate с отрицательными контролями, production endpoints, registration/booking/security evidence и сопоставление с CURRENT-STATE. Не путать с проверкой PR или прежнего main.
- **Closure:** `RULES.md` §6 и DoD каждого issue: merge/green tests не закрывают production или security issue; внешняя проверка отдельно от producer report. Новая issue только если доказана отдельная проблема, не покрываемая #18/#19/#21/#22/#35/#36 или #34.

**Состояние маршрута:** PARTIALLY_COMPLETED только в смысле инвентаризации зависимостей; ни один downstream gate этой записью не пройден. Новых Issues создано: **0**. GitHub comment в #34 из этой сессии отклонён API (`Resource not accessible by integration`); маршрут сохранён здесь, без заявления о публикации в issue. Следующий шаг: review/merge #38 уполномоченным участником, затем работа по #36.
