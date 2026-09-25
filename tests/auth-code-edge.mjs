/**
 * Прямой тест Edge Function `supabase/functions/auth-code/index.ts`.
 *
 * До этого поведение кода (одноразовость, TTL, лимит попыток, «не логировать код»)
 * проверялось только через контрактный фейк в tests/registration-flow.mjs — то есть
 * проверялся не сам обработчик, а его пересказ. Здесь выполняется НАСТОЯЩИЙ исходник
 * функции: файл загружается как есть, единственное, что подменяется, — это окружение
 * Deno (globalThis.Deno) и сеть (globalThis.fetch) в памяти процесса.
 *
 * Подменяемое окружение моделирует PostgREST-таблицу auth_login_codes и
 * Supabase Auth Admin API, поэтому тест ловит именно ошибки обработчика,
 * а не ошибки фейка. PostgREST-фейк понимает условные UPDATE
 * (Prefer: return=representation + фильтры в query-строке) — именно на них
 * держится атомарный захват кода (issue #14, п.4).
 *
 * Запуск: node tests/auth-code-edge.mjs   (или: npm run verify:authcode)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const FN = new URL('../supabase/functions/auth-code/index.ts', import.meta.url);

let loadSeq = 0;

let passed = 0;
let failed = 0;
const ok = (name, fn) => {
  try { fn(); passed += 1; console.log(`   PASS ${name}`); }
  catch (e) { failed += 1; console.log(`   FAIL ${name}\n        ${e.message}`); }
};
const eq = (a, b, m) => assert.equal(a, b, m);
const truthy = (v, m) => assert.ok(v, m);

// ——— окружение ———————————————————————————————————————————————————————————

/** Состояние «БД» и «Auth» + журнал исходящих запросов. */
let state;

/** Колонки SR-004: без них атомарный захват и recover невозможны. */
const SR004_COLUMNS = ['issued_token_hash', 'issues', 'consumed_at'];

/**
 * Промотать время вперёд: сдвигаем отметки существующих строк в прошлое на ту
 * же величину (обработчик сравнивает их с настоящим Date.now()).
 */
function advanceTime(ms) {
  const shift = new Date(Date.now() - ms).toISOString();
  for (const row of state.codes) {
    row.created_at = shift;
    row.expires_at = new Date(new Date(row.expires_at).getTime() - ms).toISOString();
  }
}
let sentMail;
let logs;

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Фильтры PostgREST, которые реально использует функция. */
function matchFilter(row, key, op, value) {
  const v = row[key];
  switch (op) {
    case 'eq': return String(v) === value;
    case 'gt': return new Date(v).getTime() > new Date(value).getTime();
    case 'lt': return new Date(v).getTime() < new Date(value).getTime();
    case 'is': return value === 'null' ? v === null || v === undefined : String(v) === value;
    default: throw new Error(`фейк PostgREST не знает оператор ${op}`);
  }
}

function parseFilters(qs) {
  const params = new URLSearchParams(qs);
  const filters = [];
  for (const [key, raw] of params.entries()) {
    if (['order', 'limit', 'select', 'offset'].includes(key)) continue;
    const dot = raw.indexOf('.');
    filters.push({ key, op: raw.slice(0, dot), value: raw.slice(dot + 1) });
  }
  return { filters, params };
}

/**
 * Минимальный PostgREST-фейк для таблицы auth_login_codes + Auth Admin API.
 * Поддерживает ровно те запросы, которые делает функция: SELECT с фильтром
 * email/order/limit, DELETE по email, POST строки, условный PATCH по id
 * (с Prefer: return=representation) и ошибки «колонка не найдена», если
 * схема БД не переприменена (legacySchema).
 */
