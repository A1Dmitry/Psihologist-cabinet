#!/usr/bin/env node
/**
 * Смоук серверной авторизации и серверного кабинета (мок Supabase):
 *   node verify_auth.mjs
 * Проверяет: свой код входа (Edge Function auth-code: 6–8 букв/цифр, uppercase,
 * hashed_token → сессия, честные ошибки без magic-link), запасной OTP-канал
 * (create_user, перебор type при verify), окно 2 минуты, claim → вход,
 * pull кабинета, write-through задач/заметок/блокировок.
 */
const calls = [];
const state = { otpTypes: [], verifyTypes: [], verifyHashes: [], claimCalls: 0, fnMode: 'missing', fnRequests: [], fnVerify: [] };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push(u);
  if (u.endsWith('/auth/v1/otp')) {
    state.otpTypes.push(body);
    if (body.email === 'busy@x.by') return resp(429, { msg: 'over_email_send_rate_limit' });
    return resp(200, {});
  }
  if (u.endsWith('/auth/v1/verify')) {
    if (body.token_hash) {
      // сессия по hashed_token (канал auth-code)
      state.verifyHashes.push(body.token_hash);
      if (body.token_hash === 'ht_1') return resp(200, { access_token: 'jwt-fn', refresh_token: 'r-fn' });
      return resp(400, { msg: 'Invalid token_hash' });
    }
    state.verifyTypes.push(body.type);
    if (body.token === '000000') return resp(400, { msg: 'Invalid token' });
    if (body.token === '111111') {
      // принимает только magiclink
      if (body.type === 'magiclink') return resp(200, { access_token: 'jwt-1', refresh_token: 'r1' });
      return resp(400, { msg: 'Invalid type' });
    }
    if (body.token === '222222') {
      // magiclink отклонён, signup — ок (новый пользователь)
      if (body.type === 'signup') return resp(200, { access_token: 'jwt-2', refresh_token: 'r2' });
      return resp(400, { msg: 'Invalid type' });
    }
    return resp(400, { msg: 'Invalid token' });
  }
  if (u.includes('/functions/v1/auth-code')) {
    // Edge Function auth-code: свой код в БД (письмо через Resend)
    if (state.fnMode === 'missing') return resp(404, { msg: 'Function not found' });
    // 'cors': функция не задеплоена → preflight OPTIONS получает 404 без
    // CORS-заголовков → браузер бросает TypeError и статус прочитать нельзя
    if (state.fnMode === 'cors') throw new TypeError('Failed to fetch');
    state.fnRequests.push(body);
    if (body.action === 'request') {
      if (body.email === 'noresend@x.by') return resp(500, { ok: false, error: 'Почта не настроена: задайте секрет RESEND_API_KEY (supabase secrets set RESEND_API_KEY=re_...)' });
      if (body.email === 'ratelimit@x.by') return resp(429, { ok: false, error: 'Слишком часто: подождите около 30 секунд' });
      return resp(200, { ok: true, ttl_seconds: 120 });
    }
    if (body.action === 'verify') {
      state.fnVerify.push(body.code);
      if (body.code === 'ABCD2345') return resp(200, { ok: true, hashed_token: 'ht_1' });
      return resp(400, { ok: false, error: 'Неверный код' });
    }
    return resp(400, { ok: false, error: 'Неизвестное действие' });
  }
  if (u.includes('/rpc/claim_psychologist_profile')) {
    state.claimCalls++;
    return resp(200, { ok: true, id: 'psy_test_1' });
  }
  if (u.includes('psychologists?id=eq.psy_test_1')) {
    return resp(200, [{ id: 'psy_test_1', email: 'doc@x.by', full_name: 'Док Тестов', slug: 'dok-testov', is_active: true, created_at: '2026-01-01T00:00:00Z' }]);
  }
  // кабинет: pull / write-through
  if (u.includes('/rest/v1/tasks')) {
    if (opts.method === 'POST') return resp(201, [{ id: 'task_srv_1', ...body }]);
    if (opts.method === 'PATCH') return resp(200, []);
    if (opts.method === 'DELETE') return resp(204, null);
    return resp(200, [{ id: 'task_srv_0', psychologist_id: 'psy_test_1', title: 'Серверная задача', done: false, created_at: '2026-01-01T00:00:00Z' }]);
  }
  if (u.includes('/rest/v1/psy_notes')) {
    if (opts.method === 'POST') return resp(201, [{ id: 'note_srv_1', ...body }]);
    return resp(200, []);
  }
  if (u.includes('/rest/v1/schedule_blocks')) {
    if (opts.method === 'POST') return resp(201, [{ id: 'blk_srv_1', ...body }]);
    if (opts.method === 'DELETE') return resp(204, null);
    return resp(200, []);
  }
  if (u.includes('/rest/v1/clients')) return resp(200, [{ id: 'cli_srv_1', psychologist_id: 'psy_test_1', name: '', nickname: 'Anna_G', phone: '', created_at: '2026-01-01T00:00:00Z' }]);
  if (u.includes('/rest/v1/sessions')) {
    if (opts.method === 'POST') return resp(201, [{ id: 'ses_srv_1', ...body }]);
    if (opts.method === 'PATCH') return resp(200, []);
    return resp(200, []);
  }
  if (u.includes('/rest/v1/session_settings')) return resp(200, [{ psychologist_id: 'psy_test_1', work_hours: 'Пн–Пт 10:00–18:00' }]);
  if (u.includes('/rest/v1/client_entries')) {
    if (opts.method === 'POST') return resp(201, [{ id: 'ent_srv_1', ...body }]);
    return resp(200, []);
  }
  if (u.includes('/rest/v1/waiting_items')) return resp(200, []);
  if (u.includes('/rest/v1/')) return resp(200, []);
  return resp(404, { msg: 'nf' });

  function resp(status, json) {
    return {
      ok: status < 400, status,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(json),
      json: async () => json
    };
  }
};

