#!/usr/bin/env node
/**
 * Защита от утечки секретов в клиентские файлы (production-требование Supabase:
 * «Set your Supabase credentials as environment variables on whatever platform
 * you deploy to, rather than committing them to source control» —
 * https://supabase.com/docs/guides/getting-started/quickstarts/nextjs).
 *
 * Архитектура проекта — статический SPA на GitHub Pages: сервера, который мог бы
 * держать секреты, нет и быть не может, поэтому в браузер уходит РОВНО один
 * ключ — publishable/anon key. Он публичен by design и секретом не является.
 * Всё остальное (service_role, Resend, токен бота) живёт только в секретах
 * Edge Functions и читается через Deno.env — в клиентский бандл попадать не должно.
 *
 * Дефект, который здесь запинен: `service_role` key в клиентском файле = полный
 * обход RLS и полный доступ ко всем данным клиентов (P0 по docs/RULES.md §6.10).
 * Ручь «вставил не тот ключ из Dashboard» — типовая ошибка: в панели Supabase
 * `anon public` и `service_role` лежат рядом, отличаются одной подписью JWT.
 *
 * Что проверяется:
 *   A. в клиентских файлах (index.html, js/**, css/**) нет service_role-JWT,
 *      Resend-ключа, sb_secret_* и присваивания SUPABASE_SERVICE_ROLE_KEY;
 *   B. единственный ключ в supabaseConfig.js — именно anon/publishable:
 *      его JWT-payload имеет role=anon и ref того же проекта, что SUPABASE_URL;
 *   C. ключ не просрочен (иначе прода падает 401 — и preflight выглядел бы
 *      как CORS-ошибка, см. docs/INFRA.md).
 *
 * Запуск: node tests/no-committed-secrets.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const ok = (name, fn) => {
  try { fn(); passed += 1; console.log(`   PASS ${name}`); }
  catch (e) { failed += 1; console.log(`   FAIL ${name}\n        ${e.message}`); }
};
const truthy = (v, m) => { if (!v) throw new Error(m || 'ожидалось истинное значение'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'неравенство'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

/** Файлы, которые реально отдаются браузеру (плюс шаблоны сборки). */
function walk(dir, out = [], ext = /\.(js|mjs|css|html)$/) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out, ext);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}
const CLIENT_FILES = [
  join(ROOT, 'index.html'),
  ...walk(join(ROOT, 'js')),
  ...walk(join(ROOT, 'css'))
];
truthy(CLIENT_FILES.length >= 10, `сканер нашёл только ${CLIENT_FILES.length} клиентских файлов — он сломан`);

const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => p.slice(ROOT.length + 1);

/* ── A. Никаких секретов в клиентских файлах ────────────────────────────── */
const SECRET_PATTERNS = [
  ['Resend API key', /\bre_[A-Za-z0-9_]{16,}\b/],
  ['Supabase secret key (sb_secret_)', /\bsb_secret_[A-Za-z0-9_-]{8,}\b/],
  ['присваивание SUPABASE_SERVICE_ROLE_KEY', /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"][^'"]{8,}['"]/],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['service_role в открытом виде (JSON/текст)', /["']role["']\s*:\s*["']service_role["']/]
];