function makeFetch({ mailOk = true, mailStatus = 200, linkFails = false, legacySchema = false } = {}) {
  return async function fakeFetch(url, init = {}) {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const prefer = String(init.headers?.Prefer || '');
    logs.push({ url: u, method, body, prefer });

    if (u.startsWith('https://api.resend.com/emails')) {
      sentMail.push(body);
      return new Response(mailOk ? '{"id":"mail_1"}' : '{"message":"bad domain"}', {
        status: mailOk ? mailStatus : 422,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (u.includes('/auth/v1/admin/generate_link')) {
      if (linkFails) return Response.json({ error: 'server_error', msg: 'link failed' }, { status: 500 });
      if (!state.users.has(body.email)) {
        // как настоящий GoTrue: для несуществующего пользователя ссылки нет
        return Response.json({ error: 'not_found', msg: 'user not found' }, { status: 404 });
      }
      return Response.json({
        action_link: `https://x.supabase.co/auth/v1/verify?token_hash=HASH_${state.users.size}&type=magiclink`,
        hashed_token: `HASH_${state.users.size}`
      });
    }
    if (u.includes('/auth/v1/admin/users')) {
      state.users.add(body.email);
      return Response.json({ id: 'u_' + state.users.size, email: body.email });
    }

    // PostgREST: /rest/v1/auth_login_codes...
    const isTable = u.includes('/rest/v1/auth_login_codes');
    if (!isTable) return new Response('{}', { status: 404 });

    const qs = u.split('?')[1] || '';
    const { filters, params } = parseFilters(qs);
    const matches = (row) => filters.every(f => matchFilter(row, f.key, f.op, f.value));
    const limit = params.get('limit');

    if (method === 'GET') {
      let rows = state.codes.filter(matches);
      if (filters.some(f => f.key === 'order') || /order=created_at\.desc/.test(qs)) {
        rows = rows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      }
      if (limit) rows = rows.slice(0, Number(limit));
      return Response.json(rows);
    }
    if (method === 'DELETE') {
      const before = state.codes.length;
      state.codes = state.codes.filter(r => !matches(r));
      return new Response(null, { status: 204, headers: { 'content-range': `0-${before - 1}/${before}` } });
    }
    if (method === 'POST') {
      state.codes.push({
        id: 'code_' + (state.codes.length + 1),
        email: body.email,
        code_hash: body.code_hash,
        expires_at: body.expires_at,
        created_at: new Date(state.clock).toISOString(),
        used_at: null,
        attempts: 0,
        issued_token_hash: null,
        issues: 1,
        consumed_at: null
      });
      return Response.json([{ id: 'code_' + state.codes.length }], { status: 201 });
    }
    if (method === 'PATCH') {
      // «Схема БД устарела»: колонки SR-004 в таблице нет
      const missing = [...Object.keys(body || {}), ...filters.map(f => f.key)]
        .filter(k => SR004_COLUMNS.includes(k));
      if (legacySchema && missing.length) {
        return Response.json({
          code: '42703',
          message: `column auth_login_codes.${missing[0]} does not exist`
        }, { status: 400 });
      }
      const rows = state.codes.filter(matches);
      for (const row of rows) Object.assign(row, body);
      if (prefer.includes('return=representation')) return Response.json(rows, { status: 200 });
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 405 });
  };
}

/** Загрузка НАСТОЯЩЕГО обработчика с подменой Deno/fetch. */
async function loadHandler(opts = {}) {
  const src = readFileSync(FN, 'utf8');
  const DenoShim = {
    env: {
      get(name) {
        if (name === 'SUPABASE_URL') return 'https://test.supabase.co';
        if (name === 'SUPABASE_SERVICE_ROLE_KEY') return 'service_role_test';
        if (name === 'RESEND_API_KEY') return opts.noMail ? undefined : 're_test';
        if (name === 'MAIL_FROM') return 'PsyПортал <code@test.invalid>';
        if (name === 'APP_URL') return opts.appUrl; // undefined → default Pages URL in function
        return undefined;
      }
    },
    serve(fn) { /* подставляется ниже, чтобы каждый прогон ловил свой обработчик */ }
  };
  Object.defineProperty(globalThis, 'Deno', { value: DenoShim, configurable: true, writable: true });
  globalThis.fetch = makeFetch(opts);
  // .ts-расширение Node не загрузит — исполняем исходник как модуль, ничего в нём не меняя
  // Единственное преобразование исходника — снятие TypeScript-аннотаций
  // (в файле два non-null assertion `!`). Ни одна строка логики не меняется.
  // Маркер загрузки в конце — data: URL кешируется по содержимому, а обработчик
  // нужен заново для каждого сценария (своё окружение).
  const js = stripTypeScriptTypes(src, { mode: 'strip' }) + `\n//# load-${++loadSeq}\n`;
  const b64 = Buffer.from(js, 'utf8').toString('base64');
  let handler = null;
  DenoShim.serve = (fn) => { handler = fn; };
  await import(`data:text/javascript;base64,${b64}`);
  truthy(handler, 'Deno.serve получил обработчик');
  return handler;
}

const post = (handler, payload) =>
  handler(new Request('https://test.supabase.co/functions/v1/auth-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }));
const readJson = async (res) => JSON.parse(await res.text());

function freshState({ clock = Date.now(), users = new Set(['a@test.invalid']) } = {}) {
  state = { codes: [], users, clock };
  sentMail = [];
  logs = [];
}

/** Вынуть код, который функция отправила по почте (из письма, а не из «БД»). */
const codeFromMail = () => /letter-spacing:6px[^>]*>([A-Z0-9]{6,8})</.exec(sentMail[0]?.html || '')?.[1]
  ?? /Код входа: ([A-Z0-9]{6,8})/.exec(sentMail[0]?.subject || '')?.[1];

const codeRow = () => state.codes[0];
const generateLinkCalls = () => logs.filter(l => l.url.includes('admin/generate_link')).length;

// ——— тесты ——————————————————————————————————————————————————————————————

console.log('\n── auth-code (настоящий исходник Edge Function)\n');

// 1. OPTIONS / метод
{
  freshState();
  const h = await loadHandler();
  const opts = await h(new Request('https://x/', { method: 'OPTIONS' }));
  ok('OPTIONS → 200 + CORS', () => { eq(opts.status, 200); eq(opts.headers.get('Access-Control-Allow-Origin'), '*'); });
  // Preflight проверяется браузером ДВУМЯ условиями: статус 2xx И разрешённые
  // методы/заголовки. Нехватка `content-type` в Allow-Headers или `POST`
  // в Allow-Methods даёт ту же консольную CORS-ошибку, что и 404/401, —
  // поэтому контракт запинен полностью, а не только по Allow-Origin.
  ok('OPTIONS → Allow-Methods содержит POST и OPTIONS', () => {
    const m = opts.headers.get('Access-Control-Allow-Methods') || '';
    truthy(/post/i.test(m) && /options/i.test(m), m);
  });
  ok('OPTIONS → Allow-Headers содержит content-type (SPA шлёт JSON)', () => {
    const hh = opts.headers.get('Access-Control-Allow-Headers') || '';
    truthy(/content-type/i.test(hh), hh);
  });
  ok('OPTIONS → Allow-Headers содержит apikey/x-client-info/authorization', () => {
    const hh = (opts.headers.get('Access-Control-Allow-Headers') || '').toLowerCase();
    ['apikey', 'x-client-info', 'authorization'].forEach(k =>
      truthy(hh.includes(k), `нет ${k} в ${hh}`));
  });
  const bad = await h(new Request('https://x/', { method: 'GET' }));
  ok('GET → 405', () => eq(bad.status, 405));
  // Ошибочные ответы тоже несут CORS: иначе браузер съест тело ошибки и
  // пользователь увидит «Failed to fetch» вместо причины.
  const errRes = await h(new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'request', email: 'not-an-email' })
  }));
  ok('ошибка 400 несёт CORS-заголовки (иначе причина не видна)', () => {
    eq(errRes.status, 400);
    eq(errRes.headers.get('Access-Control-Allow-Origin'), '*');
  });
}

