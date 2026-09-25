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
import { supabaseSync } from '../services/supabaseSync.js';
import {
  browserZone, offsetMinutes, convertWallClock, formatUtcOffset,
  zonedToInstant, instantToZoned,
  timeToMinutes, minutesToTime, addMinutesToTime, formatTimeRange,
  todayStr, daysFromToday, weekdayOf, DEFAULT_TIMEZONE
} from '../services/timezoneService.js';
import { resolveDurationMinutes, resolveCandidateDurationMinutes, formatDuration as fmtDuration } from '../domain/duration.js';
import {
  computeBookableSlots, isoWeekStartOf, addDaysIso
} from '../domain/availability.js';

/** Шаги wizard'а записи (T-01): Услуга → Время → Контакт. */
export const BookingSteps = {
  SERVICE: 1,
  TIME: 2,
  CONTACT: 3
};

const DEFAULT_SLOT_TIMES = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
const DAY_MINUTES = 24 * 60;

/**
 * Человеческая подпись дня: «сегодня», «завтра», «ср, 24 сент.».
 * Календарная арифметика — из канонического js/services/timezoneService.js.
 */
function formatDay(iso) {
  if (iso === todayStr()) return 'сегодня';
  if (iso === daysFromToday(1)) return 'завтра';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  } catch (_) {
    return iso;
  }
}

