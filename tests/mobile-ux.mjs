#!/usr/bin/env node
/**
 * Мобильные диалоги, CTA и защита от двойной отправки (issue #64: MX-03,
 * MX-05, MX-06, BL-05).
 *
 *   node tests/mobile-ux.mjs
 *
 * Что проверяется:
 *   1. MX-03 — в js/ не осталось нативных confirm()/prompt(); диалоги живут
 *      в единственной канонической реализации js/views/uiDialogs.js;
 *   2. MX-05 — viewport-fit=cover, safe-area у sticky-хедеров, модалки кабинета
 *      и UI-диалоги — bottom-sheet на мобильном (классы .modal-sheet/.modal-panel
 *      присутствуют и в собранном css/tailwind.css);
 *   3. MX-06 — блок «Далее/Записаться» воронки обёрнут в #book-cta.book-cta
 *      (sticky снизу на мобильном), десктопная раскладка не менялась;
 *   4. BL-05 — поведение: двойной вызов submit() во время полёта не создаёт
 *      вторую заявку, флаг submitting поднимается/опускается, при отказе сервера
 *      кнопка возвращается в рабочее состояние;
 *   5. UI-диалоги: отмена ≠ подтверждение, деструктивный диалог не «отправляет»
 *      действие при закрытии, черновик prompt не теряется при отмене,
 *      копирование идёт через Clipboard API, а фолбэк — sheet, не prompt.
 *
 * Это регресс-набор #64 в общем гейте (`npm run verify`), не замена
 * verify_pages.py (смоук против живого devserver) и не браузерный E2E:
 * мобильный рендер на устройстве подтверждает владелец.
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

// ============================================================
// A. Статические инварианты разметки и стилей (MX-03/MX-05/MX-06)
// ============================================================
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'css/tailwind.css'), 'utf8');
const srcCss = readFileSync(join(ROOT, 'css/tailwind.src.css'), 'utf8');

function walkJs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Комментарии не являются вызовом: «confirm()/prompt() запрещены» — это текст. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const jsFiles = walkJs(join(ROOT, 'js'));
const nativeCalls = [];
for (const file of jsFiles) {
  const code = stripComments(readFileSync(file, 'utf8'));
  for (const m of code.matchAll(/(^|[^.\w$])(?:window\.)?(confirm|prompt)\s*\(/g)) {
    const rel = file.slice(ROOT.length + 1);
    // Google Identity Services вызывает собственный prompt() — не наш диалог.
    const around = code.slice(Math.max(0, m.index - 40), m.index + 10);
    if (/accounts\.id\.$/.test(around) || /google/i.test(around)) continue;
    nativeCalls.push(`${rel}: ${m[0].trim()}`);
  }
}
check('MX-03: нативных confirm()/prompt() в js/ нет', nativeCalls.length === 0, nativeCalls.join('; '));
check('MX-03: канонический модуль диалогов существует',
  jsFiles.some(f => f.endsWith('js/views/uiDialogs.js')));
const dialogsSrc = stripComments(readFileSync(join(ROOT, 'js/views/uiDialogs.js'), 'utf8'));
check('MX-03: uiDialogs не использует нативные confirm/prompt',
  !/(^|[^.\w$])confirm\s*\(/.test(dialogsSrc) && !/(^|[^.\w$])prompt\s*\(/.test(dialogsSrc));
check('MX-03: uiConfirm/uiPrompt/copyText экспортируются',
  /export async function uiConfirm/.test(dialogsSrc)
  && /export async function uiPrompt/.test(dialogsSrc)
  && /export async function copyText/.test(dialogsSrc));

check('MX-05: viewport-fit=cover объявлен',
  /<meta name="viewport"[^>]*viewport-fit=cover/.test(html));
const stickyHeaders = [...html.matchAll(/<header class="([^"]*sticky top-0[^"]*)"/g)].map(m => m[1]);
check('MX-05: все sticky-хедеры учитывают safe-area сверху',
  stickyHeaders.length >= 4 && stickyHeaders.every(c => /\bsafe-top\b/.test(c)),
  `${stickyHeaders.length} хедеров`);
const sheetModals = [...html.matchAll(/id="(modal-[a-z]+)"[^>]*class="([^"]*)"/g)]
  .filter(([, id]) => ['modal-session', 'modal-client', 'modal-service'].includes(id));
check('MX-05: три модалки кабинета — sheet на мобильном',
  sheetModals.length === 3 && sheetModals.every(([, , cls]) => /\bmodal-sheet\b/.test(cls)),
  sheetModals.map(([id, cls]) => `${id}:${cls}`).join(' | '));
check('MX-05: панели модалок помечены modal-panel',
  (html.match(/class="modal-panel /g) || []).length >= 3);
check('MX-05: UI-диалоги подтверждения/ввода — sheet с панелью',
  /id="modal-confirm"[\s\S]{0,200}modal-sheet/.test(html)
  && /id="modal-prompt"[\s\S]{0,200}modal-sheet/.test(html)
  && /id="modal-prompt"[\s\S]{0,1200}id="ui-prompt-text"/.test(html));
check('MX-05: деструктивное подтверждение — отдельная красная кнопка',
  /id="ui-confirm-ok"[^>]*bg-rose-600/.test(html.replace(/\n\s*/g, ' ')));

