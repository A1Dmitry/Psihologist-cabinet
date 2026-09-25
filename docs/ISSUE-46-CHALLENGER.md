# ISSUE-46 — Challenger + Main Re-Audit: независимая проверка `main @ d28ae94`

> **АУДИТОР: САМ** — локальные прогоны и мутационные атаки выполнены в этой сессии
> (песочница Arena), дерево при прогонах было **неизменённым `main`**
> (`git status --porcelain` пусто, `HEAD = d28ae942d60cf3eecf2626aea84e30cd791abbff`).
> **АУДИТОР: ВНЕШНИЙ** — для фактов из GitHub Actions (runner вне песочницы):
> `Quality Gate`, `Production read-only probe`, job'ы `Deploy to GitHub Pages`.
> **Производственный SQL-канал (pg_proc/гранты/RLS) в этой сессии недоступен → UNKNOWN.**
>
> Этот отчёт **не сертифицирует сам себя**: по `docs/RULES.md` §3/§6.6 отчёт
> Challenger'а — вход для Main Re-Audit владельцем/следующим проверяющим, а не
> его замена. Issue #46 этим отчётом **не закрывается**.
>
> Секреты не использовались и не публикуются. Канал прода — публичный anon key
> (он и так опубликован в собранном сайте); OTP, access/refresh-токены,
> service-role key и PII не выводились.

## Паспорт прогона

