# MAIN-AUDIT #63 (B) — Main Re-Audit после merge PR #104

> **АУДИТОР: САМ** — repo-level Main Re-Audit после merge в `main` (исполнитель
> `EXEC-rzVmS30TVl`, тот же, что автор правок: независимого Challenger по §6.6
> нет — зафиксированное ограничение, не скрытое допущение).
> **АУДИТОР: ВНЕШНИЙ** — GitHub Actions: job `quality-gate/verify` и job `deploy`
> (включая шаг `Smoke check deployed site (verify_pages.py)` против живого Pages-URL)
> на run `36262508423`, 2026-09-26T18:25:48Z; и `Production read-only probe`
> на SHA `b110abb` (run 36262188613, 27/27 измерено, недоступно 0).
> **Дата:** 2026-09-26 UTC. **Окружение:** node v22.22.3, python 3.11.2,
> embedded-postgres PG 18.4; egress из песочницы до `*.supabase.co` и до
> `a1dmitry.github.io` закрыт (curl → 000) — живой сайт напрямую не открывался,
> факт деплоя подтверждён внешним CI-шагом, а не моим curl.

- **Merge:** PR #104 → `main @ f087642b7cea347eeab1cd17a7a9dfbf20467cc6`
  (2026-09-26T18:25:29Z). PR перед merge: `MERGEABLE / CLEAN`, checks
  `verify` SUCCESS, `probe` SUCCESS на head `b110abb`.
- **Метод:** `git archive origin/main@f087642` → пристальный снимок `/tmp/maudit-63b`
  (без файлов рабочей ветки) → `npm install` → `npm run verify` → `devserver.py 8766`
  → `BASE_URL=http://127.0.0.1:8766 python3 verify_pages.py` (сервер остановлен после смоука).

## Присутствие фиксов в merged-дереве (чтение из `origin/main`, не из своей ветки)

| Факт | Значение |
|---|---|
| `git show origin/main:css/tailwind.src.css` → `.cab-menu { z-index: 45 }` | 45 (было 30) |
| `git show origin/main:css/tailwind.css` (сборка) → `.cab-menu{…z-index:45…}` | 45 — src и артефакт синхронны |
| `git show origin/main:js/views/cabinetMobile.js` → инвариант «любой тап… закрывает панели» | присутствует (1) |
| постороннее имя в комментарии контроллера (`Dermansky`) | 0 вхождений |

## Прогон на снимке merged main

- **Полный гейт:** `GATE_EXIT=0`, **40/40 наборов, 1809 проверок** (0 падений).
- **Смоук маршрутов:** `verify_pages.py` против живого devserver снимка (порт 8766) —
  **ALL PASS 13/13** (`/`, `/index.html`, `/js/app.js`, `/js/core/dbContext.js`,
  `/css/tailwind.css`, `/psy/<slug>`, `/book/<slug>`, `/cabinet`, `/auth`,
  `/onboarding`, `/booking-done`, `/reply`, битый ассет → 404).
- **CSS, отдаваемый сервером снимка:** `.cab-menu z-index = 45` (curl по живому devserver).

## Внешний контур (деплой)

- `Deploy to GitHub Pages` на `f087642` — **completed/success**; шаги job `deploy`:
  `Rebuild Tailwind CSS` → success (деплой пересобирает стили из `css/tailwind.src.css`
  тем же `tailwindcss@3.4.17`, поэтому в прод ушёл `z-index:45`),
  `Build site`, `Generate sitemap.xml + robots.txt`, `Configure GitHub Pages`,
  `Upload site artifact`, `Deploy to GitHub Pages`,
  **`Smoke check deployed site (verify_pages.py)` → success** (смоук живого сайта
  внешним раннером); job `quality-gate/verify` — все шаги success
  (`Run project gate`, `Smoke routes against a real devserver`).
- `Production read-only probe` (PR-контур, SHA `b110abb`) — SUCCESS: 27/27 измерено,
  недоступно 0; drift 3 — `auth-code` REVIVED_RETIRED_PATH и `create_booking`
  missing ×2. **К #63 отношения не имеет** (контуры #35/#40/#46, schema/Edge),
  новых drift-элементов после presentation-правок не появилось.

## Остаток по Issue #63

1. **Прогон мобильной раскладки владельцем на устройстве** — граница Issue
   («в песочнице эмулятора нет — честно фиксировать, что мобильный рендер
   владельцем не подтверждён»): в песочнице нет ни эмулятора, ни headless-браузера
   (apt/CDN Playwright/Puppeteer → 000), попиксельная геометрия не измерялась.
2. **Независимый Challenger (§6.6)** правок этой сессии — не выполнен
   (автор правок не может быть своим Challenger-ом); QA-прогон
   (`docs/ISSUE-63-REAUDIT.md`, раздел «QA-ПРОГОН»: независимый харнес 29/29,
   мутационная матрица 4/4, реконструкция baseline) — самоаудит, маркер `АУДИТОР: САМ`.
3. **CLAIM/evidence-комментарий в Issue #63** не публикуется: у интеграции нет
   `issues:write` (`Resource not accessible by integration`) — владение видно по
   карточке `.claims/issue-63.EXEC-rzVmS30TVl.json` и по PR #104.

## Вердикт

Main Re-Audit #63 (B) на `f087642` — **PASS** (repo-часть + деплой-контур):
фиксы присутствуют в merged-дереве, гейт 40/40 (1809) и смоук 13/13 зелёные
на пристальном снимке, внешний CI подтвердил деплой и смоук живого сайта.
Статус Issue #63 до подтверждения рендера владельцем и независимого Challenger —
**ЧАСТИЧНО ЗАВЕРШЕНО**; merge сам по себе DONE не означает (§6.7).
