#!/usr/bin/env node
/**
 * UI-контракт входа специалиста (issue #88): Google OAuth — единственный путь.
 *
 *   node tests/auth-ui-pending.mjs
 *
 * Раньше набор проверял, что шаг ввода email-кода переживает F5. Этот поток
 * снят: психолог больше не вводит код. Набор теперь фиксирует, что форма кода
 * отсутствует, а кнопка Google и обработчик PKCE на месте.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
globalThis.fetch = async () => ({
  ok: false, status: 404,
  headers: { get: () => 'application/json' },
  text: async () => '{}', json: async () => ({})
});

await import(new URL('../js/app.js', import.meta.url).href);

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf-8');
const app = readFileSync(fileURLToPath(new URL('../js/app.js', import.meta.url)), 'utf-8');

const checks = [];
const ok = (name, cond, extra = '') => {
  checks.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

ok('кнопка «Войти через Google» есть в разметке', html.includes('id="btn-google-signin"') && html.includes('Войти через Google'));
ok('заголовок входа не обещает код из письма', !/Войдите по коду/i.test(html));
ok('нет формы email-кода психолога', !html.includes('id="auth-step-email"') && !html.includes('id="auth-send"'));
ok('нет поля кода из письма', !html.includes('id="auth-code"') && !html.includes('id="auth-step-code"'));
ok('нет кнопки «Получить код»', !html.includes('Получить код'));
ok('нет вкладок Вход/Регистрация по email', !html.includes('data-auth-mode'));
ok('app.js не вызывает requestCode (OTP UX снят)', !app.includes('requestCode()'));
ok('app.js не вызывает consumeAuthRedirect (email-link психолога снят)', !app.includes('consumeAuthRedirect()'));
ok('app.js запускает Google OAuth', app.includes('startGoogleSignIn'));
ok('клиентский Google при записи (#41) не удалён',
  readFileSync(fileURLToPath(new URL('../js/services/googleClientAuthService.js', import.meta.url)), 'utf-8')
    .includes('signInWithGoogleIdToken'));

const failed = checks.filter(([, pass]) => !pass).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