check('MX-05: собранный CSS содержит sheet/safe-area',
  css.includes('.modal-sheet{') && css.includes('.modal-panel{')
  && css.includes('safe-area-inset-bottom') && css.includes('safe-area-inset-top')
  && /max-width:\s*767px/.test(srcCss));

check('MX-06: CTA воронки — sticky-блок #book-cta.book-cta',
  /id="book-cta" class="book-cta /.test(html) && css.includes('.book-cta{')
  && /<div id="book-cta" class="book-cta[^>]*>[\s\S]{0,900}id="book-submit"/.test(html));
check('MX-06: sticky-CTA только мобильный (внутри media max-width:767px)',
  /@media \(max-width: 767px\)[\s\S]*\.book-cta\s*\{/.test(srcCss));

// ============================================================
// B. DOM-стаб: диалоги + реальный app.js (двойная отправка)
// ============================================================
function makeEl(id = '') {
  const el = {
    id,
    _html: '', _text: '', _value: '', _rows: 0, _placeholder: '',
    classes: new Set(),
    disabled: false, hidden: false, checked: false,
    style: {}, dataset: {}, listeners: {},
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
    set value(v) { el._value = v === undefined ? '' : String(v); },
    get value() { return el._value; },
    set rows(v) { el._rows = v; },
    get rows() { return el._rows; },
    set placeholder(v) { el._placeholder = String(v ?? ''); },
    get placeholder() { return el._placeholder; },
    querySelectorAll: () => [],
    querySelector: () => makeEl(),
    addEventListener: (n, f) => { (el.listeners[n] ||= []).push(f); },
    removeEventListener: () => {},
    appendChild: () => makeEl(),
    setAttribute: () => {},
    getAttribute: () => null,
    closest: () => null,
    scrollIntoView: () => {},
    focus: () => {},
    select: () => { el._selected = true; },
    remove: () => {}
  };
  return el;
}

const els = new Map();
const getEl = sel => {
  if (!els.has(sel)) els.set(sel, makeEl(sel));
  return els.get(sel);
};
const docListeners = {};
globalThis.document = {
  title: '',
  head: makeEl('head'),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  hidden: false,
  querySelector: sel => getEl(sel),
  querySelectorAll: sel => (sel === '.book-step' ? [1, 2, 3].map(i => getEl(`#book-step-${i}`)) : []),
  getElementById: id => getEl('#' + id),
  createElement: () => makeEl(),
  addEventListener: (n, f) => { (docListeners[n] ||= []).push(f); },
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
  addEventListener: () => {},
  scrollTo: () => {},
  location: loc,
  confirm: () => { throw new Error('нативный confirm вызван из кода (#64)'); },
  prompt: () => { throw new Error('нативный prompt вызван из кода (#64)'); }
}, { get(t, p) { return p in t ? t[p] : makeEl(); }, set(t, p, v) { t[p] = v; return true; } });
globalThis.location = loc;
globalThis.history = { pushState() {}, replaceState() {} };
globalThis.confirm = () => { throw new Error('нативный confirm вызван из кода (#64)'); };
globalThis.prompt = () => { throw new Error('нативный prompt вызван из кода (#64)'); };
globalThis.alert = () => {};
globalThis.FileReader = class {};
globalThis.scrollTo = () => {};
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node-harness', clipboard: { writeText: async () => { globalThis.__copied = true; } } }
});

