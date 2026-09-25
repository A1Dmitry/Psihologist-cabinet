#!/usr/bin/env node
/**
 * Регрессия issue #74 — первый визит по прямой ссылке /book/{slug} при пустом
 * кэше: мастер записи должен отрисоваться ПОСЛЕ загрузки каталога.
 *
 *   node tests/booking-first-visit.mjs
 *
 * Что воспроизводится (симптом из issue):
 *   1. Чистый профиль (пустой localStorage), глубокая ссылка /book/{slug}.
 *   2. Первый render происходит ДО загрузки серверного каталога; в локальном
 *      seed слаг кириллический («наталия-михайловская-19»), серверный —
 *      латинский («nataliya-mikhajlovskaya-19»), поэтому специалист «не найден».
 *   3. ДО фикса: заглушка ставилась через `#book-body`.innerHTML и безвозвратно
 *      стирала статическую разметку мастера (#book-step-*, #book-services, …).
 *      После загрузки каталога рисовать было некуда — «Специалист не найден»
 *      оставался навсегда.
 *
 * Почему прежние харнесы не ловили баг: их мок-DOM не моделирует уничтожение
 * дочерних узлов при перезаписи innerHTML (getElementById всегда возвращает
 * кэш). Здесь — честная модель: состав поддерева #book-body читается из
 * РЕАЛЬНОГО index.html, и присваивание innerHTML контейнеру отвязывает
 * дочерние id, отсутствующие в новой разметке (семантика настоящего DOM).
 *
 * Покрывает (DoD из issue):
 *   • первый визит на /book/{slug} при пустом кэше → пока каталог грузится,
 *     видно состояние загрузки, разметка мастера не разрушена; после загрузки
 *     мастер отрисован;
 *   • «Специалист не найден» — только когда каталог точно загружен и
 *     специалиста в нём нет; состояние обратимо (возврат на валидный слаг
 *     снова рисует мастер);
 *   • то же для /psy/{slug}: первый визит → после загрузки каталога страница
 *     специалиста отрисована;
 *   • SEO-честность: noindex НЕ ставится, пока каталог ещё грузится.
 */
import { readFileSync } from 'node:fs';

// ——— разбор РЕАЛЬНОГО index.html: состав поддерева #book-body ———
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function subtreeIds(containerId) {
  const openIdx = HTML.indexOf(`id="${containerId}"`);
  if (openIdx === -1) throw new Error(`в index.html нет контейнера #${containerId}`);
  // сбалансированный разбор <div …> … </div> от контейнера
  let i = HTML.lastIndexOf('<div', openIdx);
  let depth = 0;
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = i;
  let m, end = -1;
  while ((m = re.exec(HTML))) {
    if (m[0].startsWith('</div')) depth -= 1;
    else depth += 1;
    if (depth === 0) { end = re.lastIndex; break; }
  }
  if (end === -1) throw new Error(`не найден конец #${containerId}`);
  const chunk = HTML.slice(openIdx, end);
  return new Set([...chunk.matchAll(/id="([^"]+)"/g)].map(x => x[1]));
}

const BOOK_BODY_IDS = subtreeIds('book-body');

// ——— мок-DOM с честной семантикой уничтожения поддеревьев ———
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
    set innerHTML(v) {
      el._html = String(v);
      // Честная DOM-семантика: контейнер с известным поддеревом при перезаписи
      // innerHTML теряет дочерние узлы, которых нет в новой разметке.
      const kids = CHILD_IDS.get(el.id);
      if (kids) {
        for (const kid of kids) {
          if (kid === el.id) continue;
          if (!el._html.includes(`id="${kid}"`)) detached.add(kid);
          else detached.delete(kid);
        }
      }
    },
    get innerHTML() { return el._html; },
    set textContent(v) { el._text = String(v); },
    get textContent() { return el._text; },
    querySelectorAll: () => [],
    querySelector: sel => (sel.startsWith('#') ? getEl(sel.slice(1)) : makeEl()),
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

const CHILD_IDS = new Map([['book-body', BOOK_BODY_IDS]]);
const detached = new Set();      // id, фактически удалённые из DOM
const els = new Map();
const getEl = id => {
  if (!els.has(id)) els.set(id, makeEl(id));
  const el = els.get(id);
  return detached.has(id) ? null : el;   // уничтоженный узел больше не находится
};

globalThis.document = {
  title: '',
  head: makeEl('head'),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  hidden: false,
  querySelector: sel => (sel.startsWith('#') ? getEl(sel.slice(1)) : makeEl()),
  querySelectorAll: sel => (sel === '.book-step'
    ? [1, 2, 3].map(i => getEl(`book-step-${i}`)).filter(Boolean)
    : []),
  getElementById: id => getEl(id),
  createElement: () => makeEl(),
  addEventListener: () => {},
  removeEventListener: () => {}
};

const lsMap = new Map();             // ПУСТОЙ кэш — условие воспроизведения
globalThis.localStorage = {
  get: k => (lsMap.has(k) ? lsMap.get(k) : null),
  set: (k, v) => lsMap.set(k, String(v)),
  remove: k => lsMap.delete(k),
  clear: () => lsMap.clear()
};

const SLUG = 'nataliya-mikhajlovskaya-19';
const loc = { pathname: `/book/${SLUG}`, search: '', hash: '', origin: 'http://x' };
const listeners = {};
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

// ——— мок «сервера» с управляемой задержкой (детерминированные фазы) ———
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
  { id: 'svc60', psychologist_id: PSY_ID, title: 'Консультация 60 мин', description: '', duration_min: 60, price: 80, currency: 'BYN', format: 'offline', platforms: [], pay_url: '', sort_order: 1 }
];
const SETTINGS_ROW = {
  psychologist_id: PSY_ID, work_hours: 'Пн–Пт 10:00–19:00', timezone: 'Europe/Minsk',
  slot_start: '10:00', slot_end: '19:00', slot_step_min: 60, work_days: [1, 2, 3, 4, 5]
};
const RESP = (json, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(json), json: async () => json });

