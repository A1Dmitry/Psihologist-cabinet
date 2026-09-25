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
 *
 * Правила честности самого гейта (#36 — ложный зелёный, #51 — silent-набор):
 *  1. набор с exit 0 обязан предъявить ≥1 маркер проверки (`PASS`/`✅`) либо
 *     собственный маркер успеха из ALT_SUCCESS_MARKER — иначе красный;
 *  2. красные строки распознаются с ЛЮБЫМ отступом (`FAIL`, `  FAIL`, `   FAIL`);
 *  3. VERIFY_ONLY — только тестовый шов для негативных контролей guard'а;
 *     такой прогон помечается в выводе как REDUCED и не является полным гейтом.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  ['Доменные правила: пояс, календарь, длительность', 'node', ['tests/timezone-domain.mjs']],
  ['Канонический маппер сессий', 'node', ['tests/session-mapper.mjs']],
  ['D1: Availability + Booking Policy Engine (домен)', 'node', ['tests/availability-policy.mjs']],
  ['D1: перенос на каноническом engine (suggestSlots)', 'node', ['tests/suggest-slots.mjs']],
  ['D1: кабинет политики (overrides, лимиты, доступность услуги)', 'node', ['tests/cabinet-policy.mjs']],
  ['Воронка записи (wizard, слоты, пояса, server-first success)', 'node', ['tests/booking-wizard.mjs']],
  ['Демо-оплата: нет ложного «оплата прошла» при живом сервере (#21 п.4)', 'node', ['tests/demo-pay-honesty.mjs']],
  ['Синхронизация: деградация при частично применённой схеме (#46)', 'node', ['tests/sync-degradation.mjs']],
  ['Read-only probe: «не измерено» честно отличается от «drift 0» (#54)', 'node', ['tests/prod-probe-report.mjs']],
  ['Регистрация и вход специалиста (E2E-контракт)', 'node', ['tests/registration-flow.mjs']],
  ['OTP: одноразовость, TTL, лимит попыток (настоящий auth-code)', 'node', ['--no-warnings', 'tests/auth-code-edge.mjs']],
  ['SQL-контракт schema.sql на настоящем PostgreSQL', 'node', ['tests/db-contract.mjs']],
  ['Сходимость схемы: применение к «грязному» проду (перегрузки RPC, гранты, RLS)', 'node', ['tests/schema-convergence.mjs']],
  ['Security regression (booking authority, tenant isolation, domain validation)', 'node', ['tests/security-regression.mjs']],
  ['D1: Booking Policy enforcement на настоящем PostgreSQL', 'node', ['tests/availability-db.mjs']],
  ['D1 recovery: parity-матрица client↔server', 'node', ['tests/availability-parity.mjs']],
  ['D1 recovery: E2E записи (valid/blocked/unauthorized)', 'node', ['tests/booking-e2e.mjs']],
  ['Poka-Yoke тест-харнеса (детерминированные выходы)', 'node', ['tests/harness-guard.mjs']],
  ['Кабинет: серии, условия, мини-кабинет, пояса', 'node', ['tools/verify_cabinet.mjs']],
  ['Авторизация: каналы кода, сессия, write-through', 'node', ['verify_auth.mjs']],
  ['UI входа: ожидание кода переживает перезагрузку', 'node', ['tests/auth-ui-pending.mjs']],
  ['Карточка специалиста из строк БД', 'node', ['verify_profile.mjs']],
  ['Telegram-уведомления', 'node', ['verify_telegram.mjs']],
  ['Роутер (Hash History)', 'node', ['test_routing.mjs']],
  ['Сборка Tailwind покрывает все классы', 'node', ['tools/verify_tailwind.mjs']],
  ['Загрузка SPA', 'node', ['verify_app.mjs']]
];

// Poka-Yoke (recovery PR32): зависший набор не должен вешать весь гейт.
// Лимит щедрый (обычные наборы — секунды); превышение = красный набор.
const SUITE_TIMEOUT_MS = Number(process.env.VERIFY_SUITE_TIMEOUT_MS || 300000);