/**
 * Расписание специалиста хранится «настенным» временем в ЕГО поясе; вся
 * арифметика доступности считается в этом поясе, а в пояс клиента переводятся
 * только подпись и то, что уходит в API записи.
 */

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
    /** Шаги публичной записи: 1 — услуга, 2 — время, 3 — контакт. */
    this.wizardStep = 1;
    this.slotPsychDate = null;
    this.slotPsychTime = null;
    /** публичная доступность (free/busy) с сервера */
    this.remoteBusy = {};   // { 'YYYY-MM-DD': { 'HH:MM': durationMin } }
    this.remoteBlocks = []; // [{dateFrom, dateTo, timeFrom, timeTo, kind, title}]
    this.remoteOverrides = []; // D1: [{date, isClosed, openFrom, openTo, title}]
    this.onAvailability = null; // колбэк после async-обновления занятости
    /** wizard: текущий шаг и максимальный достигнутый (для индикатора прогресса) */
    this.step = BookingSteps.SERVICE;
    this.maxStepReached = BookingSteps.SERVICE;
    /**
     * Пояс клиента определяется один раз за сессию (T-03) и доступен только
     * через геттер clientTimeZone. Отдельного «зеркального» поля нет: до аудита
     * здесь жили два имени одного бизнес-поля (clientTimeZone / clientTimezone),
     * и одно из них обнулялось при неудачном merge.
     */
    this._clientTimeZone = null;
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
      const [fromDate, toDate] = [todayStr(), daysFromToday(this.dateRange === 'month' ? 30 : 7)];
      const [slots, blocks, overrides] = await Promise.all([
        supabaseApi.listBookedSlots(psyId, fromDate, toDate).catch(() => []),
        supabaseApi.listBusyBlocks(psyId, fromDate, toDate).catch(() => []),
        supabaseApi.listOverrides(psyId, fromDate, toDate).catch(() => [])
      ]);
      this.remoteBusy = {};
      // SR-003: сервер отдаёт длительность чужой записи — без неё при шаге сетки
      // 30 мин 90-минутная запись закрывала бы только один слот
      (slots || []).forEach(s => {
        (this.remoteBusy[s.session_date] ||= {})[s.session_time] = Number(s.duration_min) || null;
      });
      this.remoteBlocks = (blocks || []).map(b => ({
        dateFrom: b.date_from,
        dateTo: b.date_to || b.date_from,
        timeFrom: b.time_from || '',
        timeTo: b.time_to || '',
        kind: b.kind || 'busy',
        title: b.title || ''
      }));
      this.remoteOverrides = (overrides || []).map(o => ({
        date: o.date,
        isClosed: !!o.is_closed,
        openFrom: o.open_from || '',
        openTo: o.open_to || '',
        title: o.title || ''
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
    this.slotPsychDate = null;
    this.slotPsychTime = null;
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

  /**
   * Длительность кандидата для сетки — через канонический резолвер
   * (услуга → шаг сетки → дефолт + серверный кламп 480). Раньше геттер
   * дублировал часть резолвера (услуга → 60) и расходился с сервером
   * при пустой длительности услуги + шаге ≠ 60 и при длительности > 480.
   */
  get durationMinutes() {
    return resolveCandidateDurationMinutes({
      service: this.selectedService,
      slotStepMin: this.slotStepMinutes
    });
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
      const diff = timeToMinutes(t[1]) - timeToMinutes(t[0]);
      if (diff > 0) return diff;
    }
    return 60;
  }

  /** Конец рабочего окна (минуты от полуночи) — дальше слот не начинается. */
  get dayWindowEndMinutes() {
    const t = this.slotTimes;
    const last = timeToMinutes(t[t.length - 1]);
    const stepEnd = last + this.slotStepMinutes;
    const cfgEnd = this.settings?.slotEnd ? timeToMinutes(this.settings.slotEnd) : NaN;
    return Number.isFinite(cfgEnd) ? Math.max(stepEnd, cfgEnd) : stepEnd;
  }

  get dayWindowLabel() {
    return `${minutesToTime(timeToMinutes(this.slotTimes[0]))}–${minutesToTime(this.dayWindowEndMinutes)}`;
  }

  /** Часы приёма в человеческом виде («Пн–Пт 10:00–19:00»). */
  get workHoursLabel() {
    return this.settings?.workHours || '';
  }

  /**
   * Занятые интервалы на дату (минуты в поясе специалиста): локальные сессии,
   * холды, ожидающие переноса, серверный free/busy (public_booked_slots) и
   * блокировки (выходной/отпуск/Google Calendar).
   * Формат — объекты { from, to, kind, title }: `_slotsFor` берёт из них и
   * пересечение, и подпись причины («Время занято», название блокировки).
   */
  _busyIntervalsFor(date) {
    const intervals = [];
    const fallback = this.slotStepMinutes;
    const add = (time, duration, kind = 'booked', title = 'Время занято') => {
      const from = timeToMinutes(time);
      if (from == null) return;
      const span = Math.max(1, Number(duration) || fallback);
      intervals.push({ from, to: from + span, kind, title });
    };

    // серверный free/busy: длительность приходит из public_booked_slots (SR-003)
    Object.entries(this.remoteBusy[date] || {}).forEach(([time, durationMin]) => {
      add(time, resolveDurationMinutes({ durationMin, slotStepMin: fallback }));
    });

    // локальные записи: подтверждённые/ожидающие + холды без истечения срока
    db.sessions.forEach(s => {
      if (s.psychologistId !== this.psychologist?.id) return;
      if (['cancelled', 'expired', 'no_show'].includes(s.status)) return;
      if (s.status === 'held' && s.holdExpiresAt && new Date(s.holdExpiresAt) < new Date()) return;
      const duration = this._bookingDurationAt(s.date, s.time);
      if (s.date === date) add(s.time, duration);
      if (s.pendingChange && s.changeConsentStatus === 'pending' && s.pendingChange.date === date) {
        add(s.pendingChange.time, duration);
      }
    });

    // блокировки занятости: выходной/отпуск/импорт календаря
    const blocks = [...db.blocksOf(this.psychologist?.id), ...this.remoteBlocks];
    for (const b of blocks) {
      const from = b.dateFrom || '';
      const to = b.dateTo || b.dateFrom || '';
      if (!from || date < from || date > to) continue;
      if (!b.timeFrom && !b.timeTo) {
        intervals.push({ from: 0, to: DAY_MINUTES, kind: 'block', title: b.title || 'Закрыто' });
      } else {
        const f = timeToMinutes(b.timeFrom || '00:00');
        const t = timeToMinutes(b.timeTo || '23:59');
        if (t > f) intervals.push({ from: f, to: t, kind: 'block', title: b.title || 'Закрыто' });
      }
    }
    return intervals;
  }

  /**
   * Длительность чужой записи — через канонический резолвер
   * (js/domain/duration.js): снимок в записи → услуга → шаг сетки → дефолт.
   */
  _bookingDurationAt(date, time) {
    const psyId = this.psychologist?.id;
    const s = db.sessions.find(x =>
      x.psychologistId === psyId && x.date === date && x.time === time && x.isSlotBlocking);
    const svc = s ? db.services.find(sv => sv.id === s.serviceId) : null;
    return resolveDurationMinutes({
      durationMin: s?.durationMin,
      service: svc,
      slotStepMin: this.slotStepMinutes
    });
  }

  /**
   * Слоты на дату — через канонический D1 engine (js/domain/availability.js).
   * ViewModel только собирает входы (расписание + политика + занятость) и
   * дорисовывает подпись в поясе клиента (T-03). Собственной логики
   * доступности здесь нет: решение принимает engine, сервер перепроверяет.
   */
  _slotsFor(date) {
    paymentService.expireStaleHolds(this.psychologist?.id);
    const dur = this.durationMinutes;
    const psyTz = this.psychologistTimeZone;
    const foreign = this.isForeignTimeZone;
    const settings = this.settings || {};
    const now = new Date();
    const psyToday = (instantToZoned(now, psyTz) || {}).date || todayStr();
    const result = computeBookableSlots({
      date,
      durationMin: dur,
      schedule: {
        workDays: settings.workDays || [1, 2, 3, 4, 5],
        slotStart: settings.slotStart || '10:00',
        slotEnd: settings.slotEnd || '18:00',
        slotTimes: Array.isArray(settings.slotTimes) && settings.slotTimes.length
          ? settings.slotTimes
          : null,
        stepMin: this.slotStepMinutes,
        timezone: psyTz
      },
      policy: {
        minNoticeMinutes: settings.minNoticeMinutes ?? 0,
        maxAdvanceDays: settings.maxAdvanceDays ?? null,
        bufferBeforeMin: settings.bufferBeforeMin ?? 0,
        bufferAfterMin: settings.bufferAfterMin ?? 0,
        slotIncrementMin: settings.slotIncrementMin ?? null,
        maxBookingsPerDay: settings.maxBookingsPerDay ?? null,
        maxBookingsPerWeek: settings.maxBookingsPerWeek ?? null
      },
      serviceAvailability: this.selectedService?.availability || null,
      overrides: [...db.overridesOf(this.psychologist?.id), ...this.remoteOverrides],
      busy: this._busyIntervalsFor(date),
      counts: { day: this._bookedCountOn(date), week: this._bookedCountInWeek(date) },
      clock: {
        nowMs: now.getTime(),
        today: psyToday,
        slotMs: (d, t) => {
          const z = zonedToInstant(d, t, psyTz);
          return z ? z.getTime() : null;
        }
      }
    });

    return result.slots.map(s => {
      const start = timeToMinutes(s.time);
      const end = start + dur;
      const client = foreign ? convertWallClock(date, s.time, psyTz, this.clientTimeZone) : null;
      return {
        time: s.time,
        endTime: minutesToTime(end),
        available: s.available,
        busy: !s.available,
        reason: s.reason || '',
        code: s.code,
        // T-03: то же мгновение в поясе клиента
        clientTime: client ? client.time : s.time,
        clientEndTime: client ? minutesToTime(timeToMinutes(client.time) + dur) : minutesToTime(end),
        clientDate: client ? client.date : date,
        clientDayShift: client ? client.dayShift : 0
      };
    });
  }

  /**
   * Занятых мест на дату (для дневного лимита D1): объединение локальных
   * блокирующих сессий и серверного free/busy по времени старта.
   * Advisory-оценка: сервер считает авторитетно и может отклонить.
   */
  _bookedCountOn(date) {
    const psyId = this.psychologist?.id;
    const times = new Set(Object.keys(this.remoteBusy[date] || {}));
    db.sessions.forEach(s => {
      if (s.psychologistId !== psyId || s.date !== date) return;
      if (['cancelled', 'expired', 'no_show'].includes(s.status)) return;
      if (s.status === 'held' && s.holdExpiresAt && new Date(s.holdExpiresAt) < new Date()) return;
      times.add(s.time);
    });
    return times.size;
  }

  /** Занятых мест в ISO-неделе даты (для недельного лимита D1). */
  _bookedCountInWeek(date) {
    const monday = isoWeekStartOf(date);
    if (!monday) return 0;
    let n = 0;
    for (let i = 0; i < 7; i++) n += this._bookedCountOn(addDaysIso(monday, i));
    return n;
  }

  /** Эффективные рабочие дни: услуга может сузить дни настроек (D1). */
  get effectiveWorkDays() {
    const svcDays = this.selectedService?.availability?.days;
    if (Array.isArray(svcDays) && svcDays.length) return svcDays.map(Number);
    return this.settings?.workDays || [1, 2, 3, 4, 5];
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
    const workDays = this.effectiveWorkDays;
    const horizon = this.settings?.maxAdvanceDays;
    const total = horizon === null || horizon === undefined ? days : Math.min(days, horizon + 1);
    let count = 0;
    for (let i = 0; i < total; i++) {
      const date = daysFromToday(i);
      if (!workDays.includes(weekdayOf(date))) continue;
      count += this.freeCountOnDate(date);
    }
    return count;
  }

  // ==========================================================================
  // T-03 — часовой пояс клиента
  // ==========================================================================

  get clientTimeZone() {
    if (!this._clientTimeZone) this._clientTimeZone = browserZone();
    return this._clientTimeZone;
  }

  get psychologistTimeZone() {
    return this.settings?.timezone || DEFAULT_TIMEZONE;
  }

  /** Момент выбранного слота (или «сейчас», если слот ещё не выбран). */
  get referenceInstant() {
    if (this.date && this.time) {
      const inst = zonedToInstant(this.date, this.time, this.psychologistTimeZone);
      if (!Number.isNaN(inst.getTime())) return inst;
    }
    return new Date();
  }

  get psychologistUtcOffsetMinutes() {
    return offsetMinutes(this.referenceInstant, this.psychologistTimeZone);
  }

  get clientUtcOffsetAtSlot() {
    return offsetMinutes(this.referenceInstant, this.clientTimeZone);
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

  get timezoneLabel() {
    return `Время в вашем поясе (${this.clientTimeZone}). Часовой пояс специалиста: ${this.psychologistTimeZone}.`;
  }

  get selectedClientDate() {
    const date = this.slotPsychDate || this.date;
    const time = this.slotPsychTime || this.time;
    const instant = date && time ? zonedToInstant(date, time, this.psychologistTimeZone) : null;
    return instant ? (instantToZoned(instant, this.clientTimeZone)?.date || date) : date;
  }

  get selectedClientSlotText() {
    const date = this.slotPsychDate || this.date;
    const time = this.slotPsychTime || this.time;
    if (!time) return '';
    const instant = date ? zonedToInstant(date, time, this.psychologistTimeZone) : null;
    const local = instant ? instantToZoned(instant, this.clientTimeZone) : null;
    return `${local?.date || this.selectedClientDate} в ${local?.time || this.time}`;
  }

  /** Current offset for the selected appointment, useful for SR-001/API payloads. */
  get clientTimezoneOffsetMin() {
    const date = this.slotPsychDate || this.date;
    const time = this.slotPsychTime || this.time;
    const instant = date && time ? zonedToInstant(date, time, this.psychologistTimeZone) : new Date();
    return instant ? offsetMinutes(instant, this.clientTimeZone) : 0;
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
    const workDays = this.effectiveWorkDays; // ISO: 1=Пн … 7=Вс
    const horizon = this.settings?.maxAdvanceDays;
    const total = horizon === null || horizon === undefined ? opt.days : Math.min(opt.days, horizon + 1);
    return Array.from({ length: total }, (_, i) => daysFromToday(i))
      .filter(iso => workDays.includes(weekdayOf(iso)));
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
    if (b) return b.title || 'Закрыто';
    // D1: закрытый день через override
    const o = db.overrideOn(this.psychologist?.id, date)
      || this.remoteOverrides.find(x => x.date === date);
    if (o?.isClosed) return o.title || 'Закрыто';
    return null;
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
      endTime: this.time ? minutesToTime(timeToMinutes(this.time) + this.durationMinutes) : null,
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

  /**
   * Демо-кнопка на публичной странице — не эквайринг и не server-ack (#21 п.4).
   * Когда запись уже на сервере (Supabase настроен), «оплата прошла» было бы
   * ложным успехом: меняется только localStorage, RPC/payments не вызываются.
   * Локальный демо-контур без сервера может подтверждать запись в этом браузере.
   */
  get demoPayIsLocalOnly() {
    return !supabaseSync.enabled();
  }

  /**
   * Единственный источник копирайта панели оплаты: UI не решает сам,
   * показывать ли демо-кнопки, которые притворяются эквайрингом.
   */
  get paymentCheckout() {
    if (!this.awaitingPayment) return { visible: false, allowDemoPay: false };
    const due = this.paymentInfo?.amountDueNow ?? this.paymentInfo?.amountDue ?? 0;
    const currency = this.paymentInfo?.currency || 'BYN';
    const dueLabel = paymentService.formatAmount(due, currency);
    if (this.demoPayIsLocalOnly) {
      return {
        visible: true,
        mode: 'local-demo',
        title: 'Подтверждение оплаты (демо)',
        lead: this.successText,
        dueLabel,
        allowDemoPay: true,
        footnote: 'Демо: оплата сохраняется только в этом браузере. На сервер она не уходит.'
      };
    }
    return {
      visible: true,
      mode: 'server-hold',
      title: 'Ожидание оплаты',
      lead: this.successText,
      dueLabel,
      allowDemoPay: false,
      footnote: 'Оплата на сайте не проводится. Переведите сумму по реквизитам психолога — он подтвердит запись в кабинете. Неоплаченный резерв снимается автоматически.'
    };
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
    // сетка слотов в поясе специалиста: слот должен быть свободен на момент отправки
    const selectedSlot = this._slotsFor(selectedPsychDate)
      .find(slot => slot.time === selectedPsychTime);
    if (!selectedSlot || !selectedSlot.available) {
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
    // T-25: фиксируем факт согласия на момент отправки (152-ФЗ-подобные требования)
    const consentAt = new Date().toISOString();
    if (!client) {
      client = await clientVaultService.saveClientFromPublicBooking(this.psychologist.id, {
        name: this.nickname,
        nickname: this.nickname,
        phone,
        contact: this.contact.trim() || phone,
        note: this.note.trim(),
        trustLevel: check.riskLevel === 'high' ? 'caution' : 'new',
        consent: true,
        consentAt
      });
    } else {
      client.consent = true;
      client.consentAt = client.consentAt || consentAt;
    }

    const isOnline = svc?.format === 'online';
    const payFields = paymentService.buildSessionPaymentFields(this.psychologist.id, svc);

    // T-03 / SR-001: канонический контракт пояса клиента. Пояс (IANA) и снимок
    // его смещения пишутся ОТДЕЛЬНЫМИ полями записи — раньше пояс дописывался
    // строкой в sessions.note, а поле timezoneOffset вообще не заполнялось.
    const clientTimezone = this.isForeignTimeZone ? this.clientTimeZone : '';
    const clientUtcOffsetMin = this.isForeignTimeZone ? this.clientUtcOffsetAtSlot : null;
    // снимок длительности услуги: если услугу позже изменят, запись не «поедет».
    // Кандидатный резолвер с серверным клампом — иначе локальный снимок
    // расходился бы с duration_min, который сервер выведет сам (p_duration_min игнорируется).
    const durationMin = resolveCandidateDurationMinutes({ service: svc, slotStepMin: this.slotStepMinutes });

    const session = db.addSession({
      psychologistId: this.psychologist.id,
      clientId: client.id,
      serviceId: this.serviceId,
      // в БД — «настенное» время специалиста; пояс клиента — отдельными полями
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
      requiresPayment: payFields.requiresPayment,
      clientTimezone,
      clientUtcOffsetMin,
      durationMin
    });

    // ============================================================
    // Серверная транзакция — ОБЯЗАТЕЛЬНЫЙ шаг до показа успеха.
    //
    // До аудита AUDIT-REG-DRY-001 порядок был обратным: сначала navigate('success')
    // и successText, потом fire-and-forget pushBooking, а отказ сервера уходил
    // только в console.warn. Клиент видел «заявка отправлена» даже когда запись
    // в БД не появилась. Теперь: validate → server transaction → persist →
    // и только потом success.
    // ============================================================
    const persisted = await this._persistBooking(session, client);
    if (!persisted.ok) {
      // откатываем локальную запись: иначе слот останется «занятым» в зеркале,
      // а на сервере записи нет
      db.removeSession(session.id);
      this.error = persisted.message;
      this._setWizardError(persisted.message);
      this.notify();
      return false;
    }
    if (persisted.sessionId) session.id = persisted.sessionId;
    if (persisted.clientId) session.clientId = persisted.clientId;
    if (persisted.durationMin) session.durationMin = persisted.durationMin;
    this.createdSessionId = session.id;

    fraudProtectionService.logAttempt({
      psychologistId: this.psychologist.id,
      phone,
      success: true,
      reason: 'created',
      consent: true,
      consentAt
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

  /**
   * Отправить запись на сервер и дождаться подтверждения транзакции.
   * Единственный путь записи — RPC create_booking (security definer): сервер
   * повторно проверяет занятость и анти-спам, поэтому клиентская проверка
   * доступности выше — это UX, а не гарантия.
   *
   * @returns {Promise<{ok: boolean, message?: string, sessionId?: string, clientId?: string, durationMin?: number|null, localOnly?: boolean}>}
   */
  async _persistBooking(session, client) {
    if (!supabaseSync.enabled()) {
      // Supabase не настроен — это не production-запись, и говорим об этом прямо
      return {
        ok: true,
        localOnly: true,
        message: 'Запись сохранена только в этом браузере: сервер БД не настроен'
      };
    }
    try {
      const res = await supabaseSync.pushBooking({
        psychologistId: session.psychologistId,
        client,
        session
      });
      if (!res.ok) {
        return { ok: false, message: res.message || 'Сервер не принял запись. Попробуйте другое время.' };
      }
      return {
        ok: true,
        sessionId: res.sessionId || null,
        clientId: res.clientId || null,
        durationMin: res.durationMin ?? null
      };
    } catch (ex) {
      return { ok: false, message: `Сервер недоступен, запись не создана: ${ex?.message || ex}` };
    }
  }

  /**
   * Демо-оплата / «чек» на публичной странице.
   *
   * Канон #21 п.4: либо реальный server-ack, либо честный local-only UX.
   * Эквайринга нет — поэтому при живом Supabase метод отказывается подтверждать
   * запись и не шлёт «Оплата прошла (сайт)» в Telegram. Poka-Yoke: даже если
   * в разметке останется data-pay-demo, ложного успеха не будет.
   */
  completePayment(method = 'card_demo') {
    if (!this.createdSessionId) {
      this.error = 'Нет сессии для оплаты';
      this.notify();
      return false;
    }
    if (!this.demoPayIsLocalOnly) {
      this.error = 'Демо-оплата не записывается на сервер. Оплатите по реквизитам психолога — он подтвердит запись в кабинете.';
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
    this.successText = `${this.nickname || this.name}, демо-оплата сохранена только в этом браузере. ${res.message} Запись: ${formatDay(this.date)} в ${this.selectionSlotText || this.time}.`;
    this.showToast(res.message);
    this.notify();
    return true;
  }
}
