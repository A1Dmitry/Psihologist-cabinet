#!/usr/bin/env node
/**
 * Мобильный кабинет 1.0 (issue #63: MX-01, MX-02, MX-04, F1).
 *
 *   node tests/mobile-cabinet.mjs
 *
 * Что проверяется:
 *   A. MX-01/MX-02 — bottom tab bar (4 раздела + «Ещё»), sheet «Ещё» с
 *      остальными 11 разделами; все 15 разделов достижимы со смартфона;
 *      чипов-ленты нет; сайдбар и его тексты не тронуты; бейдж «Ожидание»
 *      живёт и в таб-баре; safe-area и CSS таб-бара в сборке.
 *   B. MX-04 — строки главной/расписания/журнала: primary-действие + меню «…»;
 *      все прежние data-действия на месте; деструктивные (Удалить/Неявка)
 *      визуально отделены; десктопный порядок и тексты сохранены
 *      (обёртки — display:contents на десктопе); цели тапа ≥44px.
 *   C. Проводка в js/app.js: импорт и bind контроллера, ветка таб-бара
 *      в renderCabinet, активность «Ещё» из DOM, бейджи, закрытие sheet.
 *   D. Поведение настоящего js/views/cabinetMobile.js на DOM-стабе:
 *      тогглы, закрытие по тапу вне/Escape, sheet, bind-once, no-DOM safety.
 *
 * Это регресс-набор #63 в общем гейте (`npm run verify`), не замена
 * verify_pages.py (смоук против живого devserver) и не браузерный E2E:
 * мобильный рендер на устройстве подтверждает владелец (граница #63).
 * Урок RRSI-реестра (#74) учтён: стаб не моделирует разрушение узлов при
 * перезаписи innerHTML — тесты поведения опираются только на переключение
 * классов стабильных узлов, перерендер списков не симулируется.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'css/tailwind.css'), 'utf8');
const srcCss = readFileSync(join(ROOT, 'css/tailwind.src.css'), 'utf8');
const appSrc = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
const mobileSrc = readFileSync(join(ROOT, 'js/views/cabinetMobile.js'), 'utf8');

// ============================================================
// A. Tab bar + sheet «Ещё» (MX-01/MX-02)
// ============================================================
const asideStart = html.indexOf('<aside class="w-56');
const asideEnd = html.indexOf('</aside>', asideStart);
const aside = html.slice(asideStart, asideEnd);
const barStart = html.indexOf('<nav id="cab-tabbar"');
const barEnd = html.indexOf('</nav>', barStart);
const tabbar = html.slice(barStart, barEnd);
const sheetStart = html.indexOf('<div id="modal-more"');
const sheetEnd = html.indexOf('UI-ДИАЛОГИ', sheetStart);
const sheet = html.slice(sheetStart, sheetEnd);

const tabsIn = region => [...region.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
const barTabs = tabsIn(tabbar);
const sheetTabs = tabsIn(sheet);
const asideTabs = tabsIn(aside);

check('MX-02: таб-бар #cab-tabbar существует и скрыт на десктопе (md:hidden)',
  barStart > 0 && /<nav id="cab-tabbar"[^>]*md:hidden/.test(html));
check('MX-02: таб-бар — nav- landmark с подписью', /<nav id="cab-tabbar"[^>]*aria-label="Навигация кабинета"/.test(html));
check('MX-02: в таб-баре ровно 4 раздела: Главная/Журнал/Расписание/Клиенты',
  barTabs.length === 4
  && barTabs[0] === 'home' && barTabs[1] === 'journal' && barTabs[2] === 'schedule' && barTabs[3] === 'clients',
  barTabs.join(','));
check('MX-02: 5-я кнопка — «Ещё» без data-tab (открывает sheet, а не вкладку)',
  /<button id="cab-more-btn"[^>]*>/.test(tabbar) && !/<button id="cab-more-btn"[^>]*data-tab=/.test(tabbar)
  && /aria-haspopup="dialog"/.test(tabbar));
check('MX-02: короткий ярлык «Журнал» с полным aria-label «Книга записей»',
  /data-tab="journal"[^>]*aria-label="Книга записей"[^>]*>[\s\S]*?Журнал</.test(tabbar));
check('MX-01: в sheet «Ещё» ровно 11 недостающих разделов',
  sheetTabs.length === 11
  && ['blocks', 'tasks', 'notepad', 'telegram', 'services', 'waiting', 'stats', 'reminders', 'payments', 'link', 'profile']
    .every(t => sheetTabs.includes(t)),
  sheetTabs.join(','));
check('MX-01: таб-бар ∪ sheet = все 15 разделов сайдбара (ничего не потеряно)',
  asideTabs.length === 15 && [...barTabs, ...sheetTabs].length === 15
  && asideTabs.every(t => barTabs.includes(t) || sheetTabs.includes(t)),
  `aside=${asideTabs.length} bar+sheet=${barTabs.length}+${sheetTabs.length}`);
check('MX-01: порядок и названия в sheet — как в сайдбаре',
  sheetTabs.join(',') === asideTabs.filter(t => !barTabs.includes(t)).join(','),
  sheetTabs.join(','));
check('MX-02: чипов-ленты больше нет (все .cab-nav-btn — в aside/таб-баре/sheet)',
  (html.match(/class="cab-nav-btn/g) || []).length === 30
  && !/overflow-x-auto gap-1 px-3 py-2 bg-white border-b/.test(html),
  `${(html.match(/class="cab-nav-btn/g) || []).length} кнопок`);
check('MX-02: sheet «Ещё» — канонный .modal-sheet/.modal-panel с закрытием',
  /<div id="modal-more"[^>]*modal-sheet[^>]*role="dialog"/.test(html)
  && /<div id="modal-more"[\s\S]{0,600}class="modal-panel /.test(sheet)
  && /<button id="cab-more-close"[^>]*class="[^"]*w-11 h-11[^"]*"[^>]*aria-label="Закрыть"/.test(sheet));
check('MX-02: бейдж «Ожидание» сохранён: сайдбар + таб-бар (.wait-badge ×2)',
  (html.match(/wait-badge/g) || []).length >= 2
  && /<span id="wait-badge" class="wait-badge /.test(html)
  && /<button id="cab-more-btn"[\s\S]{0,400}class="wait-badge /.test(tabbar));
check('MX-02: десктопный сайдбар не тронут (15 кнопок, те же названия)',
  asideTabs.length === 15 && /hidden md:flex flex-col/.test(aside)
  && ['Главная', 'Книга записей', 'Расписание', 'Занятость', 'Клиенты', 'Задачи', 'Блокнот',
    'Уведомления', 'Услуги', 'Ожидание', 'Статистика', 'Напоминания',
    'Оплата и защита', 'Ссылка записи', 'Профиль'].every(label => aside.includes(`>${label}`)));

/** Индекс ближайшего @media выше позиции: для проверки mobile/desktop скоупа. */
function mediaAbove(pos) {
  const maxI = srcCss.lastIndexOf('@media', pos);
  return maxI < 0 ? '' : srcCss.slice(maxI, srcCss.indexOf('{', maxI));
}
const inMaxMedia = rule => {
  const i = srcCss.indexOf(rule);
  return i > 0 && mediaAbove(i).includes('max-width: 767px');
};
const inMinMedia = rule => {
  const i = srcCss.indexOf(rule);
  return i > 0 && mediaAbove(i).includes('min-width: 768px');
};

