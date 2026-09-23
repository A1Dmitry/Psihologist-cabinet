#!/usr/bin/env node
/**
 * Смоук серверной авторизации и серверного кабинета (мок Supabase):
 *   node verify_auth.mjs
 * Проверяет: OTP (create_user), перебор type при verify, окно 2 минуты,
 * claim → вход, pull кабинета, write-through задач/заметок/блокировок.
 */
const calls = [];
const state = { otpTypes: [], verifyTypes: [], claimCalls: 0 };
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
authVm.step = 'code'; authVm.email = 'new@x.by'; authVm.code = '222222';
state.verifyTypes = [];
const psy2 = await authVm.confirmCode();
ok('verify fallback signup → psychologist', !!psy2 && psy2.id === 'psy_test_1');
ok('type chain magiclink→signup', state.verifyTypes.includes('magiclink') && state.verifyTypes.includes('signup'));

let failed = 0;
for (const [n, p] of checks) { console.log((p ? 'PASS' : 'FAIL') + '  ' + n); if (!p) failed++; }
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
