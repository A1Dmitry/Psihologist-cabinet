import { BaseViewModel } from './BaseViewModel.js';
import { db } from '../core/dbContext.js';
import { paymentService } from '../services/paymentService.js';
import { fraudProtectionService, normalizePhone } from '../services/fraudProtectionService.js';
import { PaymentPolicy } from '../models/entities.js';
import { reminderService } from '../services/reminderService.js';
import { nicknameService, normalizeNickname } from '../services/nicknameService.js';
import { clientVaultService } from '../services/clientVaultService.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * ViewModel публичной записи + предоплата + антиспам
 */
export class BookingViewModel extends BaseViewModel {
  constructor() {
    super();
    this.psychologist = null;
    this.serviceId = null;
    this.date = todayStr();
    this.time = null;
    this.name = '';
    this.nickname = '';
    this.nicknameSuggestions = [];
    this.phone = '';
    this.contact = '';
    this.note = '';
    this.consent = true;
    this.honeypot = ''; // bots fill this — must stay empty
    this.done = false;
    this.successText = '';
    this.createdSessionId = null;
    this.paymentInfo = null;
    this.awaitingPayment = false;
    /** today | tomorrow | week | biweek | month */
    this.dateRange = 'week';
  }

  loadBySlug(slug) {
    paymentService.expireStaleHolds();
    fraudProtectionService.markFormOpened();
    this.psychologist = db.findPsychologistBySlug(slug);
    this._resetFormState();
    if (this.psychologist) {
      this.serviceId = this.services[0]?.id || null;
      this._refreshPaymentInfo();
    }
    this.notify();
    return !!this.psychologist;
  }

  loadById(id) {
    paymentService.expireStaleHolds();
    fraudProtectionService.markFormOpened();
    this.psychologist = db.psychologists.find(p => p.id === id && p.isActive) || null;
    this._resetFormState();
    if (this.psychologist) {
      this.serviceId = this.services[0]?.id || null;
      this._refreshPaymentInfo();
    }
    this.notify();
    return !!this.psychologist;
  }

  _resetFormState() {
    this.done = false;
    this.error = '';
    this.awaitingPayment = false;
    this.createdSessionId = null;
    this.paymentInfo = null;
    this.honeypot = '';
    this.time = null;
    this.date = todayStr();
  }

  get services() {
    if (!this.psychologist) return [];
    return db.servicesOf(this.psychologist.id);
  }

  get selectedService() {
    return this.services.find(s => s.id === this.serviceId) || null;
  }

  get settings() {
    if (!this.psychologist) return null;
    return db.settingsOf(this.psychologist.id);
  }

  get dateRangeOptions() {
    return [
      { id: 'today', label: 'Сегодня', days: 1 },
      { id: 'tomorrow', label: 'Сегодня–завтра', days: 2 },
      { id: 'week', label: 'Неделя', days: 7 },
      { id: 'biweek', label: '2 недели', days: 14 },
      { id: 'month', label: 'Месяц', days: 30 }
    ];
  }

  get availableDays() {
    const opt = this.dateRangeOptions.find(o => o.id === this.dateRange) || this.dateRangeOptions[2];
    return Array.from({ length: opt.days }, (_, i) => addDays(i));
  }

  setDateRange(rangeId) {
    if (!this.dateRangeOptions.some(o => o.id === rangeId)) return;
    this.dateRange = rangeId;
    const days = this.availableDays;
    if (!days.includes(this.date)) {
      this.date = days[0];
      this.time = null;
    }
    this.notify();
  }

  get slots() {
    paymentService.expireStaleHolds(this.psychologist?.id);
    const times = this.settings?.slotTimes || ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    const busy = new Set();
    db.sessions.forEach(s => {
      if (s.psychologistId !== this.psychologist?.id) return;
      if (['cancelled', 'expired', 'no_show'].includes(s.status)) return;
      if (s.status === 'held' && s.holdExpiresAt && new Date(s.holdExpiresAt) < new Date()) return;
      // текущий слот
      if (s.date === this.date) busy.add(s.time);
      // предложенный перенос ещё не подтверждён — резервируем новое время
      if (s.pendingChange && s.changeConsentStatus === 'pending' && s.pendingChange.date === this.date) {
        busy.add(s.pendingChange.time);
      }
    });
    return times.map(t => ({ time: t, busy: busy.has(t) }));
  }

  _refreshPaymentInfo() {
    if (!this.psychologist || !this.selectedService) {
      this.paymentInfo = null;
      return;
    }
    this.paymentInfo = paymentService.resolvePolicy(this.psychologist.id, this.selectedService);
  }

  selectService(id) {
    this.serviceId = id;
    this.time = null;
    this._refreshPaymentInfo();
    this.notify();
  }

  selectDate(date) {
    this.date = date;
    this.time = null;
    this.notify();
  }

  onNicknameInput(value) {
    this.nickname = value;
    this.name = value; // display alias
    if (this.psychologist) {
      this.nicknameSuggestions = nicknameService.suggest(value, this.psychologist.id, 5);
    }
    this.notify();
  }

  applyNicknameSuggestion(nick) {
    this.nickname = nick;
    this.name = nick;
    this.nicknameSuggestions = [];
    this.notify();
  }

  selectTime(time) {
    const slot = this.slots.find(s => s.time === time);
    if (!slot || slot.busy) return;
    this.time = time;
    this.notify();
  }

