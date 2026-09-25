#!/usr/bin/env node
/**
 * UI-контракт шага ввода кода: ожидание подтверждения переживает перезагрузку.
 *
 *   node tests/auth-ui-pending.mjs
 *
 * Проверяется связка, которую не видно в доменных тестах: safeStorage →
 * registration.pendingVerification() → AuthViewModel.resumePendingVerification()
 * → renderAuth() в js/app.js (issue #14, п.3).
 *
 * Окружение — те же DOM/localStorage-заглушки, что в verify_auth.mjs;
 * импортируется НАСТОЯЩИЙ js/app.js (вместе с boot() и renderAuth).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ——— DOM/хранилище ——— */
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

/* ——— сервер: только запрос кода,verify здесь не нужен ——— */
const calls = [];
let fnUp = true; // false = Edge Function auth-code не задеплоена (прод 2026-09-25)
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push(u);
  const resp = (status, json) => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(json),
    json: async () => json
  });
  if (u.includes('/functions/v1/auth-code')) {
    if (!fnUp) return resp(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
    if (body.action === 'request') return resp(200, { ok: true, ttl_seconds: 120 });
    return resp(400, { ok: false, error: 'Неизвестное действие' });
  }
  if (u.includes('/auth/v1/otp')) return resp(200, {});
  if (u.includes('/rest/v1/')) return resp(200, []);
  return resp(404, { msg: 'nf' });
};

const { authVm } = await import(new URL('../js/app.js', import.meta.url).href);
const { registration } = await import(new URL('../js/domain/registration.js', import.meta.url).href);

const checks = [];
const ok = (name, cond, extra = '') => {
  checks.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

// ——— 1. «Первая загрузка»: код запрошен, шаг ввода открыт ———
authVm.email = 'natalia@example.by';
const requested = await authVm.requestCode();
ok('запрос кода открывает шаг ввода', requested === true && authVm.step === 'code');
ok('канал выбран и сохранён (fn)', registration.currentChannel() === 'fn', String(registration.currentChannel()));
const stored = JSON.parse(lsMap.get('psy_pending_verification_v1') || 'null');
ok('ожидание лежит в localStorage (переживёт F5)',
  !!stored && stored.email === 'natalia@example.by' && stored.channel === 'fn', JSON.stringify(stored));
ok('окно ввода тикает (120 с)', authVm.resendIn === 120, String(authVm.resendIn));

// ——— 2. «Перезагрузка»: новая ViewModel, память модулей пуста ———
const { AuthViewModel } = await import(new URL('../js/viewmodels/AuthViewModel.js', import.meta.url).href);
const reborn = new AuthViewModel();
ok('после перезагрузки шаг снова «email» (память чистая)', reborn.step === 'email');
const resumed = reborn.resumePendingVerification();
ok('resumePendingVerification восстановил шаг ввода кода', resumed === true && reborn.step === 'code');
ok('email восстановлен из ожидания', reborn.email === 'natalia@example.by', reborn.email);
ok('окно ввода продолжило тикнуть с остатка, а не с нуля',
  reborn.resendIn > 0 && reborn.resendIn <= 120, String(reborn.resendIn));
ok('повторный вызов resume не сбрасывает состояние', reborn.resumePendingVerification() === false);

// ——— 3. «Перезагрузка» после истечения окна: нужен новый код ———
lsMap.set('psy_pending_verification_v1', JSON.stringify({
  email: 'natalia@example.by',
  channel: 'fn',
  requestedAt: Date.now() - 200e3,
  expiresAt: Date.now() - 80e3
}));
const stale = new AuthViewModel();
stale.resumePendingVerification();
ok('истёкшее окно: пользователь возвращён на шаг email', stale.step === 'email', stale.step);
ok('истёкшее окно: явное сообщение «запросите новый код»',
  /новый код/i.test(stale.error || ''), stale.error);
ok('истёкшее окно: протухшее ожидание удалено из хранилища',
  registration.pendingVerification() === null);

// ——— 4. Подсказка канала: форма обязана говорить правду о письме ———
// Дефект, найденный на живом проде (2026-09-25): владелец получил ССЫЛКУ
// (запасной канал Supabase), кода в письме не было, а renderAuth() писал
// «Код отправлен: 6–8 букв и цифр» в элемент #auth-code-hint, которого в
// index.html не существовало — подсказка не отображалась вовсе.
const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf-8');
const iStep = html.indexOf('id="auth-step-code"');
const iHint = html.indexOf('id="auth-code-hint"');
const iPass = html.indexOf('id="auth-pass-wrap"');
ok('index.html: элемент #auth-code-hint существует', iHint > 0, String(iHint));
ok('index.html: подсказка внутри шага ввода кода',
  iStep > 0 && iHint > iStep && iPass > iHint, `${iStep}/${iHint}/${iPass}`);

ok('канал fn: подсказка обещает код 6–8 символов',
  /6–8/.test(authVm.codeHint) && authVm.channel === 'fn', authVm.codeHint);

fnUp = false; // прод: функция не задеплоена → запасной канал
authVm.email = 'fallback@example.by';
const otpRequested = await authVm.requestCode();
ok('нет Edge Function: запрос кода переключил канал на otp',
  otpRequested === true && authVm.channel === 'otp', String(authVm.channel));
ok('канал otp: подсказка говорит про ССЫЛКУ, а не про код',
  /ссылка/i.test(authVm.codeHint) && !/^Код отправлен/.test(authVm.codeHint), authVm.codeHint);
ok('канал otp: подсказка называет причину и лечение (auth-code)',
  /auth-code/i.test(authVm.codeHint), authVm.codeHint);
ok('канал otp: сообщение use case не обещает код в письме',
  !/Код отправлен/.test(String(authVm.error || '')) && /ссылка/i.test(authVm.codeHint));
fnUp = true;

// после перезагрузки канал восстанавливается вместе с ожиданием → та же подсказка
const afterReload = new AuthViewModel();
afterReload.resumePendingVerification();
ok('после перезагрузки канал восстановлен из ожидания',
  afterReload.channel === 'otp', String(afterReload.channel));
ok('после перезагрузки подсказка та же (про ссылку)',
  /ссылка/i.test(afterReload.codeHint), afterReload.codeHint);

const failed = checks.filter(([, pass]) => !pass).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
