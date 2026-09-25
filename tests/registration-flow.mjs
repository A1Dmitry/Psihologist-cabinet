#!/usr/bin/env node
/**
 * Регистрация/вход специалиста — проверка фактического контракта (P0).
 *
 *   node tests/registration-flow.mjs
 *
 * Что проверяется (Definition of Done из задачи AUDIT-REG-DRY-001):
 *   • новый email реально создаёт аутентифицированного пользователя Supabase;
 *   • создаётся или claim-ится РОВНО ОДИН психолог;
 *   • psychologists.owner_id == auth.uid();
 *   • все обязательные поля профиля сохранены (email, fullName, phone,
 *     specialization, city, about);
 *   • повторный вход тем же email не создаёт дубль;
 *   • неверный / просроченный / повторно использованный код отклоняются;
 *   • отсутствие Edge Function → запасной канал, но тот же use case;
 *   • отсутствие mail-конфигурации → честная ошибка, без тихого fallback;
 *   • ошибка RPC → честная ошибка пользователю;
 *   • reload страницы сохраняет аутентифицированное состояние.
 *
 * Supabase здесь заменён контрактным фейком: он хранит состояние по тем же
 * правилам (один профиль на email, owner_id из sub JWT, одноразовый код с TTL),
 * а проверяемый код — настоящий (js/domain/registration.js → supabaseApi).
 * Реальный SQL-контракт RPC проверяется отдельно в tests/db-contract.mjs
 * на настоящем PostgreSQL.
 */

/* ——— DOM/хранилище-заглушки (та же модель, что в verify_auth.mjs) ——— */
function fakeEl() {
  const t = function () {};
  return new Proxy(t, {
    get(_, p) {
      if (p === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      if (p === 'style' || p === 'dataset') return {};
      if (['value', 'textContent', 'innerHTML', 'src', 'href', 'id', 'className'].includes(p)) return '';
      if (['querySelectorAll', 'addEventListener', 'removeEventListener', 'appendChild', 'setAttribute', 'scrollIntoView', 'remove'].includes(p)) return () => [];
      if (p === 'querySelector') return () => fakeEl();
      if (p === 'getAttribute') return () => null;
      if (p === 'closest') return () => null;
      if (p === Symbol.toPrimitive) return () => '';
      return fakeEl();
    },
    set() { return true; },
    apply() { return fakeEl(); }
  });
}
globalThis.document = {
  title: '', head: fakeEl(), body: fakeEl(), documentElement: fakeEl(), hidden: false,
  querySelector: () => fakeEl(), querySelectorAll: () => [], getElementById: () => fakeEl(),
  createElement: () => fakeEl(), addEventListener: () => {}, removeEventListener: () => {}
};
const lsMap = new Map();
globalThis.localStorage = {
  getItem: k => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: k => lsMap.delete(k),
  clear: () => lsMap.clear()
};
const loc = { pathname: '/', search: '', hash: '', origin: 'http://x' };
globalThis.window = new Proxy(
  { localStorage: globalThis.localStorage, addEventListener: () => {}, scrollTo: () => {}, location: loc },
  { get: (t, p) => (p in t ? t[p] : fakeEl()), set: () => true }
);
globalThis.location = loc;
globalThis.history = { pushState() {}, replaceState() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 't', clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.prompt = () => 'x';
globalThis.FileReader = class {};

/* ——— Контрактный фейк Supabase ——— */
import { createHash } from 'node:crypto';

const TTL_MS = 2 * 60e3;
const dbState = {
  users: new Map(),        // email -> { id }
  psychologists: new Map(),// id -> row
  codes: new Map(),        // email -> { code, expiresAt, used, attempts }
  fnDeployed: true,
  fnThrows: false,       // функция есть, но сеть/CORS: fetch бросает TypeError
  mailConfigured: true,
  rpcFails: false,
  issuedCode: null,
  clock: () => Date.now()
};

function uid() {
  return 'uid_' + Math.random().toString(36).slice(2, 10);
}

const sha256Hex = (str) => createHash('sha256').update(String(str), 'utf8').digest('hex');

/** Неподписанный JWT с `sub` (+ email) — подписи в фейке нет, нужен auth.uid() и emailFromSession. */
function fakeJwt(sub, email = '') {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const payload = { sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 };
  if (email) payload.email = email;
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

/** Кто владелец запроса — из Bearer-токена (как это делает PostgREST). */
function uidFromRequest(opts) {
  const auth = String(opts?.headers?.Authorization || '');
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || token.split('.').length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub || null;
  } catch {
    return null;
  }
}

function resp(status, json) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(json),
    json: async () => json
  };
}

const logLines = [];
const realConsoleLog = console.log;

