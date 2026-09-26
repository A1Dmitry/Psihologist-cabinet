#!/usr/bin/env node
/**
 * Смоук карточки специалиста /psy/{slug}: вся информационная модель сайта
 * (профиль/направления/образование/опыт/услуги/оплата/реквизиты/контакты/
 * мессенджеры/адрес+карта) отрисована из данных, полученных как из БД (mapPsy).
 *   node verify_profile.mjs
 */
function fakeEl() {
  const t = function(){};
  return new Proxy(t, { get(_, p) {
    if (p === 'classList') return { add(){},remove(){},toggle(){},contains(){return false;} };
    if (p === 'style' || p === 'dataset') return {};
    if (['value','src','href','id','className'].includes(p)) return '';
    if (p === 'querySelectorAll') return () => [];
    if (p === 'querySelector') return () => fakeEl();
    if (['addEventListener','removeEventListener','appendChild','setAttribute','scrollIntoView','remove'].includes(p)) return () => {};
    if (p === 'getAttribute') return () => null;
    if (p === 'closest') return () => null;
    if (p === Symbol.toPrimitive) return () => '';
    return fakeEl();
  }, set(){return true;}, apply(){return fakeEl();} });
}
const listeners = {};
let profHtml = '';
const profBody = {
  set innerHTML(v) { profHtml = String(v); },
  get innerHTML() { return profHtml; },
  classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }
};
globalThis.document = { title:'', head:fakeEl(), body:fakeEl(), documentElement:fakeEl(), hidden:false,
  querySelector: sel => (sel === '#prof-body' ? profBody : fakeEl()),
  querySelectorAll:()=>[],
  getElementById: id => (id === 'prof-body' ? profBody : fakeEl()),
  createElement:()=>fakeEl(),
  addEventListener:(n,f)=>{(listeners[n] ||= []).push(f);}, removeEventListener:()=>{} };
const lsMap = new Map();
globalThis.localStorage = { get:k=>lsMap.get(k)??null, set:(k,v)=>lsMap.set(k,String(v)), remove:k=>lsMap.delete(k), clear:()=>lsMap.clear() };
const loc = { pathname:'/', search:'', hash:'#/psy/наталия-михайловская-19', origin:'http://x' }; // Hash History
globalThis.window = new Proxy({ localStorage: globalThis.localStorage, addEventListener:(n,f)=>{(listeners['w:'+n] ||= []).push(f);}, scrollTo:()=>{}, location: loc },
  { get(t,p){ return p in t ? t[p] : fakeEl(); }, set(){return true;} });
globalThis.location = loc; globalThis.history = { pushState(){}, replaceState(){} };
Object.defineProperty(globalThis,'navigator',{value:{userAgent:'t',clipboard:{writeText:async()=>{}}}});
globalThis.confirm=()=>true; globalThis.alert=()=>{}; globalThis.prompt=()=>'x';
globalThis.FileReader = class {};