// Тестовый шов (по образцу VERIFY_APP_ENTRY): прогнать только указанные файлы
// наборов. Нужен tests/harness-guard.mjs, чтобы негативные контроли самого
// гейта (silent-набор, «FAIL с отступом») выполнялись за миллисекунды, а не
// прогоняли все 24 набора с шестью стартами PostgreSQL. Reduced-прогон явно
// помечается в выводе и не является полным гейтом.
const ONLY = (process.env.VERIFY_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
// Дополнительные наборы вне SUITES (абсолютные пути) — тот же шов для guard'а:
// позволяет прогнать через логику гейта временный набор из /tmp.
const EXTRA = (process.env.VERIFY_EXTRA_SUITE || '').split(',').map(s => s.trim()).filter(Boolean);
const SELECTED = ONLY.length
  ? SUITES.filter(([, , args]) => ONLY.includes(args[args.length - 1]))
  : (EXTRA.length ? [] : SUITES);
const TO_RUN = [
  ...SELECTED,
  ...EXTRA.map(p => [`VERIFY_EXTRA (${basename(p)})`, 'node', [p]])
];

// Наборы без PASS-маркеров обязаны предъявить собственный маркер успеха:
// verify_app печатает IMPORT OK / BOOT RAN. Без этой карты правило «≥1 проверка»
// (issue #51) дало бы ложную красноту на честном наборе.
const ALT_SUCCESS_MARKER = new Map([['verify_app.mjs', /(IMPORT OK|BOOT RAN)/]]);

function run(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (code) => { if (!done) { done = true; resolve({ code, out }); } };
    const timer = setTimeout(() => {
      out += `\nTIMEOUT: набор превысил ${SUITE_TIMEOUT_MS} мс и был убит\n`;
      child.kill('SIGKILL');
      finish(124);
    }, SUITE_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => { clearTimeout(timer); finish(code); });
    child.on('error', () => { clearTimeout(timer); finish(1); });
  });
}

if (ONLY.length || EXTRA.length) {
  const missing = ONLY.filter(o => !SELECTED.some(([, , a]) => a[a.length - 1] === o));
  if (missing.length) process.stdout.write(`\n⚠️  VERIFY_ONLY: не найдены наборы: ${missing.join(', ')}\n`);
  process.stdout.write('\n⚠️  REDUCED RUN (VERIFY_ONLY / VERIFY_EXTRA_SUITE) — это НЕ полный гейт и он непригоден для CI/деплоя.\n');
}

const report = [];
for (const [title, cmd, args] of TO_RUN) {
  process.stdout.write(`\n── ${title} (${args[0]})\n`);
  const { code, out } = await run(cmd, args);
  const lines = out.split('\n').filter(Boolean);
  // Маркеры проверок считаем с ЛЮБЫМ отступом: наборы печатают и `PASS` в
  // колонке 0, и `   PASS …` внутри своих секций.
  const checks = lines.filter(l => /^\s*(PASS\b|✅)/.test(l)).length;
  // Defence-in-depth (#36): exit 0 не должен зеленеть набор, который сам
  // напечатал FAIL / ❌ / BOOT|LOAD|IMPORT ERROR. Нельзя матчить голое
  // `ERROR:` — Postgres пишет `ERROR: permission denied` в ожидаемых RLS-пробах,
  // а PASS-строки guard содержат слово ERROR в названии проверки.
  //
  // Отступ — тоже любой: матчер по фиксированным двум пробелам пропускал
  // `FAIL` с отступом ≥3 при exit 0 (найдено Challenger'ом #46 на d28ae94).
  const failedLines = lines.filter(l =>
    /^\s*(FAIL\b|❌)/.test(l) ||
    /(^|\s)(BOOT ERROR|LOAD ERROR|IMPORT\/LINK ERROR):/.test(l)
  );
  const file = args[args.length - 1];
  const alt = ALT_SUCCESS_MARKER.get(basename(file));
  const proof = alt ? lines.some(l => alt.test(l)) : checks > 0;
  // «Ноль проверок при exit 0» — канал ложного зелёного (issue #51): набор,
  // который ничего не проверял, не должен засчитываться пройденным.
  const silent = code === 0 && failedLines.length === 0 && !proof;
  process.stdout.write(lines.map(l => '   ' + l).join('\n') + '\n');
  if (silent) {
    process.stdout.write('   ❌ набор не предъявил ни одной проверки (exit 0, 0 маркеров PASS/✅)\n');
  }
  report.push({
    title, file, checks, silent, altProof: !!alt,
    ok: code === 0 && failedLines.length === 0 && !silent,
    failedLines
  });
}

process.stdout.write('\n════════ ИТОГ ════════\n');
let bad = 0;
for (const r of report) {
  if (!r.ok) bad++;
  const why = [
    r.failedLines.length ? `${r.failedLines.length} провалов` : '',
    r.silent ? 'нет ни одной проверки (silent)' : ''
  ].filter(Boolean).join(', ');
  // У наборов без PASS-маркеров честно пишем, ЧЕМ подтверждён успех, а не «0 проверок».
  const count = r.checks === 0 && r.altProof
    ? 'подтверждён маркером IMPORT OK/BOOT RAN'
    : `проверок: ${r.checks}`;
  process.stdout.write(`${r.ok ? '✅' : '❌'} ${r.title} — ${r.file} (${count})${why ? ` (${why})` : ''}\n`);
}
const totalChecks = report.reduce((n, r) => n + r.checks, 0);
process.stdout.write(bad
  ? `\n${bad} набор(ов) упало; проверок предъявлено: ${totalChecks}\n`
  : `\nВсе наборы зелёные (${report.length}); проверок предъявлено: ${totalChecks}\n`);
process.exit(bad ? 1 : 0);