const logCalls = [];
const localStorageSnapshot = () => Object.fromEntries(lsMap.entries());
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  logCalls.push(u);
  const body = opts.body ? JSON.parse(opts.body) : {};

  // —— Edge Function auth-code ——
  if (u.includes('/functions/v1/auth-code')) {
    if (!dbState.fnDeployed) return resp(404, { msg: 'Function not found' });
    if (dbState.fnThrows) throw new TypeError('Failed to fetch'); // CORS-маскировка 404
    if (body.action === 'request') {
      if (!dbState.mailConfigured) {
        return resp(500, { ok: false, error: 'Почта не настроена: задайте секрет RESEND_API_KEY (supabase secrets set RESEND_API_KEY=re_...)' });
      }
      const code = 'ABCD2345';
      dbState.issuedCode = code;
      dbState.codes.set(body.email, {
        code,
        id: 'code_' + (dbState.codes.size + 1),
        expiresAt: dbState.clock() + TTL_MS,
        used: false,
        attempts: 0,
        issuedTokenHash: null,   // SR-004: null | claimId | sha256(hashed_token)
        issues: 1,
        consumedAt: null         // браузер обменял токен на JWT
      });
      return resp(200, { ok: true, ttl_seconds: TTL_MS / 1000 });
    }
    if (body.action === 'verify') {
      const rec = dbState.codes.get(body.email);
      if (!rec) return resp(400, { ok: false, error: 'Код не запрошен — сначала получите письмо' });
      if (rec.used) return resp(400, { ok: false, error: 'Код уже использован — запросите новый' });
      if (rec.attempts >= 5) return resp(400, { ok: false, error: 'Слишком много попыток — запросите новый код' });
      if (rec.expiresAt < dbState.clock()) return resp(400, { ok: false, error: 'Код истёк (2 минуты) — запросите новый' });
      if (body.code !== rec.code) {
        rec.attempts++;
        return resp(400, { ok: false, error: 'Неверный код' });
      }
      // атомарный захват: второй параллельный запрос сессию не получит
      if (rec.issuedTokenHash !== null) {
        return resp(409, { ok: false, error: 'Код уже используется другим запросом — запросите новый' });
      }
      if (!dbState.users.has(body.email)) dbState.users.set(body.email, { id: uid() });
      const sub = dbState.users.get(body.email).id;
      const token = 'ht_' + sub;
      rec.issuedTokenHash = sha256Hex(token);
      rec.used = true; // одноразовость (после успешного создания сессии)
      rec.issues += 1;
      return resp(200, { ok: true, hashed_token: token, code_id: rec.id });
    }
    if (body.action === 'recover') {
      const rec = dbState.codes.get(body.email);
      if (!rec || rec.id !== body.code_id) return resp(400, { ok: false, error: 'Подтверждение не найдено — запросите новый код' });
      if (rec.consumedAt) return resp(400, { ok: false, error: 'Код уже использован — запросите новый' });
      if (rec.expiresAt < dbState.clock()) return resp(400, { ok: false, error: 'Окно ввода кода истекло (2 минуты) — запросите новый код' });
      if (!rec.issuedTokenHash) return resp(400, { ok: false, error: 'Код ещё не подтверждён — введите код из письма' });
      if (rec.issues >= 3) return resp(400, { ok: false, error: 'Слишком много попыток получить сессию — запросите новый код' });
      const sub = dbState.users.get(body.email)?.id;
      const token = 'ht_' + sub;
      rec.issuedTokenHash = sha256Hex(token);
      rec.issues += 1;
      return resp(200, { ok: true, hashed_token: token, code_id: rec.id });
    }
    if (body.action === 'redeem') {
      const rec = dbState.codes.get(body.email);
      if (!rec || rec.id !== body.code_id) return resp(400, { ok: false, error: 'Подтверждение не найдено' });
      if (rec.issuedTokenHash !== sha256Hex(String(body.hashed_token || ''))) {
        return resp(400, { ok: false, error: 'Токен не соответствует выпущенному' });
      }
      rec.consumedAt = Date.now();
      return resp(200, { ok: true, consumed: true });
    }
    return resp(400, { ok: false, error: 'Неизвестное действие' });
  }

  // —— GoTrue: сессия по hashed_token / OTP / refresh ——
  if (u.includes('/auth/v1/verify')) {
    if (body.token_hash) {
      const sub = String(body.token_hash).replace(/^ht_/, '');
      const email = [...dbState.users.entries()].find(([, v]) => v.id === sub)?.[0];
      if (!email) return resp(400, { msg: 'Invalid token_hash' });
      return resp(200, {
        access_token: fakeJwt(sub, email),
        refresh_token: 'rt_' + sub,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer'
      });
    }
    // запасной канал Supabase OTP
    const rec = dbState.codes.get(body.email);
    if (!rec || rec.used || rec.code !== body.token) return resp(400, { msg: 'Invalid token' });
    if (rec.expiresAt < dbState.clock()) return resp(400, { msg: 'otp_expired' });
    rec.used = true;
    if (!dbState.users.has(body.email)) dbState.users.set(body.email, { id: uid() });
    const sub = dbState.users.get(body.email).id;
    return resp(200, {
      access_token: fakeJwt(sub, body.email),
      refresh_token: 'rt_' + sub,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer'
    });
  }
  if (u.includes('/auth/v1/otp')) {
    if (!dbState.mailConfigured) return resp(500, { msg: 'mail not configured' });
    // issue #23: redirect_to must not be localhost
    dbState.lastOtpBody = body;
    dbState.codes.set(body.email, { code: 'OTP12345', expiresAt: dbState.clock() + TTL_MS, used: false, attempts: 0 });
    dbState.issuedCode = 'OTP12345';
    return resp(200, {});
  }
  if (u.includes('/auth/v1/token?grant_type=refresh_token')) {
    const sub = String(body.refresh_token || '').replace(/^rt_/, '');
    if (!sub) return resp(400, { msg: 'invalid refresh token' });
    return resp(200, {
      access_token: fakeJwt(sub),
      refresh_token: 'rt_' + sub,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer'
    });
  }

  // —— RPC claim_psychologist_profile (security definer, owner = auth.uid()) ——
  if (u.includes('/rpc/claim_psychologist_profile')) {
    const owner = uidFromRequest(opts);
    if (!owner) return resp(200, { ok: false, error: 'Email не подтверждён' });
    if (dbState.rpcFails) return resp(500, { message: 'rpc failure' });
    const email = String(body.p_email || '').toLowerCase().trim();
    const existing = [...dbState.psychologists.values()].find(p => p.email === email);
    if (existing) {
      if (existing.owner_id && existing.owner_id !== owner) {
        return resp(200, { ok: false, error: 'Этот профиль уже привязан к другой учётной записи' });
      }
      // Зеркало SQL-контракта (supabase/schema.sql, claim_psychologist_profile):
      // вход НЕ реактивирует отключённый кабинет. Проверено на настоящем
      // PostgreSQL в tests/db-contract.mjs, секция «ОТКЛЮЧЁННЫЙ АККАУНТ».
      if (existing.is_active === false) {
        return resp(200, {
          ok: false,
          inactive: true,
          error: 'Учётная запись отключена. Для восстановления доступа обратитесь к администратору портала.'
        });
      }
      existing.owner_id = existing.owner_id || owner;
      // дозаполнение только пустого
      for (const [field, value] of [['phone', body.p_phone], ['about', body.p_about], ['city', body.p_city], ['specialization', body.p_specialization]]) {
        if (!existing[field] && value) existing[field] = value;
      }
      return resp(200, { ok: true, id: existing.id, owner_id: existing.owner_id, created: false });
    }
    const row = {
      id: 'psy_' + Math.random().toString(36).slice(2, 8),
      email,
      full_name: body.p_full_name || email.split('@')[0],
      phone: body.p_phone || '',
      specialization: body.p_specialization || 'Психолог',
      city: body.p_city || '',
      about: body.p_about || '',
      slug: 'spec-' + Math.random().toString(36).slice(2, 6),
      owner_id: owner,
      is_active: true,
      created_at: new Date().toISOString()
    };
    dbState.psychologists.set(row.id, row);
    return resp(200, { ok: true, id: row.id, owner_id: row.owner_id, created: true });
  }

  // —— PostgREST: psychologists ——
  if (u.includes('/rest/v1/psychologists')) {
    const owner = uidFromRequest(opts);
    const byOwner = /owner_id=eq\.([^&]+)/.exec(u);
    const byId = /[?&]id=eq\.([^&]+)/.exec(u);
    // PATCH — как RLS owner_all: писать может только владелец своей строки
    if ((opts.method || 'GET').toUpperCase() === 'PATCH') {
      const row = [...dbState.psychologists.values()].find(r => r.id === decodeURIComponent(byId?.[1] || ''));
      if (!owner || !row || row.owner_id !== owner) return resp(401, { message: 'new row violates row-level security policy' });
      Object.assign(row, body);
      return resp(200, [row]);
    }
    let rows = [...dbState.psychologists.values()];
    if (byOwner) rows = rows.filter(r => r.owner_id === decodeURIComponent(byOwner[1]));
    if (byId) rows = rows.filter(r => r.id === decodeURIComponent(byId[1]));
    // RLS owner_all: без владельца или чужой владелец — пусто
    if (!owner) return resp(200, []);
    return resp(200, rows.filter(r => r.owner_id === owner));
  }

  // остальной кабинет — пустые ответы
  if (u.includes('/rest/v1/')) return resp(200, []);
  return resp(404, { msg: 'not found' });
};