// 2. Валидация email
{
  freshState();
  const h = await loadHandler();
  const res = await post(h, { action: 'request', email: 'not-an-email' });
  ok('кривой email → 400', () => { eq(res.status, 400); });
  ok('кривой email → письмо не уходит', () => eq(sentMail.length, 0));
}

// 3. Нет RESEND_API_KEY → 500, код не сохранён
{
  freshState();
  const h = await loadHandler({ noMail: true });
  const res = await post(h, { action: 'request', email: 'a@test.invalid' });
  const j = await readJson(res);
  ok('без RESEND_API_KEY → 500 и внятная ошибка', () => {
    eq(res.status, 500); truthy(/RESEND_API_KEY/.test(j.error), j.error);
  });
  ok('без RESEND_API_KEY → строка кода не создана', () => eq(state.codes.length, 0));
}

// 4. Счастливый путь запроса кода
{
  freshState();
  const h = await loadHandler();
  const res = await post(h, { action: 'request', email: '  A@Test.Invalid ' });
  const j = await readJson(res);
  const code = codeFromMail();
  ok('request → ok:true + ttl 120 c', () => { eq(res.status, 200); eq(j.ok, true); eq(j.ttl_seconds, 120); });
  ok('код 8 символов, алфавит без I/O/0/1', () => {
    truthy(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code), code);
  });
  ok('email нормализован (lowercase+trim) в БД и в письме', () => {
    eq(codeRow().email, 'a@test.invalid');
    eq(sentMail[0].to, 'a@test.invalid');
  });
  ok('в БД лежит ХЕШ, а не сам код', () => {
    eq(codeRow().code_hash, sha256Hex(code + '|a@test.invalid'));
    truthy(!JSON.stringify(codeRow()).includes(`"${code}"`), 'код не должен лежать в строке БД');
  });
  ok('TTL записан как now+2 мин', () => {
    const ttl = new Date(codeRow().expires_at).getTime() - Date.now();
    truthy(ttl > 110e3 && ttl <= 120e3, `TTL вне окна 2 мин: ${ttl} мс`);
  });
  ok('код НЕ попадает в логи/ответ (в ответе нет кода)', () => {
    truthy(!JSON.stringify(j).includes(code), 'код утёк в ответ');
  });
  ok('новый код не выпущен и не израсходован (SR-004 поля чистые)', () => {
    eq(codeRow().issued_token_hash, null);
    eq(codeRow().consumed_at, null);
  });
  ok('письмо содержит код (не только ссылку)', () => {
    truthy((sentMail[0]?.html || '').includes(code), 'код отсутствует в html');
  });
  ok('письмо содержит ссылку #/auth на приложение (issue #23)', () => {
    const html = sentMail[0]?.html || '';
    truthy(/#\/auth/.test(html), html.slice(0, 240));
    truthy(!/localhost|127\.0\.0\.1/i.test(html), 'localhost в письме запрещён');
  });
  ok('ссылка в письме — https Pages origin', () => {
    const html = sentMail[0]?.html || '';
    truthy(/https:\/\/a1dmitry\.github\.io\/Psihologist-cabinet\//i.test(html), html.slice(0, 240));
  });
}

// 4b. APP_URL=localhost → poka-yoke: всё равно production link (issue #23)
{
  freshState();
  const h = await loadHandler({ appUrl: 'http://localhost:3000/' });
  await post(h, { action: 'request', email: 'b@test.invalid' });
  const html = sentMail[0]?.html || '';
  ok('APP_URL localhost не попадает в письмо', () => {
    truthy(!/localhost:3000/i.test(html), html.slice(0, 200));
    truthy(/a1dmitry\.github\.io\/Psihologist-cabinet/i.test(html), html.slice(0, 200));
  });
}

// 5. Кулдаун повторной отправки 30 с
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const again = await post(h, { action: 'request', email: 'a@test.invalid' });
  const j = await readJson(again);
  ok('повторный запрос сразу → 429', () => { eq(again.status, 429); truthy(/30 секунд/.test(j.error), j.error); });
  ok('повторный запрос → второе письмо не отправлено', () => eq(sentMail.length, 1));

  advanceTime(31e3); // прошло 31 с
  const later = await post(h, { action: 'request', email: 'a@test.invalid' });
  ok('после 31 с → снова можно', () => eq(later.status, 200));
  ok('старый код удалён при перевыпуске (действует только последний)', () => eq(state.codes.length, 1));
}

