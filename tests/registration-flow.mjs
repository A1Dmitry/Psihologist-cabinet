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
const TTL_MS = 2 * 60e3;
const dbState = {
  users: new Map(),        // email -> { id }
  psychologists: new Map(),// id -> row
  codes: new Map(),        // email -> { code, expiresAt, used, attempts }
  fnDeployed: true,
  mailConfigured: true,
  rpcFails: false,
  issuedCode: null,
  clock: () => Date.now()
};

function uid() {
  return 'uid_' + Math.random().toString(36).slice(2, 10);
}

/** Неподписанный JWT с `sub` — подписи в фейке нет, нам нужен только auth.uid(). */
function fakeJwt(sub) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
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

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};

  // —— Edge Function auth-code ——
  if (u.includes('/functions/v1/auth-code')) {
    if (!dbState.fnDeployed) return resp(404, { msg: 'Function not found' });
    if (body.action === 'request') {
      if (!dbState.mailConfigured) {
        return resp(500, { ok: false, error: 'Почта не настроена: задайте секрет RESEND_API_KEY (supabase secrets set RESEND_API_KEY=re_...)' });
      }
      const code = 'ABCD2345';
      dbState.issuedCode = code;
      dbState.codes.set(body.email, {
        code,
        expiresAt: dbState.clock() + TTL_MS,
        used: false,
        attempts: 0
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
      rec.used = true; // одноразовость
      if (!dbState.users.has(body.email)) dbState.users.set(body.email, { id: uid() });
      const sub = dbState.users.get(body.email).id;
      return resp(200, { ok: true, hashed_token: 'ht_' + sub });
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
        access_token: fakeJwt(sub),
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
      access_token: fakeJwt(sub),
      refresh_token: 'rt_' + sub,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer'
    });
  }
  if (u.includes('/auth/v1/otp')) {
    if (!dbState.mailConfigured) return resp(500, { msg: 'mail not configured' });
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
  return { registration, supabaseApi, userIdFromToken, cabinetApi, db, authService };
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
check('просроченный код: честное сообщение', /истёк/i.test(expired.message || ''), expired.message);

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
 * 7. Валидация обязательных полей — одна реализация
 * ========================================================================== */
check('валидация: пустое имя отклоняется', !!m.registration.validateProfile({ ...PROFILE, fullName: '' }, { required: true }));
check('валидация: пустой about отклоняется', !!m.registration.validateProfile({ ...PROFILE, about: '' }, { required: true }));
check('валидация: полный профиль принят', m.registration.validateProfile(PROFILE, { required: true }) === '');
check('валидация: код 5 символов отклоняется', !!m.registration.validateCode('AB123'));
check('валидация: код 8 символов принят', m.registration.validateCode('ABCD2345') === '');
check('валидация: email без домена отклоняется', !!m.registration.validateEmail('natalia@'));

const failed = results.filter(r => !r[1]).length;
realConsoleLog(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);

/* ============================================================================
 * Reload как отдельный процесс
 * ========================================================================== */

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
