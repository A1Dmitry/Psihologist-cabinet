#!/usr/bin/env node
/**
 * Честность сводки read-only probe (issue #54, найдено Challenger'ом #46).
 *
 *   node tests/prod-probe-report.mjs
 *
 * Дефект, который здесь запинен: `tools/prod-probe/probe.mjs` считал только
 * «плохие» вердикты (DRIFT / NOT_DEPLOYED / LEAK). При полностью недоступной
 * сети он печатал `probes: 27, drift/missing: 0` и выходил с 0 — то есть
 * «измерения не было» было неотличимо от «прод чист». Второй канал того же
 * дефекта: два зонда секции B печатали `HTTP_0` вместо `NETWORK_ERROR`.
 *
 * Проверяется поведение РЕАЛЬНОГО probe.mjs как чёрного ящика (шов
 * PROD_PROBE_URL — документирован в шапке инструмента):
 *   1. недоступный адрес → измерено 0/27, недоступно 27, явное предупреждение;
 *   2. живой локальный стенд → измерено 27/27, недоступно 0, без предупреждений;
 *   3. сводка workflow (`unreachable > 0` → красный) построена на этом счётчике.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(ROOT, 'tools/prod-probe/probe.mjs');

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const runProbe = (url) => {
  const r = spawnSync(process.execPath, [PROBE, '--json'], {
    cwd: ROOT,
    env: { ...process.env, PROD_PROBE_URL: url },
    encoding: 'utf8',
    timeout: 60000
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* ниже проверим */ }
  return { code: r.status, json, out: `${r.stdout || ''}${r.stderr || ''}` };
};

/* ── 1. Негативный контроль: недоступный адрес (порт закрыт) ─────────────── */
const blackhole = runProbe('http://127.0.0.1:9');
check('probe без сети: инструмент не падает', blackhole.code === 0, `exit=${blackhole.code}`);
check('probe без сети: JSON-отчёт получен', !!blackhole.json, blackhole.out.slice(0, 160));
if (blackhole.json) {
  const s = blackhole.json.summary;
  check('probe без сети: probes = 27', s.probes === 27, String(s.probes));
  check('probe без сети: измерено 0', s.measured === 0, JSON.stringify({ measured: s.measured }));
  check('probe без сети: недоступно 27', s.unreachable === 27, String(s.unreachable));
  check('probe без сети: недоступные зонды перечислены', Array.isArray(s.unreachable_items)
    && s.unreachable_items.length === 27, String(s.unreachable_items?.length));
  // главный инвариант: «0» в drift при нуле измерений — это отсутствие evidence
  check('probe без сети: drift_or_missing сам по себе НЕ доказательство (0 при 27 недоступных)',
    s.drift_or_missing === 0 && s.unreachable === s.probes,
    JSON.stringify({ drift: s.drift_or_missing, unreachable: s.unreachable }));
  check('probe без сети: HTTP_0 больше не подменяет NETWORK_ERROR (секция B)',
    blackhole.json.results.filter(r => r.status === 0).every(r => r.verdict === 'NETWORK_ERROR'),
    JSON.stringify(blackhole.json.results.filter(r => r.status === 0).map(r => r.verdict).slice(0, 4)));
}

/* ── 2. Положительный контроль: живой локальный стенд ──────────────────────
 * Стенд — ОТДЕЛЬНЫМ процессом: `spawnSync` блокирует event loop, и сервер
 * в этом же процессе не смог бы принять соединение (первая версия теста
 * именно на этом и повисла — 60 с таймаута, exit=null). */
const stubCode = `
import { createServer } from 'node:http';
const s = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('[]');
});
s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));
`;
const stub = spawn(process.execPath, ['--input-type=module', '-e', stubCode], {
  stdio: ['ignore', 'pipe', 'pipe']
});
const stubPort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('стенд не поднялся за 10 с')), 10000);
  stub.stdout.on('data', d => {
    const m = /PORT (\d+)/.exec(String(d));
    if (m) { clearTimeout(timer); resolve(Number(m[1])); }
  });
  stub.on('exit', () => { clearTimeout(timer); reject(new Error('стенд завершился')); });
}).catch(e => { check('положительный контроль: стенд поднялся', false, String(e.message || e)); return null; });
const live = stubPort ? runProbe(`http://127.0.0.1:${stubPort}`) : { code: null };
stub.kill();

check('probe на живом стенде: exit 0', live.code === 0, `exit=${live.code}`);
if (live.json) {
  const s = live.json.summary;
  check('probe на живом стенде: измерено 27/27', s.measured === 27 && s.unreachable === 0,
    JSON.stringify({ measured: s.measured, unreachable: s.unreachable }));
  check('probe на живом стенде: недоступных нет — предупреждения не будет',
    s.unreachable === 0 && s.unreachable_items.length === 0);
}

/* ── 3. Сводка для человека: явный текст вместо тихого «0» ───────────────── */
const human = spawnSync(process.execPath, [PROBE], {
  cwd: ROOT,
  env: { ...process.env, PROD_PROBE_URL: 'http://127.0.0.1:9' },
  encoding: 'utf8',
  timeout: 60000
});
check('печатная сводка: есть покрытие измерения (измерено: 0/27)',
  /измерено: 0\/27/.test(human.stdout || ''), (human.stdout || '').slice(-200).replace(/\s+/g, ' '));
