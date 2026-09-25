#!/usr/bin/env node
// Смоук роутера Hash History: .../#/psy/{slug} + legacy-нормализация.
// Запуск: node test_routing.mjs
import { fakeEl } from './_harness_stubs.mjs';

const listeners = {};
const locState = { pathname: '/', search: '', hash: '', origin: 'http://x' };
// эмуляция браузера: присвоение location.hash без «#» дописывает его
const loc = new Proxy(locState, {
  get: (t, p) => t[p],
  set: (t, p, v) => {
    if (p === 'hash') { const s = String(v); t.hash = s.startsWith('#') ? s : '#' + s; return true; }
    t[p] = v;
    return true;
  }
});

function applyUrl(u) {
  const p = new URL(u, 'http://x/');
  locState.pathname = p.pathname;
  locState.search = p.search;
  locState.hash = p.hash;
}

const lsMap = new Map();
globalThis.localStorage = {
  get: k => (lsMap.has(k) ? lsMap.get(k) : null),
  set: (k, v) => lsMap.set(k, String(v)),
  remove: k => lsMap.delete(k),
  clear: () => lsMap.clear()
};

globalThis.location = loc;
globalThis.history = {
  pushState() {},
  replaceState(_s, _t, u) { if (u) applyUrl(u); }
};
// window — реальный объект: app.js регистрирует на нём navigate/__router/…
globalThis.window = {
  localStorage: globalThis.localStorage,
  location: loc,
  addEventListener: (n, fn) => { (listeners[n] ||= []).push(fn); },
  removeEventListener: () => {},
  scrollTo: () => {},
  prompt: () => 'x'
};

globalThis.document = {
  title: '', head: fakeEl(), body: fakeEl(), documentElement: fakeEl(),
  querySelector: () => fakeEl(), querySelectorAll: () => [],
  getElementById: () => fakeEl(), createElement: () => fakeEl(),
  addEventListener: (n, fn) => { (listeners['d:' + n] ||= []).push(fn); },
  removeEventListener: () => {}, hidden: false
};
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-harness', clipboard: { writeText: async () => {} } } });
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.prompt = () => 'x';
globalThis.FileReader = class {};
globalThis.fetch = async () => ({ ok: false, status: 0, text: async () => '', json: async () => ({}) });

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}

await import('./js/app.js'); // boot: портal, normalizeLegacyUrl no-op

const nav = globalThis.window.navigate;
const router = globalThis.window.__router;
const fireHashchange = () => (listeners['hashchange'] || []).forEach(fn => fn());

// ——— Разбор hash-маршрутов ———
const set = (hash, path = '/', search = '') => { loc.hash = hash; loc.pathname = path; loc.search = search; };

set('#/psy/anna-x');
let r = router.routeFromUrl();
check('#/psy/{slug} → profile', r.name === 'profile' && r.params.slug === 'anna-x', JSON.stringify(r));

set('#/book/anna-x');
r = router.routeFromUrl();
check('#/book/{slug} → booking', r.name === 'booking' && r.params.slug === 'anna-x', JSON.stringify(r));

set('#/cabinet');
check('#/cabinet', router.routeFromUrl().name === 'cabinet');
set('#/onboarding');
check('#/onboarding', router.routeFromUrl().name === 'onboarding');
set('#/auth');
check('#/auth (mode=login)', JSON.stringify(router.routeFromUrl().params) === JSON.stringify({ mode: 'login' }));
set('#/auth?mode=register');
check('#/auth?mode=register', router.routeFromUrl().params.mode === 'register');
set('#/booking-done');
check('#/booking-done → success', router.routeFromUrl().name === 'success');
set('#/reply?reply=TOK123');
r = router.routeFromUrl();
check('#/reply?reply=TOK → clientReply', r.name === 'clientReply' && r.params.token === 'TOK123', JSON.stringify(r));
set('#/reply?token=TOK9');
check('#/reply?token=… (алиас)', router.routeFromUrl().params.token === 'TOK9');
set('#/');
check('#/ → portal', router.routeFromUrl().name === 'portal');
set('');
check('пустой hash → portal', router.routeFromUrl().name === 'portal');
set('#/definitely/unknown');
check('неизвестный hash → portal', router.routeFromUrl().name === 'portal');
set('#/psy/My%20Slug');
check('закодированный slug декодируется', router.routeFromUrl().params.slug === 'My Slug', JSON.stringify(router.routeFromUrl().params));