// ——— мок «сервера»: профиль + услуги + настройки (как в tests/booking-wizard) ———
const PSY_ID = 'psy_catalog_19';
const PSY_ROW = {
  id: PSY_ID, email: 'catalog+natalia@example.invalid', full_name: 'Наталия Михайловская',
  phone: '+375 (29) 780-45-45', specialization: 'Гештальт-терапевт', city: 'Гродно',
  about: 'Работа с отношениями.', website: '', source_url: '', address: 'г. Гродно',
  experience: '10 лет практики', slug: SLUG, profession: 'psychologist', greeting: '',
  approach: '', photo_url: '', public_email: 'natalia@example.invalid', directions: [],
  education: null, experience_items: [], socials: [], payment_links: [], payment_requisites: null,
  is_active: true, created_at: '2026-01-01T00:00:00Z'
};
const SVC_ROWS = [
  { id: 'svc60', psychologist_id: PSY_ID, title: 'Консультация 60 мин', description: '', duration_min: 60, price: 80, currency: 'BYN', format: 'offline', platforms: [], pay_url: '', sort_order: 1 }
];
const SETTINGS_ROW = {
  psychologist_id: PSY_ID, work_hours: 'Пн–Пт 10:00–19:00', timezone: 'Europe/Minsk',
  slot_start: '10:00', slot_end: '19:00', slot_step_min: 60, work_days: [1, 2, 3, 4, 5]
};
const RESP = (json, status = 200) => ({
  ok: status < 400, status, headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(json), json: async () => json
});
globalThis.fetch = async url => {
  const u = String(url);
  if (u.includes('public_profiles') || u.includes('psychologists?select=')) return RESP([PSY_ROW]);
  if (u.includes('/rest/v1/services')) return RESP(SVC_ROWS);
  if (u.includes('public_settings') || u.includes('session_settings')) return RESP([SETTINGS_ROW]);
  return RESP([]);
};

const fire = (sel, event = 'click', data = {}) => {
  const el = getEl(sel);
  for (const fn of el.listeners[event] || []) fn({ target: el, preventDefault() {}, ...data });
  return el;
};
const fireDoc = (event, payload = {}) => {
  for (const fn of docListeners[event] || []) fn(payload);
};

// ——— B1. UI-диалоги (js/views/uiDialogs.js) ———
const { uiConfirm, uiPrompt, copyText } = await import('../js/views/uiDialogs.js');

const confirmModal = getEl('#modal-confirm');
let confirmResult;
const pendingConfirm = uiConfirm({ title: 'Удалить сессию?', message: 'Необратимо', confirmLabel: 'Удалить' });
check('диалог подтверждения открыт (не нативный confirm)',
  !confirmModal.classList.contains('hidden') && confirmModal.classList.contains('flex'));
check('текст диалога задан из вызова',
  getEl('#ui-confirm-title')._text === 'Удалить сессию?' && getEl('#ui-confirm-ok')._text === 'Удалить');
pendingConfirm.then(v => { confirmResult = v; });
fire('#ui-confirm-ok');
await pendingConfirm;
check('подтверждение по красной кнопке → true', confirmResult === true, String(confirmResult));
check('диалог подтверждения закрыт после ответа',
  confirmModal.classList.contains('hidden') && !confirmModal.classList.contains('flex'));

const cancelConfirm = uiConfirm({ title: 'Удалить клиента?' });
fire('#ui-confirm-cancel');
check('отмена подтверждения → false', (await cancelConfirm) === false);
const escConfirm = uiConfirm({ title: 'Отменить сессию?' });
fireDoc('keydown', { key: 'Escape' });
check('Esc закрывает подтверждение без действия', (await escConfirm) === false);

