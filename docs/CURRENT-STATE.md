# CURRENT-STATE — canonical current-state

> Единственный current-state source of truth. Исторические отчёты не переписываются и не заменяются этим документом.
>
> **АУДИТОР: ВНЕШНИЙ** для production-фактов: сняты запросами к живому проекту
> `phiavtroybgwyjdhqqkh` из runner'а GitHub Actions (`Production read-only probe`,
> `tools/prod-probe/probe.mjs`), а не из песочницы исполнителя. Свежее LIVE-среза
> нет (запуск probe из агентской сессии — 403; последний срез 2026-09-25).
> **АУДИТОР: САМ** для repo-фактов: код и тесты проверены в сессии ресинка
> (`node tools/verify_all.mjs` → 24/24, `verify_pages.py` → ALL PASS на `ca3b23b`).
> Полные доказательства — `docs/ISSUE-46-EVIDENCE.md`, `docs/ISSUE-TRIAGE-2026-09-25.md` (§§8–10).

## Main SHA и активная ветка

- **Актуальный `origin/main` при синхронизации:** `b0313e8` (2026-09-25); эта ветка продолжает его локально.
- **Main Re-Audit `3ebce1c` (2026-09-25, сессия `arena/01a0d75b`):** гейт **26/26** наборов, **1227** проверок,
  exit 0; независимый Challenger #51/#54 — `docs/ISSUE-51-54-CHALLENGER.md`
- **Main Re-Audit `3d4210d` (2026-09-25):** гейт 25/25 наборов, 1180 проверок, exit 0; смоук 12 PASS, ALL PASS;
  Pages: `quality-gate` 06:13:43→06:14:12Z, `deploy` 06:14:16→06:14:37Z (деплой после гейта)
- **Наблюдение F4 в живом CI:** `Deploy Supabase Edge Functions` на `3d4210d` — `deploy-functions` **failure**
  на шаге «Production reachability (gateway 404 = NOT deployed)» — ожидаемое красное, пока функции не задеплоены