// —— мок Supabase: строки таблиц (snake_case), как их отдаёт REST после seed.sql ——
const PSY_ROW = {
  id: 'psy_catalog_19', email: 'catalog+natalia@example.invalid', full_name: 'Наталия Михайловская',
  phone: '+375 (29) 780-45-45', specialization: 'Гештальт-терапевт, кризисный и семейный психолог',
  city: 'Гродно',
  about: 'Работа с отношениями, кризисами, тревогой. Использует гештальт-подход.',
  website: 'https://nataliamikhailouskaya.by/', source_url: 'https://nataliamikhailouskaya.by/',
  address: 'г. Гродно, ул. Свердлова, 16',
  experience: '10 лет в областном клиническом центре и 10 лет частной практики',
  slug: 'наталия-михайловская-19', profession: 'psychologist',
  greeting: 'Добро пожаловать. Меня зовут Наталия Михайловская.',
  approach: 'В своей работе я использую методы и концепции из различных направлений психотерапии.',
  photo_url: 'https://optim.tildacdn.biz/tild3136-3339-4362-b337-613561643332/-/format/webp/IMG_6796.JPG.webp',
  public_email: 'mikhailouskayanataliya@gmail.com',
  directions: [{ title: 'Взаимоотношения', details: 'созависимые, кризисы' }, { title: 'Страхи, повышенная тревожность', details: '' }],
  education: { basic: [{ title: 'ГрГУ им. Янки Купалы', institution: '', details: 'психолог' }], additional: [{ title: 'МАК', institution: '', details: '' }] },
  experience_items: [{ organisation: 'Областной клинический центр', details: 'психолог', years: 10, isCurrent: false }],
  socials: [{ kind: 'telegram', url: 'https://t.me/natalia_psy', title: 'telegram' }, { kind: 'instagram', url: 'https://www.instagram.com/natalia_psy/', title: 'instagram' }],
  payment_links: [{ label: 'Оплата консультации', url: 'https://api.bepaid.by/products/prd_x/pay', kind: 'service' }],
  payment_requisites: { recipient: 'Михайловская Н.Н.', legalAddress: 'г. Гродно', unp: '591945736', account: 'BY67ALFA30132A03540010270000', bankName: 'Альфа-Банк', bik: 'ALFABY2X', purpose: 'Оплата психологических услуг', donationUrl: '' },
  is_active: true, created_at: '2026-01-01T00:00:00Z'
};
const SVC_ROWS = [
  { id: 'svc1', psychologist_id: PSY_ROW.id, title: 'Очная консультация', description: 'в г. Гродно (Беларусь)', duration_min: 60, price: 80, currency: 'BYN', format: 'offline', platforms: [], pay_url: 'https://api.bepaid.by/products/prd_x/pay', sort_order: 1 },
  { id: 'svc2', psychologist_id: PSY_ROW.id, title: 'Онлайн-консультация', description: 'в Skype, WhatsApp, Viber, Telegram, Zoom', duration_min: 60, price: 3000, currency: 'RUB', format: 'online', platforms: ['skype', 'whatsapp', 'viber', 'telegram', 'zoom'], pay_url: '', sort_order: 2 }
];
const SETTINGS_ROW = { psychologist_id: PSY_ROW.id, work_hours: 'Пн–Пт 10:00–19:00', timezone: 'Europe/Minsk', slot_start: '10:00', slot_end: '19:00', slot_step_min: 60 };
const RESP = (json, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(json), json: async () => json });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('public_profiles') || u.includes('psychologists?select=')) return RESP([PSY_ROW]);
  if (u.includes('/rest/v1/services')) return RESP(SVC_ROWS);
  if (u.includes('public_settings') || u.includes('session_settings')) return RESP([SETTINGS_ROW]);
  if (u.includes('schedule_blocks')) return RESP([]);
  return RESP([]);
};

await import(new URL('./js/app.js', 'file://' + process.cwd() + '/').href);
await new Promise(r => setTimeout(r, 60)); // дождаться асинхронной загрузки каталога с «сервера»
// Hash History: маршрут уже в location.hash; renderProfile подтягивает данные
// после загрузки каталога (loadServerCatalog → render()). Событие — для контроля.
for (const fn of listeners['w:hashchange'] || []) fn();