// ——— DOM-заглушки ———
function fakeEl() {
  const t = function(){};
  return new Proxy(t, { get(_, p) {
    if (p === 'classList') return { add(){},remove(){},toggle(){},contains(){return false;} };
    if (p === 'style' || p === 'dataset') return {};
    if (['value','textContent','innerHTML','src','href','id','className'].includes(p)) return '';
    if (p === 'querySelectorAll') return () => [];
    if (p === 'querySelector') return () => fakeEl();
    if (['addEventListener','removeEventListener','appendChild','setAttribute','scrollIntoView','remove'].includes(p)) return () => {};
    if (p === 'getAttribute') return () => null;
    if (p === 'closest') return () => null;
    if (p === Symbol.toPrimitive) return () => '';
    return fakeEl();
  }, set(){return true;}, apply(){return fakeEl();} });
}
const listeners = {};
globalThis.document = { title:'', head:fakeEl(), body:fakeEl(), documentElement:fakeEl(), hidden:false,
  querySelector:()=>fakeEl(), querySelectorAll:()=>[], getElementById:()=>fakeEl(), createElement:()=>fakeEl(),
  addEventListener:(n,f)=>{(listeners[n] ||= []).push(f);}, removeEventListener:()=>{} };
const lsMap = new Map();
globalThis.localStorage = { get:k=>lsMap.get(k)??null, set:(k,v)=>lsMap.set(k,String(v)), remove:k=>lsMap.delete(k), clear:()=>lsMap.clear() };
const loc = { pathname:'/', search:'', hash:'', origin:'http://x' };
globalThis.window = new Proxy({ localStorage: globalThis.localStorage, addEventListener:(n,f)=>{(listeners['w:'+n] ||= []).push(f);}, scrollTo:()=>{}, location: loc },
  { get(t,p){ return p in t ? t[p] : fakeEl(); }, set(){return true;} });
globalThis.location = loc; globalThis.history = { pushState(){}, replaceState(){} };
Object.defineProperty(globalThis,'navigator',{value:{userAgent:'t',clipboard:{writeText:async()=>{}}}});
globalThis.confirm=()=>true; globalThis.alert=()=>{}; globalThis.prompt=()=>'x';
globalThis.FileReader=class{};

const { authVm, cabinetVm } = await import(new URL('./js/app.js', 'file://' + process.cwd() + '/').href);
const { authService } = await import(new URL('./js/services/authService.js', 'file://' + process.cwd() + '/').href);
const { db } = await import(new URL('./js/core/dbContext.js', 'file://' + process.cwd() + '/').href);
const { cabinetApi } = await import(new URL('./js/services/cabinetApi.js', 'file://' + process.cwd() + '/').href);

const checks = [];
const ok = (n, c) => checks.push([n, !!c]);

// —— OTP протокол ——
let r = await authVm.requestCode();
ok('invalid email → error', r === false && /корректн/.test(authVm.error));
authVm.email = 'busy@x.by';
await authVm.requestCode();
ok('rate limit message', /Слишком часто/.test(authVm.error));
authVm.email = 'doc@x.by';
r = await authVm.requestCode();
ok('otp sent → step code', r === true && authVm.step === 'code');
ok('otp create_user:true', state.otpTypes.every(b => b.create_user === true));
ok('resend window 120s', authVm.resendIn === 120);

// —— verify: перебор type ——
authVm.code = '000000';
await authVm.confirmCode();
ok('wrong code → error', /Код неверный|не принял/.test(authVm.error));
authVm.code = '111111';
authVm.mode = 'register'; authVm.fullName = 'Док Тестов';
const psy = await authVm.confirmCode();
ok('verify (magiclink) → psychologist', !!psy && psy.id === 'psy_test_1');
ok('isAuthenticated', authService.isAuthenticated());
ok('token установлен (кабинет пишет на сервер)', cabinetApi.enabled());

// —— pull кабинета с сервера ——
await cabinetApi.refresh('psy_test_1');
ok('pull: серверная задача в зеркале', db.tasks.some(t => t.id === 'task_srv_0'));
ok('pull: клиент-привязка в зеркале', db.clients.some(c => c.id === 'cli_srv_1'));

