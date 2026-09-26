#!/usr/bin/env node
/**
 * Issue #121 (R14 ревизии #107) — production UI без demo-записи, устаревшего
 * входа «email + пароль» и разрушительного сброса личных данных.
 *
 *   node tests/production-ui-no-demo.mjs
 *
 * Канон (критерии приёмки #121):
 *   1. В рабочем пользовательском пути нет demo pay / demo reply / reset
 *      и инструкций «email + пароль», противоречащих Google-only входу (#88).
 *   2. Ненастроенный сервер даёт НЕДОСТУПНОСТЬ, а не успешную localOnly
 *      запись; демо-каталог не включается при сетевой ошибке.
 *   3. Тестовые фикстуры изолированы; удаление demo UI не уничтожает личный
 *      сейф (никакого `resetToSeed()` из UI) и не ослабляет негативные
 *      контроли оплаты (`tests/demo-pay-honesty.mjs`).
 *
 * Уровни проверки (урок #64 из RRSI-реестра: UI-инвариант = состояние модели
 * + состояние элемента управления в рендере + статический запрет
 * формы-предшественника):
 *   A. статика: index.html / js/app.js / BookingViewModel / bookingTriageWizard;
 *   B. поведение при сетевой ошибке каталога: экран «нет связи» без демо-кнопки,
 *      demo/seed не подставляется, глобальных enableDemoData/resetPortalData нет;
 *   C. поведение воронки без сервера: submit() → отказ с причиной, откат
 *      локальной записи, никакого success/localOnly, панель оплаты без демо;
 *   D. поведение опроса без сервера: кнопка прикрепления disabled и без
 *      «демо-заявки», клик по ней не прикрепляет опрос к заявке.
 *
 * DOM-стаб не моделирует разрушение узлов при перезаписи innerHTML (RRSI #74):
 * поэтому все проверки здесь читают ТЕКУЩУЮ разметку контейнера после рендера,
 * а не кэш прежних узлов; браузерный смоук — verify_pages.py против devserver.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

// Статический контроль обязан исключать комментарии (урок #64 из RRSI-реестра):
// иначе он краснеет на документации «почему это снято» и его пришлось бы
// ослаблять до бесполезного. Матчим только исполняемый код/разметку.
const stripHtmlComments = src => src.replace(/<!--[\s\S]*?-->/g, '');
const stripJsComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const html = stripHtmlComments(readFileSync(join(ROOT, 'index.html'), 'utf8'));
const appSrc = stripJsComments(readFileSync(join(ROOT, 'js/app.js'), 'utf8'));
const bvmSrc = stripJsComments(readFileSync(join(ROOT, 'js/viewmodels/BookingViewModel.js'), 'utf8'));
const wizardSrc = stripJsComments(readFileSync(join(ROOT, 'js/views/bookingTriageWizard.js'), 'utf8'));
const portalVmSrc = stripJsComments(readFileSync(join(ROOT, 'js/viewmodels/PortalViewModel.js'), 'utf8'));

// ============================================================
// A. Статика: формы-предшественники сняты из рабочего пути
// ============================================================
check('A1 index.html: нет инструкции «email + пароль» демо-входа',
  !/natalia@example\.com|ivan@example\.com/.test(html) && !/\+ пароль \(задайте при первом входе\)/.test(html));
check('A2 index.html: нет кнопки «сбросить данные» / resetPortalData',
  !html.includes('resetPortalData(') && !/сбросить данные/i.test(html));
check('A3 index.html: нет демо-входа «ответ на напоминание» (btn-open-reply-demo)',
  !html.includes('btn-open-reply-demo'));
check('A4 app.js: нет window.resetPortalData и вызова db.resetToSeed() из UI',
  !appSrc.includes('resetPortalData') && !appSrc.includes('resetToSeed('));
check('A5 app.js: нет enableDemoData / «Показать демо-данные»',
  !appSrc.includes('enableDemoData') && !appSrc.includes('Показать демо-данные'));
check('A6 app.js: источник каталога без состояния demo (бейдж, плашка, catalogReady)',
  !/source === 'demo'/.test(appSrc) && !/demo:\s*\{\s*text:/.test(appSrc) && !appSrc.includes('demoStrip'));
check('A7 app.js: нет demo pay (data-pay-demo / completePayment) и обработчика btn-open-reply-demo',
  !appSrc.includes('data-pay-demo') && !appSrc.includes('completePayment') && !appSrc.includes('btn-open-reply-demo'));
check('A8 BookingViewModel: нет completePayment / demoPayIsLocalOnly / localOnly-успеха / paySession',
  !bvmSrc.includes('completePayment') && !bvmSrc.includes('demoPayIsLocalOnly')
    && !/localOnly:\s*true/.test(bvmSrc) && !bvmSrc.includes('paySession('));
check('A9 bookingTriageWizard: нет демо-режима и «демо-заявки»',
  !/демо/i.test(wizardSrc));
// A11–A12 (решение владельца 2026-09-26, «больше никаких демо»): демо/симуляций нет
// нигде в продукте — ни на публичной странице, ни в кабинете. Свип по всему
// исполняемому коду (index.html + js/**), комментарии исключены.
const cabinetSrc = stripJsComments(readFileSync(join(ROOT, 'js/viewmodels/CabinetViewModel.js'), 'utf8'));
const reminderSrc = stripJsComments(readFileSync(join(ROOT, 'js/services/reminderService.js'), 'utf8'));
const paymentSrc = stripJsComments(readFileSync(join(ROOT, 'js/services/paymentService.js'), 'utf8'));
check('A11 кабинет: нет симуляции напоминаний («Отправить due сейчас», outbox, «Симулировать ответ», processDue/processReminders, card_demo)',
  !html.includes('btn-process-reminders') && !html.includes('reminder-outbox')
    && !appSrc.includes('Симулировать') && !appSrc.includes('processReminders') && !appSrc.includes('(демо)')
    && !cabinetSrc.includes('processReminders') && !reminderSrc.includes('processDue(')
    && !paymentSrc.includes('card_demo') && !paymentSrc.includes('demo_'));
const sweepFiles = ['index.html', 'privacy.html', ...readdirSync(join(ROOT, 'js'), { recursive: true })
  .filter(f => String(f).endsWith('.js')).map(f => join('js', String(f)))];
const sweepHits = [];
for (const rel of sweepFiles) {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  const code = rel.endsWith('.html') ? stripHtmlComments(raw) : stripJsComments(raw);
  code.split('\n').forEach((line, i) => {
    if (/демо|demo|симул|simulat/i.test(line)) sweepHits.push(`${rel}:${i + 1}`);
  });
}
check('A12 свип продукта (index.html, privacy.html, js/**): вне комментариев нет «демо/demo/симул»',
  sweepHits.length === 0, sweepHits.slice(0, 8).join(', '));

check('A10 catalogReady — один источник истины в PortalViewModel (DRY, RULES §6.14)',
  /get catalogReady\(\)/.test(portalVmSrc) && !/source === 'server' \|\| /.test(appSrc)
    && (appSrc.match(/portalVm\.catalogReady/g) || []).length >= 2);

// ============================================================
// DOM-стаб: персистентные дочерние стабы на (контейнер, селектор),
// сброс при перезаписи innerHTML, запись обработчиков и «выстрел» событий.
// ============================================================
function makeEl(id = '') {
  const el = {
    id, tagName: 'DIV', className: '',
    _html: '', _text: '', _attrs: {}, _kids: [], _q: new Map(), _handlers: {},
    classes: new Set(), disabled: false, hidden: false, value: '', checked: false,
    style: {}, dataset: {}, parentElement: null, onclick: null,
    classList: {
      add: (...c) => c.forEach(x => el.classes.add(x)),
      remove: (...c) => c.forEach(x => el.classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !el.classes.has(c) : !!force;
        on ? el.classes.add(c) : el.classes.delete(c);
      },
      contains: c => el.classes.has(c)
    },
    set innerHTML(v) { el._html = String(v); el._q.clear(); },
    get innerHTML() { return el._html; },
    set textContent(v) { el._text = String(v); },
    get textContent() { return el._text; },
    setAttribute: (n, v) => { el._attrs[n] = String(v); },
    getAttribute: n => (n in el._attrs ? el._attrs[n] : null),
    hasAttribute: n => n in el._attrs,
    appendChild: kid => { kid.parentElement = el; el._kids.push(kid); return kid; },
    querySelector: sel => {
      if (sel.startsWith('#')) return getEl(sel.slice(1));
      const attr = /^\[([\w-]+)\]$/.exec(sel)?.[1];
      if (attr) {
        const kid = el._kids.find(k => attr in k._attrs);
        if (kid) return kid;
      }
      const token = attr || sel;
      if (!el._html.includes(token)) return null;
      if (!el._q.has(sel)) el._q.set(sel, makeEl());
      return el._q.get(sel);
    },
    querySelectorAll: sel => {
      if (sel === '[data-triage-answer]' && el._html.includes('data-triage-answer')) {
        if (!el._q.has(sel)) el._q.set(sel, ['0', '1'].map(v => { const i = makeEl(); i.value = v; return i; }));
        return el._q.get(sel);
      }
      return [];
    },
    addEventListener: (n, f) => { (el._handlers[n] ||= []).push(f); },
    removeEventListener: () => {},
    fire: (n, ev = {}) => (el._handlers[n] || []).forEach(f => f({ target: el, currentTarget: el, preventDefault() {}, key: '', ...ev })),
    closest: () => null,
    scrollIntoView: () => {},
    focus: () => {},
    remove: () => { el._removed = true; }
  };
  return el;
}
const els = new Map();
const getEl = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
const docListeners = {};
globalThis.document = {
  title: '', head: makeEl('head'), body: makeEl('body'), documentElement: makeEl('html'), hidden: false,
  querySelector: sel => (sel.startsWith('#') ? getEl(sel.slice(1)) : makeEl()),
  querySelectorAll: sel => (sel === '.book-step' ? [1, 2, 3].map(i => getEl(`book-step-${i}`)) : []),
  getElementById: id => getEl(id),
  createElement: () => makeEl(),
  addEventListener: (n, f) => { (docListeners[n] ||= []).push(f); },
  removeEventListener: () => {}
};
const lsMap = new Map();  // пустой кэш: чистый браузер
globalThis.localStorage = {
  get: k => (lsMap.has(k) ? lsMap.get(k) : null),
  set: (k, v) => lsMap.set(k, String(v)),
  remove: k => lsMap.delete(k),
  clear: () => lsMap.clear()
};
const loc = { pathname: '/', search: '', hash: '', origin: 'http://x' };
const windowTarget = {
  localStorage: globalThis.localStorage,
  addEventListener: () => {},
  scrollTo: () => {},
  location: loc,
  confirm: () => true
};
globalThis.window = new Proxy(windowTarget, {
  get(t, p) { return p in t ? t[p] : makeEl(); },
  set(t, p, v) { t[p] = v; return true; }
});
globalThis.location = loc;
globalThis.history = { pushState() {}, replaceState() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-harness', clipboard: { writeText: async () => {} } } });
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.prompt = () => 'x';
globalThis.FileReader = class {};

// ——— «сервер»: сначала сетевая ошибка, потом (по флагу) настоящий каталог ———
const SLUG = 'nataliya-mikhajlovskaya-19';
const PSY_ID = 'psy_catalog_19';
const PSY_ROW = {
  id: PSY_ID, email: 'catalog+natalia@example.invalid', full_name: 'Наталия Михайловская',
  phone: '+375 (29) 780-45-45', specialization: 'Гештальт-терапевт', city: 'Гродно',
  about: 'Работа с отношениями.', website: '', source_url: '', address: 'г. Гродно', experience: '10 лет',
  slug: SLUG, profession: 'psychologist', greeting: '', approach: '', photo_url: '', public_email: '',
  directions: [], education: null, experience_items: [], socials: [], payment_links: [],
  payment_requisites: null, is_active: true, created_at: '2026-01-01T00:00:00Z'
};
const SVC_ROWS = [
  { id: 'svc60', psychologist_id: PSY_ID, title: 'Консультация 60 мин', description: '', duration_min: 60, price: 80, currency: 'BYN', format: 'offline', platforms: [], pay_url: '', sort_order: 1 }
];
const SETTINGS_ROW = {
  psychologist_id: PSY_ID, work_hours: 'Пн–Пт 10:00–19:00', timezone: 'Europe/Minsk',
  slot_start: '10:00', slot_end: '19:00', slot_step_min: 60, work_days: [1, 2, 3, 4, 5]
};
const RESP = (json, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(json), json: async () => json });
let networkUp = false;
let fetchCalls = 0;
// первая фаза: сеть «висит» — наблюдаем портал в состоянии loading
let releaseNetwork;
const networkHeld = new Promise(resolve => { releaseNetwork = resolve; });
globalThis.fetch = async url => {
  fetchCalls += 1;
  await networkHeld;
  if (!networkUp) throw new TypeError('Failed to fetch');
  const u = String(url);
  if (u.includes('public_profiles') || u.includes('psychologists?select=')) return RESP([PSY_ROW]);
  if (u.includes('/rest/v1/services')) return RESP(SVC_ROWS);
  if (u.includes('public_settings') || u.includes('session_settings')) return RESP([SETTINGS_ROW]);
  return RESP([]);
};
const tick = (n = 10) => new Promise(r => { let k = 0; const step = () => { if (++k >= n) r(); else setImmediate(step); }; step(); });

// ============================================================
// B. Сетевая ошибка каталога: честный экран, без демо
// ============================================================
const app = await import(new URL('../js/app.js', import.meta.url));
await tick(40);
const { portalVm, bookingVm } = app;
const { db } = await import('../js/core/dbContext.js');
const { supabaseSync } = await import('../js/services/supabaseSync.js');
const { supabaseApi } = await import('../js/services/supabaseApi.js');
const { fraudProtectionService } = await import('../js/services/fraudProtectionService.js');
const { bookingTriageWizard } = await import('../js/views/bookingTriageWizard.js');

const portalList = getEl('portal-list');
// B0: пока каталог грузится, seed-фикстура dbContext (пустой кэш первого визита)
// лежит в db.psychologists — но на портале НЕ рисуется ни одной карточки.
const seedWhileLoading = db.psychologists.length;
const cardsWhileLoading = (portalList._html.match(/<article/g) || []).length;
check('B0 фаза loading: seed-фикстура в зеркале есть, но карточек на портале нет — только «Загружаем…»',
  portalVm.source === 'loading' && seedWhileLoading > 0 && cardsWhileLoading === 0
    && portalList._html.includes('Загружаем каталог с сервера') && !portalList._html.includes('Анастасия Мартынова'),
  `source=${portalVm.source} seed=${seedWhileLoading} cards=${cardsWhileLoading}`);
check('B0b фаза loading: фильтр городов не заполнен из фикстуры',
  !getEl('portal-city')._html.includes('<option value="Минск"'), getEl('portal-city')._html);
releaseNetwork();
await tick(60);
check('B1 сетевая ошибка → источник каталога none (не demo)', portalVm.source === 'none', String(portalVm.source));
check('B2 экран «нет связи» показан с кнопкой «Повторить»',
  portalList._html.includes('Нет связи с сервером данных') && portalList._html.includes('retryServerData'),
  portalList._html.slice(0, 120));
check('B3 экран «нет связи» без кнопки/упоминания демо-данных',
  !/демо/i.test(portalList._html) && !portalList._html.includes('enableDemoData'), portalList._html.slice(0, 200));
check('B4 seed-каталог не подставлен при сетевой ошибке (db.psychologists пуст)',
  Array.isArray(db.psychologists) && db.psychologists.length === 0, String(db.psychologists?.length));
check('B5 глобальных enableDemoData / resetPortalData в window нет',
  !('enableDemoData' in windowTarget) && !('resetPortalData' in windowTarget));
check('B6 catalogReady=false при none', portalVm.catalogReady === false);
const badge = getEl('portal-src-badge');
check('B7 бейдж источника при none — «Нет связи с сервером»', badge._text === 'Нет связи с сервером', badge._text);

// ============================================================
// C. Воронка записи без сервера: недоступность, не localOnly-успех
// ============================================================
networkUp = true;
window.retryServerData();
await tick(60);
check('C0 после «Повторить» каталог загружен с сервера', portalVm.source === 'server' && portalVm.catalogReady === true, String(portalVm.source));

const noteHost = makeEl('note-host');
getEl('bk-note').parentElement = noteHost;
window.navigate('booking', { slug: SLUG });
await tick(20);
check('C1 страница записи загрузила специалиста', bookingVm.psychologist?.id === PSY_ID, bookingVm.psychologist?.fullName);
bookingVm.selectServiceAndContinue('svc60');
const d = new Date(); d.setDate(d.getDate() + 14);
while (![1, 2, 3, 4, 5].includes(d.getDay())) d.setDate(d.getDate() + 1);
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
bookingVm.selectDate(DATE);
bookingVm.selectTimeAndContinue('12:00');
bookingVm.nickname = 'Anna_R14';
bookingVm.name = 'Anna_R14';
bookingVm.phone = '+375 29 111-22-33';
bookingVm.contact = '@anna_r14';
bookingVm.consent = true;
bookingVm.honeypot = '';
bookingVm.note = '';
fraudProtectionService.formOpenedAt = Date.now() - 30000;
check('C2 воронка доведена до шага 3', bookingVm.step === 3, `step=${bookingVm.step}`);

const origEnabled = supabaseSync.enabled.bind(supabaseSync);
const origCreate = supabaseApi.createBooking;
let rpcCalls = 0;
supabaseApi.createBooking = async () => { rpcCalls += 1; return { ok: true, client_id: 'x', session_id: 'y' }; };
supabaseSync.enabled = () => false;              // сервер НЕ настроен
const sessionsBefore = db.sessions.length;
const clientsBefore = db.clients.length;
let submitRes;
try {
  submitRes = await bookingVm.submit();
  check('C3 submit() без сервера → false (никакого local success)', submitRes === false, String(submitRes));
  check('C4 ошибка объясняет отказ (недоступность / сервер не настроен)',
    /недоступн|не настроен/i.test(bookingVm.error || ''), bookingVm.error);
  check('C5 success не показан: done=false, successText пуст, awaitingPayment=false',
    bookingVm.done !== true && !bookingVm.successText && !bookingVm.awaitingPayment,
    `done=${bookingVm.done} text=${JSON.stringify(bookingVm.successText)}`);
  check('C6 локальная запись откатана (sessions не выросли)', db.sessions.length === sessionsBefore,
    `${sessionsBefore} → ${db.sessions.length}`);
  check('C7 RPC create_booking не вызывался (сервер не настроен → нет сетевых вызовов записи)', rpcCalls === 0, String(rpcCalls));
  check('C8 submitting снят — повторная попытка возможна', bookingVm.submitting === false);

  const persisted = await bookingVm._persistBooking({ psychologistId: PSY_ID }, { id: 'cli_x' });
  check('C9 _persistBooking без сервера: ok=false и не localOnly',
    persisted?.ok === false && persisted?.localOnly !== true && /недоступн|не настроен/i.test(persisted?.message || ''),
    JSON.stringify(persisted));

  // панель оплаты (контракт гетера) — без сервера НЕ включает демо-кнопки
  bookingVm.awaitingPayment = true;
  bookingVm.paymentInfo = { amountDueNow: 40, currency: 'BYN', policy: 'deposit', holdMinutes: 60 };
  const checkout = bookingVm.paymentCheckout;
  check('C10 paymentCheckout без сервера: демо-режима нет',
    checkout.visible === true && checkout.allowDemoPay !== true && checkout.mode !== 'local-demo'
      && !/демо|только в этом браузере/i.test(`${checkout.title} ${checkout.footnote}`),
    JSON.stringify(checkout));
  bookingVm.awaitingPayment = false;
  bookingVm.paymentInfo = null;
  check('C11 в BookingViewModel нет метода completePayment (demo pay снят)', typeof bookingVm.completePayment === 'undefined');
  // Граница задачи: карточка клиента создаётся в локальном зеркале ДО серверной
  // транзакции и при любом отказе сервера (занятое время, недоступность) не
  // откатывается — это контур локального зеркала/server-ack (R01 #108, R02 #109),
  // а не demo-подмена; здесь фиксируем факт, не маскируя его (RULES §6.15).
  console.log(`INFO  клиентов в локальном зеркале после отказа: ${clientsBefore} → ${db.clients.length} (граница R01/R02)`);

  // ============================================================
  // D. Опрос (триаж) без сервера: прикрепить нельзя, демо-заявки нет
  // ============================================================
  bookingVm.done = false;
  bookingVm.error = '';
  bookingVm.triageAssessment = null;
  bookingVm.clientAuthSession = null;
  bookingVm.clientGoogleUser = null;
  bookingTriageWizard.afterRender({ route: { name: 'booking' }, vm: bookingVm });
  const controls = noteHost.querySelector('[data-booking-triage-controls]');
  const openBtn = controls?.querySelector('[data-triage-open]');
  check('D1 контролы опроса смонтированы рядом с полем комментария', !!controls && typeof openBtn?.onclick === 'function');
  openBtn.onclick();
  const modal = document.body._kids.find(k => k.id === 'booking-triage-modal' && !k._removed);
  const content = modal?.querySelector('[data-triage-content]');
  check('D2 интро опроса без сервера: сказано, что отправка недоступна, без слова «демо»',
    !!content && /недоступн|не настроен/i.test(content._html) && !/демо/i.test(content._html),
    content?._html?.replace(/\s+/g, ' ').slice(0, 200));
  const shareConsent = content.querySelector('[data-triage-share-consent]');
  shareConsent.checked = true;
  shareConsent.fire('change');
  content.querySelector('[data-triage-start]').fire('click');
  let guard = 0;
  while (!content._html.includes('data-triage-save') && guard++ < 12) {
    const answers = content.querySelectorAll('[data-triage-answer]');
    answers[0].fire('change');                       // «0» на каждый вопрос
    content.querySelector('[data-triage-next]').fire('click');
  }
  check('D3 опрос пройден до финального экрана', content._html.includes('data-triage-save'), `итераций=${guard}`);
  const status = content.querySelector('[data-triage-auth-status]');
  const save = content.querySelector('[data-triage-save]');
  const finalConsent = content.querySelector('[data-triage-final-consent]');
  finalConsent.checked = true;
  finalConsent.fire('change');                       // согласие дано — но сервера нет
  check('D4 без сервера кнопка прикрепления disabled и не «Добавить в демо-заявку»',
    save.disabled === true && !/демо/i.test(save._text), `disabled=${save.disabled} text=${JSON.stringify(save._text)}`);
  check('D5 статус объясняет недоступность без «демо-режима»',
    /недоступн|не настроен/i.test(status._text) && !/демо/i.test(status._text), status._text);
  check('D6 финальная сноска без сервера не обещает «останется в этом браузере»',
    !/останется только в|демонстрационн/i.test(content._html), content._html.replace(/\s+/g, ' ').slice(0, 200));
  save.fire('click', { currentTarget: save });       // Poka-Yoke: даже принудительный клик
  await tick(5);
  check('D7 клик по «прикрепить» без сервера НЕ прикрепляет опрос к заявке',
    bookingVm.triageAssessment == null, JSON.stringify(bookingVm.triageAssessment)?.slice(0, 80));
  bookingTriageWizard.close();
} finally {
  supabaseSync.enabled = origEnabled;
  supabaseApi.createBooking = origCreate;
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
