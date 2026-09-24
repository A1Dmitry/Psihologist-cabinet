#!/usr/bin/env node
/**
 * Poka-Yoke тест-харнеса (recovery PR32, D1-QG-004).
 *
 *   node tests/harness-guard.mjs
 *
 * Статические инварианты, не дающие вернуться маскировке провалов:
 *  1. DB-набор (импортирует startTestDatabase) завершается через
 *     `await finishSuite(` — иначе async-exit-hook форсит exit 0 (см.
 *     tools/dbtest/index.mjs) и FAILED выглядит как успех.
 *  2. Запрещён `.unref` в хвостах tests/ (placebo-контроль завершения).
 *  3. Запрещён хвост `process.exitCode = failed ? …` (массив всегда truthy).
 *  4. Каждый tests/*.mjs имеет детерминированный выход
 *     (`process.exit(` или `process.exitCode`).
 *  5. Каждый tests/*.mjs зарегистрирован в tools/verify_all.mjs —
 *     иначе тест существует, но гейт его не гоняет.
 *
 * Сам guard — обычный скрипт без БД: естественный выход + exitCode.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const testFiles = readdirSync(join(ROOT, 'tests')).filter(f => f.endsWith('.mjs')).sort();
check('guard: tests/ не пуст', testFiles.length > 0, String(testFiles.length));

const verifyAll = readFileSync(join(ROOT, 'tools/verify_all.mjs'), 'utf-8');

// Сам guard исключён из контент-правил 1–3: он содержит эти паттерны
// как строковые литералы. Правила 4–5 применяются и к нему самому.
const SELF = 'harness-guard.mjs';
for (const f of testFiles) {
  const src = readFileSync(join(ROOT, 'tests', f), 'utf-8');
  const isDb = f !== SELF && src.includes('startTestDatabase');
  if (isDb) {
    check(`${f}: DB-набор завершается через finishSuite`,
      src.includes('await finishSuite(')
        && src.includes('finishSuite')
        && src.includes('tools/dbtest'),
      'нет await finishSuite( / импорта');
    check(`${f}: нет .unref в хвосте`, !src.includes('.unref'), 'найден .unref');
  }
  if (f !== SELF) {
    check(`${f}: нет хвоста = failed ? (массив truthy)`,
      !/process\.exitCode\s*=\s*failed\s*\?/.test(src), 'найден = failed ?');
  }
  check(`${f}: детерминированный выход`,
    src.includes('process.exit(') || src.includes('process.exitCode'), 'нет process.exit(/exitCode');
  check(`${f}: зарегистрирован в verify_all`,
    verifyAll.includes(`tests/${f}`), 'нет в SUITES');
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exitCode = failed.length ? 1 : 0;
