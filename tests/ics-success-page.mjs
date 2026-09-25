#!/usr/bin/env node
/**
 * Issue #65 / BL-08 — E2E (DOM-уровень) «Добавить в календарь (.ics)».
 *
 *   node tests/ics-success-page.mjs
 *
 * Полный клиентский путь на настоящем app.js (сервер — мок, как в
 * booking-wizard.mjs): каталог → wizard → submit (сервер принял) → страница
 * успеха: кнопка .ics привязана к Blob-файлу с человекочитаемым именем,
 * Google-ссылка сохранена; на reply-странице (секретная ссылка клиента)
 * та же кнопка; в запросе переноса — скрыта (время ещё не подтверждено).
 * Генератор .ics здесь не проверяется — только привязка UI (см. tests/ics-event.mjs).
 */
function makeEl(id = '') {
  const el = {
    id,
    _html: '', _text: '',
    classes: new Set(['hidden']),
    disabled: false, value: '', checked: false, href: '', download: '',
    style: {}, dataset: {},
    classList: {
      add: (...c) => c.forEach(x => el.classes.add(x)),
      remove: (...c) => c.forEach(x => el.classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !el.classes.has(c) : !!force;
        on ? el.classes.add(c) : el.classes.delete(c);
      },
      contains: c => el.classes.has(c)
    },
    set innerHTML(v) { el._html = String(v); },
    get innerHTML() { return el._html; },
    set textContent(v) { el._text = String(v); },
    get textContent() { return el._text; },
    querySelectorAll: () => [],
    querySelector: () => makeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => makeEl(),
    setAttribute: () => {},
    getAttribute: () => null,
    closest: () => null,
    scrollIntoView: () => {},
    focus: () => {},
    remove: () => {}
  };
  return el;
}

const els = new Map();
const getEl = sel => {
  if (!els.has(sel)) els.set(sel, makeEl(sel));
  return els.get(sel);
};
const listeners = {};

globalThis.document = {
  title: '',
  head: makeEl('head'),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  hidden: false,
  querySelector: sel => getEl(sel),
  querySelectorAll: () => [],
  getElementById: id => getEl('#' + id),
  createElement: () => makeEl(),
  addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
  removeEventListener: () => {}
};
const lsMap = new Map();
globalThis.localStorage = {
  get: k => (lsMap.has(k) ? lsMap.get(k) : null),
  set: (k, v) => lsMap.set(k, String(v)),
  remove: k => lsMap.delete(k),
  clear: () => lsMap.clear()
};
const SLUG = 'nataliya-mikhajlovskaya-19';
const loc = { pathname: `/book/${SLUG}`, search: '', hash: '', origin: 'http://x' };
globalThis.window = new Proxy({
  localStorage: globalThis.localStorage,
  addEventListener: (n, f) => { (listeners['w:' + n] ||= []).push(f); },
  scrollTo: () => {},
  location: loc,
  confirm: () => true
}, { get(t, p) { return p in t ? t[p] : makeEl(); }, set(t, p, v) { t[p] = v; return true; } });
globalThis.location = loc;
globalThis.history = { pushState() {}, replaceState() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-harness', clipboard: { writeText: async () => {} } } });
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.prompt = () => 'x';
globalThis.FileReader = class {};

// ——— мок «сервера»: профиль + услуга 90 мин + настройки (Europe/Minsk, 10:00–19:00) ———
const PSY_ID = 'psy_catalog_19';
const PSY_ROW = {
  id: PSY_ID, email: 'catalog+natalia@example.invalid', full_name: 'Наталия Михайловская',
  phone: '+375 (29) 780-45-45', specialization: 'Гештальт-терапевт', city: 'Гродно',
  about: 'Работа с отношениями, кризисами, тревогой.', website: '', source_url: '',
  address: 'г. Гродно, ул. Свердлова, 16', experience: '10 лет практики',
  slug: SLUG, profession: 'psychologist', greeting: 'Добро пожаловать.', approach: '',
  photo_url: '', public_email: 'natalia@example.invalid', directions: [], education: null,
  experience_items: [], socials: [], payment_links: [], payment_requisites: null,
  is_active: true, created_at: '2026-01-01T00:00:00Z'
};
const SVC_ROWS = [
  { id: 'svc90', psychologist_id: PSY_ID, title: 'Глубокая сессия 90 мин', description: 'расширенный формат', duration_min: 90, price: 120, currency: 'BYN', format: 'online', platforms: ['zoom'], pay_url: '', sort_order: 1 }
];
const SETTINGS_ROW = {
  psychologist_id: PSY_ID, work_hours: 'Пн–Пт 10:00–19:00', timezone: 'Europe/Minsk',
  slot_start: '10:00', slot_end: '19:00', slot_step_min: 60, work_days: [1, 2, 3, 4, 5]
};
const RESP = (json, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(json), json: async () => json });
globalThis.fetch = async url => {
  const u = String(url);
  if (u.includes('public_profiles') || u.includes('psychologists?select=')) return RESP([PSY_ROW]);
  if (u.includes('/rest/v1/services')) return RESP(SVC_ROWS);
  if (u.includes('public_settings') || u.includes('session_settings')) return RESP([SETTINGS_ROW]);
  return RESP([]);
};

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