const promptModal = getEl('#modal-prompt');
const textField = getEl('#ui-prompt-text');
const promptPromise = uiPrompt({
  title: 'Запись о сессии', label: 'Видна только вам', key: 'session-note-1', rows: 5
});
check('sheet ввода открыт, поле многострочное',
  !promptModal.classList.contains('hidden') && textField.rows === 5);
textField.value = 'Клиент говорил о тревоге';
fire('#ui-prompt-cancel');
check('отмена sheet ввода → null (ничего не сохраняется)', (await promptPromise) === null);
const reopened = uiPrompt({ title: 'Запись о сессии', label: 'Видна только вам', key: 'session-note-1' });
check('MX-03: черновик не теряется при отмене',
  getEl('#ui-prompt-text').value === 'Клиент говорил о тревоге', getEl('#ui-prompt-text').value);
getEl('#ui-prompt-text').value = 'Клиент говорил о тревоге и о сне';
fire('#ui-prompt-ok');
check('сохранение sheet ввода возвращает текст',
  (await reopened) === 'Клиент говорил о тревоге и о сне');
const afterSave = uiPrompt({ title: 'Запись о сессии', key: 'session-note-1' });
check('после сохранения черновик очищен (повторное открытие пустое)',
  getEl('#ui-prompt-text').value === '');
fire('#ui-prompt-cancel');
await afterSave;

globalThis.__copied = false;
const copyOk = await copyText('https://example.invalid/book/x', { title: 'Ссылка' });
check('копирование: Clipboard API + toast (via=clipboard)',
  copyOk.ok === true && copyOk.via === 'clipboard' && globalThis.__copied === true,
  JSON.stringify(copyOk));
const realClipboard = navigator.clipboard;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node-harness', clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } }
});
const copyFallback = copyText('https://example.invalid/book/y', { title: 'Ссылка клиента' });
await new Promise(r => setTimeout(r, 0)); // отказ clipboard → фолбэк открывается в микрозадаче
check('фолбэк копирования — sheet, а не нативный prompt',
  !getEl('#modal-prompt').classList.contains('hidden')
  && getEl('#ui-prompt-text').value === 'https://example.invalid/book/y',
  getEl('#ui-prompt-text').value);
fire('#ui-prompt-ok');
const fallbackRes = await copyFallback;
check('фолбэк вернул via=sheet и ok=false',
  fallbackRes.ok === false && fallbackRes.via === 'sheet', JSON.stringify(fallbackRes));
Object.defineProperty(globalThis, 'navigator', { value: realClipboard });

// ——— B2. Двойная отправка заявки на реальном BookingViewModel (BL-05) ———
const app = await import('../js/app.js');
await new Promise(r => setTimeout(r, 80)); // каталог «с сервера»
const { bookingVm } = app;
const { supabaseApi } = await import('../js/services/supabaseApi.js');
const { fraudProtectionService } = await import('../js/services/fraudProtectionService.js');

const render = () => window.navigate('booking', { slug: SLUG });
const futureWorkday = () => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  for (let i = 0; i < 10; i++) {
    const iso = d.toISOString().slice(0, 10);
    const isoDay = ((new Date(iso + 'T12:00:00').getDay() + 6) % 7) + 1;
    if (isoDay <= 5) return iso;
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
};

render();
fraudProtectionService.formOpenedAt = Date.now() - 30000; // антиспам: форма «открыта» давно
bookingVm.selectServiceAndContinue('svc60');
bookingVm.selectDate(futureWorkday());
render();
bookingVm.selectTimeAndContinue('10:00');
bookingVm.nickname = 'Anna_Double';
bookingVm.name = 'Anna_Double';
bookingVm.phone = '+375 29 111-22-33';
bookingVm.contact = '@anna_double';
bookingVm.note = 'тест двойной отправки';
bookingVm.consent = true;
// renderBooking синхронизирует поля из DOM (единственный источник для клиента),
// поэтому в стабе заполняем и DOM, и VM — как это делает реальный ввод.
getEl('#bk-nickname').value = 'Anna_Double';
getEl('#bk-phone').value = '+375 29 111-22-33';
getEl('#bk-contact').value = '@anna_double';
getEl('#bk-note').value = 'тест двойной отправки';
getEl('#bk-consent').checked = true;
render();