/** z-index правила: работает и для исходника, и для минифицированной сборки.
 *  `\.cab-menu\s*\{` не матчит `.cab-menu-wrap{`/`.cab-menu-toggle{` — только само правило. */
function zIndexOf(text, selector) {
  const m = text.match(new RegExp(selector.replace(/\./g, '\\.') + '\\s*\\{[^}]*z-index:\\s*(\\d+)'));
  return m ? Number(m[1]) : NaN;
}

check('MX-02: .cab-tabbar прижат к низу + safe-area снизу',
  /\.cab-tabbar\s*\{[^}]*position:\s*fixed[^}]*bottom:\s*0[^}]*env\(safe-area-inset-bottom/.test(srcCss)
  && css.includes('.cab-tabbar{'));
check('MX-02: кнопки таб-бара ≥44px, иконки и бейдж описаны в CSS',
  /\.cab-tabbar-btn\s*\{[^}]*min-height:\s*56px[^}]*min-width:\s*44px/.test(srcCss)
  && /\.cab-tabbar-btn \.wait-badge\s*\{[^}]*position:\s*absolute/.test(srcCss)
  && css.includes('.cab-tabbar-btn{'));
check('MX-02: контент не уходит под таб-бар (.cab-content, только мобильный)',
  html.includes('class="cab-content p-4')
  && /\.cab-content\s*\{[^}]*padding-bottom:\s*5\.5rem/.test(srcCss) && inMaxMedia('.cab-content'));
