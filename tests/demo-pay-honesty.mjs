#!/usr/bin/env node
/**
 * #21 п.4 → ужесточено issue #121 (R14): на публичной странице записи НЕТ
 * клиентского пути «оплата прошла».
 *
 *   node tests/demo-pay-honesty.mjs
 *
 * История канона. #21 п.4 разрешал демо-оплату «только в этом браузере», когда
 * сервер не настроен, и запрещал её при живом Supabase. #121 (по решению
 * владельца в ревизии #107) снял демо-контур целиком: без сервера запись не
 * создаётся вовсе, а панель оплаты имеет единственный режим — серверный резерв,
 * который подтверждает специалист в кабинете.
 *
 * Негативные контроли #21 п.4 сохранены и усилены: ни при живом сервере, ни без
 * него у BookingViewModel нет способа перевести сессию в paid, записать payment,
 * взвести done или отправить Telegram «Оплата прошла (сайт)».
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../js/core/dbContext.js';
import { Psychologist, Client, PaymentStatus } from '../js/models/entities.js';
import { BookingViewModel } from '../js/viewmodels/BookingViewModel.js';
import { supabaseSync } from '../js/services/supabaseSync.js';
import { telegramService } from '../js/services/telegramService.js';
import { paymentService } from '../js/services/paymentService.js';

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
const origPaySession = paymentService.paySession.bind(paymentService);
let notifyCalls = [];
let paySessionCalls = 0;
telegramService.notifyViaWebhook = async (...args) => {
  notifyCalls.push(args);
  return { ok: false, reason: 'test-stub' };
};
paymentService.paySession = (...args) => { paySessionCalls += 1; return origPaySession(...args); };

const vm = new BookingViewModel();
vm.psychologist = db.psychologists.find(p => p.id === PSY);
vm.nickname = 'Клиент';
vm.date = '2031-06-02';
vm.time = '10:00';
vm.paymentInfo = { amountDueNow: 40, currency: 'BYN', policy: 'deposit', holdMinutes: 60 };

const sessionUntouched = () => {
  const s = db.sessions.find(x => x.id === SES);
  return s?.status === 'held' && s?.paymentStatus === PaymentStatus.UNPAID && Number(s?.amountPaid || 0) === 0;
};

/** Всё, что публичная страница может сделать с VM в состоянии «ожидание оплаты». */
const publicPageActions = () => {
  // перечисление всех методов VM: ни один не должен называться как платёжное действие
  const proto = Object.getPrototypeOf(vm);
  const names = Object.getOwnPropertyNames(proto).filter(n => typeof Object.getOwnPropertyDescriptor(proto, n)?.value === 'function');
  // мутирующие платёжные глаголы; read-only _refreshPaymentInfo/paymentCheckout — не действие
  return names.filter(n => /(complete|confirm|mark|record|register|apply|submit)\w*pa(y|id)/i.test(n) || /^pay/i.test(n));
};