await import(new URL('../js/app.js', import.meta.url));
await new Promise(r => setTimeout(r, 80)); // каталог «с сервера»
const app = await import(new URL('../js/app.js', import.meta.url));
const { bookingVm } = app;
const { db } = await import('../js/core/dbContext.js');
const { supabaseApi } = await import('../js/services/supabaseApi.js');
const { fraudProtectionService } = await import('../js/services/fraudProtectionService.js');

function futureWorkday() {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  for (let i = 0; i < 10; i++) {
    const iso = d.toISOString().slice(0, 10);
    const isoDay = ((new Date(iso + 'T12:00:00').getDay() + 6) % 7) + 1;
    if (isoDay <= 5) return iso;
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}
const DATE = futureWorkday();
const TIME = '17:00';
const render = () => window.navigate('booking', { slug: SLUG });

// ——— wizard: услуга → время → контакт → submit (сервер принял) ———
render();
check('загрузился специалист из «сервера»', !!bookingVm.psychologist, bookingVm.psychologist?.fullName);
bookingVm.selectServiceAndContinue('svc90');
render();
bookingVm.selectDate(DATE);
render();
bookingVm.selectTimeAndContinue(TIME);
render();
bookingVm.nickname = 'Anna_Ics';
bookingVm.name = 'Anna_Ics';
bookingVm.phone = '+375 29 111-22-33';
bookingVm.contact = 'anna.ics@example.invalid';
bookingVm.consent = true;
bookingVm.honeypot = '';
bookingVm.note = '';
fraudProtectionService.formOpenedAt = Date.now() - 30000; // антиспам: форма «открыта» давно

const realCreateBooking = supabaseApi.createBooking;
supabaseApi.createBooking = async () => ({
  ok: true, client_id: 'cli_ics_1', session_id: 'ses_ics_1', duration_min: 90
});
const created = await bookingVm.submit();
supabaseApi.createBooking = realCreateBooking;
check('заявка создана (сервер принял)', !!created && created.id === 'ses_ics_1', created?.id || bookingVm.error);
check('запись в локальном зеркале есть (для привязки .ics)',
  !!db.sessions.find(s => s.id === 'ses_ics_1'));

// ——— страница успеха ———
window.navigate('success');
const ics = getEl('#success-ics');
const gcal = getEl('#success-gcal');
const expectedFile = `session-nataliya-mikhaylovskaya-${DATE}-${TIME.replace(':', '-')}.ics`;

check('кнопка .ics на успехе видна', !ics.classes.has('hidden'));
check('кнопка .ics ведёт на Blob-файл (download)',
  ics.href.startsWith('blob:') && !!ics.download, `${ics.href} ${ics.download}`);
check('имя файла: специалист (транслит) + дата + время',
  ics.download === expectedFile, ics.download);
check('Blob URL стабилен на элементе (dataset.icsUrl == href)', ics.dataset.icsUrl === ics.href);
check('Google-ссылка сохранена (render?action=TEMPLATE)',
  gcal.href.includes('calendar.google.com/calendar/render') && gcal.href.includes('action=TEMPLATE'),
  gcal.href.slice(0, 120));
check('Google-ссылка: те же дата/время/длительность (90 мин → 18:30)',
  gcal.href.includes(`${DATE.replaceAll('-', '')}T170000`) && gcal.href.includes(`T183000`),
  gcal.href.slice(0, 200));
check('снимок длительности в записи = 90 (источник для .ics и gcal — один)',
  db.sessions.find(s => s.id === 'ses_ics_1')?.durationMin === 90);

// содержимое Blob — проверяется через URL (node: blob: URL не читается fetch'ом),
// поэтому здесь фиксируем только контракт ссылки; генерация — tests/ics-event.mjs.
// Отдельно: повторный renderSuccess не должен ломать кнопку (перерисовка страницы)
window.navigate('success');
check('повторный render success не теряет кнопку .ics',
  !ics.classes.has('hidden') && ics.href.startsWith('blob:'));

// ——— reply-страница (секретная ссылка клиента) ———
db.reminders.push({
  id: 'rem_ics_1', sessionId: 'ses_ics_1', responseToken: 'tok_ics_confirm',
  kind: 'confirm_request', status: 'pending', messageBody: 'Подтвердите запись'
});
window.navigate('clientReply', { token: 'tok_ics_confirm' });
const replyIcs = getEl('#reply-ics');
check('reply: кнопка .ics видна для подтверждённой записи', !replyIcs.classes.has('hidden'));
check('reply: имя файла то же (специалист + дата + время)',
  replyIcs.download === expectedFile, replyIcs.download);

// Контра-пример: запрос переноса — время ещё не подтверждено → кнопки нет
db.reminders.push({
  id: 'rem_ics_2', sessionId: 'ses_ics_1', responseToken: 'tok_ics_reschedule',
  kind: 'reschedule_request', status: 'pending', messageBody: 'Предлагаю перенести'
});
window.navigate('clientReply', { token: 'tok_ics_reschedule' });
check('reply: в запросе переноса .ics скрыта (время не подтверждено)',
  replyIcs.classes.has('hidden'));

// Контра-пример: неизвестный токен → страницы без кнопки
window.navigate('clientReply', { token: 'tok_unknown' });
check('reply: неизвестный токен — кнопки .ics нет', replyIcs.classes.has('hidden'));

const failed = results.filter(([, pass]) => !pass);
console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено`);
process.exit(failed.length ? 1 : 0);
