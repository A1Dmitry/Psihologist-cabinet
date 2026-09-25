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

- **Актуальный `main`:** `dcb4093606c0c3993c6632adabb8e2685077fc04`
- **Активная исполнительская ветка #46:** `arena/01a0d6b5-psihologist-cabinet` → **PR #47**
- Исторические baseline: `0320c40`, `5d5636d` (PR #44), `03c6fa5` (PR #43), `87e3951`, `4d490d2`.

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

LIVE-факты (2026-09-25, `phiavtroybgwyjdhqqkh`):

| Элемент | Статус | Класс |
|---|---|---|
| REST/PostgREST отвечает, каталог жив (2 активные анкеты) | работает | LIVE |
| `auth-code` / `telegram-notify` | **не задеплоены** (404 NOT_FOUND) | LIVE |
| SR-001/SR-003 (`sessions.*`, `public_booked_slots.duration_min`) | применены | LIVE |
| SR-004 (`auth_login_codes.*`) | **отсутствует** | LIVE |
| SR-D1 (`schedule_overrides`, `public_schedule_overrides`, колонки политик, `services.availability`) | **отсутствует** | LIVE |
| `create_booking` для anon | **недоступен** (PGRST202) → публичная запись не работает | LIVE |
| `client_risks` для anon/authenticated | закрыт (42501) — #22 в части грантов подтверждён | LIVE |
| `auth_login_codes` строки для anon | `[]` (RLS без политик = deny) | LIVE |
| Application origin | `https://a1dmitry.github.io/Psihologist-cabinet/` (не localhost) | LIVE |
| Supabase Auth: `external.email=true`, `disable_signup=false`, `mailer_autoconfirm=false` | факт | LIVE |
| Site URL / Redirect URLs в Auth | не подтверждено (Dashboard) | UNKNOWN |
| Серверный срок сессии (≤ месяца) | не подтверждено | UNKNOWN |
| Реальный registration E2E (код и ссылка) | не проведён | BLOCKED |

Root cause (INFERENCE, высокая уверенность): `supabase/schema.sql` не
переприменялся в проде целиком — задокументировано в `docs/INFRA.md` п.2, теперь
подтверждено живыми ответами.

## Repo-level состояние

По текущей ветке подтверждено наличие и работоспособность:

- registration domain / OTP flow, два входа (код и ссылка) в одну canonical-сессию;
- отказ в доступе отключённому аккаунту (SQL + RLS + клиент);
- абсолютный срок сессии (месяц) на клиенте + требование серверной настройки;
- server-authoritative booking contract (`create_booking`) и D1 policy engine;
- tenant isolation / anti-spam (по `created_at`), security-regression;
- parity-матрица client↔server, booking E2E, harness guard;
- read-only production probe (новый инструмент #46);
- Toyota Quality Gate / Producer + Challenger process.

Это **repo + live-probe evidence**, а не production E2E.

## Открытые критические контуры

| Issue | Priority | Current status |
|---|---:|---|
| #46 | P0 | EXECUTOR-контур исполнен, PR #47 + PR #48 merged; production-разблокировка — за владельцем (Блоки 1–8); Challenger (TASK 7) и Main Re-Audit НЕ выполнены |
| #35 | P1 | Edge Functions deployment — **LIVE-подтверждено: не задеплоены** (срез 2026-09-25, свежее нет — dispatch probe 403); блокер на владельце |
| #40 | P1 | Требования закрыты в repo (входы, inactive-гейт, срок сессии) с тестами; production E2E — BLOCKED |
| #21 | P1 | Server-authoritative booking — repo merged; completePayment local-only жив (п.4); production-гейт: `create_booking` для anon недоступен (LIVE) |
| #22 | P2 | Tenant isolation / anti-spam — repo merged + тесты; `client_risks` закрыт в проде (LIVE) |
| #34 | P1 | Challenger recovery + свежий Main Re-Audit — OPEN (проверялся 4d490d2, main ушёл на ca3b23b) |
| #36 | P2 | Harness false-green — implementation merged + независимый Challenger PASS на ca3b23b; к закрытию владельцем; follow-up — #51 |
| #51 | P2 | Silent suite (0 проверок, exit 0) проходит гейт зелёным — найден Challenger'ом #36, воспроизведён |
| #50 | P2 | Docs resync + verification gate #19 — OPEN; этот файл ресинкнут (producer), RECOVERY/ROADMAP + Challenger + Main Re-Audit pending |
| #41 | P1 | Client Google identity — requirements open (LIVE: external.google=false) |
| #27–#31 | BA | Продуктовый backlog; не дефекты |

Закрыты 2026-09-25 и перепроверены: #15 (Quality Gate DONE), #49 (probe-мусор).
Закрыты ранее: #7, #8, #11, #14, #18, #19, #23, #30, #33 (вердикты — триаж §3).

## Canonical authentication contract

```text
manual one-time code ──┐
                       ├──> ОДНА canonical Supabase session → owner_id = auth.uid() → свой кабинет
email link ────────────┘
```

- Оба входа реализованы и сходятся в `finishAuthenticatedLogin` → `claimOrCreatePsychologist`.
- Второй auth-engine не создавался; `key_verifier` — только сейф клиентов, не вход.
- Ссылка из письма использует реальный origin (`APPLICATION_URL`), localhost отбрасывается.
- Отключённый аккаунт: вход не реактивирует, RLS закрывает данные, сессия не сохраняется.
- Срок сессии: не больше месяца (клиент + требование серверной настройки).

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

1. production-активация владельцем (Блоки 1–8 `docs/OWNER-CHECKLIST-E2E.md`);
2. закрытие #36 владельцем (Challenger PASS готов) + фикс #51;
3. независимый Challenger по #46 (TASK 7) и #34 (свежий, на `ca3b23b`);
4. Main Re-Audit на новом SHA `main` + завершение #50 (RECOVERY/ROADMAP);
5. реальный registration E2E после деплоя `auth-code` и применения схемы.

## Next actions — dependency order

1. Владелец: закрыть #36 (evidence — `docs/ISSUE-TRIAGE-2026-09-25.md`, §10).
2. Producer: фикс #51 (silent suite) → Challenger → merge → Main Re-Audit.
3. Владелец: Блок 2 (схема целиком) → Блок 1 (деплой функций) → Блоки 3–4 (Resend/секреты) → Блок 8 (срок сессии).
4. Повторный прогон `Production read-only probe` — drift должен исчезнуть (отчёт в PR/issue).
5. Владелец: Блок 5 (`tools/prod-e2e.mjs --email …`) → реальный E2E: код, ссылка, reload, повторный вход.
6. Независимый Challenger (TASK 7 #46) → Main Re-Audit → merge → повторная синхронизация этого файла.
7. Только после этого — BA-фичи #27–#31.

## Historical documents

Исторические отчёты не переписываются: `docs/ISSUE-14-REPORT.md`,
`docs/ISSUE-14-CHALLENGER.md`, `docs/ISSUE-15-REPORT.md`,
`docs/QUALITY-GATE-REPORT.md`, `docs/D1-REPORT.md`, `docs/ISSUE-34-REPORT.md`,
`docs/ISSUE-34-TRIAGE.md`, `docs/ISSUE-19-REPORT.md`, `docs/AUDIT-2026-09-25.md`.

---

*Синхронизировано: 2026-09-25 UTC; baseline `main` @ `dcb4093`, исполнительская
ветка #46 → PR #47. Документ фиксирует repo-state и LIVE-факты прода; он НЕ
сертифицирует production-готовность.*