/* ——— Режим дочернего процесса: «перезагрузка» между запросом и вводом кода ——— */
if (process.argv[2] === '--pending') {
  const { readFileSync } = await import('node:fs');
  const snap = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  for (const [k, v] of snap.storage) lsMap.set(k, v);
  for (const [k, v] of snap.server.codes) dbState.codes.set(k, v);
  for (const [k, v] of snap.server.users) dbState.users.set(k, v);
  for (const [k, v] of snap.server.psychologists) dbState.psychologists.set(k, v);
  dbState.issuedCode = snap.code;

  const out = [];
  const reg = (await import('../js/domain/registration.js')).registration;
  const before = logCalls.length;

  const pending = reg.pendingVerification();
  out.push(['reload до ввода кода: ожидание восстановлено', !!pending && pending.email === snap.email, JSON.stringify(pending)]);
  out.push(['reload до ввода кода: канал восстановлен (fn)', pending?.channel === 'fn', String(pending?.channel)]);
  out.push(['reload до ввода кода: окно жизни кода сохранено',
    pending?.expiresAt > Date.now() && pending?.expiresAt <= Date.now() + TTL_MS, String(pending?.expiresAt)]);

  const verified = await reg.verifyVerification(snap.email, snap.code);
  const transportCalls = logCalls.slice(before);
  out.push(['reload: код принят сохранённым каналом', verified.ok === true, JSON.stringify(verified)]);
  out.push(['reload: канал не переключился на запасной OTP',
    !transportCalls.some(u => u.includes('/auth/v1/otp')), transportCalls.join(' | ')]);
  out.push(['reload: новый код не запрашивался (транспорт тот же)',
    !transportCalls.some(u => u.includes('/functions/v1/auth-code') && /"action":"request"/.test(u)),
    transportCalls.join(' | ')]);

  // verifyVerification гасит ожидание (код одноразовый), поэтому дальше идём
  // по явным шагам того же контракта, а не вызываем completeVerification повторно
  const ensured = reg.ensureAuthenticatedSession(verified.session);
  out.push(['reload: сессия зафиксирована (auth.uid() получен)',
    ensured.ok === true && !!ensured.ownerId, JSON.stringify(ensured.ownerId)]);
  const claimed = await reg.claimOrCreatePsychologist(snap.email, snap.profile);
  out.push(['reload: кабинет привязан тем же use case', claimed.ok === true && !!claimed.id, JSON.stringify(claimed)]);
  const loaded = await reg.loadOwnedProfile(claimed.id);
  out.push(['reload: вход завершён, профиль загружен с сервера', loaded.ok === true, loaded.message || '']);
  out.push(['reload: после входа ожидание кода очищено', reg.pendingVerification() === null]);

  process.stdout.write('PENDING_RESULT ' + JSON.stringify(out));
  process.exit(0);
}

/* ——— Режим дочернего процесса: «страница перезагружена» ——— */
if (process.argv[2] === '--restore') {
  const { readFileSync } = await import('node:fs');
  const snap = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  for (const [k, v] of snap.storage) lsMap.set(k, v);
  // «сервер» переживает перезагрузку страницы — восстанавливаем его состояние
  for (const [k, v] of snap.server.users) dbState.users.set(k, v);
  for (const [k, v] of snap.server.psychologists) dbState.psychologists.set(k, v);

  const out = [];
  const reg = (await import('../js/domain/registration.js')).registration;
  const { supabaseApi, userIdFromToken } = await import('../js/services/supabaseApi.js');
  const { db } = await import('../js/core/dbContext.js');

  out.push(['reload: до восстановления токен пуст (память модуля чистая)', supabaseApi.hasSession() === false, String(supabaseApi.hasSession())]);
  const restored = await reg.restoreAuthenticatedState();
  out.push(['reload: аутентификация восстановлена', restored.authenticated === true, JSON.stringify(restored)]);
  out.push(['reload: восстановлен ТОТ ЖЕ психолог', restored.psychologist?.id === snap.created.id, `${restored.psychologist?.id} vs ${snap.created.id}`]);
  out.push(['reload: владелец определён по auth.uid(), а не по email', restored.ownerId === snap.created.owner_id, String(restored.ownerId)]);
  out.push(['reload: кабинет снова пишет на сервер (hasSession)', supabaseApi.hasSession() === true, String(supabaseApi.hasSession())]);
  out.push(['reload: currentPsychologist доступен', db.currentPsychologist?.id === snap.created.id, String(db.currentPsychologist?.id)]);
  process.stdout.write('RELOAD_RESULT ' + JSON.stringify(out));
  process.exit(0);
}

