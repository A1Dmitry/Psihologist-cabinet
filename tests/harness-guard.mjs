#!/usr/bin/env node
/**
 * Poka-Yoke тест-харнеса (recovery PR32, D1-QG-004, issue #36).
 *
 *   node tests/harness-guard.mjs
 *
 * Статические инварианты, не дающие вернуться маскировке провалов:
 *  1. DB-набор (импортирует startTestDatabase) завершается через
 *     `await finishSuite(` — иначе async-exit-hook форсит exit 0 (см.
 *     tools/dbtest/index.mjs) и FAILED выглядит как успех.
 *  2. Запрещён `.unref` в хвостах tests/ (placebo-контроль завершения).
 *  3. Запрещён хвост `process.exitCode = failed ? …` (массив всегда truthy).
 *  4. Каждый набор из SUITES (любой каталог) имеет детерминированный выход
 *     (`process.exit(` или `process.exitCode`).
 *  5. Каждый набор (tests/*.mjs, verify_*.mjs, test_*.mjs и tools/verify_*.mjs)
 *     зарегистрирован в tools/verify_all.mjs — иначе файл существует, но гейт
 *     его не гоняет (root/tools-наборы раньше не покрывались, см. #46 F2).
 *  6. Негативный контроль канала A: скелет finishSuite + stray async-крах
 *     обязан выйти ≠0 (пин против возврата «ALL PASS, exit 0»).
 *  7. Негативный контроль канала B: verify_app против битого модуля и
 *     против модуля, бросающего в boot, обязан выйти ≠0.
 *  8. Негативные контроли честности гейта (#51, #46 F2): silent-набор
 *     (0 проверок, exit 0) и набор с `FAIL` в отступе ≥3 обязаны красить
 *     REDUCED-прогон verify_all; честный мини-набор — обязан зеленеть.
 *
 * Сам guard — обычный скрипт без БД: естественный выход + exitCode.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const testFiles = readdirSync(join(ROOT, 'tests')).filter(f => f.endsWith('.mjs')).sort();
check('guard: tests/ не пуст', testFiles.length > 0, String(testFiles.length));

const verifyAll = readFileSync(join(ROOT, 'tools/verify_all.mjs'), 'utf-8');
const suitesStart = verifyAll.indexOf('const SUITES');
const suitesEnd = verifyAll.indexOf('];', suitesStart);
const suitesBlock = suitesStart >= 0 && suitesEnd > suitesStart
  ? verifyAll.slice(suitesStart, suitesEnd + 2)
  : '';
const suiteFiles = [...suitesBlock.matchAll(/'((?:tests|tools)\/[^']+\.mjs|verify_[^']+\.mjs|test_[^']+\.mjs)'/g)]
  .map(m => m[1]);
check('guard: SUITES разобраны', suiteFiles.length >= testFiles.length, String(suiteFiles.length));

// Наборы живут не только в tests/: root `verify_*.mjs` / `test_*.mjs` и
// tools/verify_*.mjs тоже запускаются гейтом. Раньше проверка регистрации
// смотрела только в tests/, и новый root-набор мог остаться незапущенным (#46 F2).
const rootSuites = readdirSync(ROOT)
  .filter(f => /^(verify_|test_)[^/]*\.mjs$/.test(f))
  .sort();
const toolSuites = readdirSync(join(ROOT, 'tools'))
  .filter(f => /^verify_.*\.mjs$/.test(f))
  // сам гейт не является набором: он их запускает
  .filter(f => f !== 'verify_all.mjs')
  .sort()
  .map(f => `tools/${f}`);
for (const f of [...rootSuites, ...toolSuites]) {
  check(`${f}: зарегистрирован в verify_all`,
    verifyAll.includes(`'${f}'`), 'нет в SUITES');
}

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

for (const rel of suiteFiles) {
  const abs = join(ROOT, rel);
  let src = '';
  try { src = readFileSync(abs, 'utf-8'); } catch { src = ''; }
  check(`${rel}: файл набора существует`, src.length > 0, abs);
  if (!src) continue;
  if (rel.endsWith('/' + SELF) || rel === 'tests/' + SELF) continue;
  check(`${rel}: детерминированный выход (SUITES)`,
    src.includes('process.exit(') || src.includes('process.exitCode'), 'нет process.exit(/exitCode');
  check(`${rel}: нет .unref`, !src.includes('.unref'), 'найден .unref');
  check(`${rel}: нет хвоста = failed ?`,
    !/process\.exitCode\s*=\s*failed\s*\?/.test(src), 'найден = failed ?');
}

check('verify_all: красный канал по FAIL/❌/BOOT-LOAD-IMPORT при exit 0',
  /failedLines\.length === 0/.test(verifyAll)
    && /BOOT ERROR/.test(verifyAll)
    && /LOAD ERROR/.test(verifyAll)
    && /IMPORT\\\/LINK ERROR/.test(verifyAll),
  'нет defence-in-depth в verify_all');
check('finishSuite учитывает process.exitCode',
  /process\.exitCode/.test(readFileSync(join(ROOT, 'tools/dbtest/index.mjs'), 'utf-8'))
    && /fromResults/.test(readFileSync(join(ROOT, 'tools/dbtest/index.mjs'), 'utf-8')),
  'finishSuite не смотрит exitCode');
check('verify_app: IMPORT/LINK ERROR выходит ≠0',
  /IMPORT\/LINK ERROR[\s\S]*process\.exit\(1\)/.test(readFileSync(join(ROOT, 'verify_app.mjs'), 'utf-8')),
  'нет process.exit(1) на импорте');
check('verify_app: BOOT ERROR выходит ≠0',
  /bootFailed[\s\S]*process\.exit\(1\)/.test(readFileSync(join(ROOT, 'verify_app.mjs'), 'utf-8')),
  'нет process.exit(1) на boot');

function runNode(file, extraEnv = {}, timeout = 20000) {
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const tmp = mkdtempSync(join(tmpdir(), 'harness-36-'));
try {
  const finishUrl = pathToFileURL(join(ROOT, 'tools/dbtest/index.mjs')).href;
  const strayPath = join(tmp, 'stray-crash.mjs');
  writeFileSync(strayPath, `import { finishSuite } from ${JSON.stringify(finishUrl)};
process.on('uncaughtException', (e) => { console.error(e); process.exitCode = 1; });
process.on('unhandledRejection', (e) => { console.error(e); process.exitCode = 1; });
console.log('ALL PASS');
process.nextTick(() => { throw new Error('STRAY CRASH'); });
await new Promise(r => setTimeout(r, 30));
await finishSuite(0);
`);
  const stray = runNode(strayPath, {}, 30000);
  check('negative A: stray async-крах + finishSuite(0) → exit ≠ 0',
    stray.code !== 0 && /STRAY CRASH/.test(stray.out) && !/Cannot find package/.test(stray.out),
    `exit=${stray.code} out=${stray.out.slice(0, 240).replace(/\s+/g, ' ')}`);

  const brokenMod = join(tmp, 'broken-import.mjs');
  writeFileSync(brokenMod, 'throw new Error("PRODUCT BROKEN AT IMPORT");\n');
  const broken = runNode(join(ROOT, 'verify_app.mjs'), {
    VERIFY_APP_ENTRY: pathToFileURL(brokenMod).href
  });
  check('negative B: verify_app битый импорт → exit ≠ 0',
    broken.code !== 0 && /IMPORT\/LINK ERROR/.test(broken.out),
    `exit=${broken.code} out=${broken.out.slice(0, 240).replace(/\s+/g, ' ')}`);

  const bootMod = join(tmp, 'broken-boot.mjs');
  writeFileSync(bootMod, `document.addEventListener('DOMContentLoaded', () => { throw new Error('BOOT BROKEN'); });\n`);
  const boot = runNode(join(ROOT, 'verify_app.mjs'), {
    VERIFY_APP_ENTRY: pathToFileURL(bootMod).href
  });
  check('negative B: verify_app BOOT ERROR → exit ≠ 0',
    boot.code !== 0 && /BOOT ERROR/.test(boot.out),
    `exit=${boot.code} out=${boot.out.slice(0, 240).replace(/\s+/g, ' ')}`);

  /* ── Честность самого гейта: silent-набор и FAIL с отступом (#51, #46 F2) ──
   * Прогоняем временные наборы через РЕАЛЬНУЮ логику tools/verify_all.mjs
   * (шов VERIFY_EXTRA_SUITE): судит тот же код, что судит CI. */
  const runGateWith = (file) => runNode(join(ROOT, 'tools/verify_all.mjs'),
    { VERIFY_EXTRA_SUITE: file }, 60000);

  const silentSuite = join(tmp, 'guard-silent.mjs');
  writeFileSync(silentSuite, 'console.log("nothing to see here");\nprocess.exit(0);\n');
  const silentRun = runGateWith(silentSuite);
  check('negative C: silent-набор (0 проверок, exit 0) красит гейт (#51)',
    silentRun.code !== 0 && /не предъявил ни одной проверки/.test(silentRun.out),
    `exit=${silentRun.code} out=${silentRun.out.slice(-260).replace(/\s+/g, ' ')}`);
  check('negative C: REDUCED-прогон помечен — его нельзя выдать за полный гейт',
    /REDUCED RUN/.test(silentRun.out), silentRun.out.slice(0, 160).replace(/\s+/g, ' '));

  const indentedFail = join(tmp, 'guard-indented-fail.mjs');
  writeFileSync(indentedFail,
    'console.log("   FAIL  поддельный провал с отступом");\nconsole.log("PASS  честная проверка рядом");\nprocess.exit(0);\n');
  const indentedRun = runGateWith(indentedFail);
  check('negative D: FAIL с отступом ≥3 при exit 0 красит гейт (#46 F2)',
    indentedRun.code !== 0 && /1 провалов/.test(indentedRun.out),
    `exit=${indentedRun.code} out=${indentedRun.out.slice(-260).replace(/\s+/g, ' ')}`);

  const honestSuite = join(tmp, 'guard-honest.mjs');
  writeFileSync(honestSuite, 'console.log("PASS  единственная честная проверка");\nprocess.exit(0);\n');
  const honestRun = runGateWith(honestSuite);
  check('positive C: честный мини-набор (1 проверка) гейт считает зелёным',
    honestRun.code === 0 && /проверок предъявлено: 1/.test(honestRun.out),
    `exit=${honestRun.code} out=${honestRun.out.slice(-220).replace(/\s+/g, ' ')}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exitCode = failed.length ? 1 : 0;
process.exit(failed.length ? 1 : 0);