/**
 * JWT в клиентских файлах. Нельзя искать литерал `service_role`: payload в JWT
 * закодирован в base64url (`"role":"service_role"` → `InJvbGUiOiJzZXJ2aWNlX3JvbGUi`),
 * поэтому grep по подстроке не найдёт НИЧЕГО — включая настоящий service_role.
 * Первая версия этого теста содержала exactly эту дыру: falsification-контроль
 * (подмена anon → service_role) прошёл зелёным. Правильный способ — декодировать.
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch { return null; }
}

ok('сканер клиентских файлов нашёл бандл (>=10 файлов)', () => {
  truthy(CLIENT_FILES.length >= 10, String(CLIENT_FILES.length));
});

for (const [label, re] of SECRET_PATTERNS) {
  ok(`в клиентских файлах нет: ${label}`, () => {
    const hits = CLIENT_FILES.filter(f => re.test(read(f))).map(rel);
    truthy(hits.length === 0, `найдено в ${hits.join(', ')} — секрет уйдёт в публичный бандл (P0)`);
  });
}

// подпись не ограничиваем по длине: роль лежит в payload, а не в подписи,
// и обрезанный/подделанный токен должен находиться так же надёжно.
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
ok('в клиентских файлах нет JWT с role=service_role (проверка ДЕКОДИРОВАНИЕМ)', () => {
  const bad = [];
  for (const f of CLIENT_FILES) {
    for (const m of read(f).matchAll(JWT_RE)) {
      const p = decodeJwtPayload(m[0]);
      if (p?.role && p.role !== 'anon' && p.role !== 'authenticated') {
        bad.push(`${rel(f)} → role=${p.role}`);
      }
    }
  }
  truthy(bad.length === 0, `в публичный бандл уходят серверные JWT: ${bad.join('; ')} (P0, §6.10)`);
});

/* ── B. Единственный ключ — publishable/anon, того же проекта ───────────── */
const CONFIG = join(ROOT, 'js/services/supabaseConfig.js');
const cfgSrc = read(CONFIG);

const urlMatch = /SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/.exec(cfgSrc);
const keyMatch = /SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/.exec(cfgSrc);
truthy(urlMatch && keyMatch, 'в supabaseConfig.js не найдены SUPABASE_URL / SUPABASE_ANON_KEY');

const SUPABASE_URL = urlMatch[1];
const ANON_KEY = keyMatch[1];
const projectRef = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(SUPABASE_URL)?.[1];
truthy(projectRef, `SUPABASE_URL не разбирается: ${SUPABASE_URL}`);

ok('SUPABASE_URL — https и проект разбирается', () => {
  truthy(SUPABASE_URL.startsWith('https://'), SUPABASE_URL);
  truthy(/^[a-z0-9]+$/.test(projectRef), projectRef);
});

ok('ключ в конфиге — JWT с role=anon (не service_role)', () => {
  const parts = ANON_KEY.split('.');
  eq(parts.length, 3, 'JWT должен иметь 3 части');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  eq(payload.role, 'anon', 'role в payload');
  eq(payload.iss, 'supabase', 'iss в payload');
});

ok('ключ относится к тому же проекту, что SUPABASE_URL', () => {
  const payload = JSON.parse(Buffer.from(ANON_KEY.split('.')[1], 'base64url').toString('utf8'));
  eq(payload.ref, projectRef, 'ref в JWT vs ref в URL');
});

ok('ключ не просрочен (просроченный → 401, а в браузере это CORS-ошибка)', () => {
  const payload = JSON.parse(Buffer.from(ANON_KEY.split('.')[1], 'base64url').toString('utf8'));
  truthy(Number.isFinite(payload.exp) && payload.exp * 1000 > Date.now(),
    `exp=${payload.exp} (${new Date(payload.exp * 1000).toISOString()}) — ключ истёк`);
});

/* ── C. Клиентские настройки не содержат серверных секретов ─────────────── */
ok('NOTIFY_WEBHOOK_URL не содержит секретов/токенов', () => {
  const m = /NOTIFY_WEBHOOK_URL\s*=\s*['"]([^'"]*)['"]/.exec(cfgSrc);
  const v = m ? m[1] : '';
  truthy(!/token|key|secret|bearer/i.test(v), v);
});
ok('GOOGLE_CLIENT_ID — только публичный client id (не Client Secret)', () => {
  const m = /GOOGLE_CLIENT_ID\s*=\s*String\(([^)]*)\)/.exec(cfgSrc);
  truthy(m, 'GOOGLE_CLIENT_ID не найден');
  const src = m[1];
  truthy(!/GOCSPX-/.test(src), 'в конфиге похож на Google Client Secret (GOCSPX-)');
  truthy(!/secret/i.test(src), 'в выражении GOOGLE_CLIENT_ID упомянут secret');
});

console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