// текстовые вхождения в отрисованную карточку
const contains = [];
const must = [
  ['фото с первоисточника (tildacdn)', 'tildacdn'],
  ['приветствие', 'Добро пожаловать'],
  ['подход', 'В своей работе я использую'],
  ['о себе', 'гештальт-подход'],
  ['направления', 'Взаимоотношения'],
  ['услуга 1 + цена', 'Очная консультация'],
  ['услуга 2', 'Онлайн-консультация'],
  ['онлайн-услуга: каналы', 'Skype, WhatsApp, Viber, Telegram, Zoom'],
  ['образование', 'Образование'],
  ['опыт', 'Опыт'],
  ['кнопки оплаты (label)', 'Оплата консультации'],
  ['кнопки оплаты (bepaid url)', 'bepaid.by'],
  ['реквизиты: УНП', '591945736'],
  ['реквизиты: р/с', 'BY67ALFA30132A03540010270000'],
  ['реквизиты: назначение', 'Назначение платежа'],
  ['адрес практики', 'ул. Свердлова, 16'],
  ['карта: адрес в data-map-query', 'data-map-query="г. Гродно, ул. Свердлова, 16"'],
  ['карта: заглушка data-map-box', 'data-map-box'],
  ['карта: Яндекс по умолчанию (кнопка)', 'data-map-load="yandex"'],
  ['карта: Google — альтернатива (кнопка)', 'data-map-load="google"'],
  ['карта: кнопка «Показать карту»', 'Показать карту'],
  ['маршрут Google', 'google.com/maps/dir'],
  ['маршрут Яндекс', 'yandex.ru/maps'],
  ['телефон tel:', 'tel:+375297804545'],
  ['WhatsApp', 'wa.me/375297804545'],
  ['Viber', 'viber://chat?number=%2B375297804545'],
  ['Telegram из соцсетей', 't.me'],
  ['Instagram из соцсетей', 'instagram'],
  ['email', 'mikhailouskayanataliya@gmail.com'],
  ['иконки мессенджеров SVG', 'fill-current shrink-0'],
  ['кнопка записи', 'Записаться на консультацию'],
  ['источник профиля', 'nataliamikhailouskaya.by'],
  ['SEO-ссылка на запись', '/book/']
];
for (const [name, needle] of must) contains.push([name, profHtml.includes(needle)]);

// —— MX-07 (#66): карта НЕ грузится автоматически — только по тапу ——
contains.push(['карта: авто-iframe НЕ рендерится (MX-07)', !profHtml.includes('<iframe')]);
contains.push(['карта: embed-ссылка НЕ в исходном HTML', !profHtml.includes('output=embed')]);

// поведение: тап по кнопке подгружает iframe (Яндекс по умолчанию, Google — фолбэк)
let mapBoxHtml = '';
let mapFrameHtml = '';
const mapFrameStub = {
  classList: { remove: () => {} },
  set innerHTML(v) { mapFrameHtml = String(v); }
};
const mapBtnObjects = {
  yandex: { dataset: { mapLoad: 'yandex' }, className: '' },
  google: { dataset: { mapLoad: 'google' }, className: '' }
};
const richMapBoxStub = {
  dataset: { mapQuery: 'Гродно, г. Гродно, ул. Свердлова, 16' },
  querySelector: sel => (sel === '[data-map-frame]' ? mapFrameStub : null),
  querySelectorAll: sel => (sel === 'button[data-map-load]' ? [mapBtnObjects.yandex, mapBtnObjects.google] : [])
};
const mapBtnStub = provider => {
  const btn = mapBtnObjects[provider];
  btn.closest = sel => (sel === 'button[data-map-load]' ? btn : sel === '[data-map-box]' ? richMapBoxStub : null);
  return btn;
};
const mapEv = provider => ({ target: { closest: sel => sel === 'button[data-map-load]' ? mapBtnStub(provider) : null } });

for (const fn of listeners['click'] || []) fn(mapEv('yandex'));
contains.push(['карта: тап → iframe подгружен в frame', mapFrameHtml.includes('<iframe')]);
contains.push(['карта: тап → Яндекс-embed по умолчанию', mapFrameHtml.includes('https://yandex.ru/map-widget/v1/')]);
contains.push(['карта: адрес в запросе embed', mapFrameHtml.includes(encodeURIComponent('Гродно'))]);
contains.push(['карта: кнопка Яндекс стала активной', mapBtnObjects.yandex.className.includes('bg-slate-900')]);

mapFrameHtml = '';
for (const fn of listeners['click'] || []) fn(mapEv('google'));
contains.push(['карта: Google-фолбэк по явной кнопке', mapFrameHtml.includes('maps.google.com') && mapFrameHtml.includes('output=embed')]);
contains.push(['карта: переключение → кнопка Google стала активной', mapBtnObjects.google.className.includes('bg-slate-900')]);
contains.push(['карта: переключение → кнопка Яндекс стала неактивной', mapBtnObjects.yandex.className.includes('border-slate-300')]);

let failed = 0;
for (const [n, okk] of contains) { console.log((okk ? 'PASS' : 'FAIL') + '  ' + n); if (!okk) failed++; }
if (!profHtml) { console.log('FAIL  карточка пуста'); failed = 1; }
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
