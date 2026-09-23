#!/usr/bin/env node
/**
 * Проверка собранного css/tailwind.css против исходников (замена runtime CDN).
 *
 * Зачем: при CDN классы генерировались в браузере на лету — любой класс в коде
 * гарантированно получал стили. При сборке через CLI стили генерируются только
 * для классов, найденных сканером в контенте. Этот скрипт — внешний аудитор
 * того, что ни один используемый класс не потерялся при переходе на сборку.
 *
 * Что проверяется:
 *   1. Каждый токен из class="…" (index.html + js-шаблоны, включая литералы
 *      внутри ${условие ? 'a' : 'b'}) присутствует в собранном CSS.
 *   2. Каждый литерал из className = …, classList.add/remove/toggle(…),
 *      cls: '…' присутствует в собранном CSS.
 *   3. «Подозрительные полу-наборы»: любая строка в js, где часть токенов
 *      есть в CSS, а части нет (ловит карты классов вроде statusClass).
 *   4. index.html не ссылается на cdn.tailwindcss.com и подключает
 *      css/tailwind.css; файл сборки не пустой.
 *   5. Allowlist поведенческих классов (без стилей) не протух: каждый
 *      элемент всё ещё используется в исходниках.
 *
 * Запуск: node tools/verify_tailwind.mjs   (входит в npm run verify)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = join(ROOT, 'css/tailwind.css');

/** Классы-маркеры поведения (JS-селекторы) — стилей не имеют и не должны. */
const BEHAVIORAL_CLASSES = new Set(['page', 'cab-nav-btn', 'cab-tab', 'pe-row', 'pe-list', 'book-step', 'own-page-btn']);

/** Форма токена, который вообще может быть utility-классом Tailwind. */
const UTILITY_SHAPE = /^[a-z-][a-z0-9[\]/().:_-]*$/;

let failed = 0;
const fail = (msg) => { failed++; console.log('  ❌ ' + msg); };
const pass = (msg) => console.log('  ✅ ' + msg);

// ——— исходники ———
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (extname(e.name) === '.js') out.push(p);
  }
  return out;
}
const sources = [
  { name: 'index.html', text: readFileSync(join(ROOT, 'index.html'), 'utf8') },
  ...walk(join(ROOT, 'js')).map(p => ({ name: p.slice(ROOT.length + 1), text: readFileSync(p, 'utf8') }))
];

// ——— собранный CSS ———
let css = '';
try { css = readFileSync(CSS_PATH, 'utf8'); } catch { /* обработано ниже */ }

// ——— проверка присутствия селектора ———
const escapeSelector = (token) => token.replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function inCss(token) {
  if (BEHAVIORAL_CLASSES.has(token)) return true; // маркер без стилей — легально
  // > нужен для selectors вида .space-y-4>:not([hidden])~:not([hidden])
  return new RegExp(reEscape('.' + escapeSelector(token)) + '(?=[{,:>])').test(css);
}

// ——— сбор токенов классов ———
const where = new Map(); // token -> [файл:контекст]
function addToken(tok, src) {
  if (!tok || /\$\{/.test(tok)) return;
  if (!where.has(tok)) where.set(tok, []);
  where.get(tok).push(src);
}

for (const { name, text } of sources) {
  // 1) class="…" — атрибуты (в т.ч. внутри JS-шаблонов)
  for (const m of text.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    const attr = m[1];
    for (const tok of attr.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) addToken(tok, name + ' class=');
    // литералы веток тернарника внутри ${…} — тоже классы
    for (const im of attr.matchAll(/\$\{([^}]*)\}/g)) {
      for (const qm of im[1].matchAll(/(?:\?|:)\s*'([^']*)'/g)) {
        for (const tok of qm[1].split(/\s+/)) addToken(tok, name + ' class=${}');
      }
    }
  }
  // 2) className = <выражение до ;>
  for (const m of text.matchAll(/\.className\s*=\s*([^;]+);/g)) {
    for (const qm of m[1].matchAll(/'([^']*)'/g)) {
      for (const tok of qm[1].split(/\s+/)) addToken(tok, name + ' className=');
    }
  }
  // 3) classList.add/remove/toggle('класс', <условие>) — только ПЕРВЫЙ литерал
  //    (второй аргумент toggle — булево условие, его литералы — не классы)
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
    const first = m[1].match(/'([^']*)'/);
    if (first) {
      for (const tok of first[1].split(/\s+/)) addToken(tok, name + ' classList');
    }
  }
  // 4) карты вида { cls: '…' }
  for (const m of text.matchAll(/\bcls:\s*'([^']*)'/g)) {
    for (const tok of m[1].split(/\s+/)) addToken(tok, name + ' cls:');
  }
}

// 5) подозрительные полу-наборы в любых строках js (карты классов: statusClass и т.п.).
//    Строка допускается к проверке, только если ВСЕ её токены имеют форму
//    utility-класса (ASCII, без кириллицы и HTML-фрагментов) — иначе это
//    обычный текст, а не перечисление классов.
const suspicious = [];
for (const { name, text } of sources) {
  if (name === 'index.html') continue;
  for (const m of text.matchAll(/'([^'\n]*)'/g)) {
    const toks = m[1].trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2 || !toks.every(t => UTILITY_SHAPE.test(t))) continue;
    const present = toks.filter(inCss).length;
    if (present > 0 && present < toks.length) suspicious.push(`${name}: '${m[1]}'`);
  }
}

// ——— прогон ———
console.log('Проверка css/tailwind.css против исходников (index.html + js/)');

if (!css || css.length < 1000) {
  fail('css/tailwind.css отсутствует или подозрительно мал — соберите: npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i css/tailwind.src.css -o css/tailwind.css --minify');
} else {
  pass(`сборка на месте (${(css.length / 1024).toFixed(1)} КБ)`);
}

const html = sources[0].text;
if (/<script[^>]*src="[^"]*cdn\.tailwindcss\.com/.test(html)) fail('index.html всё ещё подключает cdn.tailwindcss.com');
else pass('runtime CDN не используется');
if (!/%BASE%css\/tailwind\.css/.test(html)) fail('index.html не подключает %BASE%css/tailwind.css');
else pass('index.html подключает собранный css/tailwind.css');

const missing = [...where.keys()].filter(t => !inCss(t));
if (missing.length) {
  for (const t of missing) fail(`класс «${t}» используется (${[...new Set(where.get(t))].join(', ')}), но отсутствует в css/tailwind.css`);
} else {
  pass(`все ${where.size} используемых классов найдены в сборке`);
}

if (suspicious.length) {
  for (const s of suspicious) fail(`подозрительная строка-полу-набор (часть классов есть в CSS, части нет): ${s}`);
} else {
  pass('полу-наборов нет (карты классов полны)');
}

// allowlist не протух
for (const b of BEHAVIORAL_CLASSES) {
  const used = sources.some(({ text }) => new RegExp(`['" ]${b}['" ]`).test(text));
  if (!used) fail(`BEHAVIORAL_CLASSES протух: «${b}» больше не используется в исходниках`);
}

console.log(failed ? `\n${failed} провал(ов)` : '\nALL PASS');
process.exit(failed ? 1 : 0);
