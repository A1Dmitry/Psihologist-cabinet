#!/usr/bin/env node
/**
 * Смоук Telegram-уведомлений: модель (поля), схема БД, админ-настройка
 * (вкладка «Уведомления»), переключатели событий, напоминания клиенту,
 * привязка чатов (/start), outbox новых записей с watermark, webhook-путь,
 * кнопка «Поделиться специалистом», Edge Function.
 *   node verify_telegram.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
const read = p => readFileSync(p, 'utf-8');
const SRC = { schema: read('supabase/schema.sql'), html: read('index.html'), app: read('js/app.js'),
  bvm: read('js/viewmodels/BookingViewModel.js'), cvm: read('js/viewmodels/CabinetViewModel.js'),
  cfg: read('js/services/supabaseConfig.js'), edge: existsSync('supabase/functions/telegram-notify/index.ts') ? read('supabase/functions/telegram-notify/index.ts') : '' };

// —— браузерный каркас (минимальный) ——
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
globalThis.document = { title:'Psy', head:fakeEl(), body:fakeEl(), documentElement:fakeEl(), hidden:false,
  querySelector: () => fakeEl(), querySelectorAll: () => [],
  getElementById: () => fakeEl(), createElement: () => fakeEl(),
  addEventListener:(n,f)=>{(listeners[n] ||= []).push(f);}, removeEventListener:()=>{} };
const lsMap = new Map();
globalThis.localStorage = {
  get:k=>lsMap.get(k)??null, set:(k,v)=>lsMap.set(k,String(v)), remove:k=>lsMap.delete(k), clear:()=>lsMap.clear(),
  getItem:k=>lsMap.get(k)??null, setItem:(k,v)=>lsMap.set(k,String(v)), removeItem:k=>lsMap.delete(k)
};
const loc = { pathname:'/', search:'', hash:'', origin:'http://x' };
const winTarget = { localStorage: globalThis.localStorage, addEventListener:(n,f)=>{(listeners['w:'+n] ||= []).push(f);}, scrollTo:()=>{}, location: loc };
globalThis.window = new Proxy(winTarget,
  { get(t,p){ return p in t ? t[p] : fakeEl(); }, set(t,p,v){ t[p] = v; return true; } });
globalThis.location = loc; globalThis.history = { pushState(){}, replaceState(){} };
const navProps = { userAgent:'verify', clipboard:{ writeText: async () => { navProps._clip = true; } } };
Object.defineProperty(globalThis,'navigator',{ value: navProps });
globalThis.confirm=()=>true; globalThis.alert=()=>{}; globalThis.prompt=()=>'x';
globalThis.FileReader = class {};

// —— мок fetch: Telegram API + Supabase REST ——
const tgCalls = [];      // {url, body}
const sbCalls = [];      // {url, method, body}
const RESP = (json, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(json), json: async () => json });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.telegram.org')) {
    tgCalls.push({ url: u, body: JSON.parse(opts.body || '{}') });
    if (u.endsWith('/getMe')) return RESP({ ok: true, result: { username: 'psy_test_bot' } });
    if (u.endsWith('/getUpdates')) return RESP({ ok: true, result: [
      { message: { chat: { id: 111 }, from: { first_name: 'Анна' }, text: '/start client-1', date: 200 } },
      { message: { chat: { id: 111 }, from: { first_name: 'Анна' }, text: 'привет', date: 210 } },
      { message: { chat: { id: 222 }, from: { first_name: 'Борис' }, text: 'просто вопрос', date: 220 } }
    ] });
    return RESP({ ok: true, result: true });
  }
  sbCalls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  return RESP([]);
};

const { db } = await import(new URL('./js/core/dbContext.js', 'file://' + process.cwd() + '/').href);
const { SessionSettings, Session, Client, SessionReminder, Service } = await import(new URL('./js/models/entities.js', 'file://' + process.cwd() + '/').href);
const { telegramService } = await import(new URL('./js/services/telegramService.js', 'file://' + process.cwd() + '/').href);
const { NOTIFY_WEBHOOK_URL } = await import(new URL('./js/services/supabaseConfig.js', 'file://' + process.cwd() + '/').href);

// —— чистые данные вместо seed ——
db.psychologists = []; db.sessions = []; db.clients = []; db.services = []; db.reminders = []; db.settings = [];
db.currentPsychologistId = 'psy1';
const PSY = 'psy1';
const settings = new SessionSettings({ psychologistId: PSY });
db.settings.push(settings);
const svc = new Service({ id: 'svc1', psychologistId: PSY, name: 'Консультация', durationMin: 60, price: 80, currency: 'BYN', isActive: true });
db.services.push(svc);
const clientA = new Client({ id: 'client-1', psychologistId: PSY, name: 'Анна', nickname: 'anna' });
const clientB = new Client({ id: 'client-2', psychologistId: PSY, name: 'Борис', nickname: 'boris', telegramChat: '222' });
db.clients.push(clientA, clientB);

const R = [];
const ok = (n, c) => R.push([n, !!c]);

// ============ A. Статика ============
ok('schema: telegram_bot_token', SRC.schema.includes('telegram_bot_token'));
ok('schema: telegram_chat_id', SRC.schema.includes('telegram_chat_id'));
ok('schema: telegram_bot_name', SRC.schema.includes('telegram_bot_name'));
ok('schema: 3 переключателя', ['telegram_notify_booking','telegram_notify_reminders','telegram_notify_payments'].every(x => SRC.schema.includes(x)));
ok('schema: last_notified_session_at', SRC.schema.includes('last_notified_session_at'));
ok('schema: clients.telegram_chat', /alter table clients[\s\S]*?telegram_chat/.test(SRC.schema));
ok('index: вкладка Уведомления (десктоп + чипы)', (SRC.html.match(/data-tab="telegram"/g) || []).length >= 2);
ok('index: секция tab-telegram', SRC.html.includes('id="tab-telegram"'));
ok('index: поле токена', SRC.html.includes('id="tg-token"'));
ok('index: «Найти чат»', SRC.html.includes('btn-tg-find-chat'));
ok('index: 3 переключателя в UI', ['tg-notify-booking','tg-notify-reminders','tg-notify-payments'].every(x => SRC.html.includes(`id="${x}"`)));
ok('index: «Проверить подключения»', SRC.html.includes('btn-tg-link-clients'));
ok('index: cache-bust поднят', SRC.html.includes('app.js?v=20260925-ics'));
ok('config: NOTIFY_WEBHOOK_URL экспорт', /export const NOTIFY_WEBHOOK_URL = ''/.test(SRC.cfg));
ok('app: outbox-цикл после входа', /startTelegramLoops\(/.test(SRC.app));
ok('app: рендер+биндинг вкладки', SRC.app.includes('renderCabTelegram') && SRC.app.includes('bindTelegramTab'));
ok('app: share-кнопка на карточке', SRC.app.includes('Поделиться специалистом') && SRC.app.includes('sharePsyLink'));
ok('app: telegram-блок в карточке клиента', SRC.app.includes('renderClientTelegramBlock'));
ok('app: приглашение t.me?start=', SRC.app.includes('?start='));
ok('BVM: уведомление о новой записи через webhook', SRC.bvm.includes("notifyViaWebhook(\n      this.psychologist.id, 'booking'"));
ok('BVM: демо-оплата НЕ шлёт webhook «оплата прошла» (#21 п.4)',
  !SRC.bvm.includes("notifyViaWebhook(this.psychologist.id, 'payment'")
  && SRC.bvm.includes('demoPayIsLocalOnly'));
ok('CVM: saveTelegramSettings', SRC.cvm.includes('saveTelegramSettings'));
ok('CVM: setClientTelegramChat', SRC.cvm.includes('setClientTelegramChat'));
ok('CVM: оплата → Telegram', SRC.cvm.includes("sendToPsychologist('payment'"));
ok('edge: функция существует', !!SRC.edge);
ok('edge: отправка и watermark', SRC.edge.includes('sendMessage') && SRC.edge.includes('last_notified_session_at') && SRC.edge.includes('SUPABASE_SERVICE_ROLE_KEY'));

// ============ B. Модель/сущности ============
ok('entities: настройки по умолчанию', settings.telegramBotToken === '' && settings.telegramNotifyBooking === true && settings.telegramNotifyReminders === true && settings.telegramNotifyPayments === true);
ok('entities: клиент без chat → пусто', clientA.telegramChat === '' && clientB.telegramChat === '222');

// ============ C. Поведение telegramService ============
// 1) не настроен → disabled
let r = await telegramService.sendToPsychologist('booking', 'x');
ok('send: без настроек — not-configured', r.ok === false && r.reason === 'not-configured');

// 2) настройка → enabled, отправка booking
settings.telegramBotToken = 'TOK123'; settings.telegramChatId = '999';
let cfg = telegramService.config();
ok('config: настроен', cfg.enabled === true && cfg.botName === '');
const before = tgCalls.length;
r = await telegramService.sendToPsychologist('booking', '<b>тест</b>');
ok('send: booking ушёл на chat_id психолога', r.ok === true && tgCalls.length === before + 1
  && tgCalls.at(-1).url.includes('botTOK123/sendMessage') && tgCalls.at(-1).body.chat_id === '999'
  && tgCalls.at(-1).body.parse_mode === 'HTML');

// 3) переключатель booking выключен → отказ без отправки
settings.telegramNotifyBooking = false;
r = await telegramService.sendToPsychologist('booking', 'x');
ok('send: booking выключен → disabled', r.ok === false && r.reason === 'disabled' && tgCalls.length === before + 1);
settings.telegramNotifyBooking = true;

// 4) payment при выключенном payments
settings.telegramNotifyPayments = false;
r = await telegramService.sendToPsychologist('payment', 'x');
ok('send: payments выключен → disabled', r.reason === 'disabled');
settings.telegramNotifyPayments = true;

// 5) клиенту: без chat — отказ, с chat — на его chat_id
r = await telegramService.sendToClient(clientA, 'x');
ok('sendToClient: без chat — not-configured', r.reason === 'not-configured');
r = await telegramService.sendToClient(clientB, 'напоминание');
ok('sendToClient: уходит на chat клиента', r.ok === true && tgCalls.at(-1).body.chat_id === '222');
settings.telegramNotifyReminders = false;
r = await telegramService.sendToClient(clientB, 'x');
ok('sendToClient: reminders выключен → disabled', r.reason === 'disabled');
settings.telegramNotifyReminders = true;

// 6) bookingText: данные + экранирование
const s1 = new Session({ id: 's1', psychologistId: PSY, clientId: 'client-1', serviceId: 'svc1', date: '2026-09-25', time: '10:00', status: 'planned', note: '', createdAt: new Date(Date.now() - 26 * 3600e3).toISOString() });
db.sessions.push(s1);
const txt = telegramService.bookingText(s1, { name: '<b>Анна</b>' }, svc);
ok('bookingText: имя/дата/время/услуга/цена', txt.includes('Анна') && txt.includes('2026-09-25') && txt.includes('10:00') && txt.includes('Консультация') && txt.includes('80'));
ok('bookingText: HTML экранирован', txt.includes('&lt;b&gt;Анна&lt;/b&gt;') && !txt.includes('<b>Анна</b>'));
s1.note = 'Результат самоопроса: raw_vector 0-1-1-0; clinical_summary sensitive';
const privateText = telegramService.bookingText(s1, { name: 'Анна' }, svc);
ok('bookingText: не отправляет комментарий/ответы опроса в Telegram',
  !privateText.includes('raw_vector') && !privateText.includes('clinical_summary') && !privateText.includes('sensitive')
    && privateText.includes('Дополнительная информация есть в кабинете.'));
s1.note = '';
const detachedNotice = telegramService.bookingText(s1, { name: 'Анна' }, svc, { hasAdditionalInfo: true });
ok('bookingText: безопасная отметка доступна и после очистки локального note',
  detachedNotice.includes('Дополнительная информация есть в кабинете.') && !detachedNotice.includes('raw_vector'));

// 7) outbox: новые записи после watermark
const nowIso = () => new Date().toISOString();
const old1 = new Session({ id: 'old1', psychologistId: PSY, clientId: 'client-2', serviceId: 'svc1', date: '2026-09-26', time: '11:00', status: 'planned', createdAt: new Date(Date.now() - 48 * 3600e3).toISOString() });
const new1 = new Session({ id: 'new1', psychologistId: PSY, clientId: 'client-1', serviceId: 'svc1', date: '2026-09-27', time: '12:00', status: 'planned', createdAt: new Date(Date.now() - 3600e3).toISOString() });
const new2 = new Session({ id: 'new2', psychologistId: PSY, clientId: 'client-2', serviceId: 'svc1', date: '2026-09-27', time: '15:00', status: 'planned', createdAt: new Date(Date.now() - 600e3).toISOString() });
db.sessions.push(old1, new1, new2);
settings.lastNotifiedSessionAt = new Date(Date.now() - 2 * 3600e3).toISOString();
const sbBefore = sbCalls.length;
r = await telegramService.notifyNewBookings(PSY);
ok('outbox: отправлены только новые (2)', r.sent === 2 && r.total === 2);
ok('outbox: watermark сдвинут', new Date(settings.lastNotifiedSessionAt).getTime() > Date.now() - 10e3);
ok('outbox: watermark сохранён (db.saveChanges)', JSON.stringify([...lsMap.values()].join('')).includes('lastNotifiedSessionAt'));
ok('outbox: pushSettings вызван (без сессии — очередь молчит)', sbCalls.length === sbBefore);
r = await telegramService.notifyNewBookings(PSY);
ok('outbox: повторно не дублирует', r.sent === 0);

// 8) outbox при выключенном booking
settings.telegramNotifyBooking = false;
r = await telegramService.notifyNewBookings(PSY);
ok('outbox: выключен → 0', r.sent === 0);
settings.telegramNotifyBooking = true;

// 9) напоминания: должное уходит, будущее ждёт, без chat — ждёт
db.reminders.push(
  new SessionReminder({ id: 'r1', psychologistId: PSY, sessionId: 's1', clientId: 'client-2', scheduledFor: new Date(Date.now() - 60e3).toISOString() }),
  new SessionReminder({ id: 'r2', psychologistId: PSY, sessionId: 's1', clientId: 'client-2', scheduledFor: new Date(Date.now() + 3600e3).toISOString() }),
  new SessionReminder({ id: 'r3', psychologistId: PSY, sessionId: 's1', clientId: 'client-1', scheduledFor: new Date(Date.now() - 60e3).toISOString() })
);
r = await telegramService.sendDueReminders(PSY);
const rem1 = db.reminders.find(x => x.id === 'r1'), rem2 = db.reminders.find(x => x.id === 'r2'), rem3 = db.reminders.find(x => x.id === 'r3');
ok('reminders: должное отправлено (1)', r.sent === 1 && rem1.status === 'sent' && rem1.channel === 'telegram' && !!rem1.sentAt);
ok('reminders: будущее — scheduled', rem2.status === 'scheduled');
ok('reminders: клиент без chat — scheduled', rem3.status === 'scheduled');

// 10) привязка /start
r = await telegramService.linkClientChats(PSY);
ok('link: /start client-1 привязан', r.linked >= 1 && clientA.telegramChat === '111');
const linkedBefore = clientA.telegramChat;
await telegramService.linkClientChats(PSY);
ok('link: повторно не перезаписывает', clientA.telegramChat === linkedBefore);
ok('link: чужой /start игнор', clientB.telegramChat === '222');

// 11) testToken / recentChats / webhook
ok('testToken: @username', (await telegramService.testToken('TOK123')) === 'psy_test_bot');
const chats = await telegramService.recentChats('TOK123');
ok('recentChats: дедуп chat_id + свежий текст', chats.length === 2 && chats.some(c => c.chatId === '111' && c.text === 'привет') && chats.some(c => c.chatId === '222'));
r = await telegramService.notifyViaWebhook(PSY, 'booking', 'x', nowIso());
ok('webhook: без URL — no-webhook (токен не на клиенте)', NOTIFY_WEBHOOK_URL === '' && r.reason === 'no-webhook');

// ============ D. Страница психолога: share ============
const PSY_ROW = { id: 'psy_catalog_19', full_name: 'Наталия Михайловская', slug: 'наталия-михайловская-19', is_active: true, phone: '+375297804545', city: 'Гродно', created_at: '2026-01-01T00:00:00Z' };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('public_profiles') || u.includes('psychologists?select=')) return RESP([PSY_ROW]);
  if (u.includes('/rest/v1/services')) return RESP([]);
  if (u.includes('session_settings') || u.includes('public_settings')) return RESP([]);
  return RESP([]);
};
let profHtml = '';
const profBody = { set innerHTML(v) { profHtml = String(v); }, get innerHTML() { return profHtml; }, classList: { add(){},remove(){},toggle(){},contains(){return false;} } };
globalThis.document = { ...globalThis.document, querySelector: sel => (sel === '#prof-body' ? profBody : fakeEl()), getElementById: id => (id === 'prof-body' ? profBody : fakeEl()) };
loc.pathname = '/psy/наталия-михайловская-19';
await import(new URL('./js/app.js', 'file://' + process.cwd() + '/').href);
await new Promise(rr => setTimeout(rr, 80));
// Hash History: legacy pathname уже обработан при boot (normalize + render после каталога)
for (const fn of listeners['w:hashchange'] || []) fn();
await new Promise(rr => setTimeout(rr, 60));
ok('профиль: кнопка «Поделиться специалистом»', profHtml.includes('Поделиться специалистом') && profHtml.includes('sharePsyLink('));
ok('профиль: глобальный sharePsyLink', typeof globalThis.window.sharePsyLink === 'function' || typeof globalThis.sharePsyLink === 'function');
// navigator.share → системное меню
navProps.share = async (d) => { navProps._shared = d; };
await globalThis.window.sharePsyLink('наталия-михайловская-19');
ok('share: navigator.share получил url страницы', !!navProps._shared && navProps._shared.url.includes('/psy/%D0%BD%D0%B0%D1%82%D0%B0%D0%BB%D0%B8%D1%8F'));
// fallback → буфер обмена
delete navProps.share; navProps._clip = false;
await globalThis.window.sharePsyLink('наталия-михайловская-19');
ok('share: fallback — ссылка в буфере', navProps._clip === true);

// ============ Итог ============
let failed = 0;
for (const [n, good] of R) { console.log((good ? 'PASS' : 'FAIL') + '  ' + n); if (!good) failed++; }
console.log(failed ? `\n${failed} FAILED` : `\nALL PASS (${R.length})`);
process.exit(failed ? 1 : 0);