try {
  check('supabase в репозитории настроен — production-путь включён по умолчанию',
    supabaseSync.enabled() === true);

  /* ── живой сервер ── */
  heldSession();
  vm.createdSessionId = SES;
  vm.awaitingPayment = true;
  vm.done = false;
  vm.successText = 'Слот зарезервирован.';
  vm.error = '';
  const paymentsBefore = db.payments.filter(p => p.sessionId === SES).length;

  const checkoutProd = vm.paymentCheckout;
  check('панель при живом сервере: видима, заголовок «Ожидание оплаты»',
    checkoutProd.visible === true && checkoutProd.title === 'Ожидание оплаты', JSON.stringify(checkoutProd));
  check('панель при живом сервере: демо-кнопок нет (allowDemoPay/mode local-demo отсутствуют)',
    checkoutProd.allowDemoPay !== true && checkoutProd.mode !== 'local-demo');
  check('панель при живом сервере: сноска не обещает подтверждение после кнопки',
    /не проводится/.test(checkoutProd.footnote || '') && !/считается подтверждённой/.test(checkoutProd.footnote || ''),
    checkoutProd.footnote);
  check('сумма к оплате отформатирована из paymentInfo', /40/.test(checkoutProd.dueLabel || ''), checkoutProd.dueLabel);

  check('у BookingViewModel нет платёжных действий (completePayment снят, #121)',
    typeof vm.completePayment === 'undefined' && publicPageActions().length === 0, publicPageActions().join(','));
  check('сессия остаётся held/unpaid (нечем «оплатить» локально)', sessionUntouched());
  check('локальных payments не появилось', db.payments.filter(p => p.sessionId === SES).length === paymentsBefore);
  check('done не взведён, awaitingPayment жив', vm.done === false && vm.awaitingPayment === true);
  check('successText не содержит «оплата прошла»', !/оплата прошла/i.test(vm.successText || ''));
  check('paymentService.paySession с публичной страницы не вызывался', paySessionCalls === 0);
  check('Telegram «Оплата прошла (сайт)» не уходил', notifyCalls.length === 0, JSON.stringify(notifyCalls));

  /* ── сервер не настроен: панель та же, демо не появляется ── */
  supabaseSync.enabled = () => false;
  notifyCalls = [];
  const checkoutLocal = vm.paymentCheckout;
  check('панель без сервера: тот же серверный режим, демо-кнопок нет',
    checkoutLocal.visible === true && checkoutLocal.allowDemoPay !== true && checkoutLocal.mode !== 'local-demo'
      && !/демо|только в этом браузере/i.test(`${checkoutLocal.title} ${checkoutLocal.footnote}`),
    JSON.stringify(checkoutLocal));
  check('панель без сервера: текст идентичен серверному (один источник копирайта)',
    checkoutLocal.title === checkoutProd.title && checkoutLocal.footnote === checkoutProd.footnote);
  check('без сервера сессия по-прежнему held/unpaid', sessionUntouched());
  check('без сервера Telegram не уходил', notifyCalls.length === 0);
  check('без сервера paySession не вызывался', paySessionCalls === 0);

  /* ── без ожидания оплаты панель скрыта ── */
  vm.awaitingPayment = false;
  check('без awaitingPayment панель невидима', vm.paymentCheckout.visible === false);

  /* ── статика: UI не рисует демо-кнопки и не решает про оплату сам ── */
  const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const appSrc = strip(readFileSync(join(ROOT, 'js/app.js'), 'utf-8'));
  const bvmSrc = strip(readFileSync(join(ROOT, 'js/viewmodels/BookingViewModel.js'), 'utf-8'));
  check('app.js: панель оплаты читает paymentCheckout (не сама решает про кнопки)',
    /bookingVm\.paymentCheckout/.test(appSrc));
  check('app.js: data-pay-demo / completePayment / allowDemoPay не рендерятся и не обрабатываются',
    !appSrc.includes('data-pay-demo') && !appSrc.includes('completePayment') && !appSrc.includes('allowDemoPay'));
  check('app.js: старая ложная сноска «После оплаты запись считается подтверждённой» снята',
    !/После оплаты запись считается подтверждённой/.test(appSrc));
  check('BookingViewModel: нет paySession / demoPayIsLocalOnly / «оплата прошла»',
    !bvmSrc.includes('paySession(') && !bvmSrc.includes('demoPayIsLocalOnly') && !/оплата прошла/i.test(bvmSrc));
  check('BookingViewModel: webhook «payment» с публичной страницы не отправляется',
    !bvmSrc.includes("notifyViaWebhook(this.psychologist.id, 'payment'") && !/'payment'/.test(bvmSrc));
} finally {
  supabaseSync.enabled = origEnabled;
  telegramService.notifyViaWebhook = origNotify;
  paymentService.paySession = origPaySession;
  db.sessions = db.sessions.filter(s => s.id !== SES);
  db.payments = db.payments.filter(p => p.sessionId !== SES);
  db.clients = db.clients.filter(c => c.id !== CLI);
  db.psychologists = db.psychologists.filter(p => p.id !== PSY);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