// 6. Почтовый сервис отказал → 502
{
  freshState();
  const h = await loadHandler({ mailOk: false });
  const res = await post(h, { action: 'request', email: 'a@test.invalid' });
  ok('Resend 422 → 502 с подсказкой', () => eq(res.status, 502));
}

// 7. Проверка кода: счастливый путь
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  const res = await post(h, { action: 'verify', email: 'a@test.invalid', code: code.toLowerCase() });
  const j = await readJson(res);
  ok('verify правильным кодом (в нижнем регистре) → ok + hashed_token', () => {
    eq(res.status, 200); eq(j.ok, true); truthy(/^HASH_/.test(j.hashed_token), JSON.stringify(j));
  });
  ok('код погашен (used_at выставлен)', () => truthy(codeRow().used_at, 'used_at не выставлен'));
  ok('в БД отмечен хеш выпущенного токена (recovery capability)', () => {
    eq(codeRow().issued_token_hash, sha256Hex(j.hashed_token));
  });
  ok('ответ отдаёт code_id для восстановления сессии', () => eq(j.code_id, codeRow().id));
  ok('ответ НЕ содержит сам код', () => truthy(!JSON.stringify(j).includes(code)));
}

// 8. Одноразовость: повторное использование того же кода
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  await post(h, { action: 'verify', email: 'a@test.invalid', code });
  const again = await post(h, { action: 'verify', email: 'a@test.invalid', code });
  const j = await readJson(again);
  ok('повторное использование → 400 «уже использован»', () => {
    eq(again.status, 400); truthy(/использован/i.test(j.error), j.error);
  });
  ok('повторное использование → сессия не выдаётся', () => truthy(!j.hashed_token));
}

