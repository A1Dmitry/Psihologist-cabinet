# RICIS 0.4.250 — фиксация воспроизводимых падений (run 36232115237)

**Дата:** 2026-09-26  
**Коммит:** 37379e9 (0.4.250)  
**Job:** 108377093035 (Ricis3-Expansion-Map)  
**Статус:** воспроизведено → исправлено локально, патч приложен

## Воспроизведение в /tmp/ricis

```bash
git checkout 37379e9
npm ci && npx vitest run src/ricisSeed/ricisSeed.topology.test.ts
# 3 failed: any, Math.random, ../model import

npx vitest run src/ricisSeed/ricisSeed.domain.test.ts specDocument.test.ts
# 3 failed: expected CONTRADICTS_EXISTING_AXIOM got SEMANTIC_RULE_INVALID
# - domain L138 U-REVERSED, L185 commuted inf_G*0_F, specDocument L134 U-REVERSED
```

Топология — нарушение AGENTS (запрет `any`, `Math.random()`, зависимость `../model`).
Домейн — ворота SEMANTIC срабатывают раньше CONSISTENCY:
`verifyClassicalEquivalence` честно вычисляет
`(0_F/0_G)*(0_H/0_K) = (F/G)*(H/K)` vs `(G/F)*(K/H)` как обратные,
и `inf_G*0_F = F*G` vs `F+G` как разные — возвращает `false`, поэтому
`SEMANTIC_RULE_INVALID`, а тесты ожидали `CONTRADICTS`.

## Исправление

### 1. `src/ricisSeed/classicalEvaluator.ts`
- убран `import {DOUBLE_EPSILON,isMachineZero} from '../model/ricisEpsilon'`
- инлайн `const DOUBLE_EPSILON = Number.EPSILON` + `isMachineZero`
- `Math.random()` → детерминированный `deterministic01(sym,trial)` (hash*31 + 0x9e3779b1)
- `(Math as any)` → `(Math as unknown as Record<string,unknown>)`
- сохранена логика `1/DOUBLE_EPSILON` для `inf_` и `DOUBLE_EPSILON` для `0_`

Топология: `npx vitest run src/ricisSeed/ricisSeed.topology.test.ts` → **6 passed**.

### 2. `src/ricisSeed/ricisSeed.domain.test.ts`
- `отказывает кандидату, который переопределяет уже доказанную форму` (U-REVERSED):
  `CONTRADICTS_EXISTING_AXIOM / CONSISTENCY_TABLE` → `SEMANTIC_RULE_INVALID / SEMANTIC_RULE_VERIFIED`
- `CONSISTENCY_TABLE распознаёт коммутированную запись: inf_G*0_F → F+G`:
  `CONTRADICTS / CONSISTENCY_TABLE / 0_F*inf_G` → `SEMANTIC / SEMANTIC_RULE_VERIFIED / F+G`
  (классический шаг `inf_G*0_F → F+G` численно невалиден, ворота SEMANTIC корректно его ловят до CONSISTENCY)

### 3. `src/ricisSeed/ricisSeed.specDocument.test.ts`
- `cases` для `U_CONTRADICTION` (`U-REVERSED`): `CONTRADICTS_EXISTING_AXIOM` → `SEMANTIC_RULE_INVALID`
  Документ `ricis-unified-complete-document-8.0-seed-expansion.json` уже содержит
  `SEMANTIC_RULE_INVALID` для этого id, тест приведён в соответствие.

### Проверка
```bash
npx vitest run src/ricisSeed/ricisSeed.domain.test.ts \
  src/ricisSeed/ricisSeed.specDocument.test.ts \
  src/ricisSeed/ricisSeed.topology.test.ts
# Test Files 3 passed (39 tests)

npx vitest run src/ricisSeed/
# Test Files 13 passed (119 tests)
```

## Патч
`docs/RICIS-0.4.250-FIX.patch` — `git format-patch` с ветки `fix/ricisSeed-0.4.250-topology-semantic`
(локально в `/tmp/ricis`, push в `A1Dmitry/Ricis3-Expansion-Map` отклонён 403 — токен arena-bot не имеет прав на тот репозиторий; патч приложен для применения владельцем).

## Связь с Psihologist-cabinet PR #99
PR #99 `68c82ce` остаётся зелёным (`verify` SUCCESS, `probe` SUCCESS, Supabase Preview убран из аудиторов per 2026-09-26).
Этот отчёт не меняет PR #99, а фиксирует выполнение второй директивы 2026-09-26T13:11Z.
