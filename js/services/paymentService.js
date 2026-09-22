/**
 * PaymentService — предоплата, аванс, 100% по чеку
 */
import { db } from '../core/dbContext.js';
import { PaymentPolicy, PaymentStatus, Payment } from '../models/entities.js';

function uid(prefix = 'pay') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

export class PaymentService {
  /** Эффективная политика для услуги */
  resolvePolicy(psychologistId, service) {
    const settings = db.settingsOf(psychologistId);
    const policy = service?.paymentPolicy || settings.paymentPolicy || PaymentPolicy.NONE;
    let depositDue = 0;
    const price = service?.price || 0;
    const currency = service?.currency || 'BYN';

    if (policy === PaymentPolicy.FULL) {
      depositDue = price;
    } else if (policy === PaymentPolicy.DEPOSIT || policy === PaymentPolicy.HOLD_UNTIL_PAID) {
      if (service?.depositAmount != null) depositDue = service.depositAmount;
      else if (settings.depositAmount != null) depositDue = settings.depositAmount;
      else {
        const pct = service?.depositPercent ?? settings.depositPercent ?? 30;
        depositDue = money((price * pct) / 100);
      }
      if (depositDue > price) depositDue = price;
    }

    return {
      policy,
      price,
      currency,
      amountDueNow: depositDue,
      amountDueTotal: price,
      holdMinutes: settings.holdMinutes || 60,
      requiresPayment: policy !== PaymentPolicy.NONE && depositDue > 0
    };
  }

  policyLabel(policy) {
    return ({
      [PaymentPolicy.NONE]: 'Без предоплаты',
      [PaymentPolicy.DEPOSIT]: 'Аванс (часть суммы)',
      [PaymentPolicy.FULL]: '100% предоплата',
      [PaymentPolicy.HOLD_UNTIL_PAID]: 'Слот до оплаты'
    })[policy] || policy;
  }

  formatAmount(amount, currency) {
    if (currency === 'RUB') return `${amount} ₽`;
    return `${amount} бел. руб.`;
  }

  /** Создать hold/pending сессию с суммами */
  buildSessionPaymentFields(psychologistId, service) {
    const r = this.resolvePolicy(psychologistId, service);
    const holdExpiresAt = r.requiresPayment
      ? new Date(Date.now() + r.holdMinutes * 60 * 1000).toISOString()
      : null;

    let status = 'pending';
    if (r.requiresPayment) status = 'held';
    else status = 'confirmed';

    return {
      paymentPolicy: r.policy,
      paymentStatus: PaymentStatus.UNPAID,
      amountDue: r.amountDueNow,
      amountPaid: 0,
      currency: r.currency,
      holdExpiresAt,
      requiresPayment: r.requiresPayment,
      status,
      resolve: r
    };
  }

  /**
   * Симуляция оплаты клиентом (демо-эквайринг / чек)
   * method: card_demo | transfer | receipt
   */
  paySession(sessionId, { method = 'card_demo', receiptCode = '', note = '' } = {}) {
    const session = db.sessions.find(s => s.id === sessionId);
    if (!session) return { ok: false, message: 'Сессия не найдена' };
    if (['cancelled', 'expired', 'done'].includes(session.status)) {
      return { ok: false, message: 'Сессию нельзя оплатить' };
    }
    if (session.holdExpiresAt && new Date(session.holdExpiresAt) < new Date() && session.paymentStatus === PaymentStatus.UNPAID) {
      session.status = 'expired';
      session.paymentStatus = PaymentStatus.EXPIRED;
      db.saveChanges();
      return { ok: false, message: 'Время на оплату истекло, слот освобождён' };
    }

    const due = session.amountDue || 0;
    if (due <= 0 && session.paymentPolicy === PaymentPolicy.NONE) {
      return { ok: false, message: 'Предоплата не требуется' };
    }

    const amount = due > 0 ? due : (db.services.find(s => s.id === session.serviceId)?.price || 0);
    const kind = session.paymentPolicy === PaymentPolicy.FULL ? 'full' : 'deposit';

    // Генерация «чека»
    const code = receiptCode || `CHK-${Date.now().toString(36).toUpperCase()}`;

    const payment = new Payment({
      id: uid('pay'),
      sessionId: session.id,
      psychologistId: session.psychologistId,
      clientId: session.clientId,
      amount,
      currency: session.currency,
      kind,
      method,
      status: kind === 'full' ? PaymentStatus.FULLY_PAID : PaymentStatus.DEPOSIT_PAID,
      receiptCode: code,
      externalRef: method === 'card_demo' ? `demo_${uid('tx')}` : '',
      paidAt: new Date().toISOString(),
      note
    });

    db.payments.push(payment);
    session.amountPaid = money((session.amountPaid || 0) + amount);
    session.paymentStatus = payment.status;

    // 100% оплата или аванс → подтверждённая запись
    if (session.paymentPolicy === PaymentPolicy.FULL || session.paymentStatus === PaymentStatus.FULLY_PAID) {
      session.status = 'paid';
      session.paymentStatus = PaymentStatus.FULLY_PAID;
    } else if (session.paymentStatus === PaymentStatus.DEPOSIT_PAID) {
      session.status = 'confirmed';
    }

    session.holdExpiresAt = null;
    db.saveChanges();

    return {
      ok: true,
      payment,
      session,
      message: kind === 'full'
        ? `Оплачено 100%. Чек ${code}. Запись подтверждена.`
        : `Аванс получен. Чек ${code}. Запись подтверждена.`
    };
  }

  /** Психолог вручную отмечает оплату по чеку / переводу */
  markPaidByPsychologist(sessionId, { amount = null, receiptCode = '', note = '' } = {}) {
    const session = db.sessions.find(s => s.id === sessionId);
    if (!session) return { ok: false, message: 'Не найдено' };
    const payAmount = amount != null ? Number(amount) : (session.amountDue || 0);
    return this.paySession(sessionId, {
      method: 'receipt',
      receiptCode: receiptCode || `MAN-${Date.now().toString(36).toUpperCase()}`,
      note: note || 'Подтверждено психологом'
    });
  }

  /** Просроченные hold → expired, слот свободен */
  expireStaleHolds(psychologistId = null) {
    const now = new Date();
    let n = 0;
    db.sessions.forEach(s => {
      if (psychologistId && s.psychologistId !== psychologistId) return;
      if (s.status === 'held' && s.holdExpiresAt && new Date(s.holdExpiresAt) < now && s.paymentStatus === PaymentStatus.UNPAID) {
        s.status = 'expired';
        s.paymentStatus = PaymentStatus.EXPIRED;
        n++;
      }
    });
    if (n) db.saveChanges();
    return n;
  }

  paymentsForSession(sessionId) {
    return db.payments.filter(p => p.sessionId === sessionId);
  }
}

export const paymentService = new PaymentService();
