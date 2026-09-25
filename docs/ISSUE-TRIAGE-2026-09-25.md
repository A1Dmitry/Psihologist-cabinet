# Аудит проекта + триаж ишью — 2026-09-25

> **АУДИТОР: САМ** (сессия Arena Agent Mode, ветка `arena/01a0d700-psihologist-cabinet`).
> Проверенный SHA: `b1dbf1add5d512751bf60f7346297f57e2f5e345` (= `origin/main`, merge PR #47).
> Дата: 2026-09-25 UTC. Окружение: node v22.22.3, python 3.11.2, embedded-postgres PG 18.4.
> Production из песочницы не вызывался (egress до `*.supabase.co` закрыт средой —
> установленный факт всех прошлых сессий); production-факты ниже — из LIVE evidence
> `docs/ISSUE-46-EVIDENCE.md` (2026-09-25, runner GitHub Actions), а не перепроверка.
> Актуальное состояние проекта — `docs/CURRENT-STATE.md` (сам документ stale, см. F1).

Изучены все MD: `AGENTS.md`, `README.md`, `docs/RULES.md`, `docs/CURRENT-STATE.md`,
`docs/RECOVERY-ORCHESTRATION.md`, `docs/ROADMAP-OKNA.md`, `docs/ROADMAP-DATABASE-CONNECTION.md`,
`docs/DATA-MODEL.md`, `docs/INFRA.md`, `docs/SCHEMA-REQUESTS.md`, `docs/TELEGRAM.md`,
`docs/TEST-HARNESS.md`, `docs/TASK-P0-SUPABASE-PORTAL.md`, `docs/OWNER-CHECKLIST-E2E.md`,
`docs/T22-video-link-design.md`, `docs/PLAN-AUDIT-REG-DRY-001.md`, `docs/FULL-AUDIT-REPORT.md`,
`docs/AUDIT-2026-09-25.md`, `docs/QUALITY-GATE-REPORT.md`, `docs/D1-REPORT.md`,
`docs/AGENT-1/2/3-REPORT.md`, `docs/ISSUE-14-REPORT.md`, `docs/ISSUE-14-CHALLENGER.md`,
`docs/ISSUE-15-REPORT.md`, `docs/ISSUE-19-REPORT.md`, `docs/ISSUE-23-EVIDENCE.md`,
`docs/ISSUE-23-IMPLEMENTATION.md`, `docs/ISSUE-34-REPORT.md`, `docs/ISSUE-34-TRIAGE.md`,
`docs/ISSUE-36-REPORT.md`, `docs/ISSUE-46-EVIDENCE.md`, `docs/ISSUE-46-CHALLENGER-KIT.md`,
`docs/ISSUE-TRIAGE-2026-09-24.md`, архив `docs/archive/repo-transfer/*`.
Сверены с кодом: `supabase/schema.sql`, `js/domain/*`, `js/services/*`, `js/viewmodels/*`,
`js/app.js`, `index.html`, `supabase/functions/*`, `tools/*`, `tests/*`, `.github/*`.
Сверены с GitHub: все 22 issue (13 open / 9 closed), PR #32–#48.

---

## 1. Состояние репозитория (FACT, эта сессия)

- `npm run verify` → **24/24 набора зелёные, exit 0** (включая DB-наборы на настоящем PostgreSQL 18.4).
- `BASE_URL=http://127.0.0.1:8765 python3 verify_pages.py` против живого `devserver.py` → **ALL PASS** (12 проверок).
- `origin/main` = `b1dbf1a` (merge PR #47). PR #48 OPEN с той же ветки `arena/01a0d6b5`
  (1 коммит `dfdc4334`, checks probe+verify SUCCESS, mergeable CLEAN) — к merge готов, решение за владельцем.

## 2. Состояние production (LIVE EVIDENCE из #46, 2026-09-25; не перепроверялось здесь)

Приложение в production по основному пути **не работает**: `auth-code`/`telegram-notify`
не задеплоены (gateway 404), в схеме прода нет SR-004 и SR-D1, `create_booking` для anon
не резолвится (публичная запись мертва). Каталог жив (2 анкеты). Блокеры — действия
владельца (`docs/OWNER-CHECKLIST-E2E.md`, блоки 1–8). Вывод: production-нога #46/#35 —
по-прежнему P0 Stop-the-Line; BA-фичи #27–#31 не стартовать.

## 3. Триаж закрытых ишью (9)

| Issue | Закрыта | Вердикт аудита |
|---|---|---|
| #7 DRY-рефактор | 2026-09-24, batch, без комментария | **Closure VALID.** Канон держится на `b1dbf1a`: `timezoneService` (единственный `todayStr`, арифметика поясов только там; `Intl` вне — лишь подпись дня в `BookingViewModel.formatDay`), `sessionMapper`, `duration`, `safeStorage` на месте; `calendarService` своих tz-функций не вернул. Наблюдение (не нарушение #7): дефолт `holdMinutes \|\| 60` в 2 местах (`paymentService.js:42`, `CabinetViewModel.js:498`) — hold-политика, вне scope #7. |
| #8 (пустое тело) | batch, без комментария | **Closure VALID** (неactionable). |
| #11 регистрация (код) | batch, без комментария | **Closure VALID** для кодового scope: канонический use case (`request/verify/ensureSession/claimOrCreate/restore`), полный claim-DTO (email/fullName/phone/specialization/city/about), `auth-about` в форме, персистентность сессии. Production-нога осознанно вынесена в #14→#18→#46. |
| #14 production activation + hardening | batch, **без комментария** | **Процедурно INVALID, по существу покрыто.** Отчёт фиксировал ЧАСТИЧНО ЗАВЕРШЕНО (production E2E + Challenger открыты). Позже: независимый Challenger выполнен (`ISSUE-14-CHALLENGER.md`, P2-фикс влит); production-остаток полностью покрыт открытыми #46 + #35 + #40. Нового дублирующего ишью не создавать (нарушит правило #46 «не дублировать»). Post-facto комментарий — при появлении Issues:write (текст ниже). |
| #18 production E2E | 2026-09-25, **без комментария** | **Процедурно INVALID, по существу покрыто.** DoD не был подтверждён (признано в теле #46). #46 создана как явный преемник-execution queue и открыта. Нового ишью не требуется. |
| #19 docs sync | 2026-09-25, **без комментария** | **INVALID: помечена выполненной, verification gate не выполнен.** Собственный отчёт (§11) запрещал закрытие до Challenger + Main Re-Audit. Документы с тех пор снова разошлись с main (см. §5). → **Создан новый issue #50** (ресинк + verification gate). |
| #23 localhost/otp_expired | 2026-09-24, **без комментария** | **Процедурно INVALID, код покрыт, прод-нога покрыта #46.** Implementation-отчёт требовал «#23 stays OPEN until production E2E + Challenger». Код в main проверен: `APPLICATION_URL`, loopback poka-yoke, `email_redirect_to`, `consumeAuthRedirect`, письмо `auth-code` с `APP_URL`. Production E2E (реальное письмо/Site URL/другое устройство) = TASK 3/4 открытой #46. Нового ишью не требуется. |
| #30 BA gap analysis | 2026-09-25, без комментария | **Closure VALID.** Корректно декомпозирована в недублирующую delta #31 (OPEN, сверено с телом #31). |
| #33 PR32 recovery (D1-QG-001..004) | 2026-09-25, без комментария | **Superseded, покрыто.** D1 независимо проверен #34 на merged main (мутанты P12/P13); harness-канал выделен в открытую #36; свежий re-audit — в открытой #34. Нового ишью не требуется. |

## 4. Триаж открытых ишью (13)

| Issue | Вердикт |
|---|---|
| **#15 Toyota Quality Gate** | **DONE → ЗАКРЫТА владельцем 2026-09-25T05:26:49Z, перепроверено.** Все 8 пунктов DoD на `b1dbf1a`: RULES §6 (§§6.1–6.16), AGENTS-вход, форма `significant-defect.yml` (12 полей), процесс реально применяется (#33/#34/#35/#36/#46), продуктовый scope не затронут, гейт 24/24 + pages ALL PASS (перепроверено после закрытия, см. §8). |
| #21 booking authority | **Держать OPEN.** Repo-часть закрыта (server-derived оплата/статус/длительность/hold, тесты T02/T04/T05), но п.4 жив в main: `completePayment`/`paySession` — local-only с текстом «оплата прошла» без серверной записи (проверено чтением кода). Production-гейт: `create_booking` для anon недоступен (LIVE). |
| #22 tenant/anti-spam | **Держать OPEN.** Repo-часть закрыта (`client_risks` без политик, anti-spam по `created_at`, `booking_attempts`). Production-гейт открыт (LIVE подтверждён лишь запрет anon на `client_risks`). |
| #27/#28/#29 BA backlog | **Держать OPEN**, не стартовать до разблокировки production (#46 Stop-the-Line). |
| #31 BA booking delta | **Держать OPEN** (D1 из него в main; D2/D3/D4/D5 не начаты). |
| #34 Challenger recovery | **Держать OPEN.** Независимый Challenger main@`4d490d2` выполнен, но main ушёл далеко вперёд (`b1dbf1a`); свежий Challenger + Main Re-Audit не выполнены. |
| #35 Edge Functions deploy | **Держать OPEN.** LIVE-подтверждено: не задеплоены. Блокер на владельце. |
| #36 harness false-green | **Держать OPEN.** Implementation merged (PR #44, проверено: `finishSuite` учитывает `exitCode`, `verify_app` → exit 1, guard на все SUITES + negative controls), независимая проверка OPEN. |
| #40 dual-entry auth | **Держать OPEN.** Repo-контракт закрыт (`is_active_own_psychologist`, inactive-гейт, `MAX_SESSION_AGE_DAYS=30`, два входа → одна сессия — всё в main с тестами); production E2E BLOCKED. |
| #41 Google identity (triage) | **Держать OPEN.** Requirements open; LIVE: `external.google=false`. |
| #46 P0 executor | **Держать OPEN.** Execution-контур исполнен (PR #47 merged); production-разблокировка, Challenger (TASK 7, kit готов) и Main Re-Audit не выполнены. |

## 5. Найденные расхождения документов с main (FACT)

- **F1.** `CURRENT-STATE.md`: main @ `dcb4093` (факт `b1dbf1a`); PR #47 «активная ветка» (факт merged); PR #48 не упомянут.
- **F2.** `RECOVERY-ORCHESTRATION.md`: main @ `2d2897b`; #18 — P0 OPEN (факт CLOSED); #46 отсутствует в таблице.
- **F3.** `ROADMAP-OKNA.md`: сверка @ `87e3951`; PHASE 1 держит #18 P0 и #19 «verification pending» (обе closed); #40/#41/#46 не отражены.
- **F4.** Ложных продуктовых ✅ не найдено: все ✅ корректно ограничены repo-scope
  (T-01…T-04, D1, consent `clients`/`booking_attempts`, T-16 код) — сверено с кодом/схемой/тестами.
- **F5.** Дефект в main, уже чинится открытым PR #48: `js/app.js:499` пишет подсказку
  в `#auth-code-hint`, которого нет в `index.html` (grep: 0), а строка 534 обещает
  «Код отправлен: 6–8 букв и цифр» и в канале, где приходит ссылка. Нового ишью не требуется —
  рекомендовано ревью + merge PR #48 (checks green, mergeable).
- **F6.** `TASK-P0-SUPABASE-PORTAL.md` (NOT_STARTED, параметры OPEN) — статус адекватен;
  зафиксированное расхождение auth-flow (confirmation-link+callback vs код-из-письма) —
  по-прежнему решение владельца, не исполнителя. Действий не требуется.

## 6. Выполненные действия по ишью

1. **Создан #50** «Docs: current-state снова разошёлся с main — ресинк + verification gate
   закрытой #19» (P2, DoD + связь с #19 + этот аудит). Единственная «помеченная выполненной,
   но не выполненная» задача без открытого покрытия.
2. **#15 к закрытию**: из сессии невозможно (токен без Issues:write — `Resource not
   accessible by integration` на close/comment/edit; проверено). Готовый комментарий ниже.
3. Остальные закрытия (#7/#8/#11/#30) признаны валидными; (#14/#18/#23/#33) — процедурно
   неполные закрытия, но существо покрыто открытыми #46/#35/#40/#34/#36 — дубли не создавались
   сознательно (RULES §4, правило #46).
4. ⚠️ Побочный артефакт сессии: probe issue **#49** (`TEST-DO-NOT-CREATE-probe`) — создан
   проверкой прав и не может быть удалён/отредактирован этим токеном. **Просьба владельцу:
   закрыть или удалить #49.**

## 7. Готовые тексты (применить при появлении Issues:write / владельцем вручную)

### Закрытие #15 (comment + close)

```markdown
## Main Re-Audit (независимая проверка, 2026-09-25, main @ b1dbf1a)

DoD сверен с актуальным main чтением кода, а не по отчёту Producer:
- RULES §6 Toyota Quality Gate на месте (цикл, Jidoka, Stop-the-Line P0/P1, Root Cause/5 Why,
  Poka-Yoke, Challenger, Main Re-Audit, Kaizen, privacy/E2E/канон/fresh-state/shared boundaries — §§6.1–6.16).
- AGENTS.md — входная точка со ссылкой на §6.
- Шаблон .github/ISSUE_TEMPLATE/significant-defect.yml — 12 обязательных полей.
- Процесс реально применяется: #33/#34/#35/#36/#46 оформлены по §6.9, Challenger-отчёты
  и 12-секционные отчёты ведутся.
- Продуктовый scope не затронут; гейт на проверенном SHA: npm run verify 24/24 + verify_pages ALL PASS.

Закрываю как исполненное. Основание: docs/ISSUE-TRIAGE-2026-09-25.md.
```

### Post-facto комментарии к batch-закрытиям (опционально, для audit trail)

- #14: «Закрыта без комментария 2026-09-24 при статусе отчёта ЧАСТИЧНО ЗАВЕРШЕНО. Post-facto:
  код + независимый Challenger выполнены; production-остаток — в открытых #46/#35. Аудит: docs/ISSUE-TRIAGE-2026-09-25.md.»
- #18: «Закрыта без комментария при неподтверждённом DoD. Преемник — открытая #46 (явно заявлена в её теле).»
- #23: «Закрыта без комментария вопреки требованию implementation-отчёта (production E2E + Challenger).
  Код проверен в main; production-нога — TASK 3/4 открытой #46.»
- #19: «Закрыта без комментария вопреки запрету отчёта §11 (Challenger + Main Re-Audit).
  Verification gate вынесен в #50.»
- #33: «Закрыта без комментария. Покрытие: независимый Challenger D1 — #34 (OPEN, свежий re-audit pending);
  harness-канал — #36 (OPEN, implementation merged).»

---

## 8. Перепроверка после закрытия #15 (2026-09-25, та же сессия)

По запросу владельца всё перепроверено заново на неизменном `origin/main = b1dbf1a`:

- **#15: CLOSED** (`closedAt 2026-09-25T05:26:49Z`), комментариев нет. DoD перепроверен:
  RULES §6 + форма на месте, гейт зелёный (ниже). Закрытие валидно.
- **Гейт: 24/24, exit 0** (`node tools/verify_all.mjs`, лог `/tmp/verify_rerun.log`);
  **pages: ALL PASS, exit 0** против живого `devserver.py`.
- **Каноны держатся** (re-grep): DRY (`Intl` вне канона — только подпись дня),
  registration 4/4, `is_active_own_psychologist` + `MAX_SESSION_AGE_DAYS=30`,
  #22 (`drop policy owner_read`, anti-spam по `created_at`).
- **Открытые гейты на месте**: `completePayment` — 0 серверных вызовов (#21 п.4 жив, #21
  обоснованно OPEN); `#auth-code-hint` отсутствует в `index.html` при ссылке из
  `js/app.js:499` (дефект жив, чинится открытым PR #48 — OPEN, mergeable CLEAN).
- **Состояния GitHub**: #49 (probe-мусор) всё ещё OPEN — удалить за владельцем;
  #50 OPEN; остальные issue без изменений (12 open + #49 + #50, 10 closed).
- **CURRENT-STATE/RECOVERY/ROADMAP** по-прежнему stale (F1–F3) → #50 актуален.

Ложная краснота в ходе перепроверки: первый прогон гейта дал 7 красных наборов
(все DB + harness-guard) — причина чисто средовая: `node_modules` не переживает
снапшот песочницы (`ERR_MODULE_NOT_FOUND: embedded-postgres`). После `npm install`
— 24/24. Дефекта репозитория нет; урок: перед гейтом в новой песочнице всегда `npm install`.
Локальный коммит аудита также был восстановлен с remote (`git reset --hard` на
`ccf48f8`, дерево чистое, контент совпал).

---

# Итог цикла — строго по 12 разделам `docs/RULES.md` §5

### 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Изучить MD, провести полный аудит проекта, закрыть выполненные/устаревшие ишью,
создать новые ишью для задач, помеченных выполненными, но не выполненных по факту.

### 2. РЕЗУЛЬТАТ

- Изучены все 37 MD + архив; сверены код, схема, тесты, GitHub (22 issue, PR #32–#48).
- Гейт на `b1dbf1a`: 24/24 + verify_pages ALL PASS (FACT этой сессии).
- Создан #50 (единственный gap без покрытия). #15 обоснован к закрытию (не закрыт — нет прав).
- Закрытия #7/#8/#11/#30 признаны валидными; #14/#18/#23/#33 — процедурно неполные, существо покрыто.
- Открытые #21/#22/#27–#29/#31/#34/#35/#36/#40/#41/#46 — все обоснованно открыты, stale нет.
- Рекомендовано: merge PR #48, удалить probe #49, переподключить GitHub (Issues:write).

### 3. ПРОВЕРКА

Чтение всех MD целиком; `node tools/verify_all.mjs` (24/24, exit 0);
`verify_pages.py` против живого `devserver.py` (ALL PASS); grep-аудит канонов
(#7 DRY, #11 registration DTO, #23 URL-контракт, #21 local-only оплата, #22 RLS/anti-spam,
#36 harness, #40 inactive/session-cap, #15 RULES/форма); `gh issue/pr view` по всем номерам;
пробы прав токена (create ✅ / close ❌ / edit ❌ / comment ❌).

### 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- Репозиторий здоров: гейт зелёный, каноны (#7/#11/#21-server/#22/#36/#40-repo) держатся на актуальном main.
- Ни одного ложного продуктового ✅ в ROADMAP: все статусы корректно ограничены repo-scope.
- Новый gap ровно один (#50); дубли не созданы.
- PR #48 готов к merge (checks green, mergeable) и закрывает живой UI-дефект main.

### 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- #15 закрыта владельцем без комментария (этот отчёт — evidence base; готовый текст был в §7).
- Production не перепроверялся (среда без egress); опора — LIVE evidence #46 от 2026-09-25.
- Создан мусорный probe issue #49 (не удаляется этим токеном) — за владельцем.
- 5 закрытий без комментариев (#14/#18/#19/#23/#33) — audit trail восстанавливается только post-facto.

### 6. ТУФТА НАЙДЕНА

- В истории: 5 закрытий без комментариев и доказательств, два из них — вопреки прямому
  запрету собственных отчётов (#19 §11, #23 implementation §5). Форма 6 (самосертификация
  через молчаливое закрытие). Существенный вред ограничен: 4 из 5 покрыты открытыми преемниками.
- В своей работе: попытка close до проверки прав создала лишний шум (неуспешный вызов без
  последствий); probe-create оставил мусор #49 — задекларировано, переложено на владельца явно.

### 7. КОРЕННЫЕ ПРИЧИНЫ

- Batch-закрытия без комментариев: закрывающий не следовал RULES §6.7 (Main Re-Audit +
  доказательства в Issue). Почему: процесс §6 требует, но GitHub не запрещает молчаливое
  закрытие технически (та же причина, что в #15 §9: «текст правил не обеспечивает
  автоматический запрет»).
- Повторный docs-drift (F1–F3): Kaizen-кандидат #19 §8 (current-state как артефакт merge)
  не принят — вынесен в #50 для решения сопровождающим.

### 8. РЕМОНТ

- Системный ремонт — в #50 (ресинк + решение по Kaizen-кандидату + Challenger + Main Re-Audit).
- Poka-Yoke предложен там же, не здесь (scope-граница: аудит не правит RULES самовольно).

### 9. ОСТАВШИЕСЯ РИСКИ

- #15 может висеть открытой despite DONE (низкий риск: процесс и так применяется).
- #49-шуметь в трекере до удаления владельцем.
- #50 без исполнителя снова устареет к следующему merge (митигация — Kaizen внутри #50).
- Production по-прежнему не работает (P0 #46) — вне scope этого аудита, зафиксировано.

### 10. ДОКАЗАТЕЛЬСТВО

Команды и выводы — разделы 1–5 и §3 выше; SHA `b1dbf1a`; issue #50 —
https://github.com/A1Dmitry/Psihologist-cabinet/issues/50; probe #49 — там же/issues/49;
PR #48 — mergeable CLEAN, checks SUCCESS (gh api).

### 11. ОКОНЧАТЕЛЬНЫЙ СТАТУС

**ЗАВЕРШЁННЫЙ.** Аудит выполнен полностью; #50 создан; #15 закрыта владельцем
2026-09-25T05:26:49Z и перепроверена (§8: DoD держится, гейт 24/24 зелёный).
Остаток за владельцем: удалить probe #49, merge PR #48, продвинуть #46 (блоки 1–8).

### 12. УВЕРЕННОСТЬ

Высокая для repo-фактов (все — прямыми прогонами/чтением этой сессии на зафиксированном SHA).
Нулевая для fresh production-фактов (объявлены опорой на evidence #46, не перепроверкой).
Независимого Challenger этого аудита не было — маркер АУДИТОР: САМ.