// 9. Неверный код → попытка списывается
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const res = await post(h, { action: 'verify', email: 'a@test.invalid', code: 'ZZZZZZZZ' });
  const j = await readJson(res);
  ok('неверный код → 400', () => eq(res.status, 400));
  ok('неверный код → attempts=1, код жив', () => {
    eq(codeRow().attempts, 1); eq(codeRow().used_at, null);
  });
  ok('неверный код → hashed_token не выдан', () => truthy(!j.hashed_token));
}

// 10. Лимит попыток = 5
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  for (let i = 0; i < 5; i += 1) await post(h, { action: 'verify', email: 'a@test.invalid', code: 'ZZZZZZZZ' });
  eq(codeRow().attempts, 5, 'после 5 неверных попыток attempts должен быть 5');
  const code = codeFromMail();
  const res = await post(h, { action: 'verify', email: 'a@test.invalid', code });
  const j = await readJson(res);
  ok('6-я попытка даже ВЕРНЫМ кодом → отказ (лимит 5)', () => {
    eq(res.status, 400); truthy(/попыток/i.test(j.error), j.error); truthy(!j.hashed_token);
  });
}

// 11. TTL истёк
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  codeRow().expires_at = new Date(state.clock - 1000).toISOString();
  const res = await post(h, { action: 'verify', email: 'a@test.invalid', code });
  const j = await readJson(res);
  ok('просроченный код → 400 «истёк»', () => {
    eq(res.status, 400); truthy(/истёк/i.test(j.error), j.error);
  });
  ok('просроченный код → сессия не выдаётся', () => truthy(!j.hashed_token));
}