- Влито в main 2026-09-25: #47 (`b1dbf1a`), #48 (`ca3b23b`), #52 (`d28ae94`), #53 (`3d4210d`), #56 (`3ebce1c`), #58 (`938e7f6`)
- Исторические baseline: `dcb4093`, `0320c40`, `5d5636d` (PR #44), `03c6fa5` (PR #43), `87e3951`, `4d490d2`.

## Самая важная открытая задача — безопасный портал психологов (P1 / SR-006)

Приоритет №1 проекта сохраняется за порталом психологов. Вход по собственному одноразовому коду, защита отключённого аккаунта и месячный предел клиентской сессии есть в репозитории; безопасная invitation-регистрация и настоящий direct sign-in link ещё не завершены.

- При последующем входе сохранить оба способа: ручной код `auth-code` и одноразовую ссылку из письма, которая действительно создаёт проверенную Auth-сессию. Ссылка, которая только открывает форму с подставленным email, аутентификацией не является. Не удалять и не заменять ручной ввод кода.
- Для первичной регистрации нужны email + invitation-код, отдельный Supabase Auth пароль (не пароль сейфа), `signUp`, email confirmation и callback `/auth/callback`; профиль связывать только после подтверждения email и из проверенной сессии. Не помещать invitation-код в URL/Auth metadata.
- Новые login-коды запрашиваются только через `auth-code`. GoTrue `/auth/v1/otp` fallback запрещён при любой ошибке, включая 404 и status=0/CORS/сеть; status=0 неоднозначен — письмо могло уйти, поэтому не отправлять второй код по одному действию.
- Текущая клиентская `claim_psychologist_profile` по-прежнему требует серверной проверки: нельзя принимать клиентский email/owner/profile id как доказательство владения, создавать профиль без allowlist-приглашения или менять владельца/активность через пользовательский путь. Текущую саморегистрацию не считать безопасной.
- Полный контракт и preflight-требования — `docs/PSYCHOLOGIST-PORTAL-SECURITY-PLAN.md`, SR-006 в `docs/SCHEMA-REQUESTS.md`. Production deploy/auth-link/URL не подтверждены; URL из исходников — кандидат и должен быть подтверждён владельцем перед production-настройкой.

## Исполнение issue #46 (P0 EXECUTOR) — что сделано

1. **Открыт LIVE-канал инспекции прода без секретов владельца:**
   `tools/prod-probe/probe.mjs` + workflow `.github/workflows/prod-probe.yml`
   (26 read-only зондов; отчёт публикуется комментарием в PR).
2. **Production drift доказан живыми ответами, а не «неизвестно»:**
   в проде отсутствуют SR-004 (`auth_login_codes.issued_token_hash/issues/consumed_at`),
   SR-D1 (`schedule_overrides`, `public_schedule_overrides`,
   `session_settings.min_notice_minutes`, `services.availability`),
   а `create_booking` **недоступен роли anon** → публичная запись в проде не работает.
3. **Edge Functions не задеплоены (LIVE):** `auth-code` и `telegram-notify` →
   gateway `404 NOT_FOUND`. Деплой не имитировался: `BLOCKED — OWNER ACTION REQUIRED`.
4. **Исправлены три красных набора** (гейт не защищал от регрессий):
   `db-contract` (анти-спам не доходил до счётчика), `security-regression`
   (даты попадали на выходные → T02 не выполнялся), `availability-db`
   (коллизия недели в weekLimit). После фикса — 22/22 зелёные.
5. **Auth-контракт #40 усилен (с тестами на настоящем PostgreSQL):**
   вход больше не реактивирует отключённый аккаунт; канонический предикат
   `public.is_active_own_psychologist()` закрывает RLS-доступ при деактивации;
   абсолютный срок сессии — месяц (fail-closed), refresh его не удлиняет.
6. **Документация:** `docs/ISSUE-46-EVIDENCE.md`, Блоки 7–8 в
   `docs/OWNER-CHECKLIST-E2E.md` (read-only SQL для владельца + срок сессии).
7. **PR #47 MERGED** (`b1dbf1a`), затем **PR #48 MERGED** (`ca3b23b`): честный канал
   доставки кодового входа (`verificationHint` — «в запасном канале ссылка, а не код»)
   + `#auth-code-hint` в форме (мёртвая ссылка `js/app.js:499` устранена).
8. **Main Re-Audit мержа PR #48:** гейт 24/24 + `verify_pages.py` ALL PASS на `ca3b23b`
   (`docs/ISSUE-TRIAGE-2026-09-25.md`, §9). Регрессий нет.

## Production — честный статус

**Production readiness НЕ подтверждена. Приложение в production НЕ работает**
по основному пути (регистрация и публичная запись).

LIVE-факты (срез 2026-09-25, `phiavtroybgwyjdhqqkh`; дрейф схемы закрыт
владельцем между 04:55Z и 05:14Z — подробности `docs/ISSUE-46-EVIDENCE.md` §2bis):

| Элемент | Статус | Класс |
|---|---|---|
| REST/PostgREST отвечает, каталог жив (2 активные анкеты) | работает | LIVE |
| `auth-code` / `telegram-notify` | **не задеплоены** (404 NOT_FOUND; 05:14Z, 05:42Z, 05:53Z) | LIVE, блокер |
| SR-001/SR-003 (`sessions.*`, `public_booked_slots.duration_min`) | применены | LIVE |
| SR-004 (`auth_login_codes.issued_token_hash/issues/consumed_at`) | **применены** (было «отсутствует» до 05:14Z) | LIVE |
| SR-D1 (`schedule_overrides`, `public_schedule_overrides`, колонки политик, `services.availability`) | **применены** | LIVE |
| `create_booking` для anon | **недоступен** (PGRST202) → публичная запись не работает | LIVE, блокер |
| `client_risks` / `clients` / `payments` / `booking_attempts` для anon | закрыты (42501) — #22 в части грантов подтверждён | LIVE |
| `auth_login_codes` строки для anon | `[]` (RLS без политик = deny) | LIVE |
| Application origin | `https://a1dmitry.github.io/Psihologist-cabinet/` (не localhost) | LIVE |
| Supabase Auth: `external.email=true`, `disable_signup=false`, `mailer_autoconfirm=false` | факт | LIVE |
| Site URL / Redirect URLs в Auth | не подтверждено (Dashboard) | UNKNOWN |
| Серверный срок сессии (≤ месяца) | не подтверждено | UNKNOWN |
| Реальный registration E2E (код и ссылка) | не проведён | BLOCKED |

Root cause (FACT по внешнему каналу): `supabase/schema.sql` был применён не
целиком — это устранено владельцем 2026-09-25; остаток — деплой Edge Functions
и доступность `create_booking` для anon (причина различима только SQL-каналом).

## Repo-level состояние

По текущей ветке подтверждено наличие и работоспособность:

- registration domain / OTP flow, два входа (код и ссылка) в одну canonical-сессию;
- отказ в доступе отключённому аккаунту (SQL + RLS + клиент);
- абсолютный срок сессии (месяц) на клиенте + требование серверной настройки;
- server-authoritative booking contract (`create_booking`) и D1 policy engine;
- tenant isolation / anti-spam (по `created_at`), security-regression;
- parity-матрица client↔server, booking E2E, harness guard;
- read-only production probe (новый инструмент #46) + честная сводка измерения
  (`measured`/`unreachable`, #54) и гейт workflow на «не измерено»;
- честность самого гейта: silent-набор (0 проверок) и `FAIL` с любым отступом
  краснеют (#51 и F2 из Challenger-аудита), деплой функций не бывает зелёным
  без фактической доступности endpoint'ов;
- Toyota Quality Gate / Producer + Challenger process.

Это **repo + live-probe evidence**, а не production E2E.

## Открытые критические контуры

| Issue | Priority | Current status |
|---|---:|---|
| #46 | P0 | EXECUTOR + Challenger (TASK 7) выполнены (PR #53, `docs/ISSUE-46-CHALLENGER.md`); production-разблокировка — за владельцем (деплой функций, SQL по `create_booking`); Main Re-Audit — после merge |
| #35 | P1 | Edge Functions deployment — **LIVE-подтверждено: не задеплоены** (срез 05:53Z 2026-09-25); блокер на владельце; `supabase-deploy.yml` теперь краснеет без деплоя (F4) |
| #40 | P1 | Требования закрыты в repo (входы, inactive-гейт, срок сессии) с тестами; production E2E — BLOCKED |
| #21 | P1 | Server-authoritative booking — repo merged, включая п.4: демо-оплата при живом Supabase больше не пишет «оплата прошла» (local-only UX + negative `tests/demo-pay-honesty.mjs`); production-гейт: `create_booking` для anon недоступен (LIVE); Challenger + Main Re-Audit OPEN |
| #22 | P2 | Tenant isolation / anti-spam — repo merged + тесты; `client_risks` закрыт в проде (LIVE) |
| #34 | P1 | Challenger recovery + свежий Main Re-Audit — OPEN (проверялся 4d490d2, main ушёл на ca3b23b) |
| #36 | P2 | Harness false-green — **DoD выполнен, к закрытию владельцем**: свежий независимый Challenger на `5f20349` ≡ `938e7f6` (`docs/ISSUE-36-CHALLENGER.md`): сырьё A1/A2/B/C повторено, все три канала красные; гейт 26/26. Закрытие — за владельцем: у App-токена нет `issues:write`, auto-close не срабатывает от merge App'ом |
| #51 | P2 | Silent suite (0 проверок, exit 0) — **CLOSED**: независимый Challenger + Main Re-Audit на `3ebce1c` (`docs/ISSUE-51-54-CHALLENGER.md`): повтор атаки C2 → гейт красный; 26/26 зелёные |
| #54 | P2 | Probe-сводка «drift 0» без измерений — **CLOSED**: Challenger PASS (`docs/ISSUE-51-54-CHALLENGER.md`): blackhole → `измерено: 0/26`, `HTTP_0` устранён, workflow-гейт на `unreachable>0`, live-прогон читаем (Actions 06:55Z) |
| #50 | P2 | Docs resync — этот файл, `INFRA.md` и `ISSUE-46-EVIDENCE.md` синхронизированы с продом (05:53Z); остаток #50 — RECOVERY-ORCHESTRATION/ROADMAP, Challenger + Main Re-Audit |
| #41 | P1 | Client Google identity — requirements open (LIVE: external.google=false) |
| #27–#31 | BA | Продуктовый backlog; не дефекты |

Закрыты 2026-09-25 и перепроверены: #15 (Quality Gate DONE), #49 (probe-мусор),
#21, #22, #34, #51, #54 (владельцем; независимый Challenger + Main Re-Audit по
#51/#54 — `docs/ISSUE-51-54-CHALLENGER.md`).
Готов к закрытию владельцем (DoD выполнен, evidence на main): #36
(`docs/ISSUE-36-CHALLENGER.md`).
Закрыты ранее: #7, #8, #11, #14, #18, #19, #23, #30, #33 (вердикты — триаж §3).

## Целевой authentication contract и фактическое состояние

```text
ручной код auth-code ──────┐
настоящая одноразовая ссылка ├──> ОДНА проверенная Supabase-сессия → auth.uid() → только свой активный кабинет
                           ┘
```

- **Целевое требование:** код и настоящая одноразовая ссылка — два варианта последующего входа в одну практику; для регистрации подтверждение email и invitation-код сходятся в один безопасный bind.
- **Сделано:** ручной `auth-code` вход, единая обработка полученной Supabase Auth-сессии, inactive-gate и абсолютный клиентский срок сессии (30 дней).
- **Ещё не сделано:** текущая кнопка в письме `auth-code` лишь открывает `#/auth?email=…`; она не аутентифицирует. Настоящий одноразовый sign-in link и безопасный invitation signup/bind с полноценным PKCE callback остаются открытыми.
- Новый login-код идёт только через `auth-code`; GoTrue/Auth OTP fallback запрещён при любой ошибке. Legacy redirect-парсер и завершение ранее сохранённого OTP не означают разрешение нового fallback.
- `key_verifier` — только сейф клиентов, не вход. Производственный URL и настройки Auth требуется подтвердить владельцу перед применением.
- Отключённый аккаунт не реактивируется входом, RLS закрывает кабинет; срок сессии — не больше месяца (клиент + требование серверной настройки).

## Schema / SR status

`supabase/schema.sql` содержит SR-001…SR-004, SR-D1 и фиксы #21/#22 плюс
канонический предикат `is_active_own_psychologist` (#40/#46).
**Production отличается от репозитория** — конкретный список drift см. в
`docs/ISSUE-46-EVIDENCE.md`, §2. Устранение — действие владельца (Блок 2).

## Quality Gate status

```text
MAIN → AUDIT → DEFECT/REQUIREMENT → ISSUE → PRODUCER → TESTS → CHALLENGER → MERGE → MAIN RE-AUDIT → STANDARDIZE
```

Текущие блокеры:

1. production-активация владельцем: деплой `auth-code` / `telegram-notify` + SQL по
   `create_booking` (схема SR-004/SR-D1 уже применена 2026-09-25) — `docs/OWNER-CHECKLIST-E2E.md`;
2. реальный registration E2E после деплоя (код и ссылка) — `tools/prod-e2e.mjs`;
3. закрытие #46 владельцем по готовым evidence (Challenger PASS) + Main Re-Audit;
4. свежий Challenger по #34 на актуальном SHA и завершение #50 (RECOVERY/ROADMAP).

## Next actions — dependency order

1. Merge PR #53 (Challenger #46 + честность гейта/деплоя/probe) → Main Re-Audit нового `main`.
2. Владелец: Блок 1 (деплой функций: `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID`) → Блоки 3–4 (Resend/секреты/URL).
3. Владелец: Блок 7 (SQL: `pg_proc` + гранты `create_booking`; при корректной сигнатуре — reload кэша PostgREST).
4. Повторный прогон `Production read-only probe`: ждём `измерено: 26/26` и `drift 0` по Edge Functions.
5. Владелец: Блок 5 (`tools/prod-e2e.mjs --email … --link …`) → реальный E2E: код, ссылка, reload, повторный вход.
6. Закрытие #46 по готовому evidence (#36/#51/#54 закрыты — Challenger PASS,
   `docs/ISSUE-36-CHALLENGER.md`, `docs/ISSUE-51-54-CHALLENGER.md`), затем фичи BA-очереди (#27–#31).

## Historical documents

Исторические отчёты не переписываются: `docs/ISSUE-14-REPORT.md`,
`docs/ISSUE-14-CHALLENGER.md`, `docs/ISSUE-15-REPORT.md`,
`docs/QUALITY-GATE-REPORT.md`, `docs/D1-REPORT.md`, `docs/ISSUE-34-REPORT.md`,
`docs/ISSUE-34-TRIAGE.md`, `docs/ISSUE-19-REPORT.md`, `docs/AUDIT-2026-09-25.md`.

---

*Синхронизировано: 2026-09-25 UTC; `main` @ `3d4210d` (PR #53 merged). Документ фиксирует repo-state и LIVE-факты прода (срез 05:53Z): схема
применена владельцем, блокеры — Edge Functions и `create_booking` для anon.
Документ НЕ сертифицирует production-готовность: реальный E2E не проведён.*