// —— write-through ——
db.currentPsychologistId = 'psy_test_1';
cabinetVm.addTask({ title: 'Позвонить Анне', dueDate: '2026-09-30' });
await new Promise(rs => setTimeout(rs, 10));
ok('task POST на сервер', calls.some(u => u.includes('/rest/v1/tasks')));
ok('серверный id подставлен', db.tasks.some(t => t.id === 'task_srv_1'));
cabinetVm.addNote({ body: 'План недели' });
await new Promise(rs => setTimeout(rs, 10));
ok('note POST на сервер', calls.some(u => u.includes('/rest/v1/psy_notes')));
cabinetVm.addBlock({ dateFrom: '2026-10-01', kind: 'day_off', title: 'Выходной' });
await new Promise(rs => setTimeout(rs, 10));
ok('block POST на сервер', calls.some(u => u.includes('/rest/v1/schedule_blocks')));

// —— фолбэк type: magiclink отклонён → signup принят (новый пользователь) ——
authService.logout();
authVm.step = 'email'; authVm.error = ''; authVm.email = 'new@x.by'; authVm.code = '';
// код обязателен до шага ввода: канал доставки фиксируется в ожидании
// (safeStorage) и переживает перезагрузку — см. domain/registration
r = await authVm.requestCode();
ok('otp: код запрошен до шага ввода', r === true && authVm.step === 'code');
authVm.code = '222222';
state.verifyTypes = [];
const psy2 = await authVm.confirmCode();
ok('verify fallback signup → psychologist', !!psy2 && psy2.id === 'psy_test_1');
ok('type chain magiclink→signup', state.verifyTypes.includes('magiclink') && state.verifyTypes.includes('signup'));

// —— собственный код входа: Edge Function auth-code (письмо через Resend) ——
state.fnMode = 'on';
authService.logout();
authVm.step = 'email'; authVm.error = ''; authVm.email = 'doc@x.by'; authVm.code = ''; authVm.mode = 'login';
r = await authVm.requestCode();
ok('fn: код отправлен через auth-code', r === true && state.fnRequests.length === 1 && state.fnRequests[0].action === 'request' && state.fnRequests[0].email === 'doc@x.by');
ok('fn: канал fn + окно 120с', authService.channel === 'fn' && authVm.resendIn === 120);

authVm.code = 'AB12'; // 4 символа
const badPsy = await authVm.confirmCode();
ok('fn: код короче 6 символов отклонён', badPsy === null && /6–8/.test(authVm.error));

authVm.code = 'abcd2345'; // нижний регистр → нормализация в uppercase
const psyFn = await authVm.confirmCode();
ok('fn: код → hashed_token → сессия браузера', !!psyFn && psyFn.id === 'psy_test_1' && authService.session?.access_token === 'jwt-fn');
ok('fn: сессия по token_hash (magiclink)', state.verifyHashes.includes('ht_1'));

authService.logout();
authVm.step = 'email'; authVm.error = ''; authVm.email = 'noresend@x.by'; authVm.code = '';
r = await authVm.requestCode();
ok('fn: RESEND_API_KEY не задан → честная ошибка, не magic-link', r === false && /RESEND_API_KEY/.test(authVm.error));

authVm.email = 'ratelimit@x.by'; authVm.error = '';
r = await authVm.requestCode();
ok('fn: 30-сек кулдаун → честная ошибка', r === false && /30 секунд/.test(authVm.error));

authVm.email = 'doc@x.by'; authVm.error = '';
await authVm.requestCode();
authVm.code = 'WRONG01';
await authVm.confirmCode();
ok('fn: неверный код → понятная ошибка', /Код неверный|Неверный код/.test(authVm.error));

// —— функция не задеплоена: браузер видит CORS-ошибку (TypeError без статуса) ——
state.fnMode = 'cors';
authService.logout();
authVm.step = 'email'; authVm.error = ''; authVm.email = 'doc@x.by'; authVm.code = ''; authVm.mode = 'login';
const { registration } = await import(new URL('./js/domain/registration.js', 'file://' + process.cwd() + '/').href);
const direct = await registration.requestVerification('doc@x.by');
ok('cors: TypeError вместо 404 → запасной канал OTP, сообщение называет канал',
  direct.ok === true && direct.channel === 'otp' && /запасной канал/.test(direct.message));
const otpCallsBefore = state.otpTypes.length;
r = await authVm.requestCode();
ok('cors: «Получить код» работает (не «Failed to fetch»)',
  r === true && state.otpTypes.length === otpCallsBefore + 1 && authService.channel === 'otp');
authVm.code = '111111';
const psyOtp = await authVm.confirmCode();
ok('cors: вход по OTP-коду после переключения канала', !!psyOtp && psyOtp.id === 'psy_test_1');
state.fnMode = 'on';

let failed = 0;
for (const [n, p] of checks) { console.log((p ? 'PASS' : 'FAIL') + '  ' + n); if (!p) failed++; }
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