// 12. Формат кода проверяется до обращения к БД
{
  freshState();
  const h = await loadHandler();
  const res = await post(h, { action: 'verify', email: 'a@test.invalid', code: '12' });
  ok('код короче 6 → 400 без запроса к БД', () => {
    eq(res.status, 400);
    eq(logs.filter(l => l.url.includes('auth_login_codes')).length, 0, 'был запрос к БД');
  });
  const res2 = await post(h, { action: 'verify', email: 'a@test.invalid', code: 'ab-cd ef' });
  ok('мусор в коде вычищается до [A-Z0-9] и проверяется длина', () => eq(res2.status, 400));
}

// 13. Код не запрошен
{
  freshState();
  const h = await loadHandler();
  const res = await post(h, { action: 'verify', email: 'a@test.invalid', code: 'ABCDEFGH' });
  const j = await readJson(res);
  ok('verify без запроса кода → 400 «Код не запрошен»', () => {
    eq(res.status, 400); truthy(/не запрошен/i.test(j.error), j.error);
  });
}

// 14. Неизвестное действие
{
  freshState();
  const h = await loadHandler();
  const res = await post(h, { action: 'wipe', email: 'a@test.invalid' });
  ok('неизвестное действие → 400', () => eq(res.status, 400));
}

// 15. Пользователя нет в auth.users → создаём и повторяем generate_link
{
  freshState({ users: new Set() });
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'new@test.invalid' });
  const code = codeFromMail();
  const res = await post(h, { action: 'verify', email: 'new@test.invalid', code });
  const j = await readJson(res);
  ok('новый email → пользователь создан и сессия выдана', () => {
    eq(res.status, 200); eq(j.ok, true); truthy(state.users.has('new@test.invalid'));
  });
  ok('generate_link вызван дважды (до и после создания пользователя)', () => {
    eq(generateLinkCalls(), 2);
  });
}

// 16. АТОМАРНОСТЬ (issue #14, п.4): отказ Auth не сжигает верный код
{
  freshState();
  const h = await loadHandler({ linkFails: true });
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  const res = await post(h, { action: 'verify', email: 'a@test.invalid', code });
  const j = await readJson(res);
  ok('generate_link не работает → 502 с объяснением', () => {
    eq(res.status, 502); truthy(/сессия не создана/i.test(j.error), j.error);
  });
  ok('при отказе сессии ok=false (клиент не увидит «успех»)', () => eq(j.ok, false));
  ok('ОТП НЕ сожжён: used_at пуст после отказа Auth', () => eq(codeRow().used_at, null));
  ok('захват снят: issued_token_hash снова null (компенсация)', () => eq(codeRow().issued_token_hash, null));
  ok('сессия не выдана', () => truthy(!j.hashed_token));
}

// 16b. После компенсации тот же код принимается, когда Auth ожил
{
  freshState();
  let linkFails = true;
  const h = await loadHandler();
  // подменяем отказ Auth «на лету»: первый verify падает, второй проходит
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('admin/generate_link') && linkFails) {
      return Response.json({ error: 'server_error', msg: 'temporary' }, { status: 500 });
    }
    return realFetch(url, init);
  };
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  const first = await post(h, { action: 'verify', email: 'a@test.invalid', code });
  const firstJson = await readJson(first);
  const afterFailure = { ...codeRow() }; // снимок ДО успешного verify
  linkFails = false;
  const second = await post(h, { action: 'verify', email: 'a@test.invalid', code });
  const secondJson = await readJson(second);
  globalThis.fetch = realFetch;
  ok('первый verify с отказом Auth → код не израсходован', () => {
    eq(first.status, 502);
    eq(afterFailure.used_at, null);
    eq(afterFailure.issued_token_hash, null);
    truthy(/не израсходован/i.test(firstJson.error), firstJson.error);
  });
  ok('тот же код после восстановления Auth → сессия выдана', () => {
    eq(second.status, 200); eq(secondJson.ok, true); truthy(/^HASH_/.test(secondJson.hashed_token), JSON.stringify(secondJson));
  });
  ok('после успешной выдачи код погашен', () => truthy(codeRow().used_at, 'used_at не выставлен'));
}

