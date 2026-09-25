#!/usr/bin/env node
/**
 * #21 п.4 — демо-оплата на публичной странице не даёт production false success.
 *
 *   node tests/demo-pay-honesty.mjs
 *
 * Канон: «оплата прошла» либо реально меняет серверную запись через доверенный
 * путь, либо честно говорит, что это демо/локально. Эквайринга нет — при
 * живом Supabase completePayment обязан отказать, не трогать статус сессии,
 * не слать Telegram «Оплата прошла (сайт)». Локальный контур (сервер не
 * настроен) может подтверждать запись только в этом браузере.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../js/core/dbContext.js';
import { Psychologist, Client, Session, PaymentStatus } from '../js/models/entities.js';
import { BookingViewModel } from '../js/viewmodels/BookingViewModel.js';
import { supabaseSync } from '../js/services/supabaseSync.js';
import { telegramService } from '../js/services/telegramService.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const PSY = 'psy_demopay_1';
const SES = 'ses_demopay_1';
const CLI = 'cli_demopay_1';

db.psychologists = (db.psychologists || []).filter(p => p.id !== PSY);
db.clients = (db.clients || []).filter(c => c.id !== CLI);
db.sessions = (db.sessions || []).filter(s => s.id !== SES);
db.payments = (db.payments || []).filter(p => p.sessionId !== SES);

db.psychologists.push(new Psychologist({
  id: PSY, fullName: 'Demo Pay Test', slug: 'demo-pay-test', isActive: true,
  email: 'demopay@example.invalid'
}));
db.clients.push(new Client({
  id: CLI, psychologistId: PSY, name: 'Клиент', nickname: 'Клиент', phone: '+375291111111'
}));

const heldSession = () => db.addSession({
  id: SES,
  psychologistId: PSY,
  clientId: CLI,
  date: '2031-06-02',
  time: '10:00',
  status: 'held',
  paymentPolicy: 'deposit',
  paymentStatus: PaymentStatus.UNPAID,
  amountDue: 40,
  amountPaid: 0,
  currency: 'BYN',
  requiresPayment: true,
  holdExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
});

const origEnabled = supabaseSync.enabled.bind(supabaseSync);
const origNotify = telegramService.notifyViaWebhook.bind(telegramService);
let notifyCalls = [];
telegramService.notifyViaWebhook = async (...args) => {
  notifyCalls.push(args);
  return { ok: false, reason: 'test-stub' };
};

const vm = new BookingViewModel();
vm.psychologist = db.psychologists.find(p => p.id === PSY);
vm.nickname = 'Клиент';
vm.date = '2031-06-02';
vm.time = '10:00';
vm.paymentInfo = { amountDueNow: 40, currency: 'BYN', policy: 'deposit', holdMinutes: 60 };

try {
  check('supabase в репозитории настроен — production-путь включён по умолчанию',
    supabaseSync.enabled() === true);

  heldSession();
  vm.createdSessionId = SES;
  vm.awaitingPayment = true;
  vm.done = false;
  vm.successText = 'Слот зарезервирован.';
  vm.error = '';
  const paymentsBefore = db.payments.filter(p => p.sessionId === SES).length;

  const checkoutProd = vm.paymentCheckout;
  check('панель при живом сервере: mode=server-hold', checkoutProd.mode === 'server-hold', checkoutProd.mode);
  check('панель при живом сервере: демо-кнопок нет', checkoutProd.allowDemoPay === false);
  check('панель при живом сервере: сноска не обещает подтверждение после кнопки',
    /не проводится/.test(checkoutProd.footnote || '') && !/считается подтверждённой/.test(checkoutProd.footnote || ''),
    checkoutProd.footnote);

  const okProd = vm.completePayment('card_demo');
  const sessionAfter = db.sessions.find(s => s.id === SES);
  check('completePayment при живом сервере → false', okProd === false);
  check('сессия остаётся held/unpaid (сервер не «оплачен» локально)',
    sessionAfter?.status === 'held' && sessionAfter?.paymentStatus === PaymentStatus.UNPAID
      && Number(sessionAfter?.amountPaid || 0) === 0,
    `${sessionAfter?.status}/${sessionAfter?.paymentStatus}/${sessionAfter?.amountPaid}`);
  check('локальных payments не появилось',
    db.payments.filter(p => p.sessionId === SES).length === paymentsBefore);
  check('done не взведён, awaitingPayment жив',
    vm.done === false && vm.awaitingPayment === true);
  check('successText не содержит «оплата прошла»',
    !/оплата прошла/i.test(vm.successText || ''));
  check('ошибка честно говорит, что демо не пишется на сервер',
    /не записывается на сервер/.test(vm.error || ''), vm.error);
  check('Telegram «Оплата прошла (сайт)» не уходил',
    notifyCalls.length === 0, JSON.stringify(notifyCalls));

  const okReplay = vm.completePayment('transfer');
  check('повтор completePayment при живом сервере тоже false', okReplay === false);
  check('повтор не меняет статус',
    db.sessions.find(s => s.id === SES)?.status === 'held');

  vm.createdSessionId = null;
  check('без сессии → false', vm.completePayment('card_demo') === false);

  /* ── локальный демо-контур (сервер не настроен) ── */
  supabaseSync.enabled = () => false;
  db.sessions = db.sessions.filter(s => s.id !== SES);
  db.payments = db.payments.filter(p => p.sessionId !== SES);
  heldSession();
  vm.createdSessionId = SES;
  vm.awaitingPayment = true;
  vm.done = false;
  vm.error = '';
  vm.successText = 'Слот зарезервирован.';
  notifyCalls = [];

  const checkoutLocal = vm.paymentCheckout;
  check('панель без сервера: mode=local-demo', checkoutLocal.mode === 'local-demo', checkoutLocal.mode);
  check('панель без сервера: демо-кнопки разрешены', checkoutLocal.allowDemoPay === true);
  check('панель без сервера: сноска честно говорит «только этот браузер»',
    /только в этом браузере/.test(checkoutLocal.footnote || ''), checkoutLocal.footnote);

  const okLocal = vm.completePayment('card_demo');
  const localSession = db.sessions.find(s => s.id === SES);
  check('completePayment без сервера → true (локальное демо)', okLocal === true);
  check('локальная сессия подтверждена в этом браузере',
    localSession && localSession.status !== 'held' && localSession.paymentStatus !== PaymentStatus.UNPAID,
    `${localSession?.status}/${localSession?.paymentStatus}`);
  check('successText признаёт демо/браузер и не выдаёт серверный успех',
    /только в этом браузере/.test(vm.successText || '') && !/^.*, оплата прошла/.test(vm.successText || ''),
    vm.successText);
  check('локальное демо тоже не шлёт Telegram «Оплата прошла (сайт)»',
    notifyCalls.length === 0, JSON.stringify(notifyCalls));

  const appSrc = readFileSync(join(ROOT, 'js/app.js'), 'utf-8');
  check('app.js: панель оплаты читает paymentCheckout (не сама решает про кнопки)',
    /bookingVm\.paymentCheckout/.test(appSrc));
  check('app.js: data-pay-demo рендерится только при allowDemoPay',
    /allowDemoPay/.test(appSrc) && /data-pay-demo/.test(appSrc)
      && /demoButtons/.test(appSrc));
  check('app.js: старая ложная сноска «После оплаты запись считается подтверждённой» снята',
    !/После оплаты запись считается подтверждённой/.test(appSrc));
} finally {
  supabaseSync.enabled = origEnabled;
  telegramService.notifyViaWebhook = origNotify;
  db.sessions = db.sessions.filter(s => s.id !== SES);
  db.payments = db.payments.filter(p => p.sessionId !== SES);
  db.clients = db.clients.filter(c => c.id !== CLI);
  db.psychologists = db.psychologists.filter(p => p.id !== PSY);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