  get paymentSummaryText() {
    const p = this.paymentInfo;
    if (!p) return '';
    if (p.policy === PaymentPolicy.NONE) return 'Предоплата не требуется — психолог подтвердит запись.';
    if (p.policy === PaymentPolicy.FULL) {
      return `Для фиксации записи нужна 100% оплата: ${paymentService.formatAmount(p.amountDueNow, p.currency)}. После оплаты слот подтверждается (чек).`;
    }
    if (p.policy === PaymentPolicy.DEPOSIT) {
      return `Аванс ${paymentService.formatAmount(p.amountDueNow, p.currency)} из ${paymentService.formatAmount(p.amountDueTotal, p.currency)}. Остаток — на сессии. Слот резервируется на ${p.holdMinutes} мин до оплаты.`;
    }
    return `Слот удерживается ${p.holdMinutes} мин. Оплатите ${paymentService.formatAmount(p.amountDueNow, p.currency)}, чтобы подтвердить запись.`;
  }

  async submit() {
    this.error = '';
    if (!this.psychologist) {
      this.error = 'Психолог не выбран';
      this.notify();
      return false;
    }
    if (!this.serviceId) { this.error = 'Выберите услугу'; this.notify(); return false; }
    if (!this.time) { this.error = 'Выберите время'; this.notify(); return false; }
    if (!this.consent) {
      this.error = 'Нужно согласие на обработку данных';
      this.notify();
      return false;
    }

    const check = fraudProtectionService.validateBooking({
      psychologistId: this.psychologist.id,
      phone: this.phone,
      name: this.nickname || this.name,
      honeypot: this.honeypot,
      contact: this.contact,
      settings: this.settings
    });
    if (!check.ok) {
      this.error = check.message;
      this.notify();
      return false;
    }

    const phone = this.phone.trim();
    // клиент только в кабинете этого психолога; PII шифруется при входе владельца
    const svc = this.selectedService;
    let client = db.clientsOf(this.psychologist.id).find(c =>
      (c.nickname || c.name || '').toLowerCase() === (this.nickname || '').toLowerCase() ||
      (c.phone && normalizePhone(c.phone) === check.phoneKey)
    );
    const taken = await clientVaultService.isNicknameTaken(this.psychologist.id, this.nickname);
    if (!client && taken) {
      this.error = 'Этот никнейм уже занят';
      this.nicknameSuggestions = nicknameService.suggest(this.nickname, this.psychologist.id, 5);
      this.notify();
      return false;
    }
    if (!client) {
      client = await clientVaultService.saveClientFromPublicBooking(this.psychologist.id, {
        name: this.nickname,
        nickname: this.nickname,
        phone,
        contact: this.contact.trim() || phone,
        note: this.note.trim(),
        trustLevel: check.riskLevel === 'high' ? 'caution' : 'new'
      });
    }

    const isOnline = svc?.format === 'online';
    const payFields = paymentService.buildSessionPaymentFields(this.psychologist.id, svc);

    const session = db.addSession({
      psychologistId: this.psychologist.id,
      clientId: client.id,
      serviceId: this.serviceId,
      date: this.date,
      time: this.time,
      status: payFields.status,
      note: this.note.trim() ? `Запрос клиента: ${this.note.trim()}` : '',
      videoPlatform: isOnline ? (this.settings?.defaultVideoPlatform || 'google_meet') : '',
      meetLink: '',
      paymentPolicy: payFields.paymentPolicy,
      paymentStatus: payFields.paymentStatus,
      amountDue: payFields.amountDue,
      amountPaid: 0,
      currency: payFields.currency,
      holdExpiresAt: payFields.holdExpiresAt,
      requiresPayment: payFields.requiresPayment
    });

    fraudProtectionService.logAttempt({
      psychologistId: this.psychologist.id,
      phone,
      success: true,
      reason: 'created'
    });

    // напоминания (24ч / 12ч по настройкам)
    if (!payFields.requiresPayment) {
      reminderService.scheduleForSession(session.id);
    }

    this.createdSessionId = session.id;
    this.paymentInfo = payFields.resolve;

    if (payFields.requiresPayment) {
      this.awaitingPayment = true;
      this.done = false;
      this.successText = `Слот зарезервирован до ${new Date(payFields.holdExpiresAt).toLocaleString('ru-RU')}. Оплатите ${paymentService.formatAmount(payFields.amountDue, payFields.currency)}, чтобы подтвердить запись.`;
      this.showToast('Резерв создан — нужна оплата');
    } else {
      this.awaitingPayment = false;
      this.done = true;
      this.successText = `${this.nickname || this.name}, заявка отправлена к ${this.psychologist.fullName}: ${this.date} в ${this.time}. Психолог подтвердит запись.`;
      this.showToast('Заявка отправлена');
    }
    this.notify();
    return session;
  }

  /** Демо-оплата / «чек» */
  completePayment(method = 'card_demo') {
    if (!this.createdSessionId) {
      this.error = 'Нет сессии для оплаты';
      this.notify();
      return false;
    }
    const res = paymentService.paySession(this.createdSessionId, { method });
    if (!res.ok) {
      this.error = res.message;
      this.notify();
      return false;
    }
    reminderService.scheduleForSession(this.createdSessionId);

    this.awaitingPayment = false;
    this.done = true;
    this.successText = `${this.nickname || this.name}, оплата прошла. ${res.message} Запись: ${this.date} в ${this.time}.`;
    this.showToast(res.message);
    this.notify();
    return true;
  }
}