// 17. Гонка: два параллельных verify — сессию получает ровно один
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  const [r1, r2] = await Promise.all([
    post(h, { action: 'verify', email: 'a@test.invalid', code }),
    post(h, { action: 'verify', email: 'a@test.invalid', code })
  ]);
  const [j1, j2] = [await readJson(r1), await readJson(r2)];
  const winners = [j1, j2].filter(j => j.ok && j.hashed_token);
  const losers = [j1, j2].filter(j => !j.ok);
  ok('два параллельных verify → ровно один hashed_token', () => {
    eq(winners.length, 1, JSON.stringify([j1, j2]));
  });
  ok('второй запрос отклонён (409) без токена', () => {
    eq(losers.length, 1); eq(losers[0].hashed_token, undefined);
  });
  ok('гонка: сессия в Auth создана один раз', () => eq(generateLinkCalls(), 1));
  ok('гонка: код погашен один раз', () => {
    truthy(codeRow().used_at);
    eq(codeRow().issues, 2, 'issues = захват(1) + выпуск(1)');
  });
}

// 18. Recover: сессия потеряна в сети → перевыпуск по code_id
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  const verified = await readJson(await post(h, { action: 'verify', email: 'a@test.invalid', code }));
  const rec = await post(h, { action: 'recover', email: 'a@test.invalid', code_id: verified.code_id });
  const j = await readJson(rec);
  ok('recover по code_id → новая сессия в пределах TTL', () => {
    eq(rec.status, 200); eq(j.ok, true); truthy(/^HASH_/.test(j.hashed_token), JSON.stringify(j));
  });
  ok('recover: счётчик выпусков растёт', () => eq(codeRow().issues, 3));
  const noId = await post(h, { action: 'recover', email: 'a@test.invalid' });
  ok('recover без code_id → 400', () => eq(noId.status, 400));
  const wrongId = await post(h, { action: 'recover', email: 'a@test.invalid', code_id: 'code_999' });
  ok('recover с чужим code_id → 400', () => eq(wrongId.status, 400));
  codeRow().expires_at = new Date(Date.now() - 1000).toISOString();
  const ttlGone = await readJson(await post(h, { action: 'recover', email: 'a@test.invalid', code_id: verified.code_id }));
  ok('recover после истечения TTL → 400 «истекло»', () => {
    eq(ttlGone.ok, false); truthy(/истекло|истёк/i.test(ttlGone.error), ttlGone.error);
  });
}

// 19. Redeem: браузер получил JWT → перевыпуск закрыт (replay protection)
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  const verified = await readJson(await post(h, { action: 'verify', email: 'a@test.invalid', code }));
  const redeemed = await readJson(await post(h, {
    action: 'redeem', email: 'a@test.invalid', code_id: verified.code_id, hashed_token: verified.hashed_token
  }));
  ok('redeem своим токеном → consumed_at выставлен', () => {
    eq(redeemed.ok, true); truthy(codeRow().consumed_at, 'consumed_at не выставлен');
  });
  codeRow().consumed_at = null;
  const evil = await readJson(await post(h, {
    action: 'redeem', email: 'a@test.invalid', code_id: verified.code_id, hashed_token: 'HASH_evil'
  }));
  ok('redeem чужим токеном → 400', () => eq(evil.ok, false));

  codeRow().consumed_at = new Date().toISOString();
  const afterRedeem = await readJson(await post(h, { action: 'recover', email: 'a@test.invalid', code_id: verified.code_id }));
  ok('после redeem recover отказывает (один код = одна сессия)', () => {
    eq(afterRedeem.ok, false); truthy(/использован/i.test(afterRedeem.error), afterRedeem.error);
  });

  codeRow().consumed_at = null;
  codeRow().issued_token_hash = sha256Hex('HASH_x');
  codeRow().issues = 3;
  const overLimit = await readJson(await post(h, { action: 'recover', email: 'a@test.invalid', code_id: verified.code_id }));
  ok('лимит перевыпусков: 4-й выпуск отклонён', () => {
    eq(overLimit.ok, false); truthy(/попыток/i.test(overLimit.error), overLimit.error);
  });
}

