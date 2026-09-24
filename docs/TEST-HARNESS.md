# Стандарт тест-харнеса (Kaizen по D1-QG-004 / issue #33)

Почему этот документ существует: DB-наборы дважды маскировали провалы
под успех — сначала `async-exit-hook` форсил `exit(0)` поверх `exitCode=1`,
затем крэш основного потока пропускал хвост и давал тот же `exit(0)`.
Оба дефекта закрыты кодом + этот стандарт не даёт им вернуться.

## 1. Канонический скелет DB-набора

```js
import { startTestDatabaseOrExit, finishSuite } from '../tools/dbtest/index.mjs';

const db = await startTestDatabaseOrExit({ port: Number(process.env.DB_PORT || 554xx) });
try {
  // ...check()...
} catch (e) {
  results.push(['FATAL: suite crashed: ' + (e?.message || e), false]);
  console.error('FATAL:', e);
} finally {
  await db.stop();
}
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
await finishSuite(failed.length);
```

## 2. Запрещённые идиомы

- `process.exitCode = …` + естественный выход в DB-наборе (перехватит
  `beforeExit`-хук транзитивной зависимости и форсит 0);
- `setTimeout(…).unref?.()` как «завершение» (placebo, цикл не держит);
- `process.exitCode = failed ? …` где `failed` — массив (всегда truthy);
- стартовый `await startTestDatabase(…)` без `OrExit` (отказ/вис старта
  обязан быть красным выходом 2, а не молчанием).

## 3. Таймауты (защита от виса)

- `tools/dbtest`: `connectionTimeoutMillis: 15000`,
  `query_timeout`/`statement_timeout: 120000` — вис превращается
  в rejection → catch-fatal → красный выход.
- `tools/verify_all.mjs`: лимит на набор `VERIFY_SUITE_TIMEOUT_MS`
  (дефолт 300000) — зависший набор убивается (код 124) и краснеет,
  а не вешает гейт.

## 4. Автоматические стражи

- `tests/harness-guard.mjs` (часть `npm run verify`) статически требует:
  finishSuite в DB-наборах, отсутствие `.unref` и `= failed ?`,
  детерминированный выход каждого `tests/*.mjs`, регистрацию каждого
  набора в `verify_all.mjs`.

## 5. Приёмка нового DB-набора (обязательно)

1. Зелёный прогон (exit 0).
2. Негативный контроль: временная копия с инжектированным
   `results.push(['FORCED', false])` обязана выйти ненулевым кодом.
3. Негативный контроль крэша (для наборов со сложной логикой):
   копия с `throw` обязана дать FATAL + exit 1.

## 6. Владелец и критерий эффекта

- Владелец: сопровождающий проекта (каждый PR с DB-набором проверяет
  соответствие скелету; guard делает это автоматически).
- Критерий эффекта: любой красный DB-набор (FAIL-чек, крэш, отказ старта,
  вис) даёт ненулевой exit code; нарушение обнаруживается guard или
  негативным контролем приёмки, а не внешним аудитом.
