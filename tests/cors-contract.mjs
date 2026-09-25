#!/usr/bin/env node
/**
 * CORS-контракт Edge Functions (issue: preflight `auth-code` блокируется браузером).
 *
 * Дефект, который здесь запинен. В консоли браузера preflight даёт одну и ту же
 * строку — «blocked by CORS policy … It does not have HTTP ok status» — для трёх
 * разных причин, и браузер НЕ показывает статус и заголовки ответа:
 *   1. функция не задеплоена → gateway 404;
 *   2. verify_jwt=true → gateway 401;
 *   3. функция ответила, но её allow-list не покрывает заголовки клиента.
 *
 * Причина 3 — единственная, которую можно (и нужно) исключить в репозитории:
 * Supabase требует, чтобы `Access-Control-Allow-Headers` покрывал ВСЕ заголовки,
 * которые присылает вызывающий клиент
 * (https://supabase.com/docs/guides/functions/cors). Сюда входят
 * `x-retry-count` (авто-ретраи postgrest-js) и `traceparent` / `tracestate` /
 * `baggage` (client-side tracing): функция, задеплоенная с узким списком,
 * перестаёт вызываться из браузера после обновления SDK — лечится только
 * редеплоем, а выглядит как «CORS сломался сам».
 *
 * Что проверяется:
 *   A. канонический список заголовков/методов из доков Supabase;
 *   B. ОБЕ функции объявляют один и тот же список (расхождение = «вход работает,
 *      уведомления нет» с одинаковой консольной ошибкой);
 *   C. allow-list покрывает всё, что реально шлёт фронтенд в /functions/v1/*;
 *   D. allow-list — надмножество канонического (сужать нельзя).
 *
 * Поведенческая проверка ответа на OPTIONS (200 + эти заголовки) — в
 * tests/auth-code-edge.mjs, там же, где загружается настоящий исходник функции.
 *
 * Запуск: node tests/cors-contract.mjs
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

/* ── A. Канонический контракт Supabase ──────────────────────────────────── */
const CANONICAL_HEADERS = [
  'authorization', 'x-client-info', 'apikey', 'content-type',
  'x-retry-count', 'traceparent', 'tracestate', 'baggage'
];
const CANONICAL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** Достать CORS-объект из исходника функции (Deno, без сборки). */
function readCors(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const m = /const\s+(?:CORS|cors)\s*=\s*\{([\s\S]*?)\n\};/.exec(src);
  truthy(m, `в ${file} не найден CORS-объект`);
  const block = m[1];
  const pick = (key) => {
    // значение — одна строка в кавычках; допускаем перенос после двоеточия
    const hm = new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]*)['"]`).exec(block);
    truthy(hm, `в ${file} не найден заголовок ${key}`);
    truthy(hm[1].trim().length > 0, `в ${file} пустое значение ${key}`);
    return hm[1].trim();
  };
  return {
    origin: pick('Access-Control-Allow-Origin'),
    headers: pick('Access-Control-Allow-Headers').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    methods: pick('Access-Control-Allow-Methods').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  };
}

const authCode = readCors('supabase/functions/auth-code/index.ts');
const tgNotify = readCors('supabase/functions/telegram-notify/index.ts');

ok('auth-code: Allow-Headers — канонический список Supabase', () => {
  eq(authCode.headers.join(', '), CANONICAL_HEADERS.join(', '), 'список заголовков');
});
ok('auth-code: Allow-Methods покрывает канонические методы', () => {
  CANONICAL_METHODS.forEach(m => truthy(authCode.methods.includes(m), `нет метода ${m}: ${authCode.methods.join(',')}`));
});
ok('auth-code: Allow-Origin задан (иначе preflight не пройдёт вовсе)', () => {
  truthy(authCode.origin === '*' || /^https?:\/\//.test(authCode.origin), authCode.origin);
});

/* ── B. Обе функции объявляют один контракт ─────────────────────────────── */
ok('auth-code и telegram-notify: CORS-контракт идентичен', () => {
  eq(tgNotify.headers.join(', '), authCode.headers.join(', '), 'Allow-Headers расходятся');
  eq(tgNotify.methods.join(', '), authCode.methods.join(', '), 'Allow-Methods расходятся');
  eq(tgNotify.origin, authCode.origin, 'Allow-Origin расходятся');
});
ok('telegram-notify: Allow-Headers — канонический список Supabase', () => {
  eq(tgNotify.headers.join(', '), CANONICAL_HEADERS.join(', '), 'список заголовков');
});

/* ── C. Allow-list покрывает то, что шлёт фронтенд ──────────────────────── */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html)$/.test(name)) out.push(p);
  }
  return out;
}

const frontendFiles = [join(ROOT, 'index.html'), ...walk(join(ROOT, 'js'))];
const sentHeaders = new Set();
for (const file of frontendFiles) {
  const src = readFileSync(file, 'utf8');
  // каждый вызов Edge Function: URL с /functions/v1/ → ближайший headers:{…}
  const re = /functions\/v1\//g;
  let m;
  while ((m = re.exec(src))) {
    const window = src.slice(m.index, m.index + 600);
    const hm = /headers\s*:\s*\{([^}]*)\}/.exec(window);
    if (!hm) continue;
    for (const h of hm[1].matchAll(/['"]?([A-Za-z][A-Za-z0-9-]*)['"]?\s*:/g)) {
      sentHeaders.add(h[1].toLowerCase());
    }
  }
}

truthy(sentHeaders.size > 0, 'фронтенд не вызывает /functions/v1/* — сканер сломан или контракт потерян');
ok('фронтенд действительно вызывает Edge Functions (сканер не пустой)', () => {
  truthy([...sentHeaders].length >= 2, [...sentHeaders].join(','));
});
ok('каждый заголовок из вызовов /functions/v1/* разрешён в allow-list', () => {
  const missing = [...sentHeaders].filter(h => !authCode.headers.includes(h));
  truthy(missing.length === 0,
    `фронтенд шлёт ${[...sentHeaders].join(', ')}, а allow-list не разрешает: ${missing.join(', ')} `
    + `(браузер заблокирует preflight — docs/guides/functions/cors)`);
});

/* ── D. Список не сузили обратно ────────────────────────────────────────── */
ok('allow-list — надмножество канонического (сужать нельзя)', () => {
  const missing = CANONICAL_HEADERS.filter(h => !authCode.headers.includes(h));
  truthy(missing.length === 0, `из канонического списка выпало: ${missing.join(', ')}`);
});
ok('в allow-list нет опечаток/дублей', () => {
  eq(authCode.headers.length, new Set(authCode.headers).size, 'дубликаты заголовков');
  authCode.headers.forEach(h => truthy(/^[a-z0-9-]+$/.test(h), `подозрительное имя заголовка: ${h}`));
});

console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
