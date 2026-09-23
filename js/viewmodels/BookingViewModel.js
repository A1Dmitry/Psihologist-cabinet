import { BaseViewModel } from './BaseViewModel.js';
import { db } from '../core/dbContext.js';
import { paymentService } from '../services/paymentService.js';
import { fraudProtectionService, normalizePhone } from '../services/fraudProtectionService.js';
import { PaymentPolicy } from '../models/entities.js';
import { reminderService } from '../services/reminderService.js';
import { nicknameService, normalizeNickname } from '../services/nicknameService.js';
import { clientVaultService } from '../services/clientVaultService.js';
import { supabaseApi } from '../services/supabaseApi.js';
import { telegramService } from '../services/telegramService.js';

/**
 * Public schedule values are wall-clock values in the psychologist's timezone.
 * Keep all availability calculations in that timezone; only presentation and the
 * value sent to the booking API are converted to the client's timezone.
 */
function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  const minutes = Math.max(0, Number(value) || 0);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function datePartsInTimeZone(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return {
      date: `${values.year}-${values.month}-${values.day}`,
      time: `${values.hour}:${values.minute}`,
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second)
    };
  } catch (_) {
    return null;
  }
}

/** Convert a local wall-clock date/time in an IANA timezone to an instant. */
function zonedTimeToDate(date, time, timezone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute] = String(time || '00:00').split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Iterating once handles DST transitions without depending on the browser's
  // own timezone (which is often UTC in a server/preview environment).
  let instant = new Date(wallAsUtc);
  for (let i = 0; i < 2; i++) {
    const local = datePartsInTimeZone(instant, timezone);
    if (!local) return null;
    const localAsUtc = Date.UTC(
      Number(local.date.slice(0, 4)), Number(local.date.slice(5, 7)) - 1,
      Number(local.date.slice(8, 10)), local.hour, local.minute, 0
    );
    instant = new Date(wallAsUtc - (localAsUtc - instant.getTime()));
  }
  return instant;
}

function detectClientTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

function timezoneOffsetMinutes(date, timezone) {
  const local = datePartsInTimeZone(date, timezone);
  if (!local) return 0;
  const [year, month, day] = local.date.split('-').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, local.hour, local.minute, local.second);
  return Math.round((localAsUtc - date.getTime()) / 60000);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Покрывает ли блокировку весь день/точку времени (legacy helper). */
function blockCovers(b, date, time) {
  const from = b.dateFrom || '';
  const to = b.dateTo || b.dateFrom || '';
  if (!from || date < from || date > to) return false;
  if (!b.timeFrom && !b.timeTo) return true;
  const start = timeToMinutes(time);
  const fromMin = timeToMinutes(b.timeFrom || '00:00');
  const toMin = timeToMinutes(b.timeTo || '24:00') ?? 1440;
  return start != null && fromMin != null && start >= fromMin && start < toMin;
}