// ——— navigate() пишет hash ———
set('');
nav('profile', { slug: 'zoe-42' });
check('navigate(profile) → location.hash = #/psy/zoe-42', loc.hash === '#/psy/zoe-42', loc.hash);
nav('booking', { slug: 'zoe-42' });
check('navigate(booking) → #/book/zoe-42', loc.hash === '#/book/zoe-42', loc.hash);
nav('auth', { mode: 'register' });
check('navigate(auth, register) → #/auth?mode=register', loc.hash === '#/auth?mode=register', loc.hash);
nav('auth', { mode: 'login' });
check('navigate(auth, login) → #/auth (без хвоста)', loc.hash === '#/auth', loc.hash);
nav('onboarding');
check('navigate(onboarding) без сессии → #/auth', loc.hash === '#/auth', loc.hash);
nav('success');
check('navigate(success) → #/booking-done', loc.hash === '#/booking-done', loc.hash);
nav('clientReply', { token: 'TT' });
check('navigate(clientReply) → #/reply?reply=TT', loc.hash === '#/reply?reply=TT', loc.hash);

// ——— hashchange (назад/вперёд, внешняя смена хвоста) ———
set('#/psy/other-1');
fireHashchange();
check('hashchange → маршрут обновился (profile other-1)', router.routeFromUrl().name === 'profile' && router.routeFromUrl().params.slug === 'other-1');
// «свой» hashchange (тот же маршрут) не должен ломать состояние
set('#/psy/other-1');
fireHashchange();
check('дублирующий hashchange — без смены маршрута', router.routeFromUrl().name === 'profile');

// ——— Legacy-ссылки (path/query) → нормализация в hash без перезагрузки ———
// 1) deep-link .../psy/slug (SPA-fallback / 404.html)
set('', '/repo/psy/anna-x/', '');
r = router.routeFromUrl();
check('legacy /psy/{slug} → profile', r.name === 'profile' && r.params.slug === 'anna-x', JSON.stringify(r));
router.normalizeLegacyUrl();
check('normalize: pathname очищен, hash = #/psy/anna-x', loc.pathname === '/repo/' && loc.hash === '#/psy/anna-x', `${loc.pathname} ${loc.hash}`);
check('после normalize маршрут тот же', router.routeFromUrl().name === 'profile');

// 2) ?book= (корневой query)
set('', '/', '?book=anna-x');
check('legacy ?book= → booking', router.routeFromUrl().name === 'booking');
router.normalizeLegacyUrl();
check('normalize ?book= → #/book/anna-x', loc.hash === '#/book/anna-x' && loc.search === '', loc.hash);

// 3) /reply?reply=TOK
set('', '/reply', '?reply=TOK55');
check('legacy /reply?reply= → clientReply', router.routeFromUrl().name === 'clientReply');
router.normalizeLegacyUrl();
check('normalize /reply → #/reply?reply=TOK55, pathname без сегмента', loc.pathname === '/' && loc.hash === '#/reply?reply=TOK55' && loc.search === '', `${loc.pathname} ${loc.hash}`);

// 4) якорь /psy/{slug}#book
set('#book', '/psy/anna-x', '');
check('legacy /psy/{slug}#book → booking', router.routeFromUrl().name === 'booking');
router.normalizeLegacyUrl();
check('normalize #book → #/book/anna-x', loc.hash === '#/book/anna-x', loc.hash);

// 5) cabinet/auth/booking-done
set('', '/cabinet', '');
router.normalizeLegacyUrl();
check('legacy /cabinet → #/cabinet', loc.hash === '#/cabinet', loc.hash);
set('', '/auth', '');
router.normalizeLegacyUrl();
check('legacy /auth → #/auth', loc.hash === '#/auth', loc.hash);
set('', '/onboarding', '');
router.normalizeLegacyUrl();
check('legacy /onboarding → #/onboarding', loc.hash === '#/onboarding', loc.hash);
set('', '/booking-done', '');
router.normalizeLegacyUrl();
check('legacy /booking-done → #/booking-done', loc.hash === '#/booking-done', loc.hash);

// ——— urlFor / ссылки ———
set('', '/repo/', '');
check('BASE учитывает подпуть репозитория', router.routeUrl({ name: 'portal', params: {} }) === 'http://x/repo/#/', router.routeUrl({ name: 'portal', params: {} }));
check('urlFor.psy — абсолютная hash-ссылка', router.routeUrl({ name: 'profile', params: { slug: 'a-b' } }) === 'http://x/repo/#/psy/a-b');
check('urlFor.bookingLink', router.routeUrl({ name: 'booking', params: { slug: 'a-b' } }) === 'http://x/repo/#/book/a-b');

// ——— JSON-LD: двойной hash исключён ———
const { buildProfileJsonLd } = await import('./js/services/seoService.js');
const psy = { profession: 'psychologist', fullName: 'Тест', specialization: 'Психолог', about: '', greeting: '', approach: '', photoUrl: '', publicEmail: '', phone: '', socials: [], education: { basic: [], additional: [] }, directions: [], address: '' };
const ld = buildProfileJsonLd(psy, [], 'http://x/repo/#/psy/anna-x');
const personId = ld['@graph'][0]['@id'];
check('JSON-LD @id без двойного hash', personId === 'http://x/repo/#person', personId);

console.log(`\n${failed ? 'FAILED' : 'ALL PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