| Поле | Значение |
|---|---|
| CHECKED SHA (repo) | `d28ae942d60cf3eecf2626aea84e30cd791abbff` — `main` (merge PR #52), дерево не изменялось |
| BASELINE SHA (ветка аудитора) | `b1dbf1add5d512751bf60f7346297f57e2f5e345` (merge PR #47), подтянут fast-forward до `d28ae94` |
| DATE/UTC | 2026-09-25 |
| Окружение (локально) | песочница Arena: node v22.22.3, npm 10.9.8, Python 3.11.2, embedded PostgreSQL 18.4 |
| Egress песочницы | `*.supabase.co` → TLS обрыв (`curl` exit 35); `a1dmitry.github.io` → то же; `api.github.com` → 200 |
| Внешние каналы | GitHub Actions: `Quality Gate` (PR, `verify.yml`), `Production read-only probe` (PR, `prod-probe.yml`), `Deploy to GitHub Pages` (push, `pages.yml`) |
| Инструменты | `node tools/verify_all.mjs`, `verify_pages.py`, атаки в изолированной копии дерева (`git archive HEAD` в `/tmp`), `gh` API |
| Классификация | `FACT` — прочитано/проверено в репозитории; `LIVE EVIDENCE` — прод через внешний канал; `INFERENCE` — вывод; `UNKNOWN` — канала нет |

Кит атак — `docs/ISSUE-46-CHALLENGER-KIT.md` (9 атак A–I). Ниже он заполнен
фактическими результатами, а не пересказом отчёта Producer.

---

## 1. Main Re-Audit — что подтверждено на этом SHA

### 1.1 Дельты мержей (FACT)

`git diff --stat <merge>^1 <merge>` против GitHub-диффов соответствующих PR:

| Merge | PR | Файлов | Строк | Совпадение с PR |
|---|---|---:|---|---|
| `b1dbf1a` | #47 | 22 | +2087 / −229 | совпадает со списком файлов PR |
| `ca3b23b` | #48 | 8 | +164 / −4 | совпадает построчно |
| `d28ae94` | #52 | 2 | +359 / −18 | `CURRENT-STATE.md`, `ISSUE-TRIAGE-2026-09-25.md` — построчно |

Посторонних файлов в мержах нет.

### 1.2 Проектный гейт (FACT, локально на неизменённом дереве)

```text
$ node tools/verify_all.mjs
Все наборы зелёные (24)
exit=0            real 0m13.927s
```

- **24 набора, 1171 проверка** (маркеры `PASS` / `✅`), **exit 0**.
- Наборов с **нулём** проверок на этом SHA нет (приложение 1) — то есть канал
  #51 сегодня не используется, но и не закрыт (см. §3, F2).
- `tests/db-contract`, `tests/schema-convergence`, `tests/availability-db`,
  `tests/availability-parity`, `tests/booking-e2e`, `tests/harness-guard`
  поднимают **настоящий PostgreSQL 18.4** (6 стартов за прогон).

### 1.3 Смоук маршрутов (FACT, локально)

```text
$ python3 devserver.py 8765 & BASE_URL=http://127.0.0.1:8765 python3 verify_pages.py
PASS ×12 … ALL PASS   exit=0
```

### 1.4 Деплой Pages действительно ждёт гейт (LIVE EVIDENCE, внешний канал)

`gh api repos/.../actions/runs/36099699228/jobs` (push `d28ae94`):

| Job | Результат | Начало → конец |
|---|---|---|
| `quality-gate / verify` | success | 05:42:44Z → 05:43:08Z |
| `deploy` | success | **05:43:12Z** → 05:43:42Z |

`deploy` стартовал через 4 с **после** завершения гейта → `needs: quality-gate`
соблюдён, деплой без зелёного гейта не проходит (FACT о механизме; ранее
`gh run view --json jobs` показывал смазанные времена — для доказательства
использован `actions/runs/<id>/jobs`).

### 1.5 Регистрация наборов (FACT)

Независимый цикл `for f in tests/*.mjs; grep -q $f tools/verify_all.mjs` →
незарегистрированных нет. Сам гейт дополнительно проверяет регистрацию внутри
`tests/harness-guard.mjs` (`PASS … зарегистрирован в verify_all` ×N).

---

## 2. Атаки A–I (кит `ISSUE-46-CHALLENGER-KIT.md`, заполнено)

| # | Что опровергалось | Канал | Вердикт | Доказательство |
|---|---|---|---|---|
| A | ссылка из письма ведёт на localhost | repo (+тесты), прод — UNKNOWN | **PASS (repo)** / UNKNOWN | `PASS OTP fallback: redirect не localhost`; `PASS APPLICATION_URL задан и не localhost`; `PASS resolveApplicationUrl на localhost → APPLICATION_URL`; `PASS APP_URL localhost не попадает в письмо` (pokа-yoke в `supabase/functions/auth-code`); реальная ссылка из письма — за владельцем (нет ящика) |
| B | OTP и ссылка создают разные identities | repo (E2E-харнесс) | **PASS** | 6 проверок: `два входа: ТОТ ЖЕ psychologist.id`, `один и тот же owner_id == auth.uid()`, `дубль профиля НЕ создан`, `сессия одна и та же по sub` |
| C | отключённый аккаунт реактивируется входом | **настоящий PostgreSQL** | **PASS** | `inactive: вход не реактивирует кабинет (ok=false, inactive=true)`, `is_active в БД остался false`, `RLS закрывает сессии владельца` + мутация **M1b** ниже |
| D | можно получить чужой кабинет | настоящий PostgreSQL | **PASS** | `RLS: чужой владелец не видит сессии`; `T03: cross-tenant client_risks blocked for B` (лог PostgreSQL: `ERROR: permission denied for table client_risks`); мутация **M3** |
| E | можно создать дубль психолога | repo + SQL | **PASS** | `claim повторно: дублей нет`, `повторный вход: дублей в БД нет`, `reactivated: повторный вход возвращает ТОТ ЖЕ профиль`, `после: дублей политик нет` |
| F | `create_booking` принимает client money/status/duration | настоящий PostgreSQL | **PASS** | `T02` 8 проверок: `paid-state injection blocked or normalized`, `status/payment_status not paid`, `amount_paid not 1000`, `currency not USD`, `duration not 9999`, `amount_due server-derived`; hold: `T02: hold_expires_at server-controlled`, `T05: expired hold does not block slot` |
| G | production endpoint отсутствует | **LIVE EVIDENCE** (внешний канал) | **FAIL (дефект подтверждён)** | `GET /functions/v1/auth-code` → 404 `NOT_FOUND`; `telegram-notify` → 404; `create_booking` для anon → `PGRST202` (§4) |
| H | после миграции остаётся несколько сигнатур RPC | настоящий PostgreSQL | **PASS (repo)** / prod SQL — UNKNOWN | `schema-convergence`: 21 проверка, включая «грязный прод» → перегрузки схлопнуты, `create_booking` ровно 22 аргумента, гранты восстановлены, повторное применение идемпотентно |
| I | зелёный CI маскирует провал | repo + Actions | **PASS c двумя новыми каналами** | гейт реагирует на 5 из 5 мутаций (§2.2), деплой гейтится (§1.4); **но** silent-набор и «FAIL с отступом» проходят зелёными (§3) |

### 2.1 Как ломались инварианты (falsification, а не пересказ)

Все мутации — в изолированной копии дерева (`git archive HEAD`), рабочее дерево
не изменялось; для каждой заранее ожидался красный результат.

| Мутация | Ожидание | Факт |
|---|---|---|
| `DEFAULT_DURATION_MIN 60 → 45` (`js/domain/duration.js`) | красный | **exit 1**, 2 набора красных (`timezone-domain`, `availability-parity`) |
| Гейт отключён + `is_active = true` в `claim_psychologist_profile` | красный | **exit 1**, 5 FAIL по секции «ОТКЛЮЧЁННЫЙ АККАУНТ» (поймана реактивация) |
| `is_active_own_psychologist` игнорирует `is_active` | красный | **exit 1**: `FAIL inactive: RLS закрывает сессии владельца` |
| Политика `sessions` → `using (true)` | красный | **exit 1**: `FAIL RLS: чужой владелец не видит сессии` |
| `FAIL` в колонке 0 при `exit 0` (контроль матчера) | красный | **exit 1** |
| stray async-крах перед `finishSuite` в реальном DB-наборе | красный | **exit 1** (`ALL PASS` в выводе набора + `Error: STRAY CRASH`) |
| `verify_app` против битого импорта (`VERIFY_APP_ENTRY`) | красный | **exit 1**, `IMPORT/LINK ERROR` |
| DB-набор без `node_modules` (embedded-postgres недоступен) | красный | **exit 1** (нет «тихого пропуска» БД-части) |

Честная оговорка по методике: первая версия мутации «реактивация» (`is_active = true`
без снятия гейта) дала **зелёный** результат — она просто не достигала
проверяемой ветки, потому что гейт `if not v_is_active then return` стоит выше.
Результат отброшен как невалидный, атака повторена корректно (M1b выше).
Это ровно тот класс ошибок, от которого предостерегает `docs/RULES.md` §6.15.

---

## 3. Найденные каналы (включая незакрытые)

### F1 — probe может отчитаться «drift 0», ничего не измерив (P2, воспроизведено)

`tools/prod-probe/probe.mjs` в песочнице/на runner'е без сети до прода выдаёт
**exit 0** и сводку, в которой нет счётчика «сколько зондов реально получило
ответ»:

```text
$ (SUPABASE_URL → недоступный адрес) node tools/prod-probe/probe.mjs
NETWORK_ERROR ×24, HTTP_0 ×2 (без ответа: 26 из 26 зондов)
──── SUMMARY ────
probes: 26, drift/missing: 0
exit=0
```

- **Почему это дефект:** `drift_or_missing` считает только `DRIFT*`, `NOT_DEPLOYED`
  и `LEAK`. Полностью недоступный прод даёт ту же сводку `drift/missing: 0`, что и
  чистый прод. Это единственный LIVE-канал инспекции прода (#46 TASK 1/6), и
  читатель PR-комментария видит «0» без пометки «не измерено».
- **Плюс несогласованность меток:** два зонда (`B inventory`) при сетевом отказе
  печатают `HTTP_0`, а не `NETWORK_ERROR` (остальные 24 — `NETWORK_ERROR`).
- **Почему это важно на практике:** прогон probe — обязательный шаг evidence
  («drift должен исчезнуть после Блока 2»). Если runner потеряет сеть, отчёт
  скажет «drift 0», и это будет прочитано как «схема применена».
- **Минимальное лечение:** в JSON/сводку добавить `unreachable` (число зондов без
  ответа) и печатать в шапке `SUMMARY` строку вида
  `measured: 26/26 · unreachable: 0`; сегодня достаточно было бы `HTTP_0` →
  тот же `NETWORK_ERROR`. Гейтом CI это не делать (диагностика, не гейт), но
  шаг workflow может **падать при `unreachable > 0`**: «измерения не было» — это
  не результат.

### F2 — гейт слеп к `FAIL` с отступом; guard не видит наборы вне `tests/` (P3, воспроизведено)

```text
$ # копия main, набор печатает FAIL с тремя пробелами и выходит 0
   FAIL  поддельный провал с отступом
✅ FAIL3 probe (FAIL с отступом, exit 0) — tools/zz-fail3.mjs
Все наборы зелёные (25)        exit=0
```

- Причина в `tools/verify_all.mjs`: красная строка распознаётся шаблоном
  `^(FAIL\b|  ❌)` — только колонка 0 или ровно два пробела; `passed` считается,
  но **не участвует** в вердикте (`ok: code === 0 && failedLines.length === 0`).
  Это подтверждает корневую причину #51 независимым чтением кода.
- `tests/harness-guard.mjs` перебирает `readdirSync(join(ROOT,'tests'))`, то есть
  требование «зарегистрирован в `verify_all`» не распространяется на 7 наборов
  вне `tests/` (`verify_auth.mjs`, `verify_app.mjs`, `verify_profile.mjs`,
  `verify_telegram.mjs`, `test_routing.mjs`, `tools/verify_cabinet.mjs`,
  `tools/verify_tailwind.mjs`) — новый такой файл может остаться незапущенным.
- **Минимальное лечение:** (а) матчер по началу строки после `\s*`; (б) требовать
  от набора ≥1 маркер проверки при `exit 0` (DoD #51) с allowlist для `verify_app`;
  (в) guard — перебирать и корень.

### F3 — документация описывает прод, которого уже нет (FACT/LIVE, влияет на решения)

Внешний канал (probe) показывает, что **часть дрейфа устранена владельцем** между
04:55Z и 05:14Z 2026-09-25:

| Элемент | 04:55:28Z (`0f4ffc1f`, drift 10) | 05:14:23Z (`dfdc4334`, drift 4) |
|---|---|---|
| `auth_login_codes.issued_token_hash/issues/consumed_at` (SR-004) | DRIFT: column missing | **существует** (колонки резолвятся) |
| `session_settings.min_notice_minutes` и остальные D1-колонки | DRIFT: column missing | **существует** |
| `services.availability` | DRIFT: column missing | **существует** (`null`) |
| `public_settings.min_notice_minutes` | DRIFT: column missing | **существует** (`Europe/Minsk`, `0`) |
| `schedule_overrides` / `public_schedule_overrides` (D1) | DRIFT: object missing | **существуют** (`public_schedule_overrides` читается, 0 строк) |
| `auth-code` / `telegram-notify` | NOT_DEPLOYED | NOT_DEPLOYED |
| `create_booking` для anon | DRIFT: rpc missing | DRIFT: rpc missing |

Между тем в репозитории на этом SHA по-прежнему написано:

- `docs/ISSUE-46-EVIDENCE.md` §2 — «SR-004 отсутствует», «SR-D1 отсутствует»
  (таблица дрейфа) — **устарело**;
- `docs/INFRA.md` п.2 — «⛔ критично: переприменить … drift подтверждён LIVE» — **устарело**;
- `docs/CURRENT-STATE.md` — «Актуальный `main`: `dcb4093`», «PR #47 — активная
  ветка» при фактическом `d28ae94` и влитых #47/#48/#52 — **устарело** (это
  ровно scope #50).

**Следствие для решений:** формулировка «приложение в production не работает»
остаётся верной, но **причина сузилась**: регистрация блокируется только
деплоем Edge Functions, публичная запись — недоступностью `create_booking` для
`anon`; дрейф схемы SR-004/D1 больше не в списке блокеров (по внешнему каналу).
Пока документы не синхронизированы, любой следующий исполнитель будет чинить
уже применённое.

### F4 — «Deploy Supabase Edge Functions» бывает зелёным, ничего не деплоя (P3)

`supabase-deploy.yml` без `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_ID`
печатает `::notice::` и **завершается успешно**; история запусков — 3 × `success`
(2026-09-23/24), при этом LIVE-probe 2026-09-25 показывает `auth-code` и
`telegram-notify` как `NOT_DEPLOYED`. Отдельно: в отличие от `pages.yml`, этот
workflow **не вызывает `quality-gate`** (`needs`/`workflow_call` отсутствуют).
Поведение задокументировано, поэтому это не «скрытый» отказ, но зелёная галочка
workflow с названием «Deploy …» при отсутствии деплоя — тот же класс ложного
сигнала, что и #36/#51. Лечение: `::error::` вместо notice при отсутствии
секретов (или отдельный job-`no-op` с честным статусом), и вызов гейта перед
деплоем функций.

### F5 — мелочи документации CI (P4)

Комментарий в `.github/workflows/verify.yml` говорит «22 набора», фактически 24;
в `docs/ISSUE-46-CHALLENGER-KIT.md` §I — «все `tests/*.mjs` зарегистрированы»,
но не упомянуты 7 наборов вне `tests/` (см. F2).

---

## 4. LIVE-состояние прода по внешнему каналу (дата/время в шапке прогона)

Последний на момент аудита отчёт probe — комментарий в PR #52 (run 36099651885,
SHA `1902f8b8`, 2026-09-25T05:42:19Z). Свежий прогон для SHA этой ветки —
комментарий к PR, открытому из неё (Приложение 3).

| Элемент | Факт | Класс |
|---|---|---|
| REST/PostgREST, каталог (`public_profiles`, 2 активные анкеты) | работает | LIVE |
| `auth-code`, `telegram-notify` | **не задеплоены** (gateway 404) | LIVE |
| SR-004 / SR-D1 объекты и колонки | **применены** (05:14Z; см. F3) | LIVE |
| `create_booking` для `anon` | **не резолвится** (`PGRST202`) → публичная запись не работает | LIVE |
| `client_risks`, `clients`, `payments`, `booking_attempts` для anon | `42501 permission denied` (гранты закрыты) | LIVE |
| `auth_login_codes` для anon | 0 строк (RLS без политик = deny) | LIVE |
| `services` (anon) | читается 1 строка, `price=1`, `payment_policy=null`, `availability=null` | LIVE |
| GoTrue settings | `external.email=true`, `external.google=false`, `disable_signup=false`, `mailer_autoconfirm=false` | LIVE |
| Application origin | `https://a1dmitry.github.io/Psihologist-cabinet/` | FACT (config) |
| Site URL / Redirect URLs в Auth, серверный срок сессии, реальная ссылка из письма | не проверено | **UNKNOWN** (нет доступа к Dashboard/ящику) |
| Реальный registration E2E (код и ссылка) | не проведён | **BLOCKED** |

Что это меняет в приоритетах: `create_booking` для `anon` — единственный
подтверждённый LIVE-дефект приложения (публичная запись). Различать «функции нет» /
«нет EXECUTE у anon» / «не та сигнатура» этим каналом нельзя — нужен SQL владельца
(Блок 7 в `docs/OWNER-CHECKLIST-E2E.md`), потому что `create_booking` в прод-схеме
может существовать с ненулевой арностью и без `defaults` (тогда PostgREST и не
сможет её сматчить).

---

## 5. Что НЕ проверено (границы этого отчёта)

| Не проверено | Почему | Класс |
|---|---|---|
| `pg_proc`, overload-набор, гранты EXECUTE, RLS-политики в проде | нет SQL-канала/секретов владельца | UNKNOWN |
| Реальный вход по коду и по ссылке, письмо, reload, повторный вход | нет почтового ящика и задеплоенных функций | BLOCKED |
| Site URL / Redirect URLs, серверный срок сессии в GoTrue | Dashboard владельца | UNKNOWN |
| Фактический файл опубликованного клиента на Pages | TLS до `a1dmitry.github.io` из песочницы закрыт | UNKNOWN (INFERENCE: Pages публикует дерево репозитория того же SHA без сборки) |
| Инвентарь таблиц/функций из OpenAPI | Supabase закрывает `/rest/v1/` для anon (`OWNER_ONLY(service_role)`) | UNKNOWN |

---

## 6. Вердикт

- **Repo-контур (код, гейт, SQL-контракт на настоящем PostgreSQL): PASS.**
  5 из 5 мутаций покраснили соответствующие наборы, ни одна атака A–F/H на этом SHA
  не прошла, деплой гейтится (внешний канал).
- **Контур «честность гейта»: PASS со оговоркой** — два канала остаются открытыми
  и воспроизведены: silent-набор (#51) и `FAIL` с отступом (F2, новый).
- **Контур evidence прода: FAIL (F1)** — probe может отчитаться `drift 0`, ничего
  не измерив.
- **Production-контур (#46 TASK 2/4): BLOCKED** — `auth-code` не задеплоена,
  `create_booking` для `anon` недоступен. Это внешнее действие владельца, а не
  дефект репозитория.
- **Документация: FAIL (F3)** — `ISSUE-46-EVIDENCE.md`, `INFRA.md`,
  `CURRENT-STATE.md` описывали состояние прода до 05:14Z (исправлено в §8 этой же ветки).

**Из этого следует:** #46 **нельзя** закрывать (нет production E2E и независимой
SQL-верификации), #35 остаётся P1-блокером, #50 — актуален (F3 даёт ему точные
факты), #51 подтверждён на `d28ae94`, F1/F2/F4 требуют отдельных Issue (P2/P3).

**Статусы находок на конец цикла (§8):** F1 исправлен (+ #54, фикс в ветке),
F2 исправлен (#51), F3 исправлен (доки синхронизированы), F4 исправлен (workflow),
F5 — комментарий в `verify.yml`. Production-блокеры остаются внешними (Блок 9).

---

## 8. Что исправлено в этой же ветке (после аудита)

Аудит нашёл каналы — и они закрыты здесь же, с контролями (роль Challenger →
Producer в одном конвейере; независимую перепроверку всё равно должен сделать
следующий проверяющий, поэтому #51/#54 формально закрываются после merge+Re-Audit):

| Находка | Исправление | Контроль |
|---|---|---|
| **F1 / #54** — probe мог отчитаться `drift 0`, ничего не измерив | `summary.measured` / `unreachable` / `unreachable_items`; печатная сводка начинается с «измерено: N/26» и прямо говорит «прода НЕ измеряли»; `HTTP_0` в секции B → `NETWORK_ERROR`; шаг workflow «Verify the probe actually measured production» падает при `unreachable > 0` | `tests/prod-probe-report.mjs` (15 проверок): blackhole-прогон (0/26, 26 недоступных) + живой стенд (26/26) + печатная сводка + гейт workflow; контроль фальсификации — откат счётчика даёт 3 FAIL |
| **F2 / #51** — silent-набор и `FAIL` с отступом проходили зелёными | матчер `^\s*(FAIL\b|❌)`; правило «при exit 0 нужен ≥1 маркер проверки» с allowlist `verify_app` (`IMPORT OK`/`BOOT RAN`); в итог печатается число проверок по каждому набору; `harness-guard` перебирает и root/tools-наборы | `negative C` (silent → красный), `negative D` (FAIL с отступом → красный), `positive C` (честный мини-набор → зелёный), REDUCED-прогон помечается; сам guard использует реальную логику гейта через шов `VERIFY_EXTRA_SUITE` |
| **F4** — `supabase-deploy.yml` зелёный без деплоя | финальный шаг «Production reachability» (без секретов, выполняется всегда): `404`/нет сети → `::error::` + exit 1; job теперь зависит от `quality-gate` | проверка читается в `tests/prod-probe-report.mjs` (структура workflow); фактический красный/зелёный статус — на следующем прогоне workflow |
| **F3** — документация описывала прод до 05:14Z | `ISSUE-46-EVIDENCE.md` §2bis + §5/§6/§6.1, `docs/INFRA.md` п.2/4/5, `docs/CURRENT-STATE.md` (main SHA, прод-таблица, контуры, next actions) синхронизированы со срезом 05:53Z | факты §4 этого отчёта; повторный probe на PR верифицирует срез |
| Закрытие #46 | `docs/OWNER-CHECKLIST-E2E.md` Блок 9 — пошаговый путь «что осталось»: деплой функций, SQL по `create_booking` (+`notify pgrst, 'reload schema'`), URL/сессия, доказательства, закрытие | чек-лист §6.1 в `ISSUE-46-EVIDENCE.md` |

**Границы:** исправления проверены локально (гейт 25/25, 1180 проверок, exit 0;
`verify_pages.py` — ALL PASS) и внешне (Quality Gate + probe на PR #53). Красный
статус `supabase-deploy.yml` «по факту недоступности функций» наблюдается только
на следующем запуске этого workflow (push в `supabase/functions/**` или ручной
dispatch) — до этого момента это проверенная чтением структура, а не наблюдение.

---

## 7. Итог цикла — строго по 12 разделам `docs/RULES.md` §5

### 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Провести независимую Challenger-проверку (TASK 7 issue #46) и Main Re-Audit
актуального `main` после влитых PR #47/#48/#52: попытаться опровергнуть заявления
о безопасности/ownership/auth-контракте, честности гейта CI и состоянии прода;
зафиксировать класс `FACT`/`LIVE`/`INFERENCE`/`UNKNOWN`; не закрывать #46.

### 2. РЕЗУЛЬТАТ

Отчёт-заполненный кит A–I: repo-атаки не прошли (PASS), production-гейты
подтверждены как невыполнимые без владельца (BLOCKED); найдено 2 новых канала
ложного зелёного (F1 — probe, F2 — матчер гейта), 1 расхождение документации с
живым продом (F3), 2 замечания по CI (F4/F5). Все мутационные контроли ожидаемо
красные. Гейт и смоук на неизменённом `d28ae94`: 24/24 и ALL PASS.

### 3. ПРОВЕРКА

Локально: `node tools/verify_all.mjs` (24 набора, 1171 проверка, exit 0),
`verify_pages.py` (12 маршрутов, exit 0), 8 атак/мутаций в изолированной копии
дерева. Внешне: `gh api` по job'ам `pages.yml`, отчёты `prod-probe.yml`
(04:13Z…05:42Z), прогон `Quality Gate` на PR. Прод-факты — только внешним каналом;
SQL-инспекция не выполнялась (UNKNOWN).

### 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

Инварианты #40/#46 держатся и **реагируют на поломку**: реактивация отключённого
аккаунта, RLS-предикат `is_active_own_psychologist`, tenant isolation, дубль
профиля, server-derived money/status/duration и hold-expiry пойманы мутациями;
деплой Pages без гейта невозможен; все наборы зарегистрированы и не пусты.

### 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

Прод не работает по основному пути: Edge Functions не задеплоены,
`create_booking` для `anon` недоступен. Реальный E2E (код/ссылка) не проводился.
Probe-сводка не различает «измерено чисто» и «не измерено». Гейт слеп к `FAIL` с
отступом. Документация расходится с продом. `verify_app` не имеет PASS-маркеров
в форме, которую собирается требовать #51 (это надо учесть в фиксе).

### 6. ТУФТА НАЙДЕНА

- **Самосертификация** — не допущена: маркеры `АУДИТОР` расставлены, отчёт не
  объявляет прод проверенным.
- **Метрическая подгонка** — в моей же первой мутации: атака не достигала
  проверяемой ветки и давала «зелёное»; результат отброшен (§2.1).
- **Имитационная сложность** — нет: все выводы воспроизводимы командами.
- **Ложный зелёный** — найден в двух местах (F1, F2) и в CI-названии workflow
  «Deploy …» при отсутствии деплоя (F4).

### 7. КОРЕННЫЕ ПРИЧИНЫ

F1 — сводка считает только «плохие» вердикты и не считает «нет ответа», нет
инварианта «измерение состоялось» (5 Why: почему «0» можно прочитать как успех →
потому что нет счётчика недоступных зондов → почему его нет → метрика проектировалась
как список дрейфа, а не как отчёт о покрытии измерения). F2 — матчер по фиксированному
отступу и неиспользуемый счётчик `passed`; guard ограничен каталогом `tests/`.
F3 — цикл синхронизации документации не привязан к изменению прода (только к merge).

### 8. РЕМОНТ

Ремонт в этом цикле **не выполнялся** (роль Challenger): предложены минимальные
лечения в §3. Ремонт прод-блокеров — Блоки 1–2 `docs/OWNER-CHECKLIST-E2E.md`
(владелец). Ресинк документов — #50.

### 9. ОСТАВШИЕСЯ РИСКИ

Нет SQL-подтверждения сигнатуры/грантов `create_booking` → причина публичной
поломки остаётся `UNKNOWN` (три варианта). Нет проверки Site URL/Redirect →
ссылка из письма может уходить на неверный origin. Клиентская граница срока
сессии без серверной настройки ≠ серверная гарантия. `verify_app` без PASS-маркеров
— риск ложной красноты при внедрении DoD #51.

### 10. ДОКАЗАТЕЛЬСТВО

SHA `d28ae942d60cf3eecf2626aea84e30cd791abbff`; `git status --porcelain` пусто;
лог гейта (24/24, 1171 проверка, exit 0, 13.9 c); лог `verify_pages.py` (12 PASS,
ALL PASS, exit 0); логи мутаций M1b/M2/M3/A2/C/D/E (красные); blackhole-прогон
probe (`probes: 26, drift/missing: 0`, exit 0); `gh api` job'ы run 36099699228;
комментарии `prod-probe` (04:13Z…05:42Z) с `drift 12 → 10 → 4`; прогон
`Quality Gate` и `Production read-only probe` на PR этой ветки (Приложение 3).

### 11. ОКОНЧАТЕЛЬНЫЙ СТАТУС

**ЧАСТИЧНО ЗАВЕРШЕНО** — repo-контур и честность гейта проверены (с двумя новыми
находками), production-контур **BLOCKED — OWNER ACTION REQUIRED** (#35: деплой
функций; Блок 7: SQL-подтверждение `create_booking`; Блок 5: реальный E2E).

### 12. УВЕРЕННОСТЬ

Высокая для выводов, воспроизводимых на неизменённом дереве (гейт, мутации,
матчер, сводка probe, job-тайминги). Средняя для F3-следствий — они опираются на
внешний канал probe (verdict по кодам PostgREST), без SQL-сверки. Production-выводы
сознательно оставлены как BLOCKED/UNKNOWN: это не самовнушение, а отсутствие
канала, компенсированное явным указанием, что именно должен сделать владелец.

---

## Приложение 1 — проверки по наборам (SHA `d28ae94`, локальный прогон)

| Проверок | Набор |
|---:|---|
| 164 | Poka-Yoke тест-харнеса (`tests/harness-guard.mjs`) |
| 146 | Регистрация и вход специалиста (`tests/registration-flow.mjs`) |
| 108 | Кабинет: серии, условия, мини-кабинет, пояса (`tools/verify_cabinet.mjs`) |
| 87 | D1: Availability + Booking Policy Engine (`tests/availability-policy.mjs`) |
| 71 | OTP: одноразовость, TTL, лимит попыток (`tests/auth-code-edge.mjs`) |
| 57 | SQL-контракт `schema.sql` на настоящем PostgreSQL (`tests/db-contract.mjs`) |
| 57 | Telegram-уведомления (`verify_telegram.mjs`) |
| 55 | D1 recovery: parity-матрица client↔server |
| 48 | Воронка записи (wizard, слоты, пояса) |
| 46 | Доменные правила: пояс, календарь, длительность |
| 41 | D1: Booking Policy enforcement на настоящем PostgreSQL |
| 36 | Роутер (Hash History) |
| 30 | Security regression |
| 29 | Авторизация: каналы кода, сессия, write-through |
| 29 | Карточка специалиста из строк БД |
| 25 | D1 recovery: E2E записи |
| 24 | Загрузка SPA (`verify_app.mjs`) |
| 22 | Канонический маппер сессий |
| 21 | Сходимость схемы (перегрузки RPC, гранты, RLS) |
| 21 | UI входа: ожидание кода переживает перезагрузку |
| 20 | D1: кабинет политики |
| 17 | Синхронизация: деградация при частично применённой схеме |
| 12 | D1: перенос на каноническом engine (`suggestSlots`) |
| 5 | Сборка Tailwind покрывает все классы |

Итого: **24 набора, 1171 проверка**, наборов с нулём проверок — **нет**.

## Приложение 2 — воспроизведение

```bash
# 0. гейт и смоук на неизменённом дереве
git rev-parse HEAD && git status --porcelain        # d28ae94…, пусто
npm install --no-audit --no-fund
node tools/verify_all.mjs                            # 24/24, exit 0
python3 devserver.py 8765 & BASE_URL=http://127.0.0.1:8765 python3 verify_pages.py

# 1. изолированная копия для атак (рабочее дерево не меняется)
mkdir -p /tmp/audit/copy && git archive HEAD | tar -x -C /tmp/audit/copy
ln -s "$PWD/node_modules" /tmp/audit/copy/node_modules

# 2. falsification: доменный инвариант
sed -i 's/export const DEFAULT_DURATION_MIN = 60;/export const DEFAULT_DURATION_MIN = 45;/' \
  /tmp/audit/copy/js/domain/duration.js
(cd /tmp/audit/copy && node tools/verify_all.mjs)     # exit 1, 2 набора красных

# 3. silent-набор (#51)
printf "console.log('nothing to see here');\nprocess.exit(0);\n" > /tmp/audit/copy/tools/zz-silent.mjs
#   + регистрация в SUITES → (cd /tmp/audit/copy && node tools/verify_all.mjs) → exit 0  ← дефект

# 4. probe без сети: сменить SUPABASE_URL на недоступный адрес в копии
(cd /tmp/audit/copy && node tools/prod-probe/probe.mjs | tail -3)
#   probes: 26, drift/missing: 0     ← «0», хотя измерений не было
```

## Приложение 3 — внешние прогоны для этой ветки (2026-09-25)

PR этой ветки (#53) прошёл оба внешних канала (runner GitHub, вне песочницы):

- **Quality Gate** (run `36100424853`, job `verify` — 29 с, все шаги `success`):
  `Install dev dependencies` → `Run project gate (node tools/verify_all.mjs)` →
  `Smoke routes against a real devserver`. Внешнее подтверждение §1.2/§1.3 — гейт
  и смоук маршрутов выполнены не в песочнице исполнителя. После коммита `73b080f`
  (исправления §8) — повторный зелёный прогон: run `36101408185` (verify, 25 с).
- **Production read-only probe** (run `36100424783`, 05:53:11Z): `probes: 26,
  drift/missing: 4` — `auth-code`, `telegram-notify` → `NOT_DEPLOYED`,
  `create_booking` для anon → `DRIFT: rpc missing` (2 зонда). Совпадает с F3:
  состояние прода стабильно с 05:14Z, дрейф SR-004/D1 снят, блокерами остаются
  Edge Functions и доступность `create_booking` для роли `anon`. Повторно на
  `73b080f` — run `36101408192` (probe, 16 с), вывод тот же.
- Ветка аудитора: `arena/01a0d702-psihologist-cabinet` → PR #53.

**О истории ветки:** песочница пере-клонировала репозиторий между циклами, поэтому
история ветки была перестроена на `main @ d28ae94` одним коммитом `73b080f`
(содержимое — надмножество прежних `047e64d`/`4999295`: отчёт, Приложение 3 и
исправления §8). Ссылки на прежние SHA сохранены только как исторические записи
прогонов в PR-комментариях Actions.

---

*Сформировано 2026-09-25 в ветке `arena/01a0d702-psihologist-cabinet` на
`main @ d28ae94`. Issue #46 не закрывается: production-контур BLOCKED, требуется
независимый Main Re-Audit на новом SHA после устранения F1–F4 и действий владельца.*
