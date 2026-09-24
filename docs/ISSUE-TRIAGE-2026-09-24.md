# Триаж ишью — 2026-09-24 (результат анализа + независимого Challenger-аудита main @ d578c08)

> Комментарии ниже подготовлены и готовы к публикации, но токен текущей GitHub-интеграции
> (`arena-ai-codering-agent[bot]`) не имеет прав на запись в Issues (`triage: false`) —
> закрыть/прокомментировать из сессии нельзя. Требуется переподключить GitHub в Arena
> с правом Issues: write, после чего комментарии применяются как есть.

---

## ✅ Закрыть #7 — «Refactor: eliminate duplicated domain logic under strict DRY / DDD / SOLID»
**Причина:** исполнено и зафиксировано (PR #12 `AUDIT-REG-DRY-001`; PR #13/#16 дублей не вернули). Независимо перепроверено на актуальном main.

**Комментарий:**

```markdown
## Итог независимой проверки (Main Re-Audit, актуальный main @ d578c08)

Проверено чтением кода и прогоном тестов, а не по отчёту Producer:

**Acceptance criteria → факт на main:**
- ✅ Часовые пояса: единственная реализация — `js/services/timezoneService.js`; собственные
  `detectTimeZone/zoneOffsetMinutes/zonedTimeToUtc/convertWallClock/isPastMoment` из
  `calendarService.js` удалены (модуль импортирует канонический сервис; re-export оставлен
  только для совместимости старых импортов).
- ✅ `BookingViewModel.js`: локальных `datePartsInTimeZone/detectClientTimezone/timezoneOffsetMinutes`
  нет — используются `zonedToInstant/instantToZoned/offsetMinutes/convertWallClock` из канона.
- ✅ `todayStr/addDays`: одна реализация (`timezoneService`), в ViewModel копий нет.
- ✅ Session: канонический маппер `js/services/sessionMapper.js` (`sessionFromRow/sessionToRow`);
  `cabinetApi` делегирует ему. `mapSession` в `clientCabinetService` — UI-проекция карточки
  клиента ПОВЕРХ доменной модели на каноническом резолвере длительности, а не параллельный
  маппер строки БД.
- ✅ `duration_min` маппится один раз (`resolveDurationMinutes`, `js/domain/duration.js`);
  дефолт 60 — в одном месте на клиенте и в паре с `create_booking` на сервере.
- ✅ Regression-тесты: `tests/timezone-domain.mjs` (46), `tests/session-mapper.mjs` (22),
  `tests/booking-wizard.mjs` (47) — зелёные.
- ✅ «Все проверки зелёные»: `npm run verify` на main @ d578c08 → 14/14 наборов.

Закрываю. Возврат дублей — повод для переоткрытия.
```

---

## ✅ Закрыть #11 — «Fix: registration must work end-to-end (email OTP + profile creation)»
**Причина:** контракт регистрации исправлен и зафиксирован (PR #12 + #16); все кодовые пункты DoD выполнены и покрыты тестами. Реальная production-верификация — отдельный открытый пункт #14 (не дублируем блокер в двух ишью).

**Комментарий:**

```markdown
## Итог независимой проверки (main @ d578c08)

Все пункты «Что проверить и исправить» исполнены и зафиксированы (PR #12, #16):

1. **Единый use case** — `js/domain/registration.js`: requestVerification → verifyVerification →
   ensureAuthenticatedSession → claimOrCreatePsychologist → loadOwnedProfile; ViewModel только UI.
2. **Поля не теряются** — `claim_psychologist_profile` принимает полный DTO
   (email, full_name, phone, specialization, city, about); тесты проверяют сохранение каждого поля;
   `password` остался паролем AES-сейфа, отдельно от Auth (и после challenger-аудита #14 теперь
   действительно применяется к сейфу — см. docs/ISSUE-14-CHALLENGER.md).
3. **Одна модель OTP** — основной канал (Edge Function auth-code) и запасной (Supabase OTP) идут
   через один контракт; канал фиксируется в pending-состоянии и переживает reload.
4. **Supabase Auth** — контракт покрыт `tests/registration-flow.mjs` (новый user, повторный вход,
   сессия, refresh) и `tests/auth-code-edge.mjs` (67 проверок на настоящем исходнике функции).
5. **Безопасность** — код одноразовый (TTL 2 мин, 5 попыток, кулдаун 30 с), ownership только из
   `auth.uid()` (`tests/db-contract.mjs`, 47 проверок на реальном PostgreSQL), OTP/токены/пароль
   сейфа не логируются (проверяется тестами).
6. **Persistence** — owner_id == auth.uid(), повторный вход не создаёт дубль, кабинет
   восстанавливается после reload (отдельный процесс), `supabaseApi` работает по access token.
7. **Реальные тесты** — `tests/registration-flow.mjs` (105 проверок), ошибки конфигурации
   (нет mail/функции/RPC) показываются честно, без тихого fallback.

Пункты DoD, требующие живого production-окружения (реальный новый email → письмо → код →
session на проде), остаются в объёме #14 (Production activation) и там же честно помечены
ЗАБЛОКИРОВАНО окружением. Здесь кодовая задача закрыта как исполненная.
```

---

## ✅ Закрыть #15 — «Process: establish Toyota-style Quality Gate»
**Причина:** исполнено и зафиксировано (PR #17); последний незакрытый пункт DoD («Проверено актуальное состояние main после merge») выполнен независимым агентом при этом триаже.

**Комментарий:**

```markdown
## Main Re-Audit (независимый агент, отдельная сессия, main @ d578c08 — после merge PR #17)

DoD:
- ✅ Toyota Quality Gate добавлен в `docs/RULES.md` §6: единый цикл, Jidoka (6.1),
  Andon/Stop-the-Line для P0/P1 (6.2), обязательный вопрос этапа (6.3), Root Cause/5 Why (6.4),
  Poka-Yoke (6.5), независимый Challenger (6.6), Main Re-Audit (6.7), Kaizen (6.8),
  шаблон существенного issue (6.9).
- ✅ `AGENTS.md` — краткая входная точка со ссылкой на §6.
- ✅ Stop-the-Line формализован (§6.2, включая containment ≠ DONE).
- ✅ Producer/Challenger и Main Re-Audit связаны в один цикл (таблица переходов §6.1).
- ✅ Root Cause и Poka-Yoke обязательны для существенных дефектов.
- ✅ Шаблон: `.github/ISSUE_TEMPLATE/significant-defect.yml` (12 обязательных полей).
- ✅ Актуальный main после merge проверен (этот аудит): §6 на месте, продуктовый код не затронут,
  `npm run verify` → 14/14 зелёные.
- ✅ Документация не утверждает завершение без фактической проверки: отчёты Producer честно
  несут маркер «АУДИТОР: САМ» и списки блокеров (`docs/ISSUE-15-REPORT.md`).

Отчёт Producer: `docs/ISSUE-15-REPORT.md`. Ограничение его проверки (не было независимого
Challenger и Main Re-Audit) закрыто этим аудитом. Процессное изменение, продуктового scope нет —
закрываю как исполненное.
```

---

## ✅ Закрыть #8 — «Исправить согласно заявленной проблеме и задаче» (как неactionable)
**Причина:** тело ишью пустое, комментариев нет, конкретная проблема не указана; все заявленные проблемы из этого цикла отслеживаются в #7 (закрыт), #11 (закрыт), #14 (открыт).

**Комментарий:**

```markdown
Закрываю как неactionable: тело ишью пустое (ни описания проблемы, ни критериев), комментариев нет.
Конкретные проблемы текущего цикла отслеживались адресно и исполнены: #7 (DRY-дубли — закрыт),
#11 (регистрация — закрыт), #14 (production activation — открыт, ждёт доступов владельца).
Если имелась в виду конкретная проблема — переоткройте с описанием: что делаем, где воспроизводится,
какой ожидаемый результат.
```

---

## ⏳ Оставить открытым #14 — «P0/P1: Production activation + auth-flow hardening + independent verification»
**Причина:** кодовая часть исполнена и проверена, но production-активация (п.1–2) заблокирована доступами владельца. По RULES §6.1 объявлять DONE при незакрытом P0 нельзя.

**Комментарий (статус после независимого Challenger-аудита):**

```markdown
## Статус после независимого Challenger-аудита (другой агент, 2026-09-24)

Отчёт: `docs/ISSUE-14-CHALLENGER.md`. Ветка с исправлением: `arena/01a0d2b2-psihologist-cabinet`,
коммит 7eafc76.

**Исполнено и зафиксировано (подтверждено независимо на main @ d578c08):**
- п.3 Pending OTP channel — pending `{email, channel, requestedAt, expiresAt}` в safeStorage,
  перебор каналов удалён; reload/resume покрыты тестами (включая отдельный процесс для reload).
- п.4 OTP atomicity — захват → сессия → `used_at` с компенсацией; `recover`/`redeem`; SR-004.
- п.5 Security review, п.8 Tests (auth + persistence + booking regression), п.9 Documentation.
- п.7 Independent Challenger audit — выполнен настоящим аудитом (не «АУДИТОР: САМ»).

**Найдено аудитором и исправлено (коммит 7eafc76):**
- Пароль сейфа с формы регистрации собирался, но нигде не использовался: поле было помечено
  «\*», сейф клиентов оставался незадатым. Теперь `verifyCode` применяет его (валидация до
  сервера — код не сжигается; новый кабинет → init сейфа, существующий → unlock без подмены verifier).
- `pushProfile` вопреки комментарию вырезал `key_verifier` — verifier никогда не покидал
  устройство. Добавлен `supabaseSync.pushKeyVerifier` (единственный легитимный писатель);
  сценарий «другое устройство» покрыт тестом (verifier восстанавливается с сервера, сейф
  открывается прежним паролем).
- Проверки: `tests/registration-flow.mjs` → 105 PASS (новый блок 8 — 30), `npm run verify` →
  14/14, `verify_pages.py` → ALL PASS.

**Остаётся ЗАБЛОКИРОВАНО (нужен владелец):**
1. Задать secrets/variables деплоя: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`
   (последний прогон `supabase-deploy.yml` 35979360714 от 2026-09-24 снова прошёл по ветке
   «Skip when credentials are not configured» — функция не деплоилась ни разу).
2. Применить актуальный `supabase/schema.sql` к прод-проекту (SR-004: `issued_token_hash`,
   `issues`, `consumed_at`; сигнатура `claim_psychologist_profile` с 6 аргументами).
3. Задать `RESEND_API_KEY`, `MAIL_FROM` (разрешённый sender).
4. Провести реальный E2E с отдельным тестовым email по сценарию п.2 задачи
   (новый email → письмо → код → session → claim → кабинет → reload; повторный вход; ошибки).

После выполнения 1–4 задача закрывается по факту production-верификации, а не по коду.
```