let releaseCatalog = null;
const gate = new Promise(r => { releaseCatalog = r; });
globalThis.fetch = async url => {
  const u = String(url);
  if (u.includes('public_profiles') || u.includes('psychologists?select=')) { await gate; return RESP([PSY_ROW]); }
  if (u.includes('/rest/v1/services')) { await gate; return RESP(SVC_ROWS); }
  if (u.includes('public_settings') || u.includes('session_settings')) { await gate; return RESP([SETTINGS_ROW]); }
  return RESP([]);
};

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond, extra]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};
const tick = (n = 6) => new Promise(r => {
  let k = 0;
  const step = () => { if (++k >= n) r(); else setImmediate(step); };
  step();
});

// ——— старт приложения: глубокая ссылка /book/{slug}, каталог ещё не загружен ———
await import(new URL('../js/app.js', import.meta.url));
await tick(30);

// ФАЗА 1: каталог ещё грузится
const ph1 = getEl('book-placeholder');
const body1 = getEl('book-body');
check('фаза загрузки: плейсхолдер показывает загрузку, а не «не найден»',
  ph1 && !ph1.classes.has('hidden') && ph1._html.includes('Загружаем каталог') && !ph1._html.includes('не найден'),
  `placeholder=${JSON.stringify(ph1?._html?.slice(0, 80))}`);
check('фаза загрузки: разметка мастера НЕ разрушена (#book-services находится в DOM)',
  getEl('book-services') !== null && BOOK_BODY_IDS.has('book-services'));
check('фаза загрузки: noindex не применён (страница ещё может оказаться валидной)',
  !String(document.title).includes('не найдена'),
  `title=${document.title}`);

// ФАЗА 2: каталог догрузился — мастер должен отрисоваться
releaseCatalog();
await tick(60);

const services = getEl('book-services');
check('после загрузки каталога: услуги отрисованы в сохранившейся разметке мастера',
  !!services && services._html.includes('Консультация 60 мин'),
  `#book-services=${services ? 'найден' : 'УНИЧТОЖЕН'}`);
check('после загрузки каталога: индикатор шагов отрисован',
  !!getEl('book-steps') && getEl('book-steps')._html.includes('Услуга'));
check('после загрузки каталога: имя специалиста в шапке мастера',
  !!getEl('book-psy-name') && getEl('book-psy-name')._text === 'Наталия Михайловская',
  `имя=${JSON.stringify(getEl('book-psy-name')?._text)}`);
check('после загрузки каталога: «Специалист не найден» на странице записи отсутствует',
  body1 && !body1._html.includes('Специалист не найден') && !(getEl('book-placeholder') && !getEl('book-placeholder').classes.has('hidden') && getEl('book-placeholder')._html.includes('не найден')),
  `body=${JSON.stringify(body1?._html?.slice(0, 80))}`);
check('после загрузки каталога: корень мастера видим (не скрыт)',
  !!getEl('book-wizard-root') && !getEl('book-wizard-root').classes.has('hidden'));

// ФАЗА 3: неизвестный слаг при ЗАГРУЖЕННОМ каталоге — честное «не найден», обратимо
window.navigate('booking', { slug: 'no-such-specialist' });
await tick(20);
const ph3 = getEl('book-placeholder');
check('неизвестный слаг (каталог загружен): показано «Специалист не найден»',
  !!ph3 && !ph3.classes.has('hidden') && ph3._html.includes('Специалист не найден'),
  `placeholder=${JSON.stringify(ph3?._html?.slice(0, 80))}`);
check('неизвестный слаг: noindex применён только по факту загруженного каталога',
  String(document.title).includes('не найдена'),
  `title=${document.title}`);
check('неизвестный слаг: разметка мастера переживает состояние «не найден»',
  getEl('book-services') !== null);
window.navigate('booking', { slug: SLUG });
await tick(20);
check('возврат на валидный слаг: мастер снова отрисован (состояние обратимо)',
  !!getEl('book-services') && getEl('book-services')._html.includes('Консультация 60 мин'));

// ФАЗА 4: тот же сценарий для /psy/{slug} (DoD issue #74)
window.navigate('profile', { slug: SLUG });
await tick(20);
const profBody = getEl('prof-body');
const profName = getEl('prof-header-name');
check('первый визит /psy/{slug}: после загрузки каталога карточка специалиста отрисована',
  !!profBody && profBody._html.length > 0 && !profBody._html.includes('Страница не найдена')
    && !!profName && profName._text === 'Наталия Михайловская',
  `имя=${JSON.stringify(profName?._text)} prof-body=${JSON.stringify(profBody?._html?.slice(0, 60))}`);
window.navigate('profile', { slug: 'no-such-specialist' });
await tick(20);
check('неизвестный слаг /psy/{slug}: честное «Страница не найдена»',
  !!profBody && profBody._html.includes('Страница не найдена'));

// ——— итог ———
const failed = results.filter(([, ok]) => !ok);
console.log(`\nИТОГО: ${results.length - failed.length}/${results.length} проверок пройдено`);
if (failed.length) {
  console.log('Проваленные проверки:');
  failed.forEach(([name]) => console.log(`  FAIL ${name}`));
  process.exit(1);
}
process.exit(0);
