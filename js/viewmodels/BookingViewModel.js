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
import {
  detectTimeZone, zoneOffsetMinutes, convertWallClock, formatUtcOffset,
  zonedTimeToUtc, isPastMoment
} from '../services/calendarService.js';

/** Шаги wizard'а записи (T-01): Услуга → Время → Контакт. */
export const BookingSteps = {
  SERVICE: 1,
  TIME: 2,
  CONTACT: 3
};

const DEFAULT_SLOT_TIMES = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
const DAY_MINUTES = 24 * 60;

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':');
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

function minutesToTime(mins) {
  const v = ((Math.round(mins) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** «90» → «1,5 ч», «60» → «1 ч», «45» → «45 мин» */
function fmtDuration(min) {
  const m = Number(min) || 60;
  if (m < 60) return `${m} мин`;
  if (m % 60 === 0) return `${m / 60} ч`;
  return `${Math.floor(m / 60)},${Math.round((m % 60) / 6)} ч`;
}

function formatDay(iso) {
  if (iso === todayStr()) return 'сегодня';
  if (iso === addDays(1)) return 'завтра';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  } catch (_) {
    return iso;
  }
}

function formatTimeRange(start, end) {
  return `${start}–${end}`;
}

/** Покрывает ли блокировка занятости слот (формат ScheduleBlock / public_schedule_blocks) */
function blockCovers(b, date, time) {
  const from = b.dateFrom || '';
  const to = b.dateTo || b.dateFrom || '';
  if (!from || date < from || date > to) return false;
  if (!b.timeFrom && !b.timeTo) return true;
  return time >= (b.timeFrom || '00:00') && time < (b.timeTo || '23:59');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * ViewModel публичной записи + предоплата + антиспам.
 *
 * Клиентский путь (T-01…T-04):
 *   шаг 1 «Услуга»  → выбор услуги сразу ведёт к её свободным окнам (T-04);
 *   шаг 2 «Время»   → сетка слотов под длительность услуги (T-02), время подписано
 *                     поясом клиента (T-03);
 *   шаг 3 «Контакт» → минимум полей, без регистрации.
 * Никаких данных при переходе между шагами не теряется: состояние живёт в VM,
 * а поля ввода — в DOM (перерисовка меняет только контейнеры списков).
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
    /** публичная доступность (free/busy) с сервера */
    this.remoteBusy = {};   // { 'YYYY-MM-DD': Set<'HH:MM'> }
    this.remoteBlocks = []; // [{dateFrom, dateTo, timeFrom, timeTo, kind, title}]
    this.onAvailability = null; // колбэк после async-обновления занятости
    /** wizard: текущий шаг и максимальный достигнутый (для индикатора прогресса) */
    this.step = BookingSteps.SERVICE;
    this.maxStepReached = BookingSteps.SERVICE;
    /** пояс клиента определяется один раз за сессию (T-03) */
    this._clientTimeZone = null;
    /** пояс клиента на момент отправки заявки — для SR-001 (sessions.client_timezone) */
    this.clientTimezone = null;
    this.clientUtcOffsetMinutes = null;
  }

  loadBySlug(slug, options = {}) {
    paymentService.expireStaleHolds();
    fraudProtectionService.markFormOpened();
    this.psychologist = db.findPsychologistBySlug(slug);
    this._resetFormState();
    if (this.psychologist) {
      this.serviceId = this.services[0]?.id || null;
      // T-04: пришли по ссылке «услуга → окна» (/book/{slug}?service=<id>) —
      // услуга уже выбрана, сразу показываем её свободные окна.
      const pre = options.service || options.serviceId || null;
      if (pre && this.services.some(s => s.id === pre)) {
        this.serviceId = pre;
        this.step = BookingSteps.TIME;
        this.maxStepReached = BookingSteps.TIME;
      }
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
      this._dropUnavailableSelection();
      this.onAvailability && this.onAvailability();
    } catch (e) {
      console.warn('[Booking] free/busy недоступен', e);
    }
  }

  /** Выбранный слот мог занять кто-то другой, пока мы ждали ответ сервера */
  _dropUnavailableSelection() {
    if (!this.time) return;
    const slot = this._slotsFor(this.date).find(s => s.time === this.time);
    if (slot && !slot.available) {
      this.time = null;
      if (this.step > BookingSteps.TIME) {
        this.step = BookingSteps.TIME;
        this.error = 'Это время только что заняли — выберите, пожалуйста, другое.';
      }
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
    this.date = todayStr();
    this.step = BookingSteps.SERVICE;
    this.maxStepReached = BookingSteps.SERVICE;
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

  // ==========================================================================
  // T-02 — сетка слотов под длительность услуги
  // ==========================================================================

  /** Длительность выбранной услуги в минутах (fallback — 60). */
  get durationMinutes() {
    const d = Number(this.selectedService?.duration);
    return d > 0 ? d : 60;
  }

  get slotTimes() {
    const t = this.settings?.slotTimes;
    return Array.isArray(t) && t.length ? t.slice() : DEFAULT_SLOT_TIMES.slice();
  }

  /** Шаг сетки: из настроек, иначе — разница между первыми слотами. */
  get slotStepMinutes() {
    const step = Number(this.settings?.slotStepMin) || 0;
    if (step > 0) return step;
    const t = this.slotTimes;
    if (t.length > 1) {
      const diff = toMinutes(t[1]) - toMinutes(t[0]);
      if (diff > 0) return diff;
    }
    return 60;
  }

  /** Конец рабочего окна (минуты от полуночи) — дальше слот не начинается. */
  get dayWindowEndMinutes() {
    const t = this.slotTimes;
    const last = toMinutes(t[t.length - 1]);
    const stepEnd = last + this.slotStepMinutes;
    const cfgEnd = this.settings?.slotEnd ? toMinutes(this.settings.slotEnd) : NaN;
    return Number.isFinite(cfgEnd) ? Math.max(stepEnd, cfgEnd) : stepEnd;
  }

  get dayWindowLabel() {
    return `${minutesToTime(toMinutes(this.slotTimes[0]))}–${minutesToTime(this.dayWindowEndMinutes)}`;
  }

  /** Часы приёма в человеческом виде («Пн–Пт 10:00–19:00»). */
  get workHoursLabel() {
    return this.settings?.workHours || '';
  }

  /**
   * Интервалы занятости на дату (минуты в поясе специалиста):
   * чужие записи + блокировки (выходной/отпуск/Google Calendar).
   */
  _busyIntervalsFor(date) {
    const intervals = [];
    for (const t of this._busySetFor(date)) {
      const from = toMinutes(t);
      intervals.push({
        from,
        to: from + this._bookingDurationAt(date, t),
        kind: 'booked',
        title: 'Время занято'
      });
    }
    const blocks = [...db.blocksOf(this.psychologist?.id), ...this.remoteBlocks];
    for (const b of blocks) {
      const from = b.dateFrom || '';
      const to = b.dateTo || b.dateFrom || '';
      if (!from || date < from || date > to) continue;
      if (!b.timeFrom && !b.timeTo) {
        intervals.push({ from: 0, to: DAY_MINUTES, kind: 'block', title: b.title || 'Закрыто' });
      } else {
        const f = toMinutes(b.timeFrom || '00:00');
        const t = toMinutes(b.timeTo || '23:59');
        if (t > f) intervals.push({ from: f, to: t, kind: 'block', title: b.title || 'Закрыто' });
      }
    }
    return intervals;
  }

  /**
   * Длительность чужой записи: для локальных сессий берём длительность услуги,
   * для серверного free/busy (public_booked_slots) она не отдаётся — считаем
   * по шагу сетки (ограничение устранено заявкой SR-003).
   */
  _bookingDurationAt(date, time) {
    const psyId = this.psychologist?.id;
    const s = db.sessions.find(x =>
      x.psychologistId === psyId && x.date === date && x.time === time && x.isSlotBlocking);
    const svc = s ? db.services.find(sv => sv.id === s.serviceId) : null;
    if (Number(svc?.duration) > 0) return Number(svc.duration);
    return this.slotStepMinutes;
  }

  /**
   * Слоты на дату с учётом длительности услуги (T-02) и «прошедшего» времени.
   * Слот недоступен, если:
   *   • он пересекается с чужой записью/блокировкой;
   *   • до конца рабочего окна не хватает времени под услугу
   *     (90-минутная услуга не предлагает 18:00 при закрытии в 19:00);
   *   • время уже прошло.
   */
  _slotsFor(date) {
    paymentService.expireStaleHolds(this.psychologist?.id);
    const dur = this.durationMinutes;
    const windowEnd = this.dayWindowEndMinutes;
    const intervals = this._busyIntervalsFor(date);
    const psyTz = this.psychologistTimeZone;
    const foreign = this.isForeignTimeZone;
    const now = new Date();

    return this.slotTimes.map(t => {
      const start = toMinutes(t);
      const end = start + dur;
      const overlap = intervals.find(iv => start < iv.to && iv.from < end);
      const tooLong = end > windowEnd;
      const past = isPastMoment(date, t, psyTz, now);
      const available = !overlap && !tooLong && !past;
      let reason = '';
      if (overlap) reason = overlap.title || 'Время занято';
      else if (tooLong) reason = `не хватает ${dur} мин до конца приёма`;
      else if (past) reason = 'время уже прошло';
      const client = foreign ? convertWallClock(date, t, psyTz, this.clientTimeZone) : null;
      return {
        time: t,
        endTime: minutesToTime(end),
        available,
        busy: !available,
        reason,
        // T-03: то же мгновение в поясе клиента
        clientTime: client ? client.time : t,
        clientEndTime: client ? minutesToTime(toMinutes(client.time) + dur) : minutesToTime(end),
        clientDate: client ? client.date : date,
        clientDayShift: client ? client.dayShift : 0
      };
    });
  }

  get slots() {
    return this._slotsFor(this.date);
  }

  get slotsAvailableCount() {
    return this.slots.filter(s => s.available).length;
  }

  get selectedSlot() {
    return this.time ? this.slots.find(s => s.time === this.time) || null : null;
  }

  /** Свободные окна на конкретный день (для подсказок на чипах дней) */
  freeCountOnDate(date) {
    return this._slotsFor(date).filter(s => s.available).length;
  }

  /** Сколько свободных окон в диапазоне N дней (счётчики на табах периода, как у ОКОН) */
  freeCountInRange(days) {
    const workDays = this.settings?.workDays || [1, 2, 3, 4, 5];
    let count = 0;
    for (let i = 0; i < days; i++) {
      const date = addDays(i);
      if (!workDays.includes(((new Date(date + 'T12:00:00').getDay() + 6) % 7) + 1)) continue;
      count += this.freeCountOnDate(date);
    }
    return count;
  }

  // ==========================================================================
  // T-03 — часовой пояс клиента
  // ==========================================================================

  get clientTimeZone() {
    if (!this._clientTimeZone) this._clientTimeZone = detectTimeZone('UTC');
    return this._clientTimeZone;
  }

  get psychologistTimeZone() {
    return this.settings?.timezone || 'Europe/Minsk';
  }

  /** Момент выбранного слота (или «сейчас», если слот ещё не выбран). */
  get referenceInstant() {
    if (this.date && this.time) {
      const inst = zonedTimeToUtc(this.date, this.time, this.psychologistTimeZone);
      if (!Number.isNaN(inst.getTime())) return inst;
    }
    return new Date();
  }

  get psychologistUtcOffsetMinutes() {
    return zoneOffsetMinutes(this.psychologistTimeZone, this.referenceInstant);
  }

  get clientUtcOffsetAtSlot() {
    return zoneOffsetMinutes(this.clientTimeZone, this.referenceInstant);
  }

  get timeZoneDiffMinutes() {
    return this.clientUtcOffsetAtSlot - this.psychologistUtcOffsetMinutes;
  }

  /** Клиент в другом поясе — время слотов нужно подписывать оба раза. */
  get isForeignTimeZone() {
    return !!this.clientTimeZone
      && this.clientTimeZone !== this.psychologistTimeZone
      && this.timeZoneDiffMinutes !== 0;
  }

  /** Подпись под сеткой слотов: чей это пояс и как он соотносится с поясом клиента. */
  get timeZoneNote() {
    const psy = this.psychologistTimeZone;
    const psyOff = formatUtcOffset(this.psychologistUtcOffsetMinutes);
    if (!this.isForeignTimeZone) {
      return `Время специалиста: ${psy} (${psyOff}) — совпадает с вашим.`;
    }
    const diff = this.timeZoneDiffMinutes;
    const abs = Math.abs(diff);
    const diffText = abs % 60
      ? `${Math.floor(abs / 60)} ч ${abs % 60} мин`
      : `${abs / 60} ч`;
    const sample = convertWallClock(this.date, '12:00', psy, this.clientTimeZone).time;
    return `Время специалиста: ${psy} (${psyOff}). Ваш пояс — ${this.clientTimeZone} `
      + `(${formatUtcOffset(this.clientUtcOffsetAtSlot)}), разница ${diff > 0 ? '+' : '−'}${diffText}. `
      + `Например, 12:00 у специалиста — это ${sample} по вашему времени.`;
  }

  // ==========================================================================
  // Wizard (T-01)
  // ==========================================================================

  get steps() {
    return [
      { id: BookingSteps.SERVICE, key: 'service', label: 'Услуга', icon: '1' },
      { id: BookingSteps.TIME, key: 'time', label: 'Время', icon: '2' },
      { id: BookingSteps.CONTACT, key: 'contact', label: 'Контакт', icon: '3' }
    ].map(s => ({
      ...s,
      state: s.id === this.step ? 'current' : (s.id < this.step ? 'done' : 'todo'),
      reachable: this.canGoToStep(s.id)
    }));
  }

  /** Что мешает пройти шаг дальше (null — можно переходить). */
  _stepIssue(step) {
    if (step === BookingSteps.SERVICE) {
      return this.serviceId ? null : 'Выберите услугу — дальше покажем свободные окна';
    }
    if (step === BookingSteps.TIME) {
      if (!this.serviceId) return 'Сначала выберите услугу';
      return this.time ? null : 'Выберите свободное время';
    }
    return null;
  }

  canGoToStep(step) {
    const target = Number(step) || 1;
    if (target <= BookingSteps.SERVICE) return true;
    for (let s = BookingSteps.SERVICE; s < target; s++) {
      if (this._stepIssue(s)) return false;
    }
    return true;
  }

  goToStep(step) {
    const target = Math.min(BookingSteps.CONTACT, Math.max(BookingSteps.SERVICE, Number(step) || 1));
    if (!this.canGoToStep(target)) {
      // вернуть пользователя на первый незавершённый шаг и сказать, чего не хватает
      for (let s = BookingSteps.SERVICE; s < target; s++) {
        const issue = this._stepIssue(s);
        if (issue) {
          this.step = s;
          this.error = issue;
          break;
        }
      }
      this.notify();
      return false;
    }
    if (target !== this.step) this.error = '';
    this.step = target;
    this.maxStepReached = Math.max(this.maxStepReached, target);
    this.notify();
    return true;
  }

  nextStep() { return this.goToStep(this.step + 1); }
  prevStep() { return this.goToStep(this.step - 1); }

  /** T-04: клик по услуге — услуга выбрана и сразу показаны её свободные окна. */
  selectServiceAndContinue(id) {
    this.selectService(id);
    if (!this.serviceId) return false;
    if (this.step === BookingSteps.SERVICE) return this.goToStep(BookingSteps.TIME);
    this.notify();
    return true;
  }

  /** Выбор времени — сразу к контактам (меньше шагов до записи). */
  selectTimeAndContinue(time) {
    this.selectTime(time);
    if (!this.time) return false;
    return this.goToStep(BookingSteps.CONTACT);
  }

  // ==========================================================================
  // Даты / периоды
  // ==========================================================================

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

  /** Занятые слоты на дату: сессии/холды/переносы + удалённый free/busy */
  _busySetFor(date) {
    const busy = new Set(this.remoteBusy[date] || []);
    db.sessions.forEach(s => {
      if (s.psychologistId !== this.psychologist?.id) return;
      if (['cancelled', 'expired', 'no_show'].includes(s.status)) return;
      if (s.status === 'held' && s.holdExpiresAt && new Date(s.holdExpiresAt) < new Date()) return;
      if (s.date === date) busy.add(s.time);
      if (s.pendingChange && s.changeConsentStatus === 'pending' && s.pendingChange.date === date) {
        busy.add(s.pendingChange.time);
      }
    });
    return busy;
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
    if (!slot || !slot.available) return;
    this.time = time;
    this.notify();
  }

  // ==========================================================================
  // Итог выбора (для recap на шаге 3 и подтверждения)
  // ==========================================================================

  get selection() {
    const svc = this.selectedService;
    if (!svc) return null;
    const slot = this.selectedSlot;
    return {
      service: svc,
      serviceName: svc.name,
      priceLabel: svc.priceLabel(),
      durationMinutes: this.durationMinutes,
      durationLabel: fmtDuration(this.durationMinutes),
      date: this.date,
      dateLabel: formatDay(this.date),
      time: this.time,
      endTime: this.time ? minutesToTime(toMinutes(this.time) + this.durationMinutes) : null,
      clientDate: slot?.clientDate || this.date,
      clientTime: slot?.clientTime || this.time,
      clientEndTime: slot?.clientEndTime || null,
      clientDayShift: slot?.clientDayShift || 0,
      clientTimeZone: this.clientTimeZone,
      psychologistTimeZone: this.psychologistTimeZone,
      isForeignTimeZone: this.isForeignTimeZone
    };
  }

  /** Строка вида «24 сен, 17:00–18:30 (+ у вас 19:00–20:30)» */
  get selectionSlotText() {
    const sel = this.selection;
    if (!sel || !sel.time) return '';
    let text = `${formatTimeRange(sel.time, sel.endTime)}`;
    if (sel.isForeignTimeZone && sel.clientTime) {
      const shift = sel.clientDayShift
        ? ` (${sel.clientDayShift > 0 ? '+' : '−'}${Math.abs(sel.clientDayShift)} дн)`
        : '';
      text += ` · у вас ${formatTimeRange(sel.clientTime, sel.clientEndTime)}${shift}`;
    }
    return text;
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

    // T-03: пояс клиента фиксируем в заметке сессии — до появления колонок
    // sessions.client_timezone / client_utc_offset (заявка SR-001) это единственный
    // способ донести до специалиста, в каком поясе клиент видел своё время.
    this.clientTimezone = this.clientTimeZone;
    this.clientUtcOffsetMinutes = this.clientUtcOffsetAtSlot;
    const tzLine = this.isForeignTimeZone
      ? `Часовой пояс клиента: ${this.clientTimeZone} (${formatUtcOffset(this.clientUtcOffsetMinutes)}) — время записи в поясе специалиста: ${this.psychologistTimeZone}.`
      : '';
    const noteLines = [
      this.note.trim() ? `Запрос клиента: ${this.note.trim()}` : '',
      tzLine
    ].filter(Boolean);

    const session = db.addSession({
      psychologistId: this.psychologist.id,
      clientId: client.id,
      serviceId: this.serviceId,
      date: this.date,
      time: this.time,
      status: payFields.status,
      note: noteLines.join('\n'),
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
      this.successText = `${this.nickname || this.name}, заявка отправлена к ${this.psychologist.fullName}: ${formatDay(this.date)} в ${this.selectionSlotText || this.time}. Специалист подтвердит запись.`;
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
        `💰 <b>Оплата прошла (сайт)</b>\\nКлиент: ${c?.name || c?.nickname || '—'}\\nКогда: ${paidSession.date} в ${paidSession.time}${sv ? `\\nУслуга: ${sv.name} · ${sv.priceLabel()}` : ''}`
      ).catch(() => {});
    }

    this.awaitingPayment = false;
    this.done = true;
    this.successText = `${this.nickname || this.name}, оплата прошла. ${res.message} Запись: ${formatDay(this.date)} в ${this.selectionSlotText || this.time}.`;
    this.showToast(res.message);
    this.notify();
    return true;
  }
}