/** Does a schedule block intersect [start, end) in the psychologist's day? */
function blockOverlaps(b, date, start, end) {
  const from = b.dateFrom || '';
  const to = b.dateTo || b.dateFrom || '';
  if (!from || date < from || date > to) return false;
  if (!b.timeFrom && !b.timeTo) return true;
  const fromMin = timeToMinutes(b.timeFrom || '00:00') ?? 0;
  const toMin = timeToMinutes(b.timeTo || '24:00') ?? 1440;
  return start < toMin && end > fromMin;
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
    /** Шаги публичной записи: 1 — услуга, 2 — время, 3 — контакт. */
    this.wizardStep = 1;
    this.clientTimezone = detectClientTimezone();
    this.slotPsychDate = null;
    this.slotPsychTime = null;
    /** публичная доступность (free/busy) с сервера */
    this.remoteBusy = {};   // { 'YYYY-MM-DD': Set<'HH:MM'> }
    this.remoteBlocks = []; // [{dateFrom, dateTo, timeFrom, timeTo, kind, title}]
    this.onAvailability = null; // колбэк после async-обновления занятости

    // The booking page is server-rendered by app.js, while wizard controls are
    // intentionally local to this ViewModel. This small bridge keeps the
    // controls functional without coupling the model to the router.
    if (typeof window !== 'undefined') {
      window.bookingWizard = {
        next: () => this.nextWizardStep(),
        back: () => this.previousWizardStep(),
        go: step => this.goWizardStep(step)
      };
    }
  }

  loadBySlug(slug) {
    paymentService.expireStaleHolds();
    fraudProtectionService.markFormOpened();
    this.psychologist = db.findPsychologistBySlug(slug);
    this._resetFormState();
    if (this.psychologist) {
      this.serviceId = this.services[0]?.id || null;
      this._refreshPaymentInfo();
      this.refreshAvailability();
    }
    this._syncWizardUi();
    this.notify();
    return !!this.psychologist;
  }

  loadById(id) {
    const psy = db.psychologists.find(p => p.id === id && p.isActive) || null;
    if (psy?.slug) return this.loadBySlug(psy.slug); // единый путь: /psy/{slug} (индексируемый URL)
    return false;
  }

  /** Подтянуть публичный free/busy (занятые слоты + блокировки) с сервера */
  async refreshAvailability() {
    const psyId = this.psychologist?.id;
    if (!psyId || !supabaseApi.configured()) return;
    try {
      const [fromDate, toDate] = [todayStr(), addDays(this.dateRange === 'month' ? 30 : 7)];
      const [slots, blocks] = await Promise.all([
        supabaseApi.listBookedSlots(psyId, fromDate, toDate).catch(() => []),
        supabaseApi.listBusyBlocks(psyId, fromDate, toDate).catch(() => [])
      ]);
      this.remoteBusy = {};
      (slots || []).forEach(s => {
        (this.remoteBusy[s.session_date] ||= new Set()).add(s.session_time);
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

  _resetFormState() {
    this.done = false;
    this.error = '';
    this.awaitingPayment = false;
    this.createdSessionId = null;
    this.paymentInfo = null;
    this.honeypot = '';
    this.time = null;
    this.slotPsychDate = null;
    this.slotPsychTime = null;
    this.date = todayStr();
    this.wizardStep = 1;
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

  get psychologistTimezone() {
    return this.settings?.timezone || 'Europe/Minsk';
  }

  get timezoneLabel() {
    return `Время в вашем поясе (${this.clientTimezone}). Часовой пояс специалиста: ${this.psychologistTimezone}.`;
  }

  get selectedClientDate() {
    const date = this.slotPsychDate || this.date;
    const time = this.slotPsychTime || this.time;
    const instant = date && time ? zonedTimeToDate(date, time, this.psychologistTimezone) : null;
    return instant ? (datePartsInTimeZone(instant, this.clientTimezone)?.date || date) : date;
  }

  get selectedClientSlotText() {
    const date = this.slotPsychDate || this.date;
    const time = this.slotPsychTime || this.time;
    if (!time) return '';
    const instant = date ? zonedTimeToDate(date, time, this.psychologistTimezone) : null;
    const local = instant ? datePartsInTimeZone(instant, this.clientTimezone) : null;
    return `${local?.date || this.selectedClientDate} в ${local?.time || this.time}`;
  }

  /** Current offset for the selected appointment, useful for SR-001/API payloads. */
  get clientTimezoneOffsetMin() {
    const date = this.slotPsychDate || this.date;
    const time = this.slotPsychTime || this.time;
    const instant = date && time ? zonedTimeToDate(date, time, this.psychologistTimezone) : new Date();
    return instant ? timezoneOffsetMinutes(instant, this.clientTimezone) : 0;
  }

  _setWizardError(message) {
    this.error = message;
    if (typeof document !== 'undefined') {
      const el = document.getElementById('book-error');
      if (el) {
        el.textContent = message || '';
        el.classList.toggle('hidden', !message);
      }
    }
  }

  _syncWizardUi() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-book-step-panel]').forEach(panel => {
      panel.classList.toggle('hidden', Number(panel.dataset.bookStepPanel) !== this.wizardStep);
    });
    document.querySelectorAll('[data-book-step]').forEach(button => {
      const step = Number(button.dataset.bookStep);
      const active = step === this.wizardStep;
      button.classList.toggle('bg-indigo-600', active);
      button.classList.toggle('text-white', active);
      button.classList.toggle('bg-slate-100', !active);
      button.classList.toggle('text-slate-500', !active);
      button.setAttribute('aria-current', active ? 'step' : 'false');
    });
    const timezone = document.getElementById('book-timezone-note');
    if (timezone) timezone.textContent = this.timezoneLabel;
  }

  _scrollToWizardPanel(step) {
    if (typeof document === 'undefined') return;
    const panel = document.querySelector(`[data-book-step-panel="${step}"]`);
    panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  goWizardStep(step, { scroll = true } = {}) {
    const target = Number(step);
    if (![1, 2, 3].includes(target)) return false;
    if (target >= 2 && !this.selectedService) {
      this._setWizardError('Сначала выберите услугу');
      return false;
    }
    if (target >= 3 && !this.time) {
      this._setWizardError('Сначала выберите свободное время');
      return false;
    }
    this.error = '';
    this.wizardStep = target;
    this._syncWizardUi();
    if (scroll) this._scrollToWizardPanel(target);
    return true;
  }

  nextWizardStep() {
    if (this.wizardStep === 1 && !this.selectedService) {
      this._setWizardError('Выберите услугу, чтобы увидеть свободные окна');
      return false;
    }
    if (this.wizardStep === 2 && !this.time) {
      this._setWizardError('Выберите свободный день и время');
      return false;
    }
    return this.goWizardStep(Math.min(3, this.wizardStep + 1));
  }

  previousWizardStep() {
    return this.goWizardStep(Math.max(1, this.wizardStep - 1));
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
      this.slotPsychDate = null;
      this.slotPsychTime = null;
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

  /** Занятые интервалы на дату: сессии/холды/переносы + удалённый free/busy. */
  _busyIntervalsFor(date) {
    const intervals = [];
    const fallbackDuration = Number(this.settings?.slotStepMin) || 60;
    const add = (time, duration = fallbackDuration) => {
      const start = timeToMinutes(time);
      if (start != null) intervals.push([start, start + Math.max(1, Number(duration) || fallbackDuration)]);
    };

    (this.remoteBusy[date] || []).forEach(time => add(time));
    db.sessions.forEach(s => {
      if (s.psychologistId !== this.psychologist?.id) return;
      if (['cancelled', 'expired', 'no_show'].includes(s.status)) return;
      if (s.status === 'held' && s.holdExpiresAt && new Date(s.holdExpiresAt) < new Date()) return;
      const duration = db.services.find(service => service.id === s.serviceId)?.duration || fallbackDuration;
      if (s.date === date) add(s.time, duration);
      if (s.pendingChange && s.changeConsentStatus === 'pending' && s.pendingChange.date === date) {
        add(s.pendingChange.time, duration);
      }
    });
    return intervals;
  }

  _busySetFor(date) {
    return new Set(this._busyIntervalsFor(date).map(([start]) => minutesToTime(start)));
  }

  /** Candidate start times, clipped to the work window and service duration. */
  _candidateTimes() {
    const settings = this.settings;
    const configured = Array.isArray(settings?.slotTimes) && settings.slotTimes.length
      ? settings.slotTimes
      : [];
    if (configured.length) return configured;
    const start = timeToMinutes(settings?.slotStart || '10:00') ?? 600;
    const end = timeToMinutes(settings?.slotEnd || '18:00') ?? 1080;
    const step = Number(settings?.slotStepMin) || 60;
    const result = [];
    for (let at = start; at < end; at += step) result.push(minutesToTime(at));
    return result;
  }

  _availabilityBlocks() {
    return [
      ...db.blocksOf(this.psychologist?.id),
      ...this.remoteBlocks
    ];
  }

  _slotRowsForDate(date) {
    paymentService.expireStaleHolds(this.psychologist?.id);
    const duration = Math.max(1, Number(this.selectedService?.duration) || 60);
    const settings = this.settings;
    const workStart = timeToMinutes(settings?.slotStart || '10:00') ?? 600;
    const workEnd = timeToMinutes(settings?.slotEnd || '18:00') ?? 1080;
    const busyIntervals = this._busyIntervalsFor(date);
    const blocks = this._availabilityBlocks();

    return this._candidateTimes().map(rawTime => {
      const start = timeToMinutes(rawTime);
      const end = start == null ? null : start + duration;
      // A 90-minute service at 18:00 is rejected for a 19:00 workday. The
      // same interval check also rejects starts crossing a next busy event.
      const outsideWorkWindow = start == null || start < workStart || end > workEnd;
      const overlapsBusy = start != null && busyIntervals.some(([busyStart, busyEnd]) => {
        return start < busyEnd && end > busyStart;
      });
      const overlapsBlock = start != null && blocks.some(block => blockOverlaps(block, date, start, end));
      const psychTime = start == null ? String(rawTime) : minutesToTime(start);
      const instant = !outsideWorkWindow && date
        ? zonedTimeToDate(date, psychTime, this.psychologistTimezone)
        : null;
      const client = instant ? datePartsInTimeZone(instant, this.clientTimezone) : null;
      return {
        // `time` stays the value rendered/clicked by the existing view.
        time: client ? (client.date !== date ? `${client.date} · ${client.time}` : client.time) : psychTime,
        displayTime: client?.time || psychTime,
        displayDate: client?.date || date,
        clientDate: client?.date || date,
        clientTime: client?.time || psychTime,
        psychDate: date,
        psychTime,
        busy: outsideWorkWindow || overlapsBusy || overlapsBlock
      };
    });
  }

  get slots() {
    return this._slotRowsForDate(this.date);
  }

  /** Сколько свободных окон в диапазоне N дней (счётчики на табах периодов, как у ОКОН) */
  freeCountInRange(days) {
    paymentService.expireStaleHolds(this.psychologist?.id);
    const workDays = this.settings?.workDays || [1, 2, 3, 4, 5];
    let count = 0;
    for (let i = 0; i < days; i++) {
      const date = addDays(i);
      if (!workDays.includes(((new Date(date + 'T12:00:00').getDay() + 6) % 7) + 1)) continue;
      count += this._slotRowsForDate(date).filter(slot => !slot.busy).length;
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

  selectService(id) {
    this.serviceId = id;
    this.time = null;
    this.slotPsychDate = null;
    this.slotPsychTime = null;
    this._refreshPaymentInfo();
    this.error = '';
    // T-04: selecting a service immediately reveals its availability.
    this.wizardStep = 2;
    this._syncWizardUi();
    this.notify();
    this._scrollToWizardPanel(2);
  }

  selectDate(date) {
    this.date = date;
    this.time = null;
    this.slotPsychDate = null;
    this.slotPsychTime = null;
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
    const slot = this.slots.find(s => s.time === time || s.displayTime === time);
    if (!slot || slot.busy) return;
    this.time = slot.time;
    this.slotPsychDate = slot.psychDate;
    this.slotPsychTime = slot.psychTime;
    this.error = '';
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
    const selectedPsychDate = this.slotPsychDate || this.date;
    const selectedPsychTime = this.slotPsychTime || this.time;
    const selectedSlot = this._slotRowsForDate(selectedPsychDate)
      .find(slot => slot.psychTime === selectedPsychTime);
    if (!selectedSlot || selectedSlot.busy) {
      this.error = 'Это время уже недоступно или не помещается в рабочее окно. Выберите другое.';
      this.notify();
      return false;
    }
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
      // The database currently keeps the psychologist's wall-clock slot. The
      // requested client timezone fields are tracked in SR-001; until the
      // migration is applied, submit the converted psychologist-local value.
      date: selectedPsychDate,
      time: selectedPsychTime,
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
      this.successText = `${this.nickname || this.name}, заявка отправлена к ${this.psychologist.fullName}: ${this.selectedClientSlotText}. Это время в вашем поясе; психолог увидит его в ${this.psychologistTimezone}.`;
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
    this.successText = `${this.nickname || this.name}, оплата прошла. ${res.message} Запись: ${this.selectedClientSlotText}.`;
    this.showToast(res.message);
    this.notify();
    return true;
  }
}
