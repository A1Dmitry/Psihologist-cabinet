#!/usr/bin/env node
/**
 * Единый прогон всех проверок проекта.
 *
 *   npm run verify
 *
 * Каждый скрипт запускается отдельным процессом: у них разные ожидания от
 * глобального окружения (fetch, DOM, localStorage), и в одном процессе они бы
 * мешали друг другу. Выход ненулевой, если упал хотя бы один набор.
 *
 * verify_pages.py (смоук маршрутов против живого devserver) сюда не входит —
 * ему нужен запущенный HTTP-сервер: python3 devserver.py 8765 &
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  ['Доменные правила: пояс, календарь, длительность', 'node', ['tests/timezone-domain.mjs']],
  ['Канонический маппер сессий', 'node', ['tests/session-mapper.mjs']],
  ['Воронка записи (wizard, слоты, пояса, server-first success)', 'node', ['tests/booking-wizard.mjs']],
  ['Регистрация и вход специалиста (E2E-контракт)', 'node', ['tests/registration-flow.mjs']],
  ['OTP: одноразовость, TTL, лимит попыток (настоящий auth-code)', 'node', ['--no-warnings', 'tests/auth-code-edge.mjs']],
  ['SQL-контракт schema.sql на настоящем PostgreSQL', 'node', ['tests/db-contract.mjs']],
  ['Кабинет: серии, условия, мини-кабинет, пояса', 'node', ['tools/verify_cabinet.mjs']],
  ['Авторизация: каналы кода, сессия, write-through', 'node', ['verify_auth.mjs']],
  ['Карточка специалиста из строк БД', 'node', ['verify_profile.mjs']],
  ['Telegram-уведомления', 'node', ['verify_telegram.mjs']],
  ['Роутер (Hash History)', 'node', ['test_routing.mjs']],
  ['Загрузка SPA', 'node', ['verify_app.mjs']]
];

function run(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
}

const report = [];
for (const [title, cmd, args] of SUITES) {
  process.stdout.write(`\n── ${title} (${args[0]})\n`);
  const { code, out } = await run(cmd, args);
  const lines = out.split('\n').filter(Boolean);
  const passed = lines.filter(l => /^(PASS|  ✅)/.test(l)).length;
  const failedLines = lines.filter(l => /^(FAIL|  ❌)/.test(l));
  process.stdout.write(lines.map(l => '   ' + l).join('\n') + '\n');
  const file = args[args.length - 1];
  report.push({ title, file, ok: code === 0, passed, failedLines });
}

process.stdout.write('\n════════ ИТОГ ════════\n');
let bad = 0;
for (const r of report) {
  if (!r.ok) bad++;
  process.stdout.write(`${r.ok ? '✅' : '❌'} ${r.title} — ${r.file}${r.failedLines.length ? ` (${r.failedLines.length} провалов)` : ''}\n`);
}
process.stdout.write(bad ? `\n${bad} набор(ов) упало\n` : `\nВсе наборы зелёные (${report.length})\n`);
process.exit(bad ? 1 : 0);
