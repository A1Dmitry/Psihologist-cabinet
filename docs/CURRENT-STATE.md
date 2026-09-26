# CURRENT-STATE — canonical current-state

> Единственный current-state source of truth. Исторические отчёты не переписываются и не заменяются этим документом.
>
> **АУДИТОР: САМ** для repo-фактов: код, тесты и документы проверены в сессии
> issue #63 (`npm run verify` на снимке `main @ 8c96311` — 40 наборов, 1803 проверки,
> **все зелёные**, включая новый `tests/mobile-cabinet.mjs`; Main Re-Audit на точном merge-SHA —
> PASS (полный гейт + smoke `verify_pages.py` 13/13 против devserver снимка);
> детали — `docs/ISSUE-63-REPORT.md`, `docs/MAIN-AUDIT-63.md`; `git`/`gh`-срез
> трекера 2026-09-26T13:49Z; QA-Challenger этой же сессии — `АУДИТОР: САМ`, независимый Challenger ожидается).
> **АУДИТОР: ВНЕШНИЙ** для production-фактов: последний срез живого проекта
> `phiavtroybgwyjdhqqkh` снят `Production read-only probe` из runner'а GitHub Actions
> (`tools/prod-probe/probe.mjs`) **2026-09-25** (05:53Z). Свежего LIVE-среза нет:
> запуск probe из агентской сессии — 403, egress из песочницы до `*.supabase.co` закрыт.
> Всё, что не подтверждено тем срезом, остаётся **UNKNOWN** и не выдаётся за факт.

## Main SHA и активная ветка