// 20. Устаревшая схема БД (нет колонок SR-004): вход работает, но честно
{
  freshState();
  const h = await loadHandler({ legacySchema: true });
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  const res = await post(h, { action: 'verify', email: 'a@test.invalid', code });
  const j = await readJson(res);
  ok('legacy: вход по-прежнему работает (регистрация не заблокирована)', () => {
    eq(res.status, 200); eq(j.ok, true); truthy(/^HASH_/.test(j.hashed_token), JSON.stringify(j));
  });
  ok('legacy: код погашен (одноразовость сохранена прежним способом)', () => truthy(codeRow().used_at));
  ok('legacy: ответ помечен и без code_id (recover недоступен)', () => {
    eq(j.legacy_schema, true); eq(j.code_id, undefined);
  });
}

// 20b. Устаревшая схема + отказ Auth → компенсация и подсказка про schema.sql
{
  freshState();
  const h = await loadHandler({ legacySchema: true, linkFails: true });
  await post(h, { action: 'request', email: 'a@test.invalid' });
  const code = codeFromMail();
  const res = await post(h, { action: 'verify', email: 'a@test.invalid', code });
  const j = await readJson(res);
  ok('legacy + отказ Auth → 502, код не израсходован', () => {
    eq(res.status, 502); eq(codeRow().used_at, null); truthy(!j.hashed_token);
  });
  ok('legacy + отказ Auth → ошибка требует переприменить schema.sql', () => {
    truthy(/schema\.sql/.test(j.error), j.error);
  });
}

// 21. Код не уходит в консоль
{
  freshState();
  const h = await loadHandler();
  const realLog = console.log;
  const realErr = console.error;
  const captured = [];
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  try {
    await post(h, { action: 'request', email: 'a@test.invalid' });
    await post(h, { action: 'verify', email: 'a@test.invalid', code: codeFromMail() });
    await post(h, { action: 'verify', email: 'a@test.invalid', code: 'ZZZZZZZZ' });
  } finally {
    console.log = realLog; console.error = realErr;
  }
  ok('код не печатается в логи функции', () => {
    const code = codeFromMail();
    truthy(!captured.some(l => l.includes(code)), `код найден в логах: ${captured.join(' | ')}`);
  });
  ok('hashed_token не печатается в логи функции', () => {
    truthy(!captured.some(l => /HASH_/.test(l)), `token_hash в логах: ${captured.join(' | ')}`);
  });
}

// 22. Сервис-ключ не уходит в письмо
{
  freshState();
  const h = await loadHandler();
  await post(h, { action: 'request', email: 'a@test.invalid' });
  ok('service_role ключ не попадает в тело письма', () => {
    truthy(!JSON.stringify(sentMail).includes('service_role_test'));
  });
}

// 23. Холостая проверка схемы (диагностика клиента): recover с несуществующим code_id
{
  freshState();
  const h = await loadHandler();
  const res = await post(h, { action: 'recover', email: 'a@test.invalid', code_id: 'schema-probe' });
  const j = await readJson(res);
  ok('диагностика схемы: холостой recover → 400 без писем и записей', () => {
    eq(res.status, 400);
    eq(j.ok, false);
    eq(sentMail.length, 0);
    eq(state.codes.length, 0);
  });
}

console.log(`\n   ${failed === 0 ? 'ALL PASS' : 'FAILED'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