check('MX-02: тосты подняты над нижними панелями (только мобильный)',
  /#toast\s*\{[^}]*bottom:\s*5rem/.test(srcCss) && inMaxMedia('#toast'));

// ============================================================
// B. Карточные строки: primary + «…» (MX-04)
// ============================================================
function fnSlice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  return a < 0 || b < 0 ? '' : src.slice(a, b);
}
const homeFn = fnSlice(appSrc, 'function renderCabHome()', 'function renderCabSchedule()');
const schFn = fnSlice(appSrc, 'function renderCabSchedule()', 'Книга записей');
const jFn = fnSlice(appSrc, 'function renderCabJournal()', '— Задачи —');
check('MX-04: срезы render-функций найдены', !!homeFn && !!schFn && !!jFn);

for (const [name, fn] of [['home', homeFn], ['schedule', schFn], ['journal', jFn]]) {
  const wrapCls = name === 'journal' ? 'cab-actions ' : 'cab-actions-inline';
  check(`MX-04: строка ${name}: обёртка + тоггл «…» + панель меню`,
    fn.includes(wrapCls) && fn.includes('data-cab-menu="cab-menu-') && fn.includes('class="cab-menu"')
    && fn.includes('cab-menu-toggle') && fn.includes('aria-expanded="false"'),
    `${name}: нет trio`);
  check(`MX-04: строка ${name}: primary-действие помечено .cab-primary`,
    fn.includes('cab-primary'));
}
check('MX-04: главная: прежние действия на месте (Чек/оплата, Изменить, Неявка)',
  /data-mark-paid/.test(homeFn) && /data-edit-session/.test(homeFn) && /data-no-show/.test(homeFn)
  && homeFn.includes('Чек/оплата') && homeFn.includes('>Изменить<') && homeFn.includes('>Неявка<'));
check('MX-04: расписание: прежние действия на месте (В календарь, Изменить, Удалить)',
  /В календарь/.test(schFn) && /data-edit-session/.test(schFn) && /data-del-session/.test(schFn));
check('MX-04: журнал: прежние действия на месте (5 штук)',
  /data-j-confirm/.test(jFn) && /data-edit-session/.test(jFn) && /data-j-note/.test(jFn)
  && /data-j-noshow/.test(jFn) && /В календарь/.test(jFn)
  && jFn.includes('>Подтвердить<') && jFn.includes('>Перенести/изменить<')
  && jFn.includes('>+ запись о сессии<') && jFn.includes('>Неявка<'));
check('MX-04: деструктивные действия — в меню и визуально отделены (.cab-menu-danger)',
  /data-del-session="\$\{s\.id\}" class="cab-menu-danger /.test(schFn)
  && /data-no-show="\$\{s\.id\}" class="cab-menu-danger /.test(homeFn)
  && /data-j-noshow="\$\{s\.id\}" class="cab-menu-danger /.test(jFn)
  && /\.cab-menu > \.cab-menu-danger\s*\{[^}]*border-top/.test(srcCss));
check('MX-04: главная: десктопный порядок Чек/оплата → Изменить → Неявка сохранён',
  homeFn.indexOf('Чек/оплата') < homeFn.indexOf('>Изменить<')
  && homeFn.indexOf('>Изменить<') < homeFn.indexOf('>Неявка<'));
check('MX-04: журнал: десктопный порядок 5 действий сохранён',
  jFn.indexOf('data-j-confirm') < jFn.indexOf('data-edit-session')
  && jFn.indexOf('data-edit-session') < jFn.indexOf('data-j-note')
  && jFn.indexOf('data-j-note') < jFn.indexOf('data-j-noshow')
  && jFn.indexOf('data-j-noshow') < jFn.indexOf('В календарь'));
