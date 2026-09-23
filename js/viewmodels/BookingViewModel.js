import { BaseViewModel } from './BaseViewModel.js';
import { db } from '../core/dbContext.js';
import { paymentService } from '../services/paymentService.js';
import { fraudProtectionService, normalizePhone } from '../services/fraudProtectionService.js';
import { PaymentPolicy } from '../models/entities.js';
import { reminderService } from '../services/reminderService.js';
import { nicknameService } from '../services/nicknameService.js';
import { clientVaultService } from '../services/clientVaultService.js';
import { supabaseApi } from '../services/supabaseApi.js';
import { telegramService } from '../services/telegramService.js';
import { clientCabinetService } from '../services/clientCabinetService.js';
import { formatOffset, weekdayOf } from '../services/timezoneService.js';
import {
  detectClientTimeZone, formatTimeZoneCaption, convertPsySlotToClient,
  workWindowEnd, slotFitsDuration, isPastSlot, timeToMinutes,
  clientUtcOffsetMinutes
} from '../services/calendarService.js';

const WIZARD_STEPS = [
  { id: 1, key: 'service', label: 'Услуга' },
  { id: 2, key: 'time', label: 'Время' },
  { id: 3, key: 'contact', label: 'Контакт' }
];

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
 * Wizard (T-01): Услуга → Время → Контакт; слоты по duration (T-02);
 * пояс клиента (T-03); клик по услуге сразу к окнам (T-04).
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
    this.wantRecurring = false; // T-08 / SR-106: «хочу постоянное время»
    this.honeypot = ''; // bots fill this — must stay empty
    this.done = false;
    this.successText = '';
    this.createdSessionId = null;
    this.paymentInfo = null;
    this.awaitingPayment = false;
    /** today | tomorrow | week | biweek | month */
    this.dateRange = 'week';
    /** публичная доступность (free/busy) с сервера */
    this.remoteBusy = {};   // { 'YYYY-MM-DD': [{time, duration}] }
    this.remoteBlocks = []; // [{dateFrom, dateTo, timeFrom, timeTo, kind, title}]
    this.onAvailability = null; // колбэк после async-обновления занятости
    this.step = 1;
    this.pendingScrollToSlots = false;
    this.clientTimeZone = detectClientTimeZone();
    this._deepLinkKey = '';
  }

  get wizardSteps() { return WIZARD_STEPS; }

  get psyTimeZone() {
    return this.settings?.timezone || 'Europe/Minsk';
  }

  get timeZoneCaption() {
    return formatTimeZoneCaption(this.clientTimeZone, this.psyTimeZone);
  }

  get timeZonesDiffer() {
    return !!(this.clientTimeZone && this.psyTimeZone && this.clientTimeZone !== this.psyTimeZone);
  }

  get selectedDuration() {
    return Number(this.selectedService?.duration) || 60;
  }

  get choiceSummary() {
    const parts = [];
    const svc = this.selectedService;
    if (svc) parts.push(`${svc.name} · ${svc.duration} мин`);
    if (this.time) {
      const conv = convertPsySlotToClient(this.date, this.time, this.psyTimeZone, this.clientTimeZone);
      parts.push(this.timeZonesDiffer
        ? `${this.date} ${this.time} (${this.psyTimeZone}) · у вас ${conv.label}`
        : `${this.date} ${this.time}`);
    }
    return parts.join(' · ');
  }

  loadBySlug(slug) {
    paymentService.expireStaleHolds();
    fraudProtectionService.markFormOpened();
    this.psychologist = db.findPsychologistBySlug(slug);
    this._resetFormState({ full: true });
    this._deepLinkKey = '';
    if (this.psychologist) {
      this.serviceId = this.services[0]?.id || null;
      this._refreshPaymentInfo();
      this.refreshAvailability();
    }
    this.notify();
    return !!this.psychologist;
  }

  loadById(id) {
    const psy = db.psychologists.find(p => p.id === id && p.isActive) || null;
    if (psy?.slug) return this.loadBySlug(psy.slug); // единый путь: /psy/{slug} (индексируемый URL)
    return false;
  }

  /**
   * Старые и новые прямые ссылки: ?book=, /psy/{slug}#book, ?service=, ?step=, #slots.
   * Вызывать из View после loadBySlug — состояние формы не затирается.
   */
  applyDeepLink({ search = '', hash = '', serviceId = '' } = {}) {
    const key = `${this.psychologist?.slug || ''}|${search}|${hash}|${serviceId || ''}`;
    if (!this.psychologist || this._deepLinkKey === key) return;
    this._deepLinkKey = key;
    let qs = new URLSearchParams();
    try { qs = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search); } catch { /* */ }

    const svcParam = serviceId || qs.get('service') || qs.get('svc');
    if (svcParam && this.services.some(s => s.id === svcParam)) {
      this.serviceId = svcParam;
      this._refreshPaymentInfo();
      this.step = 2;
      this.pendingScrollToSlots = true;
    }

    const step = (qs.get('step') || '').toLowerCase();
    if (step === '1' || step === 'service') this.step = 1;
    if (step === '2' || step === 'time') this.step = 2;
    if (step === '3' || step === 'contact') this.step = 3;

    const h = String(hash || '').toLowerCase();
    if (h === '#book') {
      // легаси /psy/{slug}#book — форма записи, шаг 1 (или 2, если услуга уже в query)
      if (this.step < 1) this.step = 1;
    }
    if (h === '#slots' || h === '#time' || h === '#book-slots') {
      this.step = Math.max(this.step, 2);
      this.pendingScrollToSlots = true;
    }
    this.notify();
  }

  /** Подтянуть публичный free/busy (занятые слоты + блокировки) с сервера */
  async refreshAvailability() {
    const psyId = this.psychologist?.id;
    if (!psyId || !supabaseApi.configured()) return;
    try {
      const [fromDate, toDate] = [todayStr(), addDays(this.dateRange === 'month' ? 30 : 14)];
      const [slots, blocks] = await Promise.all([
        supabaseApi.listBookedSlots(psyId, fromDate, toDate).catch(() => []),
        supabaseApi.listBusyBlocks(psyId, fromDate, toDate).catch(() => [])
      ]);
      this.remoteBusy = {};
      (slots || []).forEach(s => {
        const rec = { time: s.session_time, duration: Number(s.duration_min) || 60 };
        (this.remoteBusy[s.session_date] ||= []).push(rec);
      });
      this.remoteBlocks = (blocks || []).map(b => ({
        dateFrom: b.date_from,
        dateTo: b.date_to || b.date_from,
        timeFrom: b.time_from || '',
        timeTo: b.time_to || '',
        kind: b.kind || 'busy',
        title: b.title || ''
      }));
      this.onAvailability && this.onAvailability();
    } catch (e) {
      console.warn('[Booking] free/busy недоступен', e);
    }
  }

  _resetFormState({ full = false } = {}) {
    this.done = false;
    this.error = '';
    this.awaitingPayment = false;
    this.createdSessionId = null;
    this.paymentInfo = null;
    this.honeypot = '';
    this.time = null;
    this.date = todayStr();
    this.step = 1;
    this.pendingScrollToSlots = false;
    if (full) {
      this.name = '';
      this.nickname = '';
      this.nicknameSuggestions = [];
      this.phone = '';
      this.contact = '';
      this.note = '';
      this.consent = true;
      this.wantRecurring = false;
    }
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
    const workDays = this.settings?.workDays || [1, 2, 3, 4, 5]; // ISO: 1=Пн … 7=Вс
    return Array.from({ length: opt.days }, (_, i) => addDays(i))
      .filter(iso => workDays.includes(((new Date(iso + 'T12:00:00').getDay() + 6) % 7) + 1));
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

  /** День полностью закрыт блокировкой (выходной/отпуск…) → подпись на чипе дня */
  dayBlockTitle(date) {
    const blocks = [...db.blocksOf(this.psychologist?.id), ...this.remoteBlocks];
    const b = blocks.find(x => !x.timeFrom && !x.timeTo
      && date >= (x.dateFrom || '') && date <= (x.dateTo || x.dateFrom || ''));
    return b ? (b.title || 'Закрыто') : null;
  }

  /** Занятые интервалы на дату: сессии/холды/переносы + удалённый free/busy */
  _occupiedIntervals(date) {
    const intervals = [];
    const add = (time, duration) => {
      if (!time) return;
      const start = timeToMinutes(time);
      intervals.push({ start, end: start + (Number(duration) || 60) });
    };
    (this.remoteBusy[date] || []).forEach(x => {
      if (typeof x === 'string') add(x, 60);
      else add(x.time, x.duration);
    });
    db.sessions.forEach(s => {
      if (s.psychologistId !== this.psychologist?.id) return;
      if (['cancelled', 'expired', 'no_show'].includes(s.status)) return;
      if (s.status === 'held' && s.holdExpiresAt && new Date(s.holdExpiresAt) < new Date()) return;
      const dur = db.services.find(x => x.id === s.serviceId)?.duration || 60;
      if (s.date === date) add(s.time, dur);
      if (s.pendingChange && s.changeConsentStatus === 'pending' && s.pendingChange.date === date) {
        add(s.pendingChange.time, dur);
      }
    });
    return intervals;
  }

  _slotReasonTitle(reason) {
    return ({
      duration: 'Недостаточно времени до конца приёма или следующей записи',
      busy: 'Слот занят',
      block: 'Специалист не принимает',
      past: 'Это время уже прошло'
    })[reason] || '';
  }

  get slots() {
    paymentService.expireStaleHolds(this.psychologist?.id);
    const times = this.settings?.slotTimes || ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    const intervals = this._occupiedIntervals(this.date);
    const blocks = [
      ...db.blocksOf(this.psychologist?.id),
      ...this.remoteBlocks
    ];
    const durationMin = this.selectedDuration;
    const workEnd = workWindowEnd(this.settings);
    const psyTz = this.psyTimeZone;
    const cliTz = this.clientTimeZone;
    return times.map(t => {
      let reason = '';
      if (isPastSlot(this.date, t, psyTz)) reason = 'past';
      else {
        const fit = slotFitsDuration({
          time: t, durationMin, workEnd, intervals, blocks, date: this.date
        });
        if (!fit.ok) reason = fit.reason;
      }
      const conv = convertPsySlotToClient(this.date, t, psyTz, cliTz);
      return {
        time: t,
        label: conv.label,
        subLabel: this.timeZonesDiffer ? t : '',
        busy: !!reason,
        reason,
        title: this._slotReasonTitle(reason)
      };
    });
  }

  /** Сколько свободных окон в диапазоне N дней (счётчики на табах периода, как у ОКОН) */
  freeCountInRange(days) {
    paymentService.expireStaleHolds(this.psychologist?.id);
    const times = this.settings?.slotTimes || ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    const workDays = this.settings?.workDays || [1, 2, 3, 4, 5];
    const blocks = [...db.blocksOf(this.psychologist?.id), ...this.remoteBlocks];
    const durationMin = this.selectedDuration;
    const workEnd = workWindowEnd(this.settings);
    const psyTz = this.psyTimeZone;
    let count = 0;
    for (let i = 0; i < days; i++) {
      const date = addDays(i);
      if (!workDays.includes(((new Date(date + 'T12:00:00').getDay() + 6) % 7) + 1)) continue;
      const intervals = this._occupiedIntervals(date);
      for (const t of times) {
        if (isPastSlot(date, t, psyTz)) continue;
        const fit = slotFitsDuration({ time: t, durationMin, workEnd, intervals, blocks, date });
        if (fit.ok) count++;
      }
    }
    return count;
  }

  _refreshPaymentInfo() {
    if (!this.psychologist || !this.selectedService) {
      this.paymentInfo = null;
      return;
    }
    this.paymentInfo = paymentService.resolvePolicy(this.psychologist.id, this.selectedService);
  }

  /**
   * @param {string} id
   * @param {{ revealSlots?: boolean }} [opts] T-04: клик по услуге сразу к окнам
   */
  selectService(id, opts = {}) {
    this.serviceId = id;
    this.time = null;
    this._refreshPaymentInfo();
    const reveal = opts.revealSlots !== false;
    if (reveal) {
      this.step = 2;
      this.pendingScrollToSlots = true;
    }
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

  canProceedFrom(step = this.step) {
    if (step === 1) return !!this.serviceId;
    if (step === 2) return !!this.time;
    return true;
  }

  goToStep(n) {
    const next = Number(n);
    if (!Number.isFinite(next) || next < 1 || next > 3) return false;
    if (next > this.step) {
      for (let i = this.step; i < next; i++) {
        if (!this.canProceedFrom(i)) {
          this.error = i === 1 ? 'Выберите услугу' : 'Выберите время';
          this.notify();
          return false;
        }
      }
    }
    this.error = '';
    this.step = next;
    this.notify();
    return true;
  }

  goNext() {
    if (this.step >= 3) return false;
    return this.goToStep(this.step + 1);
  }

  goBack() {
    if (this.step <= 1) return false;
    this.error = '';
    this.step = this.step - 1;
    this.notify();
    return true;
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

  _whenLabel() {
    const conv = convertPsySlotToClient(this.date, this.time, this.psyTimeZone, this.clientTimeZone);
    if (this.timeZonesDiffer) {
      return `${this.date} в ${this.time} (${this.psyTimeZone}); у вас ${conv.label}`;
    }
    return `${this.date} в ${this.time}`;
  }

  async submit() {
    this.error = '';
    if (!this.psychologist) {
      this.error = 'Психолог не выбран';
      this.notify();
      return false;
    }
    if (!this.serviceId) { this.error = 'Выберите услугу'; this.step = 1; this.notify(); return false; }
    if (!this.time) { this.error = 'Выберите время'; this.step = 2; this.notify(); return false; }
    if (!this.consent) {
      this.error = 'Нужно согласие на обработку данных';
      this.notify();
      return false;
    }

    const stillFree = this.slots.find(s => s.time === this.time && !s.busy);
    if (!stillFree) {
      this.error = 'Это время уже недоступно — выберите другое окно';
      this.step = 2;
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

    try {
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
      const tzNote = this.clientTimeZone
        ? `Пояс клиента: ${this.clientTimeZone} (UTC${formatOffset(clientUtcOffsetMinutes(this.clientTimeZone))})`
        : '';
      const userNote = this.note.trim() ? `Запрос клиента: ${this.note.trim()}` : '';
      const sessionNote = [userNote, tzNote].filter(Boolean).join('\n');

      const session = db.addSession({
        psychologistId: this.psychologist.id,
        clientId: client.id,
        serviceId: this.serviceId,
        date: this.date,
        time: this.time,
        status: payFields.status,
        note: sessionNote,
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
      // пока колонок нет (SR-001) — держим на объекте для локального контура
      session.clientTimeZone = this.clientTimeZone;
      session.clientUtcOffsetMin = clientUtcOffsetMinutes(this.clientTimeZone);
      db.saveChanges();

      if (this.wantRecurring) {
        try {
          const waiting = db.addWaiting({
            psychologistId: this.psychologist.id,
            clientId: client.id,
            type: 'wait',
            name: this.nickname || this.name,
            phone,
            note: `Хочет постоянное время: ${this.date} ${this.time}`
          });
          if (waiting?.id) {
            clientCabinetService.setWaitingPref(waiting.id, {
              recurring: true,
              desiredDate: this.date,
              desiredTime: this.time,
              weekday: weekdayOf(this.date),
              intervalWeeks: 1,
              sessionId: session.id
            });
          }
        } catch (e) {
          console.warn('[Booking] recurring wait', e);
        }
      }

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

      // Telegram: мгновенно через webhook (если настроен), иначе — outbox при открытии кабинета
      telegramService.notifyViaWebhook(
        this.psychologist.id, 'booking',
        telegramService.bookingText(session, client, svc),
        session.createdAt
      ).catch(() => {});

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
        this.successText = `${this.nickname || this.name}, заявка отправлена к ${this.psychologist.fullName}: ${this._whenLabel()}. Психолог подтвердит запись.`;
        this.showToast('Заявка отправлена');
      }
      this.notify();
      return session;
    } catch (e) {
      this.error = e?.message || 'Не удалось отправить заявку';
      console.warn('[Booking] submit', e);
      this.notify();
      return false;
    }
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

    const paidSession = db.sessions.find(x => x.id === this.createdSessionId);
    if (paidSession) {
      const c = db.clientsOf(this.psychologist.id).find(x => x.id === paidSession.clientId);
      const sv = db.servicesOf(this.psychologist.id).find(x => x.id === paidSession.serviceId);
      telegramService.notifyViaWebhook(this.psychologist.id, 'payment',
        `💰 <b>Оплата прошла (сайт)</b>\nКлиент: ${c?.name || c?.nickname || '—'}\nКогда: ${paidSession.date} в ${paidSession.time}${sv ? `\nУслуга: ${sv.name} · ${sv.priceLabel()}` : ''}`
      ).catch(() => {});
    }

    this.awaitingPayment = false;
    this.done = true;
    this.successText = `${this.nickname || this.name}, оплата прошла. ${res.message} Запись: ${this._whenLabel()}.`;
    this.showToast(res.message);
    this.notify();
    return true;
  }
}