check('печатная сводка: сказано прямо, что прода не измеряли',
  /не измеряли/i.test(human.stdout || ''), (human.stdout || '').slice(-200).replace(/\s+/g, ' '));

/* ── 4. Workflow обязан краснеть при нуле измерений (#54 DoD) ───────────── */
const wf = readFileSync(join(ROOT, '.github/workflows/prod-probe.yml'), 'utf-8');
check('workflow: шаг проверяет unreachable и падает при > 0',
  /unreachable/.test(wf) && /process\.exit\(1\)/.test(wf),
  'нет гейта на unreachable');
check('workflow: шаг читает именно сохранённый JSON-отчёт',
  /prod-probe-report\.json/.test(wf) && /--json/.test(wf));

/* ── 5. Preflight-зонд: три состояния, неотличимые в консоли браузера ───────
 * Дефект, который здесь запинен: «blocked by CORS policy … It does not have
 * HTTP ok status» в консоли НЕ содержит статуса и заголовков, поэтому
 * «функция не задеплоена» (gateway 404 без CORS), «verify_jwt=true»
 * (401 без CORS) и «2xx без CORS-заголовков» выглядят одинаково. Зонд обязан
 * различать все три — иначе он не доказательство, а декорация. */
const stubModes = {
  // Задеплоенная функция: OPTIONS → 200 + CORS (как auth-code/index.ts).
  deployed: `import { createServer } from 'node:http';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
createServer((req, res) => {
  if (req.url.startsWith('/functions/v1/auth-code') && req.method === 'OPTIONS') {
    res.writeHead(200, CORS); return res.end('ok');
  }
  if (req.url.startsWith('/functions/v1/')) { res.writeHead(405, CORS); return res.end('{}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
}).listen(0, '127.0.0.1', () => console.log('PORT ' + 0));`,
  // Не задеплоена: gateway 404 NOT_FOUND без единого CORS-заголовка.
  notDeployed: `import { createServer } from 'node:http';
createServer((req, res) => {
  if (req.url.startsWith('/functions/v1/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Requested function was not found' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
}).listen(0, '127.0.0.1', () => console.log('PORT ' + 0));`,
  // Задеплоена, но JWT-gateway включён: 401 без CORS-заголовков.
  jwtGate: `import { createServer } from 'node:http';
createServer((req, res) => {
  if (req.url.startsWith('/functions/v1/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Invalid JWT' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
}).listen(0, '127.0.0.1', () => console.log('PORT ' + 0));`
};


// Порт выбирает ОС (listen(0)); просим стенд напечатать свой фактический порт.
for (const mode of ['deployed', 'notDeployed', 'jwtGate']) {
  const fixed = stubModes[mode]
    .replace('createServer((req, res) => {', 'const s = createServer((req, res) => {')
    .replace("console.log('PORT ' + 0)", "console.log('PORT ' + s.address().port)");
  const child = spawn(process.execPath, ['--input-type=module', '-e', fixed], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`стенд ${mode} не поднялся`)), 10000);
    child.stdout.on('data', d => {
      const m = /PORT (\d+)/.exec(String(d));
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`стенд ${mode} завершился`)); });
  }).catch(e => { check(`preflight (${mode}): стенд поднялся`, false, String(e.message || e)); return null; });
  if (!port) continue;
  const r = runProbe(`http://127.0.0.1:${port}`);
  child.kill();
  const pre = r.json?.results.find(x => String(x.name).includes('OPTIONS preflight'));
  check(`preflight (${mode}): зонд существует и измерен`, !!pre && Number(pre.status) !== 0,
    r.out.slice(0, 200));
  if (!pre) continue;
  if (mode === 'deployed') {
    check('preflight (deployed): 200 + CORS → PREFLIGHT_OK', pre.verdict === 'PREFLIGHT_OK', pre.verdict);
    check('preflight (deployed): в отчёте есть allow-origin/methods',
      /allow-origin=\*/.test(pre.detail) && /allow-methods=POST, OPTIONS/.test(pre.detail), pre.detail);
    check('preflight (deployed): не попадает в drift',
      !(r.json.summary.drift_items || []).some(x => x.includes('OPTIONS preflight')),
      JSON.stringify(r.json.summary.drift_items));
  } else {
    const want = mode === 'notDeployed' ? 'NOT_DEPLOYED' : /PREFLIGHT_BLOCKED\(HTTP 401/.test(pre.verdict) && pre.verdict;
    check(`preflight (${mode}): ${mode === 'notDeployed' ? 'gateway 404' : 'JWT-gateway 401'} различим`, pre.verdict === want, pre.verdict);
    check(`preflight (${mode}): статус ответа сохранён (браузер его не показывает)`,
      (mode === 'notDeployed' && pre.status === 404)
      || (mode === 'jwtGate' && pre.status === 401 && /allow-origin=—/.test(pre.detail)),
      `status=${pre.status} · ${pre.detail}`);
    check(`preflight (${mode}): помечен как drift/missing`,
      (r.json.summary.drift_items || []).some(x => x.includes('OPTIONS preflight')),
      JSON.stringify(r.json.summary.drift_items));
  }
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