/* ——— Хелперы проверок ——— */
const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  realConsoleLog(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

/**
 * Модули подтягиваются один раз: ESM кэширует граф, и «перезагрузка» через
 * query-строку не очистила бы память модулей (dbContext остался бы прежним).
 * Настоящая перезагрузка страницы проверяется отдельным процессом — см.
 * runReloadCheck() ниже: свежий процесс = свежая память модулей, а общее
 * между «загрузками» только localStorage, как в браузере.
 */
async function loadFreshModules() {
  const registration = (await import('../js/domain/registration.js')).registration;
  const { supabaseApi, userIdFromToken } = await import('../js/services/supabaseApi.js');
  const { cabinetApi } = await import('../js/services/cabinetApi.js');
  const { db } = await import('../js/core/dbContext.js');
  const { authService } = await import('../js/services/authService.js');
  const { cryptoService } = await import('../js/services/cryptoService.js');
  return { registration, supabaseApi, userIdFromToken, cabinetApi, db, authService, cryptoService };
}

const PROFILE = {
  fullName: 'Наталья Тестовая',
  phone: '+375 29 111-22-33',
  specialization: 'Клинический психолог',
  city: 'Гродно',
  about: 'Работаю с тревогой и выгоранием, КПТ, онлайн и очно.'
};
const EMAIL = 'natalia.test@example.by';

/* ============================================================================
 * 1. Регистрация нового email
 * ========================================================================== */
let m = await loadFreshModules();
let req = await m.registration.requestVerification(EMAIL);
check('новый email: код запрошен (основной канал auth-code)', req.ok && req.channel === 'fn', JSON.stringify(req));
const pendingAfterRequest = m.registration.pendingVerification();
check('ожидание кода сохранено (email + канал + окно жизни)',
  pendingAfterRequest?.email === EMAIL && pendingAfterRequest?.channel === 'fn'
  && pendingAfterRequest.expiresAt > Date.now(), JSON.stringify(pendingAfterRequest));
check('окно ожидания = 2 минуты (как TTL кода на сервере)',
  Math.abs((pendingAfterRequest.expiresAt - pendingAfterRequest.requestedAt) - TTL_MS) < 1000,
  String(pendingAfterRequest?.expiresAt - pendingAfterRequest?.requestedAt));

let res = await m.registration.completeVerification(EMAIL, dbState.issuedCode, PROFILE, { requireProfileFields: true });
check('новый email: вход выполнен', res.ok, res.message || '');
check('новый email: профиль создан (created=true)', res.created === true, String(res.created));

const created = [...dbState.psychologists.values()].find(p => p.email === EMAIL);
check('создан ровно один психолог', [...dbState.psychologists.values()].filter(p => p.email === EMAIL).length === 1);
check('создан ровно один пользователь Supabase Auth', dbState.users.size === 1);
check('owner_id == auth.uid()', !!created && created.owner_id === res.ownerId && !!res.ownerId,
  `${created?.owner_id} vs ${res.ownerId}`);
check('все обязательные поля сохранены: fullName', created?.full_name === PROFILE.fullName, created?.full_name);
check('все обязательные поля сохранены: phone', created?.phone === PROFILE.phone, created?.phone);
check('все обязательные поля сохранены: specialization', created?.specialization === PROFILE.specialization, created?.specialization);
check('все обязательные поля сохранены: city', created?.city === PROFILE.city, created?.city);
check('все обязательные поля сохранены: about', created?.about === PROFILE.about, created?.about);
check('локальное состояние инициализировано (текущий психолог)', m.db.currentPsychologistId === created?.id);
check('сессия зафиксирована (кабинет пишет на сервер)', m.supabaseApi.hasSession() === true);
check('создан authenticated Supabase user (JWT с sub)',
  m.userIdFromToken(m.registration.currentSession()?.access_token) === res.ownerId);
check('после входа ожидание кода очищено', m.registration.pendingVerification() === null);

/* ============================================================================
 * 2. Reload страницы сохраняет аутентификацию
 * ========================================================================== */
const reloadReport = await runReloadCheck(created);
for (const [name, ok, extra] of reloadReport) check(name, ok, extra);
m.registration.signOut();

/* ============================================================================
 * 3. Повторный вход тем же email — дубль не создаётся
 * ========================================================================== */
const again = await loadFreshModules();
await again.registration.requestVerification(EMAIL);
const second = await again.registration.completeVerification(EMAIL, dbState.issuedCode, PROFILE);
check('повторный вход выполнен', second.ok, second.message || '');
check('повторный вход: профиль НЕ создан заново (created=false)', second.created === false, String(second.created));
check('повторный вход: тот же id психолога', second.psychologist?.id === created?.id, `${second.psychologist?.id} vs ${created?.id}`);
check('повторный вход: дублей в БД нет',
  [...dbState.psychologists.values()].filter(p => p.email === EMAIL).length === 1,
  String([...dbState.psychologists.values()].filter(p => p.email === EMAIL).length));
check('повторный вход: owner_id не изменился',
  [...dbState.psychologists.values()].find(p => p.email === EMAIL)?.owner_id === created?.owner_id);

/* ============================================================================
 * 4. Неверный / просроченный / повторно использованный код
 * ========================================================================== */
again.registration.signOut();
const otp = await loadFreshModules();

await otp.registration.requestVerification('wrong.code@example.by');
const badCode = await otp.registration.completeVerification('wrong.code@example.by', 'ZZZZ9999', PROFILE);
check('неверный код: вход отклонён', badCode.ok === false, badCode.message || '');
check('неверный код: понятное сообщение', /неверный|истёк/i.test(badCode.message || ''), badCode.message);
check('неверный код: профиль не создан',
  ![...dbState.psychologists.values()].some(p => p.email === 'wrong.code@example.by'));
check('неверный код: сессия не выдана', otp.supabaseApi.hasSession() === false);

// просроченный код: сдвигаем часы вперёд за пределы TTL
await otp.registration.requestVerification('expired@example.by');
const savedClock = dbState.clock;
dbState.clock = () => Date.now() + TTL_MS + 1000;
const expired = await otp.registration.completeVerification('expired@example.by', dbState.issuedCode, PROFILE);
check('просроченный код: вход отклонён', expired.ok === false, expired.message || '');
check('просроченный код: честное сообщение',
  /истекл|истёк|новый код/i.test(expired.message || ''), expired.message);

// повторное использование кода: новый код НЕ запрашиваем — проверяем, что уже
// погашенный код не принимается второй раз
dbState.clock = savedClock;
await otp.registration.requestVerification('reuse@example.by');
const reuseCode = dbState.issuedCode;
const firstUse = await otp.registration.completeVerification('reuse@example.by', reuseCode, PROFILE);
check('одноразовый код: первое использование принято', firstUse.ok === true, firstUse.message || '');
const secondUse = await otp.registration.verifyVerification('reuse@example.by', reuseCode);
check('повторно использованный код: отклонён', secondUse.ok === false, secondUse.message || '');
check('повторно использованный код: погашен на сервере (used_at)',
  dbState.codes.get('reuse@example.by')?.used === true);
otp.registration.signOut();
check('повторно использованный код: выход гасит сессию', otp.supabaseApi.hasSession() === false);

/* ============================================================================
 * 5. Каналы: нет Edge Function / нет почтовой конфигурации / ошибка RPC
 * ========================================================================== */
const chan = await loadFreshModules();
dbState.fnDeployed = false;
const fallback = await chan.registration.requestVerification('fallback@example.by');
check('нет Edge Function: включён запасной канал Supabase OTP',
  fallback.ok === true && fallback.channel === 'otp', JSON.stringify(fallback));
const fallbackLogin = await chan.registration.completeVerification('fallback@example.by', dbState.issuedCode, PROFILE);
check('нет Edge Function: вход через запасной канал выполнен', fallbackLogin.ok === true, fallbackLogin.message || '');
check('нет Edge Function: профиль создан тем же use case (owner_id задан)',
  [...dbState.psychologists.values()].find(p => p.email === 'fallback@example.by')?.owner_id === fallbackLogin.ownerId);
dbState.fnDeployed = true;

// функция не задеплоена, но браузер вместо 404 показывает CORS-ошибку
// (preflight OPTIONS получает 404 без CORS-заголовков → fetch бросает TypeError
// без статуса) — запасной канал обязан включаться и в этом случае
const cors = await loadFreshModules();
dbState.fnThrows = true;
const corsRes = await cors.registration.requestVerification('cors@example.by');
check('CORS вместо 404: включён запасной канал Supabase OTP',
  corsRes.ok === true && corsRes.channel === 'otp', JSON.stringify(corsRes));
const corsLogin = await cors.registration.completeVerification('cors@example.by', dbState.issuedCode, PROFILE);
check('CORS вместо 404: вход через запасной канал выполнен', corsLogin.ok === true, corsLogin.message || '');
dbState.fnThrows = false;

// issue #23: OTP fallback передаёт emailRedirectTo на реальный APPLICATION_URL (не localhost)
const otpRedirect = await loadFreshModules();
dbState.fnDeployed = false;
dbState.lastOtpBody = null;
await otpRedirect.registration.requestVerification('redir@example.by');
const otpBody = dbState.lastOtpBody || {};
const redirectTarget = String(otpBody.email_redirect_to || otpBody.options?.emailRedirectTo || '');
check('OTP fallback: email_redirect_to задан', !!redirectTarget, JSON.stringify(otpBody));
check('OTP fallback: redirect не localhost',
  redirectTarget && !/localhost|127\.0\.0\.1/i.test(redirectTarget), redirectTarget);
check('OTP fallback: redirect ведёт на #/auth',
  /#\/auth/i.test(redirectTarget), redirectTarget);
dbState.fnDeployed = true;

// issue #23: другое устройство — нет pending, код auth-code всё равно принимается
const deviceA = await loadFreshModules();
await deviceA.registration.requestVerification('crossdev@example.by');
const crossCode = dbState.issuedCode;
// «устройство B»: чистый storage (как другой браузер), тот же сервер
lsMap.clear();
const deviceB = await loadFreshModules();
deviceB.registration.clearPendingVerification();
check('другое устройство: pending на B отсутствует',
  deviceB.registration.pendingVerification() == null
    && deviceB.registration.peekPendingVerification() == null);
const crossLogin = await deviceB.registration.completeVerification('crossdev@example.by', crossCode, PROFILE);
check('другое устройство: код auth-code принят без pending',
  crossLogin.ok === true, crossLogin.message || '');
check('другое устройство: session access_token есть',
  !!deviceB.registration.currentSession()?.access_token
    || deviceB.supabaseApi.hasSession() === true,
  String(!!deviceB.registration.currentSession()?.access_token));
check('другое устройство: owner_id == auth.uid()',
  crossLogin.ownerId
    && [...dbState.psychologists.values()].find(p => p.email === 'crossdev@example.by')?.owner_id === crossLogin.ownerId);
deviceB.registration.signOut();

// issue #23: consumeAuthRedirect — otp_expired hash → честная ошибка, не тихий portal
const redirErr = await loadFreshModules();
globalThis.location = {
  href: 'http://localhost:3000/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=',
  hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=',
  search: '',
  pathname: '/',
  hostname: 'localhost',
  origin: 'http://localhost:3000'
};
const replaced = [];
globalThis.history = { replaceState: (...a) => replaced.push(a) };
const consumedErr = await redirErr.registration.consumeAuthRedirect();
check('auth redirect error: ok=false', consumedErr.ok === false, JSON.stringify(consumedErr));
check('auth redirect error: reason=auth-error', consumedErr.reason === 'auth-error', consumedErr.reason);
check('auth redirect error: friendly otp_expired message',
  /истекл|ссылк/i.test(consumedErr.message || ''), consumedErr.message);
check('auth redirect error: URL очищен (replaceState)', replaced.length >= 1, String(replaced.length));

// issue #23: consumeAuthRedirect — success hash → session → cabinet
const redirOk = await loadFreshModules();
const subOk = uid();
dbState.users.set('linkuser@example.by', { id: subOk });
const access = fakeJwt(subOk, 'linkuser@example.by');
globalThis.location = {
  href: `https://a1dmitry.github.io/Psihologist-cabinet/#access_token=${access}&refresh_token=rt_${subOk}&expires_in=3600&token_type=bearer`,
  hash: `#access_token=${access}&refresh_token=rt_${subOk}&expires_in=3600&token_type=bearer`,
  search: '',
  pathname: '/Psihologist-cabinet/',
  hostname: 'a1dmitry.github.io',
  origin: 'https://a1dmitry.github.io'
};
const replacedOk = [];
globalThis.history = { replaceState: (...a) => replacedOk.push(a) };
const consumedOk = await redirOk.registration.consumeAuthRedirect(PROFILE);
check('auth redirect success: login ok', consumedOk.ok === true, consumedOk.message || JSON.stringify(consumedOk));
check('auth redirect success: psychologist привязан',
  !!consumedOk.psychologist?.id, JSON.stringify(consumedOk.psychologist));
check('auth redirect success: owner_id == sub JWT',
  consumedOk.ownerId === subOk, String(consumedOk.ownerId));
check('auth redirect success: access_token сохранён',
  !!redirOk.registration.currentSession()?.access_token);
redirOk.registration.signOut();

// APPLICATION_URL / resolveApplicationUrl: loopback → canonical Pages URL
const { APPLICATION_URL, resolveApplicationUrl, resolveAuthEntryUrl, isLoopbackHost } =
  await import('../js/services/supabaseConfig.js');
check('APPLICATION_URL задан и не localhost',
  !!APPLICATION_URL && !/localhost|127\.0\.0\.1/i.test(APPLICATION_URL), APPLICATION_URL);
check('isLoopbackHost(localhost)', isLoopbackHost('localhost') === true);
check('isLoopbackHost(pages host)', isLoopbackHost('a1dmitry.github.io') === false);
globalThis.location = { hostname: 'localhost', origin: 'http://localhost:3000', pathname: '/' };
check('resolveApplicationUrl на localhost → APPLICATION_URL',
  resolveApplicationUrl() === APPLICATION_URL || resolveApplicationUrl().startsWith('https://'),
  resolveApplicationUrl());
check('resolveAuthEntryUrl содержит #/auth',
  /#\/auth/.test(resolveAuthEntryUrl()), resolveAuthEntryUrl());

const noMail = await loadFreshModules();
dbState.mailConfigured = false;
const noMailRes = await noMail.registration.requestVerification('nomail@example.by');
check('нет почтовой конфигурации: честная ошибка', noMailRes.ok === false, noMailRes.message || '');
check('нет почтовой конфигурации: ошибка называет RESEND_API_KEY',
  /RESEND_API_KEY/.test(noMailRes.message || ''), noMailRes.message);
check('нет почтовой конфигурации: код не выдан', dbState.codes.get('nomail@example.by') === undefined);
dbState.mailConfigured = true;

const rpc = await loadFreshModules();
dbState.rpcFails = true;
await rpc.registration.requestVerification('rpcfail@example.by');
const rpcRes = await rpc.registration.completeVerification('rpcfail@example.by', dbState.issuedCode, PROFILE);
check('ошибка RPC: вход не завершён', rpcRes.ok === false, rpcRes.message || '');
check('ошибка RPC: ошибка показана пользователю (не тихий успех)',
  /сервер/i.test(rpcRes.message || ''), rpcRes.message);
check('ошибка RPC: локальный кабинет не открыт', rpc.db.currentPsychologistId === null || rpc.db.currentPsychologistId !== undefined && !rpc.db.currentPsychologist?.email?.includes('rpcfail'));
dbState.rpcFails = false;

/* ============================================================================
 * 6. Безопасность: ownership не из email; коды не логируются
 * ========================================================================== */
const sec = await loadFreshModules();
sec.registration.signOut(); // сессии нет: владение не может взяться из воздуха
const notVerified = await sec.registration.claimOrCreatePsychologist('someone.else@example.by', PROFILE);
check('без аутентификации профиль не создаётся', notVerified.ok === false, notVerified.message || '');
check('без аутентификации: профиля нет в БД',
  ![...dbState.psychologists.values()].some(p => p.email === 'someone.else@example.by'));

console.log = (...args) => logLines.push(args.join(' '));
await (await loadFreshModules()).registration.requestVerification('logcheck@example.by');
const logCode = dbState.issuedCode;
await (await loadFreshModules()).registration.completeVerification('logcheck@example.by', logCode, PROFILE);
console.log = realConsoleLog;
check('одноразовый код не попадает в логи', !logLines.some(l => l.includes(logCode)), logLines.join(' | '));

/* ============================================================================
 * 6b. Pending-канал (issue #14, п.3): никакого самовольного переключения
 * ========================================================================== */
const pend = await loadFreshModules();
pend.registration.signOut();
pend.registration.clearPendingVerification();
const mark = logCalls.length;
const lostState = await pend.registration.verifyVerification('nobody@example.by', 'ABCD2345');
const lostSlice = logCalls.slice(mark);
check('потерянное состояние: код не принимается', lostState.ok === false, lostState.message || '');
check('потерянное состояние: понятное сообщение «запросите новый код»',
  /новый код/i.test(lostState.message || ''), lostState.message);
// issue #23: без pending — только auth-code (different-device), OTP-перебор запрещён.
check('потерянное состояние: OTP-канал не перебирается',
  !lostSlice.some(u => u.includes('/auth/v1/otp')), lostSlice.join(' | '));
check('потерянное состояние: ровно один auth-code, без GoTrue verify',
  lostSlice.filter(u => u.includes('/functions/v1/auth-code')).length === 1
    && !lostSlice.some(u => u.includes('/auth/v1/verify')),
  lostSlice.join(' | '));

// код выслан на один email — проверяем другой: транспорт не подменяется
await pend.registration.requestVerification('owner@example.by');
const otherEmail = await pend.registration.verifyVerification('intruder@example.by', 'ABCD2345');
check('чужой email: проверка отклонена до обращения к серверу',
  otherEmail.ok === false && /owner@example\.by/.test(otherEmail.message || ''), otherEmail.message);

// истёкшее окно: состояние выбрасывается, код на сервере не тратится
await pend.registration.requestVerification('window@example.by');
const pendingKey = Object.keys(localStorageSnapshot()).find(k => k.includes('pending_verification'));
lsMap.set(pendingKey, JSON.stringify({
  email: 'window@example.by',
  channel: 'fn',
  requestedAt: Date.now() - TTL_MS - 60e3,
  expiresAt: Date.now() - 60e3
}));
const callsBeforeWindow = logCalls.length;
const expiredWindow = await pend.registration.verifyVerification('window@example.by', 'ABCD2345');
check('истёкшее окно: честная ошибка вместо подбора транспорта',
  expiredWindow.ok === false && /истекло|новый код/i.test(expiredWindow.message || ''), expiredWindow.message);
check('истёкшее окно: сохранённое ожидание сброшено', pend.registration.pendingVerification() === null);
check('истёкшее окно: код на сервере не тратился', logCalls.length === callsBeforeWindow,
  logCalls.slice(callsBeforeWindow).join(' | '));
pend.registration.signOut();

// перезагрузка страницы между «получить код» и «ввести код»
const pendingReloadReport = await runPendingReloadCheck(EMAIL);
for (const [name, isOk, extra] of pendingReloadReport) check(name, isOk, extra);

/* ============================================================================
 * 7. Валидация обязательных полей — одна реализация
 * ========================================================================== */
check('валидация: пустое имя отклоняется', !!m.registration.validateProfile({ ...PROFILE, fullName: '' }, { required: true }));
check('валидация: пустой about отклоняется', !!m.registration.validateProfile({ ...PROFILE, about: '' }, { required: true }));
check('валидация: полный профиль принят', m.registration.validateProfile(PROFILE, { required: true }) === '');
check('валидация: код 5 символов отклоняется', !!m.registration.validateCode('AB123'));
check('валидация: код 8 символов принят', m.registration.validateCode('ABCD2345') === '');
check('валидация: email без домена отклоняется', !!m.registration.validateEmail('natalia@'));

/* ============================================================================
 * 8. Пароль сейфа с формы регистрации (issue #14, п.7 — challenger-находка:
 *    поле собиралось, но нигде не использовалось — сейф оставался незадатым)
 * ========================================================================== */
const vault = await loadFreshModules();
vault.registration.signOut();
vault.registration.clearPendingVerification();

// короткий пароль: честный отказ ДО обращения к серверу — код не сжигается
await vault.registration.requestVerification('vault.short@example.by');
const verifyCallsBefore = logCalls.filter(u => u.includes('/auth/v1/verify')).length;
const shortPw = await vault.authService.verifyCode('vault.short@example.by', dbState.issuedCode, PROFILE, 'abc');
check('пароль сейфа короче 6 символов: отказ до обращения к серверу',
  shortPw.ok === false && /минимум 6/i.test(shortPw.message || ''), shortPw.message);
check('пароль сейфа короче 6 символов: одноразовый код не сожжён (verify не вызывался)',
  logCalls.filter(u => u.includes('/auth/v1/verify')).length === verifyCallsBefore);

// корректный пароль: сейф создаётся и открывается тем же паролем
console.log = (...args) => logLines.push(args.join(' '));
await vault.registration.requestVerification('vault@example.by');
const withPw = await vault.authService.verifyCode('vault@example.by', dbState.issuedCode, PROFILE, 'Доверие-2026');
console.log = realConsoleLog;
check('пароль сейфа с формы: вход выполнен', withPw.ok === true, withPw.message || '');
check('пароль сейфа с формы: сообщение об открытом сейфе',
  /Сейф клиентов создан и открыт/.test(withPw.message || ''), withPw.message);
const vaultPsy = vault.db.currentPsychologist;
check('пароль сейфа с формы: keyVerifier задан', !!vaultPsy?.keyVerifier, JSON.stringify(vaultPsy?.keyVerifier || null));
check('пароль сейфа с формы: сейф открыт в памяти',
  vault.cryptoService.isUnlocked(vaultPsy.id) === true);
vault.cryptoService.lock(vaultPsy.id);
check('пароль сейфа с формы: после блокировки открывается тем же паролем',
  (await vault.cryptoService.unlock(vaultPsy.id, 'Доверие-2026', vaultPsy.keyVerifier)) === true);
vault.cryptoService.lock(vaultPsy.id);
check('пароль сейфа с формы: чужой пароль сейф не открывает',
  (await vault.cryptoService.unlock(vaultPsy.id, 'другой-пароль', vaultPsy.keyVerifier)) === false);
const serverPsy = [...dbState.psychologists.values()].find(p => p.email === 'vault@example.by');
check('пароль сейфа с формы: verifier отправлен на сервер (pushKeyVerifier)',
  serverPsy?.key_verifier?.salt === vaultPsy.keyVerifier.salt, String(serverPsy?.key_verifier?.salt));

/* —— «Другое устройство»: localStorage пуст, серверное состояние сохранено.
 *    Вход тем же email обязан подтянуть verifier с сервера и открыть сейф
 *    тем же паролем (без этого очистка хранилища = потеря доступа к сейфу,
 *    а повторный init создал бы новую соль и несовместимый ключ). —— */
lsMap.clear();
const newDevice = await loadFreshModules();
await newDevice.registration.requestVerification('vault@example.by');
const ndRes = await newDevice.authService.verifyCode('vault@example.by', dbState.issuedCode, PROFILE, 'Доверие-2026');
check('другое устройство: вход выполнен', ndRes.ok === true, ndRes.message || '');
check('другое устройство: verifier восстановлен с сервера (не создан заново)',
  newDevice.db.currentPsychologist?.keyVerifier?.salt === vaultPsy.keyVerifier.salt,
  `${newDevice.db.currentPsychologist?.keyVerifier?.salt} vs ${vaultPsy.keyVerifier.salt}`);
check('другое устройство: сейф открыт прежним паролем',
  newDevice.cryptoService.isUnlocked(ndRes.psychologist.id) === true);
check('другое устройство: сообщение «открыт» (не «создан»)',
  /Сейф клиентов открыт\./.test(ndRes.message || ''), ndRes.message);

// пустой пароль — допустимая опция: сейф остаётся незадатым, сообщение честное
const noPw = await loadFreshModules();
await noPw.registration.requestVerification('vault.empty@example.by');
const emptyRes = await noPw.authService.verifyCode('vault.empty@example.by', dbState.issuedCode, PROFILE, '');
check('без пароля сейфа: вход выполнен', emptyRes.ok === true, emptyRes.message || '');
check('без пароля сейфа: keyVerifier не задан', !noPw.db.currentPsychologist?.keyVerifier);
check('без пароля сейфа: сообщение предлагает задать пароль во вкладке «Клиенты»',
  /Клиенты/i.test(emptyRes.message || ''), emptyRes.message);

// claim существующего кабинета (register-режим + существующий email):
// пароль с формы НЕ подменяет verifier, а только открывает сейф
const claim = await loadFreshModules();
await claim.registration.requestVerification('vault@example.by');
const claimRes = await claim.authService.verifyCode('vault@example.by', dbState.issuedCode, PROFILE, 'Доверие-2026');
check('повторная регистрация тем же email: вход выполнен', claimRes.ok === true, claimRes.message || '');
check('повторная регистрация тем же email: verifier не подменён',
  claim.db.currentPsychologist?.keyVerifier?.salt === vaultPsy.keyVerifier.salt);
check('повторная регистрация тем же email: сейф открыт верным паролем',
  claim.cryptoService.isUnlocked(claimRes.psychologist.id) === true);

// пароль сейфа не попадает в логи
check('пароль сейфа не попадает в логи', !logLines.some(l => l.includes('Доверие-2026')),
  logLines.filter(l => l.includes('Доверие')).join(' | '));

/* ============================================================================
 * 9. Отключённый аккаунт и абсолютный срок сессии (issue #40 п.7–8 / #46 TASK 3)
 * ========================================================================== */
const SESSION_LS_KEY = 'psy_auth_session_v1';
const act = await loadFreshModules();
act.registration.signOut();
await act.registration.requestVerification(EMAIL);
const activeLogin = await act.registration.completeVerification(EMAIL, dbState.issuedCode, PROFILE);
check('контроль: активный аккаунт входит', activeLogin.ok === true, activeLogin.message || '');
const target = [...dbState.psychologists.values()].find(p => p.email === EMAIL);

// владелец отключил кабинет (в проде это service_role, не сам пользователь)
target.is_active = false;

// 9.1 Живая сессия после отключения аккаунта доступ не даёт
const afterDisable = await act.registration.restoreAuthenticatedState();
check('отключённый аккаунт: живая сессия кабинет не открывает',
  afterDisable.authenticated === false && afterDisable.reason === 'inactive', JSON.stringify(afterDisable));
check('отключённый аккаунт: причина показана пользователю',
  /отключена/i.test(afterDisable.message || ''), afterDisable.message);
check('отключённый аккаунт: currentPsychologist сброшен',
  act.db.currentPsychologistId == null, String(act.db.currentPsychologistId));

// 9.2 Повторный вход не реактивирует аккаунт
await act.registration.requestVerification(EMAIL);
const inactiveLogin = await act.registration.completeVerification(EMAIL, dbState.issuedCode, PROFILE);
check('отключённый аккаунт: вход отклонён', inactiveLogin.ok === false, inactiveLogin.message || '');
check('отключённый аккаунт: is_active входом НЕ изменён', target.is_active === false, String(target.is_active));
check('отключённый аккаунт: сессия не оставлена на клиенте',
  act.supabaseApi.hasSession() === false, String(act.supabaseApi.hasSession()));
check('отключённый аккаунт: дубль профиля не создан',
  [...dbState.psychologists.values()].filter(p => p.email === EMAIL).length === 1,
  String([...dbState.psychologists.values()].filter(p => p.email === EMAIL).length));

// 9.3 Реактивация владельцем возвращает доступ к ТОМУ ЖЕ кабинету
target.is_active = true;
await act.registration.requestVerification(EMAIL);
const reactivated = await act.registration.completeVerification(EMAIL, dbState.issuedCode, PROFILE);
check('реактивация: вход снова работает', reactivated.ok === true, reactivated.message || '');
check('реактивация: тот же психолог (без дубля)',
  reactivated.psychologist?.id === target.id, `${reactivated.psychologist?.id} vs ${target.id}`);

// 9.4 Абсолютный срок сессии — месяц, продление refresh-токеном его не удлиняет
const aged = JSON.parse(lsMap.get(SESSION_LS_KEY));
check('сессия хранит отметку первой выдачи (issued_at)',
  Number.isFinite(Number(aged?.issued_at)) && Number(aged.issued_at) > 0, JSON.stringify(aged?.issued_at));
const agedSession = { ...aged, issued_at: Math.floor(Date.now() / 1000) - (31 * 24 * 3600) };
lsMap.set(SESSION_LS_KEY, JSON.stringify(agedSession));
const tooOld = await act.registration.restoreAuthenticatedState();
check('сессия старше месяца: доступ закрыт',
  tooOld.authenticated === false && tooOld.reason === 'session-max-age', JSON.stringify(tooOld));
check('сессия старше месяца: честно объяснено', /30 дней|старше/i.test(tooOld.message || ''), tooOld.message);
check('сессия старше месяца: сохранённая сессия удалена', lsMap.get(SESSION_LS_KEY) == null);
check('сессия на 29-й день ещё жива (граница — месяц, не меньше)',
  act.registration.isBeyondMaxSessionAge({ issued_at: Math.floor(Date.now() / 1000) - (29 * 24 * 3600) }) === false);
check('без отметки issued_at — fail-closed (возраст недоказуем)',
  act.registration.isBeyondMaxSessionAge({ access_token: aged.access_token }) === true);

/* ============================================================================
 * 10. Оба входа — ОДНА canonical-сессия и ОДИН профиль (issue #46, TASK 3)
 *     Существующий сценарий consumeAuthRedirect брал ДРУГОЙ email, поэтому
 *     главный инвариант задачи («manual OTP и email link разрешают одного
 *     психолога, дубль не создаётся») до этого не проверялся.
 * ========================================================================== */
const dual = await loadFreshModules();
dual.registration.signOut();
await dual.registration.requestVerification(EMAIL);
const byCode = await dual.registration.completeVerification(EMAIL, dbState.issuedCode, PROFILE);
check('два входа: вход по коду выполнен', byCode.ok === true, byCode.message || '');

// тот же Supabase-пользователь (тот же sub) приходит по ссылке из письма
const sameSub = dbState.users.get(EMAIL)?.id;
const linkJwt = fakeJwt(sameSub, EMAIL);
globalThis.location = {
  href: `https://a1dmitry.github.io/Psihologist-cabinet/#access_token=${linkJwt}&refresh_token=rt_${sameSub}&expires_in=3600&token_type=bearer`,
  hash: `#access_token=${linkJwt}&refresh_token=rt_${sameSub}&expires_in=3600&token_type=bearer`,
  search: '',
  pathname: '/Psihologist-cabinet/',
  hostname: 'a1dmitry.github.io',
  origin: 'https://a1dmitry.github.io'
};
globalThis.history = { replaceState() {} };
const byLink = await dual.registration.consumeAuthRedirect(PROFILE);
check('два входа: вход по ссылке из письма выполнен', byLink.ok === true,
  byLink.message || JSON.stringify(byLink));
check('два входа: ТОТ ЖЕ psychologist.id (одна identity на оба входа)',
  byLink.psychologist?.id === byCode.psychologist?.id,
  `${byLink.psychologist?.id} vs ${byCode.psychologist?.id}`);
check('два входа: один и тот же owner_id == auth.uid()',
  byLink.ownerId === byCode.ownerId && byLink.ownerId === sameSub,
  `${byLink.ownerId} vs ${byCode.ownerId} vs ${sameSub}`);
check('два входа: дубль профиля НЕ создан',
  [...dbState.psychologists.values()].filter(p => p.email === EMAIL).length === 1,
  String([...dbState.psychologists.values()].filter(p => p.email === EMAIL).length));
check('два входа: сессия одна и та же по sub (нет второго токена входа)',
  dual.userIdFromToken(dual.registration.currentSession()?.access_token) === sameSub);

const failed = results.filter(r => !r[1]).length;
realConsoleLog(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);

/* ============================================================================
 * Reload как отдельный процесс
 * ========================================================================== */

/**
 * Перезагрузка МЕЖДУ «получить код» и «ввести код»: в живом процессе остаётся
 * только localStorage, память модулей чистая. Проверяем, что выбранный канал
 * доставки восстановился и код проверяется именно им (без перебора).
 */
async function runPendingReloadCheck(email) {
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync, rmSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');

  const fresh = await loadFreshModules();
  fresh.registration.signOut();
  fresh.registration.clearPendingVerification();
  const requested = await fresh.registration.requestVerification(email);
  if (!requested.ok) return [['reload до ввода кода: код запрошен', false, requested.message]];

  const snap = fileURLToPath(new URL('./.pending-snapshot.json', import.meta.url));
  writeFileSync(snap, JSON.stringify({
    storage: [...lsMap.entries()],
    email,
    code: dbState.issuedCode,
    profile: PROFILE,
    server: {
      codes: [...dbState.codes.entries()],
      users: [...dbState.users.entries()],
      psychologists: [...dbState.psychologists.entries()]
    }
  }));
  try {
    const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--pending', snap], { encoding: 'utf8' });
    const text = `${out.stdout || ''}${out.stderr || ''}`;
    const parsed = /PENDING_RESULT (\[.*\])/s.exec(text);
    if (!parsed) return [['reload до ввода кода: дочерняя проверка отработала', false, text.slice(0, 400)]];
    return JSON.parse(parsed[1]);
  } finally {
    rmSync(snap, { force: true });
  }
}

/**
 * Перезагрузка страницы: сохраняем localStorage, поднимаем НОВЫЙ процесс
 * (память модулей чистая, токен в supabaseApi пустой — ровно как после F5)
 * и проверяем, что аутентификация восстановилась из сохранённой сессии.
 */
async function runReloadCheck(created) {
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync, rmSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const snap = fileURLToPath(new URL('./.reload-snapshot.json', import.meta.url));
  writeFileSync(snap, JSON.stringify({
    storage: [...lsMap.entries()],
    created,
    server: {
      users: [...dbState.users.entries()],
      psychologists: [...dbState.psychologists.entries()]
    }
  }));
  try {
    const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--restore', snap], {
      encoding: 'utf8'
    });
    const text = `${out.stdout || ''}${out.stderr || ''}`;
    const parsed = /RELOAD_RESULT (\[.*\])/s.exec(text);
    if (!parsed) return [['reload: дочерняя проверка отработала', false, text.slice(0, 400)]];
    return JSON.parse(parsed[1]);
  } finally {
    rmSync(snap, { force: true });
  }
}
