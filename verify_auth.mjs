// E2E авторизации с мок-сервером Supabase: OTP → окно 2 мин → verify → claim → вход
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push(u.replace('https://phiavtroybgwyjdhqqkh.supabase.co','') + ' ' + JSON.stringify(body).slice(0, 60));
  if (u.endsWith('/auth/v1/otp')) {
    if (body.email === 'busy@x.by') return { ok: false, status: 429, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ msg: 'over_email_send_rate_limit' }) };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' };
  }
  if (u.endsWith('/auth/v1/verify')) {
    if (body.token === '000000') return { ok: false, status: 400, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ msg: 'Invalid token' }) };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ access_token: 'jwt-1', refresh_token: 'r1', user: { id: 'u1', email: body.email } }) };
  }
  if (u.includes('/rpc/claim_psychologist_profile')) {
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, id: 'psy_test_1' }) };
  }
  if (u.includes('psychologists?id=eq.psy_test_1')) {
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => [{ id: 'psy_test_1', email: 'doc@x.by', full_name: 'Док Тестов', slug: 'dok-testov', is_active: true, created_at: '2026-01-01T00:00:00Z' }] };
  }
  return { ok: false, status: 404, headers: { get: () => 'application/json' }, text: async () => 'nf', json: async () => ({}) };
};
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

const { authVm } = await import(new URL('./js/app.js', 'file://' + process.cwd() + '/').href);
const { authService } = await import(new URL('./js/services/authService.js', 'file://' + process.cwd() + '/').href);
const { db } = await import(new URL('./js/core/dbContext.js', 'file://' + process.cwd() + '/').href);

const checks = [];
const ok = (n, c) => checks.push([n, !!c]);

// валидация email
let r = await authVm.requestCode();
ok('invalid email → error', r === false && /корректн/.test(authVm.error));

// rate limit → понятная ошибка
authVm.email = 'busy@x.by';
await authVm.requestCode();
ok('rate limit message', /Слишком часто/.test(authVm.error));

// успешная отправка → окно 2 минуты
authVm.email = 'doc@x.by';
r = await authVm.requestCode();
ok('otp sent → step code', r === true && authVm.step === 'code');
ok('resend window 120s', authVm.resendIn === 120 && authService.resendIn === 120);
ok('resend label', /1:5|2:0/.test(authVm.resendLabel));

// неверный код
authVm.code = '000000';
const bad = await authVm.confirmCode();
ok('wrong code → error', bad === null && /Код неверный|не принял/.test(authVm.error));

// верный код → подтверждение → claim → вход
authVm.code = '123456';
authVm.mode = 'register';
authVm.fullName = 'Док Тестов';
const psy = await authVm.confirmCode();
ok('verify ok → psychologist', !!psy && psy.id === 'psy_test_1');
ok('isAuthenticated', authService.isAuthenticated() === true);
ok('currentPsychologist set', db.currentPsychologist?.id === 'psy_test_1');
ok('otp+verify+claim+fetch called', calls.filter(c => c.includes('/auth/v1/otp') || c.includes('/auth/v1/verify') || c.includes('claim_psychologist')).length >= 3);

// сейф: пароль не задан → init
const vr = await authService.initVaultPassword('psy_test_1', 'secret123');
ok('vault init', vr.ok === true && authService.isVaultUnlocked() === true);

let failed = 0;
for (const [n, p] of checks) { console.log((p ? 'PASS' : 'FAIL') + '  ' + n); if (!p) failed++; }
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