check('MX-04: расписание: десктопный визуальный порядок — cab-ord-1/2/3',
  /class="cab-ord-1 text-sm text-emerald-600">В календарь/.test(schFn)
  && /class="cab-primary cab-ord-2 text-sm text-indigo-600">Изменить/.test(schFn)
  && /class="cab-menu-danger cab-ord-3 text-sm text-rose-500">Удалить/.test(schFn)
  && /\.cab-ord-1\s*\{\s*order:\s*1/.test(srcCss) && /\.cab-ord-2\s*\{\s*order:\s*2/.test(srcCss)
  && /\.cab-ord-3\s*\{\s*order:\s*3/.test(srcCss)
  && inMinMedia('.cab-ord-1'));
check('MX-04: десктоп: обёртки прозрачны (display:contents), тоггл скрыт',
  inMinMedia('.cab-actions-inline') && inMinMedia('.cab-menu-wrap') && inMinMedia('.cab-menu')
  && /\.cab-menu-toggle\s*\{\s*display:\s*none/.test(srcCss) && inMinMedia('.cab-menu-toggle'));
check('MX-04: мобильный: панель «…» скрыта, открывается классом .cab-menu-open',
  inMaxMedia('.cab-menu {\n    display: none;') && /\.cab-menu\.cab-menu-open\s*\{\s*display:\s*block/.test(srcCss)
  && css.includes('.cab-menu.cab-menu-open'));
// Панель «…» открывается ВНИЗ от строки (top: calc(100% + 4px)), поэтому у строк
// в нижней части экрана она попадает в полосу фиксированного таб-бара
// (.cab-tabbar: position fixed, z-index 40). Если z-index панели ниже — последние
// пункты меню (а это деструктивные «Удалить»/«Неявка») накрыты таб-баром и тап
// уходит в таб-бар: действие недоступно (MX-04). Выше модалок (z-50 в разметке)
// панель поднимать нельзя: uiConfirm/sheet обязаны перекрывать меню.
check('MX-04: панель «…» выше фиксированного таб-бара и sticky-CTA (z-index, исходник)',
  zIndexOf(srcCss, '.cab-menu') > zIndexOf(srcCss, '.cab-tabbar')
  && zIndexOf(srcCss, '.cab-menu') > zIndexOf(srcCss, '.book-cta'),
  `src: .cab-menu=${zIndexOf(srcCss, '.cab-menu')}, .cab-tabbar=${zIndexOf(srcCss, '.cab-tabbar')}, .book-cta=${zIndexOf(srcCss, '.book-cta')}`);
check('MX-04: панель «…» выше таб-бара и в СОБРАННОМ css/tailwind.css (его отдаёт сайт/превью)',
  zIndexOf(css, '.cab-menu') > zIndexOf(css, '.cab-tabbar'),
  `css: .cab-menu=${zIndexOf(css, '.cab-menu')}, .cab-tabbar=${zIndexOf(css, '.cab-tabbar')} — сборка не обновлена из css/tailwind.src.css`);
check('MX-04: панель «…» ниже модалок (z-50) — uiConfirm и sheet перекрывают меню',
  zIndexOf(srcCss, '.cab-menu') < 50 && zIndexOf(css, '.cab-menu') < 50,
  `src=${zIndexOf(srcCss, '.cab-menu')}, css=${zIndexOf(css, '.cab-menu')}`);
check('MX-04: мобильный: primary и пункты меню ≥44px',
  /\.cab-primary\s*\{[^}]*min-height:\s*44px/.test(srcCss) && inMaxMedia('.cab-primary')
  && /\.cab-menu > button\s*\{[^}]*min-height:\s*44px/.test(srcCss)
  && /\.cab-menu-toggle\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/.test(srcCss));
check('MX-04: «Снять» в расписании — цель 44px без смены десктопного вида',
  /data-del-block="\$\{esc\(b\.id\)\}" class="[^"]*min-h-\[44px\]/.test(schFn));

/** Комментарии — не вызовы (тот же приём, что в tests/mobile-ux.mjs). */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const mobileCode = stripComments(mobileSrc);
check('MX-04: cabinetMobile.js без нативных confirm()/prompt()',
  !/(^|[^\w$.])confirm\s*\(/.test(mobileCode) && !/(^|[^\w$.])prompt\s*\(/.test(mobileCode));
check('MX-04: контроллер не пишет в БД и не знает бизнес-правил (только классы)',
  !/cabinetApi|dbContext|supabase|fetch\(|localStorage/.test(mobileCode));

// ============================================================
// C. Проводка в js/app.js
// ============================================================
check('Проводка: импорт контроллера из views/cabinetMobile.js',
  appSrc.includes("import { bindCabinetMobile, closeMoreSheet, closeAllCabMenus } from './views/cabinetMobile.js'"));
check('Проводка: render() закрывает sheet «Ещё» и меню «…» при навигации',
  /function render\(\) \{[\s\S]{0,400}closeMoreSheet\(\);[\s\S]{0,80}closeAllCabMenus\(\);/.test(appSrc));
check('Проводка: bindCabinetMobile() вызывается в bindEvents()',
  /function bindEvents\(\) \{\s*\n\s*\/\/[^\n]*\n\s*bindCabinetMobile\(\);/.test(appSrc));
check('Проводка: renderCabinet подсвечивает таб-бар (ветка #cab-tabbar)',
  /btn\.closest\('#cab-tabbar'\)/.test(appSrc) && /aria-current/.test(appSrc));
check('Проводка: активность «Ещё» выводится из DOM (без дубля списка разделов)',
  /\$\('#cab-tabbar \[data-tab\]'\)\.some\(b => b\.dataset\.tab === cabinetVm\.tab\)/.test(appSrc)
  && /\$\('#cab-more-btn'\)/.test(appSrc));
check('Проводка: бейджи обновляются циклом по .wait-badge',
  appSrc.includes("$$('.wait-badge').forEach(badge => {"));
check('Проводка: выбор раздела в sheet закрывает sheet',
  /nav\.closest\('#modal-more'\)\) closeMoreSheet\(\);/.test(appSrc));

// ============================================================
// D. Поведение контроллера на DOM-стабе
// ============================================================
function makeEl(id = '') {
  const el = {
    id, parent: null, children: [],
    classes: new Set(), dataset: {}, attrs: {}, listeners: {},
    classList: null, // ниже
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k] ?? null; },
    addEventListener(n, f) { (el.listeners[n] ||= []).push(f); },
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    matches(sel) {
      sel = sel.trim();
      // '#modal-more .cab-nav-btn' — единственный составной селектор контроллера
      if (sel.includes(' ')) {
        const [anc, self] = sel.split(/\s+/);
        if (!el.matches(self)) return false;
        let p = el.parent;
        while (p) { if (p.matches(anc)) return true; p = p.parent; }
        return false;
      }
      if (sel.startsWith('#')) return el.id === sel.slice(1);
      if (sel.startsWith('.')) return el.classes.has(sel.slice(1));
      const m = sel.match(/^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/);
      if (m) {
        let key = m[1];
        if (key.startsWith('data-')) key = key.slice(5); // data-cab-menu <-> dataset.cabMenu
        key = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return m[2] === undefined ? (key in el.dataset) : el.dataset[key] === m[2];
      }
      return false;
    },
    closest(sel) {
      let p = el;
      while (p) { if (p.matches(sel)) return p; p = p.parent; }
      return null;
    }
  };
  el.classList = {
    add: (...c) => c.forEach(x => el.classes.add(x)),
    remove: (...c) => c.forEach(x => el.classes.delete(x)),
    toggle: (c, force) => {
      const on = force === undefined ? !el.classes.has(c) : !!force;
      on ? el.classes.add(c) : el.classes.delete(c);
      return on;
    },
    contains: c => el.classes.has(c)
  };
  return el;
}

const registry = new Map();
const reg = el => { if (el.id) registry.set(el.id, el); return el; };
const docListeners = {};
// Дерево: sheet(modal-more) > panel > navBtn(.cab-nav-btn); панели меню; тогглы; сирота.
const sheetEl = reg(makeEl('modal-more'));
sheetEl.classes.add('hidden');
const sheetPanel = makeEl('');
sheetEl.appendChild(sheetPanel);
const sheetNavBtn = makeEl('');
sheetNavBtn.classes.add('cab-nav-btn');
sheetPanel.appendChild(sheetNavBtn);
const moreBtn = reg(makeEl('cab-more-btn'));
const moreClose = reg(makeEl('cab-more-close'));
const panelA = reg(makeEl('cab-menu-j-s1'));
panelA.classes.add('cab-menu');
const panelB = reg(makeEl('cab-menu-j-s2'));
panelB.classes.add('cab-menu');
const toggleA = makeEl('');
toggleA.dataset.cabMenu = 'cab-menu-j-s1';
toggleA.setAttribute('aria-expanded', 'false');
const toggleB = makeEl('');
toggleB.dataset.cabMenu = 'cab-menu-j-s2';
toggleB.setAttribute('aria-expanded', 'false');
const orphan = makeEl(''); // тап «вне»: ни меню, ни sheet, ни тоггл

globalThis.document = {
  getElementById: id => registry.get(id) || null,
  querySelectorAll: sel => {
    const all = [...registry.values(), sheetPanel, sheetNavBtn, toggleA, toggleB, orphan];
    if (sel === '.cab-menu-open') return all.filter(e => e.classes.has('cab-menu-open'));
    if (sel === '[data-cab-menu]') return all.filter(e => 'cabMenu' in e.dataset);
    return [];
  },
  querySelector: sel => {
    const m = sel.match(/^\[data-cab-menu="([^"]+)"\]$/);
    if (!m) return null;
    return [toggleA, toggleB].find(t => t.dataset.cabMenu === m[1]) || null;
  },
  addEventListener: (n, f) => { (docListeners[n] ||= []).push(f); }
};

const fire = (name, target) => (docListeners[name] || []).forEach(f => f({ target, key: 'Escape' }));
const fireKey = key => (docListeners.keydown || []).forEach(f => f({ key, target: orphan }));

const cab = await import('../js/views/cabinetMobile.js');

check('Поведение: sheet изначально закрыт', cab.isMoreSheetOpen() === false);
check('Поведение: bind возвращает true и подписывается один раз',
  cab.bindCabinetMobile() === true
  && (docListeners.click || []).length === 1 && (docListeners.keydown || []).length === 1);
check('Поведение: повторный bind — no-op (false, слушатели не плодятся)',
  cab.bindCabinetMobile() === false && (docListeners.click || []).length === 1);

check('Поведение: openMoreSheet открывает, closeMoreSheet закрывает',
  cab.openMoreSheet() === true && cab.isMoreSheetOpen() === true
  && cab.closeMoreSheet() === true && cab.isMoreSheetOpen() === false
  && cab.closeMoreSheet() === false);
cab.openMoreSheet();
fire('click', sheetNavBtn); // выбор раздела в sheet
check('Поведение: выбор раздела в sheet закрывает sheet', cab.isMoreSheetOpen() === false);
cab.openMoreSheet();
check('Поведение: кнопка «Ещё» открывает sheet (подписка moreBtn)',
  (() => { cab.closeMoreSheet(); moreBtn.listeners.click.forEach(f => f({})); return cab.isMoreSheetOpen(); })());
moreClose.listeners.click.forEach(f => f({}));
check('Поведение: кнопка ✕ закрывает sheet', cab.isMoreSheetOpen() === false);
cab.openMoreSheet();
sheetEl.listeners.click.forEach(f => f({ target: sheetEl }));
check('Поведение: клик по подложке sheet закрывает его', cab.isMoreSheetOpen() === false);

check('Поведение: toggle открывает панель + aria-expanded=true',
  cab.toggleCabMenu('cab-menu-j-s1') === true
  && panelA.classList.contains('cab-menu-open')
  && toggleA.getAttribute('aria-expanded') === 'true');
check('Поведение: повторный toggle закрывает панель',
  cab.toggleCabMenu('cab-menu-j-s1') === false
  && !panelA.classList.contains('cab-menu-open')
  && toggleA.getAttribute('aria-expanded') === 'false');
cab.toggleCabMenu('cab-menu-j-s1');
check('Поведение: открытие второй панели закрывает первую',
  cab.toggleCabMenu('cab-menu-j-s2') === true
  && !panelA.classList.contains('cab-menu-open')
  && panelB.classList.contains('cab-menu-open'));
fire('click', toggleA); // делегированный клик по тогглу A
check('Поведение: делегированный клик по тогглу переключает панель',
  panelA.classList.contains('cab-menu-open') && !panelB.classList.contains('cab-menu-open'));
fire('click', orphan); // тап вне
check('Поведение: тап вне панели закрывает меню', !panelA.classList.contains('cab-menu-open'));

// MX-04 (ре-аудит #63, 2026-09-26): тап по ПУНКТУ меню обязан закрывать панель.
// Действие пункта может не вызывать перерендер (ссылка «В календарь» открывает
// новую вкладку) или закончиться отменой диалога (uiConfirm/uiPrompt —
// «Неявка»/«Удалить»/«+ запись о сессии»): в обоих случаях список не
// перерисовывается, и открытая панель остаётся поверх строки с доступным
// деструктивным пунктом. Прежняя ветка «тап вне панели» этот случай не ловила:
// target ВНУТРИ .cab-menu → закрытия не было.
const itemLink = makeEl('');      // «В календарь» (<a href target=_blank>) — перерендера нет
const itemDanger = makeEl('');    // «Неявка»/«Удалить» — подтверждение может быть отменено
itemDanger.classes.add('cab-menu-danger');
panelA.appendChild(itemLink);
panelA.appendChild(itemDanger);

// предусловие каждой проверки выставляется явно и проверяется: toggleCabMenu —
// переключатель, поэтому «просто вызвать» на уже открытой панели означало бы
// закрыть её и получить ложное зелёное без единого тапа (урок реестра RRSI:
// состояние фиксируется до действия, а не предполагается).
cab.closeAllCabMenus();
const openedLink = cab.toggleCabMenu('cab-menu-j-s1');
fire('click', itemLink);
check('Поведение: тап по пункту меню без перерендера («В календарь») закрывает панель',
  openedLink === true && !panelA.classList.contains('cab-menu-open')
  && toggleA.getAttribute('aria-expanded') === 'false',
  `предусловие open=${openedLink}; после тапа open=${panelA.classList.contains('cab-menu-open')}, aria-expanded=${toggleA.getAttribute('aria-expanded')}`);

cab.closeAllCabMenus();
const openedDanger = cab.toggleCabMenu('cab-menu-j-s1');
fire('click', itemDanger);
check('Поведение: тап по деструктивному пункту закрывает панель (отмена диалога не оставляет «Удалить» на виду)',
  openedDanger === true && !panelA.classList.contains('cab-menu-open'),
  `предусловие open=${openedDanger}; после тапа open=${panelA.classList.contains('cab-menu-open')}`);

cab.closeAllCabMenus();
fire('click', toggleA);
check('Поведение: тоггл «…» по-прежнему ОТКРЫВАЕТ панель (закрытие не перехватывает собственный тап)',
  panelA.classList.contains('cab-menu-open') && toggleA.getAttribute('aria-expanded') === 'true',
  `open=${panelA.classList.contains('cab-menu-open')}`);
fire('click', orphan); // вернуть состояние «всё закрыто» следующей проверке

cab.toggleCabMenu('cab-menu-j-s1');
cab.openMoreSheet();
fireKey('Escape');
check('Поведение: Escape закрывает меню и sheet',
  !panelA.classList.contains('cab-menu-open') && cab.isMoreSheetOpen() === false);
check('Поведение: toggle несуществующей панели — безопасный false',
  cab.toggleCabMenu('cab-menu-nope') === false && cab.toggleCabMenu('') === false);

// Безопасность без документа: все функции — no-op, исключений нет.
const savedDoc = globalThis.document;
delete globalThis.document;
let threw = null;
let vals = [];
try {
  vals = [
    cab.openMoreSheet(), cab.closeMoreSheet(), cab.isMoreSheetOpen(),
    cab.toggleCabMenu('x'), cab.closeAllCabMenus(), cab.bindCabinetMobile()
  ];
} catch (e) { threw = e; }
globalThis.document = savedDoc;
check('Поведение: без документа — no-op без исключений',
  threw === null && JSON.stringify(vals) === JSON.stringify([false, false, false, false, 0, false]),
  threw ? String(threw) : JSON.stringify(vals));

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);