- **Актуальный `origin/main` при этой синхронизации:** `8c963113e8e49a754b8591dab1d32ed2b4fc5008`
  (merge PR #101 — issue #63 mobile cabinet 1.0, 2026-09-26T13:48:02Z; deploy GitHub Pages по этому SHA — на проверке у владельца).
  Ветка `arena/01a0dddc-psihologist-cabinet` продолжает его локально (claim/sync follow-up — PR #102).
- Исторические baseline: `dcb4093`, `0320c40`, `5d5636d` (PR #44), `03c6fa5` (PR #43),
  `87e3951`, `4d490d2`, `2d2897b`, `b1dbf1a` (PR #47), `ca3b23b` (PR #48), `d28ae94` (PR #52),
  `3d4210d` (PR #53), `3ebce1c` (PR #56), `938e7f6` (PR #58), `b0313e8` (PR #61).
- Влито в main 2026-09-26 после `a8953d1`: #93/#94 (`ресинк current-state` + Main Re-Audit #50),
  #95 (#92 — `verify_cabinet` без дата-зависимости, PR #95), #96 (#66 — карта/мессенджеры,
  PR #96), #97 (#64 — мобильные диалоги/CTA + защита от двойной отправки), #98 (Main Re-Audit #64 sync),
  #99 (ресинк #50 + QA follow-up), #100 (claim-lifecycle chore, no-op по коду), #101 (#63 — мобильный кабинет 1.0).
- Влито в main 2026-09-25 после `b0313e8`: #62 (`triage + client Google auth`),
  #68 (`BA mobile`), #70/#71 (`claim-протокол` + Main Re-Audit #69), #72 (`RRSI §7`),
  #73/#75 (`.ics` клиенту, #65), #77 (`reload кабинета`, #67/#76), #78 (`первый визит`, #74),
  #80 (`specialist wording`), #81 (`тесты #36 + parity-флейк`), #82 (`SEO-портал`),
  #83 (`карта проезда`, #66), #84/#86/#87/#90 (`#35 deploy-контур`), #85 (`snapshot parity`, #67),
  #89 (`Google OAuth — единственный вход`, #88), #91 (`Google OAuth verification`).

## Канон входа специалиста (решение владельца, 2026-09-25)

**Единственный вход специалиста — Google OAuth через Supabase Auth.** Email/OTP,
`auth-code` и email-link для психолога **CANCELLED** (AUDIT CORRECTION владельца
в #67, 2026-09-25T15:23Z; канон закреплён #88 → CLOSED, реализация PR #89).
Ссылки на #46/#35/#40 как на «email-auth production queue» — исторические;
восстанавливать OTP запрещено.

- **Сделано в репозитории:** кнопка Google, PKCE-callback на Pages без hash,
  RPC поиска/привязки/создания профиля, онбординг, inactive-gate
  (`public.is_active_own_psychologist()`), абсолютный срок сессии 30 дней,
  выход, безопасные ошибки; privacy-страница + verification-файл + Client ID
  для проверки домена Google (PR #91).
- **Не сделано / BLOCKED — OWNER ACTION REQUIRED (#40, #35):** включить Google
  provider в Supabase (Client ID/Secret, Site URL / Redirect URLs), применить
  миграцию `supabase/migrations/20260925_google_specialist_signup.sql`,
  задеплоить `telegram-notify` (#35 **только** telegram-notify после коррекции
  владельца). LIVE-срез 2026-09-25: `external.google=false`.
  Production E2E входа не проводился.
- `key_verifier` — только сейф клиентов, не вход. Отключённый аккаунт не реактивируется входом.
- Клиентский Google при записи с triage (#41) — другой актор (см. ниже).

## Production — честный статус (LIVE-срез 2026-09-25, без свежей перепроверки)

**Production readiness НЕ подтверждена.** Основной путь (регистрация/вход
специалиста, публичная запись) в production на момент среза не работал.

| Элемент | Статус (2026-09-25) | Класс |
|---|---|---|
| REST/PostgREST отвечает, каталог жив (2 активные анкеты) | работает | LIVE |
| Схема SR-001/SR-003/SR-004/SR-D1 | применена владельцем 2026-09-25 (04:55Z–05:14Z) | LIVE |
| `create_booking` для anon | **недоступен** (PGRST202) → публичная запись не работает | LIVE, блокер |
| `client_risks`/`clients`/`payments`/`booking_attempts` для anon | закрыты (42501) | LIVE |
| `auth_login_codes` строки для anon | `[]` (RLS deny) | LIVE |
| Edge Functions (`telegram-notify`; `auth-code` — устарел по канону) | **не задеплоены** (gateway 404, 05:53Z); #35 LEAVE OPEN до не-404 ответа endpoint (комментарий владельца) | LIVE, блокер |
| Application origin | `https://a1dmitry.github.io/Psihologist-cabinet/` | LIVE |
| Supabase Auth | `external.email=true`, `external.google=false`, `disable_signup=false`, `mailer_autoconfirm=false` | LIVE |
| Google provider / Site URL / Redirect URLs | не подтверждено | UNKNOWN |
| Реальный вход/регистрация E2E (Google) | не проводился | BLOCKED |

Repo-side деплой-контур после среза усилен (PR #84 preflight `auth-code`,
#86 guard секретов в бандл, #87 advisory без секретов, #90 канон деплоя
«вход только Google») — это repo-факты, **не** LIVE-доказательства деплоя.

Root cause (FACT по внешнему каналу): `supabase/schema.sql` применялся не целиком —
устранено владельцем 2026-09-25; остаток — деплой `telegram-notify` и доступность
`create_booking` для anon (причина различима только SQL-каналом владельца).

## Repo-level состояние (факты на `9171cc1`)

Подтверждено наличием кода и прогоном тестов (`npm run verify`, `tests/*`;
**внимание:** гейт не полностью зелёный — дата-зависимый набор
`tools/verify_cabinet.mjs` красный в Сб/Вс/Пн/Вт (дефект гейта, issue #92;
продуктовый сценарий исправен; фикс — отдельной работой)):

- **Вход специалиста:** Google OAuth через Supabase Auth (PKCE, RPC-привязка,
  онбординг) — `tests/google-oauth-client.mjs` (60/60), `tests/google-specialist-signup.mjs`;
- **Клиентский Google при triage-записи (#41):** GIS + `signInWithIdToken`,
  изоляция сессий, отрицательные контроли — `tests/google-client-auth.mjs` (21/21);
- **Сейф клиентов** (`key_verifier`), отключённый аккаунт не реактивируется;
- **server-authoritative booking** (`create_booking`), D1 policy engine
  (`js/domain/availability.js` + серверный близнец, parity-матрица, booking E2E);
- **tenant isolation / anti-spam** (`client_risks`, `booking_attempts`);
- **demo-pay honesty** (#21 п.4) — local-only UX, `tests/demo-pay-honesty.mjs`;
- **reload-parity кабинета** (#67 TASK 1): single-source snapshot manifest +
  `tests/db-snapshot-parity.mjs`; runtime «Задачи»/заметки/записи переживают reload;
- **первый визит `/book/{slug}` и `/psy/{slug}`** (#74): мастер переживает загрузку
  каталога — `tests/booking-first-visit.mjs` (14/14);
- **`.ics` «В календарь» клиенту** (#65): `tests/ics-event.mjs`, `tests/ics-success-page.mjs`;
- **карта проезда без Google-провала** (#66, MX-07): lazy-load по тапу, Яндекс embed
  по умолчанию, Google — альтернатива; текстовые маршруты сохранены (`renderProfile()`);
- **Мобильный UX (#64)**: единственная каноническая замена нативных `confirm()/prompt()`
  (`js/views/uiDialogs.js`), bottom-sheet и safe-area для модалок, sticky CTA воронки
  (`#book-cta`), защита от двойной отправки (`submitting` + disabled-кнопка) —
  `tests/mobile-ux.mjs` (41 проверка) в гейте;
- **claim-протокол исполнителей** (#69): `tools/claim.mjs`, `.claims/**`,
  `tests/executor-claims.mjs` в общем гейте, `RULES.md` §6.17;
- **честность гейта** (#36/#51/#54): silent-suite и FAIL-отступ краснеют;
  prod-probe сводка «измерено/недоступно» + workflow-гейт на `unreachable`;
- **harness/безопасность:** `tests/harness-guard.mjs`, `tests/no-committed-secrets.mjs`;
- **RRSI** (§7) — контур самообучения исполнителей (`docs/RRSI-CACHE.md`);
- **SEO-портал** (#82): `js/services/seoService.js`, hash-роутинг `#/psy/{slug}`.

Это **repo + тестовые доказательства**, а не production E2E.

## Открытые контуры (трекер на 2026-09-26)

| Issue | Priority | Current status |
|---|---:|---|
| #67 | P0 | Owner cabinet: TASK 1 (reload/«Задачи») исправлен (PR #77/#85) — production re-check и live-стек по TASK 1 открыты; TASK 2 (UPDATE услуг до public booking), TASK 3 («Настройки»), TASK 4 (error contract), TASK 5 (сейф UX) — не начаты. Auth-зависимость → #88 (коррекция владельца) |
| #63 | P0 | Мобильный кабинет 1.0 (bottom tab bar, 15 разделов, карточные действия) — **реализовано в main** (PR #101, merge `8c96311`; Main Re-Audit PASS — `docs/MAIN-AUDIT-63.md`; Challenger — `docs/ISSUE-63-CHALLENGER.md`, PR #103 → `c6c2f2e`). **Ре-аудит на `c6c2f2e` (2026-09-26, `EXEC-rzVmS30TVl`) нашёл и устранил 3 дефекта контура**: панель «…» не закрывалась после тапа по пункту без перерендера; `.cab-menu{z-index:30}` рисовалась под фиксированным таб-баром (`z-index:40`) — деструктивные пункты недоступны тапу; ложная посылка/постороннее имя в комментарии контроллера. Негативный контроль (4 FAIL до фикса), гейт 40/40 **1809** проверок, смоук `verify_pages.py` 13/13 — `docs/ISSUE-63-REAUDIT.md`; правки в ветке `arena/01a0de80-psihologist-cabinet` (push/PR/закрытие заблокированы: `GH_TOKEN` → 401 с 17:22:52Z). Остаток: независимый Challenger правок + подтверждение владельцем на устройстве → закрытие |
| #64 | P1 | Мобильные диалоги/CTA: sheets вместо prompt/confirm, sticky CTA, safe-area, guard двойной отправки — **реализовано в main** (PR #97, merge `a467553`; DoD repo-части выполнен, `npm run verify` 39/39, 1737 проверок; негативные контроли — `docs/MAIN-AUDIT-64.md`). — **CLOSED владельцем** 2026-09-26T12:55Z (комментарий «этот раздел закрываю») |
| #66 | P2 | Карта проезда (MX-07) — **реализация в main** (PR #83, DoD выполнен: lazy-load, Яндекс по умолчанию, verify_pages зелёный). — **CLOSED владельцем** 2026-09-26T12:55Z (комментарий «Task completed») |
| #69 | P0 PROCESS | Claim-протокол — **реализован в main** (PR #70/#71, Main Re-Audit #69, тесты в гейте). Остаток формальный: CLAIM-комментарии не публикуются (у интеграции нет `issues:write`) → «живая проверка маркера» ограничена карточками ветки; **CLOSED владельцем** 2026-09-26T11:51Z (комментарий «Task completed») |
| #50 | P2 | Этот ресинк (CURRENT-STATE/RECOVERY/ROADMAP + verification gate #19 + решение по Kaizen-кандидату) — **синхронизация к 9171cc1 выполнена в PR #99 (`aff869f`), Main Re-Audit → `docs/MAIN-AUDIT-50.md`; **CLOSED** 2026-09-26T13:18Z (auto-close merge PR #99) |
| #35 | P1 | **Только** telegram-notify (коррекция владельца): деплой + endpoint smoke не-404; блокер — секреты владельца. LEAVE OPEN (комментарий владельца 2026-09-25) |
| #40 | P1 | Google OAuth: repo-канон закрыт (#88); production-активация (Google provider, миграция, URL) + production E2E — BLOCKED на владельце |
| #41 | P1 | Client Google identity при triage: repo-часть в main (PR #62, тесты 21/21); по Acceptance — production E2E (настоящий Google/Supabase) + независимый Challenger обязательны, local mocks не закрывают |
| #27–#29, #31 | BA | Продуктовый backlog (не дефекты); триаж 2026-09-25: не стартовать до разблокировки production (#46-очередь закрыта владельцем; условие остаётся в силе для BA-слоя) |

Закрыты и перепроверены триажем: #7, #8, #11, #14, #15, #18, #19, #21, #22, #23, #30,
#33, #34, #36, #46, #49, #51, #54, #65, #74, #76, #88 (вердикты — `docs/ISSUE-TRIAGE-2026-09-25.md`,
§§3–4; закрытия после триажа — по evidence в PR #58/#59/#60/#61 и владельцу;
#50, #64, #66, #69 — закрыты 2026-09-26 (11:51–13:18Z) владельцем/merge, evidence — PR #95–#99 и `docs/MAIN-AUDIT-*.md`).

## Schema / SR status

`supabase/schema.sql` содержит SR-001…SR-004, SR-D1, фиксы #21/#22, канонический
предикат `is_active_own_psychologist` (#40/#46) и Google-migration-контракт
(`supabase/migrations/20260925_google_specialist_signup.sql`). **Production
отличалась от репозитория** на срезе 2026-09-25 — конкретный список drift —
`docs/ISSUE-46-EVIDENCE.md`, §2. Применение остатков — действие владельца.
Изменения схемы — только через `docs/SCHEMA-REQUESTS.md`.

## Quality Gate status

```text
MAIN → AUDIT → DEFECT/REQUIREMENT → ISSUE → PRODUCER → TESTS → CHALLENGER → MERGE → MAIN RE-AUDIT → STANDARDIZE
```

Текущие блокеры (в порядке зависимостей):

1. Владелец: включить Google provider + URL/миграцию (#40) и задеплоить
   `telegram-notify` (#35) → реальный вход/регистрация E2E (`tools/prod-e2e.mjs`);
2. Владелец/SQL-канал: `create_booking` для anon (PGRST202) → публичная запись в production;
3. #67 TASK 2–5 (owner cabinet) и мобильный пакет #63/#64 — по очереди;
4. #41: production E2E + независимый Challenger; #66/#69 — закрытие по готовому evidence;
   #64 — независимый Challenger + прогон владельцем на телефоне (repo-часть в main, PR #97).

## Next actions — dependency order

1. Владелец: Блок Google provider (#40) + деплой `telegram-notify` (#35) → повторный
   `Production read-only probe` (ждём `измерено: 26/26`, не-404 по функции).
2. Владелец/SQL: гранты `create_booking` для anon → публичная запись живая.
3. #67 TASK 2 (UPDATE услуг → public booking) → TASK 3 («Настройки») → TASK 4 (error contract).
4. Мобильный пакет: #63 — реализован в main (PR #101), «готово» после подтверждения владельцем на устройстве; #64 — CLOSED владельцем 2026-09-26.
5. #66/#69 — CLOSED владельцем 2026-09-26; BA-очередь (#27–#31) — после production-разблокировки.

## Historical documents

Исторические отчёты не переписываются: `docs/ISSUE-14-REPORT.md`,
`docs/ISSUE-14-CHALLENGER.md`, `docs/ISSUE-15-REPORT.md`, `docs/QUALITY-GATE-REPORT.md`,
`docs/D1-REPORT.md`, `docs/ISSUE-34-REPORT.md`, `docs/ISSUE-34-TRIAGE.md`,
`docs/ISSUE-19-REPORT.md`, `docs/AUDIT-2026-09-25.md`, `docs/ISSUE-TRIAGE-2026-09-25.md`,
`docs/ISSUE-50-REPORT.md`, `docs/ISSUE-64-REPORT.md`, `docs/MAIN-AUDIT-64.md`, `docs/MAIN-AUDIT-50.md`,
`docs/ISSUE-63-REPORT.md`, `docs/MAIN-AUDIT-63.md`.

---

*Синхронизировано: 2026-09-26 UTC (issue #63 — Main Re-Audit sync после merge PR #101, исполнитель `EXEC-ZLCS0Evg7b`; предыдущий цикл — issue #50, QA-Challenger, исполнитель
`EXEC-_k1zAnZrvi`; артефакт перехода Main Re-Audit → СТАНДАРТИЗАЦИЯ, RULES §6.7 п. 6; QA 14:25Z);
repo-state — `origin/main` @ `9171cc1` (PR #98 merged, deploy Pages success), голова PR #99 `aff869f`.
Документ фиксирует repo-state и LIVE-факты прода срезом 2026-09-25 (05:53Z) —
свежего LIVE-среза в этой сессии нет (egress закрыт). Документ НЕ сертифицирует
production-готовность: реальный E2E не проводился. Детали — `docs/ISSUE-63-REPORT.md`,
`docs/MAIN-AUDIT-63.md`.*