check('воронка доведена до шага 3 (перед отправкой)', bookingVm.step === 3, `step=${bookingVm.step}`);
check('BL-05: флаг submitting выключен до отправки', bookingVm.submitting === false);

const realCreateBooking = supabaseApi.createBooking;
let rpcCalls = 0;
let releaseRpc = null;
const rpcGate = new Promise(resolve => { releaseRpc = resolve; });
const realAddSession = bookingVm._persistBooking.bind(bookingVm);
supabaseApi.createBooking = async () => {
  rpcCalls += 1;
  await rpcGate;
  return { ok: true, client_id: 'cli_srv_x', session_id: 'ses_srv_x', duration_min: 60 };
};

const sessionsBefore = (await import('../js/core/dbContext.js')).db.sessions.length;
const first = bookingVm.submit();
const second = bookingVm.submit();          // второй тап во время полёта
const submittingDuringFlight = bookingVm.submitting;
releaseRpc();

const [firstRes, secondRes] = await Promise.all([first, second]);
check('BL-05: во время полёта submitting=true', submittingDuringFlight === true);
check('BL-05: повторный submit() не создаёт вторую заявку (вернул false)',
  secondRes === false, String(secondRes));
check('BL-05: серверный вызов ровно один', rpcCalls === 1, String(rpcCalls));
check('BL-05: первая отправка успешна и создала одну запись',
  !!firstRes && firstRes.id === 'ses_srv_x', String(firstRes?.id || bookingVm.error));
const { db } = await import('../js/core/dbContext.js');
check('BL-05: в локальном зеркале одна новая заявка (без дубля)',
  db.sessions.length === sessionsBefore + 1, `${sessionsBefore} → ${db.sessions.length}`);
check('BL-05: флаг submitting снят после завершения', bookingVm.submitting === false);

// отказ сервера: кнопка обязана вернуться в рабочее состояние.
// Для честного сценария берём другое свободное окно — 10:00 уже занято
// успешной заявкой выше (иначе submit() остановился бы на валидации слота).
supabaseApi.createBooking = async () => ({ ok: false, error: 'Это время только что заняли' });
bookingVm.done = false;
bookingVm.error = '';
bookingVm.selectTimeAndContinue('11:00');
render();
const failedSubmit = await bookingVm.submit();
check('BL-05: отказ сервера → submit() false и ошибка показана',
  failedSubmit === false && /только что заняли/.test(bookingVm.error || ''), bookingVm.error);
check('BL-05: после отказа submitting=false (повторная попытка возможна)',
  bookingVm.submitting === false);
supabaseApi.createBooking = realCreateBooking;
void realAddSession;

// ——— C. Рендер: кнопка отправки отражает состояние полёта ———
const submitBtn = getEl('#book-submit');
render();
check('MX-06/BL-05: кнопка «Записаться» видна на шаге 3 и активна',
  !submitBtn.classList.contains('hidden') && submitBtn.disabled === false,
  `hidden=${submitBtn.classList.contains('hidden')} disabled=${submitBtn.disabled}`);
bookingVm.submitting = true;
render();
check('BL-05: при submitting=true кнопка disabled и подписана «Отправляем…»',
  submitBtn.disabled === true && submitBtn._text === 'Отправляем…', submitBtn._text);
bookingVm.submitting = false;
render();
check('BL-05: после снятия флага кнопка снова активна и подписана «Записаться»',
  submitBtn.disabled === false && submitBtn._text === 'Записаться', submitBtn._text);
check('MX-06: блок CTA не скрывается целиком (sticky-обёртка живёт на всех шагах)',
  !getEl('#book-cta').classList.contains('hidden'));

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
