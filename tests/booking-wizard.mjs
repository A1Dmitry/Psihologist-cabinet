#!/usr/bin/env node
/**
 * Проверка клиентского пути записи (T-01…T-04) — смоук для фич Агента 2.
 *
 *   node tests/booking-wizard.mjs
 *
 * Покрывает:
 *   T-01 wizard: шаги «Услуга → Время → Контакт», назад/вперёд без потери данных;
 *   T-02 слоты под длительность услуги (90 мин не влезает в окно до 19:00) +
 *        пересечение с чужой записью;
 *   T-03 часовой пояс клиента: подпись, конверсия слотов, фиксация пояса в заявке;
 *   T-04 «услуга → сразу окна» (клик по услуге и ссылка /book/{slug}?service=).
 *
 * Это НЕ замена verify_* — это регресс конкретных фич записи; QA может
 * перенести/переименовать файл по своему усмотрению.
 */
function makeEl(id = '') {
  const el = {
    id,
    _html: '', _text: '',
    classes: new Set(),
    disabled: false, hidden: false, value: '', checked: false,
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
  querySelectorAll: sel => (sel === '.book-step'
    ? [1, 2, 3].map(i => getEl(`#book-step-${i}`))
    : []),
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

// —— мок «сервера»: профиль + услуги 60/90 мин + настройки (Europe/Minsk, 10:00–19:00) ——
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
  { id: 'svc60', psychologist_id: PSY_ID, title: 'Консультация 60 мин', description: '', duration_min: 60, price: 80, currency: 'BYN', format: 'offline', platforms: [], pay_url: '', sort_order: 1 },
  { id: 'svc90', psychologist_id: PSY_ID, title: 'Глубокая сессия 90 мин', description: 'расширенный формат', duration_min: 90, price: 120, currency: 'BYN', format: 'online', platforms: ['zoom'], pay_url: '', sort_order: 2 }
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
  results.push([name, !!cond, extra]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

await import(new URL('../js/app.js', import.meta.url));
await new Promise(r => setTimeout(r, 80)); // дождаться загрузки каталога «с сервера»
const app = await import(new URL('../js/app.js', import.meta.url));
const { bookingVm } = app;
const { fraudProtectionService } = await import('../js/services/fraudProtectionService.js');
const { timezoneService } = await import('../js/services/timezoneService.js');
const { supabaseApi } = await import('../js/services/supabaseApi.js');

const render = () => window.navigate('booking', { slug: SLUG });
const el = sel => getEl(sel);
const slotBtn = t => (el('#book-slots')._html.match(new RegExp(`<button[^>]*data-time="${t}"[^>]*>`)) || [''])[0];

// удобная дата: рабочий день минимум через 2 дня (чтобы слоты точно не в прошлом)
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

// ——— T-01: старт wizard'а ———
render();
check('страница записи загрузила специалиста', !!bookingVm.psychologist, bookingVm.psychologist?.fullName);
check('старт — шаг 1 (Услуга)', bookingVm.step === 1);
check('индикатор прогресса: три шага', /Услуга/.test(el('#book-steps')._html) && /Время/.test(el('#book-steps')._html) && /Контакт/.test(el('#book-steps')._html));
check('панель шага 1 открыта, шаг 2 скрыт',
  !el('#book-step-1').classList.contains('hidden') && el('#book-step-2').classList.contains('hidden'));
check('кнопка «Назад» скрыта на первом шаге', el('#book-back').classList.contains('hidden'));
check('кнопка «Записаться» скрыта до шага 3', el('#book-submit').classList.contains('hidden'));
check('T-04: услуги отрисованы со ссылкой на окна', /svc90/.test(el('#book-services')._html));

// ——— T-04: клик по услуге → сразу окна этой услуги ———
bookingVm.selectServiceAndContinue('svc90');
render();
check('T-04: выбор услуги переводит на шаг «Время»', bookingVm.step === 2, `step=${bookingVm.step}`);
check('шаг «Время» открыт', !el('#book-step-2').classList.contains('hidden'));
check('шаг «Услуга» скрыт', el('#book-step-1').classList.contains('hidden'));
check('в шаге 2 видна длительность выбранной услуги', /90 мин/.test(el('#book-step-2-hint')._text), el('#book-step-2-hint')._text);

// ——— T-02: сетка под длительность услуги ———
bookingVm.selectDate(DATE);
render();
check('T-02: 90-мин услуга — сетка отрисована', /data-time="17:00"/.test(el('#book-slots')._html));
check('T-02: 18:00 недоступен (18:00+90 мин > 19:00)', /disabled/.test(slotBtn('18:00')), slotBtn('18:00'));
check('T-02: 17:00 доступен (17:00+90 мин = 18:30 ≤ 19:00)', slotBtn('17:00') && !/disabled/.test(slotBtn('17:00')));
check('T-02: причина недоступности подписана (title)', /не хватает 90 мин/.test(el('#book-slots')._html));

bookingVm.selectService('svc60');
render();
check('T-02: для 60-мин услуги 18:00 доступен', slotBtn('18:00') && !/disabled/.test(slotBtn('18:00')));

// Пересечение с чужой записью. Занятость берём не из внутренностей ViewModel,
// а через реальный путь: supabaseApi.listBookedSlots → refreshAvailability().
// Серверная строка — в том же виде, что отдаёт view public_booked_slots (SR-003:
// с duration_min чужой записи).
bookingVm.selectService('svc90');
const realListBookedSlots = supabaseApi.listBookedSlots;
supabaseApi.listBookedSlots = async () => ([
  { psychologist_id: bookingVm.psychologist.id, session_date: DATE, session_time: '17:00', duration_min: 60 }
]);
await bookingVm.refreshAvailability();
render();
check('SR-003: free/busy с сервера прочитан (17:00 занят на 60 мин)',
  Object.keys(bookingVm.remoteBusy[DATE] || {}).includes('17:00'),
  JSON.stringify(bookingVm.remoteBusy[DATE]));
check('T-02: 16:00 закрыт — 90 мин пересекают запись 17:00–18:00', /disabled/.test(slotBtn('16:00')));
check('T-02: 15:00 свободен (15:00–16:30 не пересекается)', slotBtn('15:00') && !/disabled/.test(slotBtn('15:00')));
supabaseApi.listBookedSlots = realListBookedSlots;
bookingVm.remoteBusy = {};
render();

// ——— T-03: часовой пояс клиента ———
check('T-03: пояс клиента определён', typeof bookingVm.clientTimeZone === 'string' && bookingVm.clientTimeZone.length > 0, bookingVm.clientTimeZone);
check('T-03: собственный пояс специалиста не считается «другим»',
  (bookingVm._clientTimeZone = 'Europe/Minsk', bookingVm.isForeignTimeZone === false));
bookingVm._clientTimeZone = 'Asia/Tashkent'; // UTC+5 против Europe/Minsk UTC+3
render();
const tzNote = el('#book-tz-note')._text;
check('T-03: подпись «время в вашем поясе» показана', /Asia\/Tashkent/.test(tzNote), tzNote);
check('T-03: разница поясов посчитана (+2 ч)', /разница \+2 ч/.test(tzNote), tzNote);
check('T-03: пример конверсии 12:00 → 14:00', /12:00 у специалиста — это 14:00/.test(tzNote), tzNote);
check('T-03: в слоте показано время клиента', /19:00 у вас/.test(el('#book-slots')._html));
check('T-03: конверсия слотов совпадает с календарём',
  timezoneService.convertWallClock(DATE, '17:00', 'Europe/Minsk', 'Asia/Tashkent').time === '19:00');

// ——— T-01: выбор времени → шаг 3, возврат назад без потери данных ———
bookingVm.selectTimeAndContinue('17:00');
render();
check('выбор времени переводит на шаг «Контакт»', bookingVm.step === 3, `step=${bookingVm.step}`);
check('кнопка «Записаться» видна на шаге 3', !el('#book-submit').classList.contains('hidden'));
check('кнопка «Далее» скрыта на последнем шаге', el('#book-next').classList.contains('hidden'));
check('recap содержит услугу и время', /Глубокая сессия 90 мин/.test(el('#book-recap')._html) && /17:00–18:30/.test(el('#book-recap')._html));
check('recap содержит время клиента', /у вас: 19:00–20:30/.test(el('#book-recap')._html), el('#book-recap')._html);

// отладочный дамп отрисованной разметки: DUMP_WIZARD=1 node tests/booking-wizard.mjs
if (process.env.DUMP_WIZARD) {
  for (const sel of ['#book-steps', '#book-services', '#book-slots', '#book-recap']) {
    console.log(`\n--- ${sel} ---\n${el(sel)._html}`);
  }
  console.log('\n--- #book-tz-note ---\n' + el('#book-tz-note')._text);
  console.log('\n--- #book-step-2-hint ---\n' + el('#book-step-2-hint')._text);
}

el('#bk-nickname').value = 'Anna_Test';
el('#bk-phone').value = '+375 29 111-22-33';
bookingVm.prevStep();
render();
check('«Назад» возвращает на шаг 2', bookingVm.step === 2);
check('выбранное время сохраняется при возврате', bookingVm.time === '17:00');
check('введённые контакты не теряются', el('#bk-nickname').value === 'Anna_Test');
check('прогресс: шаг 3 отмечен достигнутым', bookingVm.maxStepReached >= 2);

// нельзя перейти к контактам без выбранного времени
bookingVm.time = null;
const jumped = bookingVm.goToStep(3);
check('без времени на шаг 3 не пускает', jumped === false && !!bookingVm.error, bookingVm.error);
bookingVm.selectTime('17:00');

// ——— заявка: успех только после подтверждения серверной транзакции ———
bookingVm.goToStep(3);
bookingVm.nickname = 'Anna_Test';
bookingVm.name = 'Anna_Test';
bookingVm.phone = '+375 29 111-22-33';
bookingVm.contact = '@anna_test';
bookingVm.consent = true;
bookingVm.honeypot = '';
fraudProtectionService.formOpenedAt = Date.now() - 30000; // антиспам: форма «открыта» давно

// 1) сервер ОТКАЗАЛ — успех показывать нельзя, локальной записи остаться не должно
const realCreateBooking = supabaseApi.createBooking;
let lastBookingPayload = null;
supabaseApi.createBooking = async (payload) => {
  lastBookingPayload = payload;
  return { ok: false, error: 'Это время только что заняли — выберите другое' };
};
const rejected = await bookingVm.submit();
check('отказ сервера → заявка не создана', rejected === false, String(rejected));
check('отказ сервера → ошибка показана пользователю',
  /только что заняли/.test(bookingVm.error || ''), bookingVm.error);
check('отказ сервера → успех не показан', bookingVm.done !== true && !bookingVm.successText);

// 2) сервер принял — проверяем фактический контракт RPC create_booking
supabaseApi.createBooking = async (payload) => {
  lastBookingPayload = payload;
  return { ok: true, client_id: 'cli_srv_1', session_id: 'ses_srv_1', duration_min: 90 };
};
const session = await bookingVm.submit();
check('заявка создана', !!session && !!session.id, session?.id || bookingVm.error);
check('время записано в поясе специалиста', session?.time === '17:00' && session?.date === DATE, `${session?.date} ${session?.time}`);
check('id заменён на серверный (запись подтверждена транзакцией)',
  session?.id === 'ses_srv_1' && session?.clientId === 'cli_srv_1', `${session?.id}/${session?.clientId}`);
check('T-03/SR-001: пояс клиента — отдельное поле записи (IANA)',
  lastBookingPayload?.p_client_timezone === 'Asia/Tashkent', lastBookingPayload?.p_client_timezone);
check('T-03/SR-001: снимок смещения пояса клиента передан',
  lastBookingPayload?.p_client_utc_offset_min === 300, String(lastBookingPayload?.p_client_utc_offset_min));
check('SR-001: снимок длительности услуги передан и сохранён',
  lastBookingPayload?.p_duration_min === 90 && session?.durationMin === 90,
  `${lastBookingPayload?.p_duration_min}/${session?.durationMin}`);
check('пояс клиента больше НЕ дублируется текстом в заметке',
  !/Часовой пояс клиента:/.test(session?.note || ''), session?.note);
supabaseApi.createBooking = realCreateBooking;

// ——— T-04: ссылка с профиля «услуга → окна» ———
loc.pathname = `/psy/${SLUG}`;
window.navigate('profile', { slug: SLUG });
check('T-04: услуги профиля ведут на /book/{slug}?service=',
  new RegExp(`book/${SLUG}\\?service=svc90`).test(el('#prof-body')._html), el('#prof-body')._html.slice(0, 0) || 'ok');

const failed = results.filter(r => !r[1]).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
