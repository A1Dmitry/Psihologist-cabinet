/**
 * SessionSeriesService — регулярные сессии («каждый вторник в 15:00»).
 *
 * Модель (T-05):
 *   SessionSeries { id, psychologistId, clientId, serviceId, weekday, time,
 *                   intervalWeeks, dateFrom, dateTo, paused, horizonWeeks }
 *
 * Поведение:
 *  - создание серии генерирует конкретные сессии на горизонт (по умолчанию 8 недель);
 *  - пауза убирает будущие сгенерированные встречи (слоты освобождаются),
 *    возобновление — генерирует их заново;
 *  - перенос серии сдвигает weekday/time и перегенерирует будущее (T-06);
 *  - порождённые сессии — обычные sessions, поэтому попадают в книгу записей,
 *    напоминания, уведомления и статистику без отдельной ветки кода.
 *
 * Хранение: серверная таблица session_series (заявка SR-101) + локальное зеркало
 * в localStorage. Если таблица ещё не применена в БД — сервис прозрачно работает
 * локально и сообщает об этом флагом serverState, чтобы кабинет объяснил это
 * человеческим языком (а не молча терял данные).
 */
import { db } from '../core/dbContext.js';
import { supabaseApi } from './supabaseApi.js';
import { cabinetApi } from './cabinetApi.js';
import { reminderService } from './reminderService.js';
import { telegramService } from './telegramService.js';
import {
  addDaysStr, todayStr, weekdayOf, weekdayTimeLabel, WEEKDAY_NAMES_SHORT, DEFAULT_TIMEZONE
} from './timezoneService.js';

const STORAGE_KEY = 'psy_session_series_v1';
const DEFAULT_HORIZON_WEEKS = 8;

/* ——— безопасное локальное хранилище (как в dbContext: sandbox-safe) ——— */
const memory = Object.create(null);
function storeGet(key) {
  try {
    const ls = window.localStorage;
    const v = ls.getItem(key);
    return v ?? memory[key] ?? null;
  } catch {
    return memory[key] ?? null;
  }
}
function storeSet(key, value) {
  memory[key] = value;
  try { window.localStorage.setItem(key, value); } catch { /* offline/приватный режим */ }
}

function uid(prefix = 'ser') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionSeries {
  constructor({
    id = null,
    psychologistId = null,
    clientId = null,
    serviceId = null,
    weekday = 1,
    time = '10:00',
    intervalWeeks = 1,
    dateFrom = '',
    dateTo = '',
    paused = false,
    horizonWeeks = DEFAULT_HORIZON_WEEKS,
    note = '',
    clientTimezone = '',
    createdAt = null,
    updatedAt = null
  } = {}) {
    this.id = id || uid();
    this.psychologistId = psychologistId;
    this.clientId = clientId;
    this.serviceId = serviceId || null;
    this.weekday = Number(weekday) >= 1 && Number(weekday) <= 7 ? Number(weekday) : 1;
    this.time = String(time || '10:00').slice(0, 5);
    this.intervalWeeks = Math.min(8, Math.max(1, Number(intervalWeeks) || 1));
    this.dateFrom = dateFrom || todayStr();
    this.dateTo = dateTo || '';
    this.paused = !!paused;
    this.horizonWeeks = Math.min(104, Math.max(1, Number(horizonWeeks) || DEFAULT_HORIZON_WEEKS));
    this.note = note || '';
    this.clientTimezone = clientTimezone || '';
    this.createdAt = createdAt || new Date().toISOString();
    this.updatedAt = updatedAt || this.createdAt;
  }

  /** «Пн 15:00 · каждую неделю · с 01.10» */
  label() {
    const every = this.intervalWeeks === 1 ? 'каждую неделю'
      : this.intervalWeeks === 2 ? 'раз в 2 недели'
        : `раз в ${this.intervalWeeks} нед.`;
    const until = this.dateTo ? ` до ${this.dateTo}` : '';
    return `${WEEKDAY_NAMES_SHORT[this.weekday]} ${this.time} · ${every} · с ${this.dateFrom}${until}`;
  }

  coversDate(date) {
    if (!date) return false;
    if (date < this.dateFrom) return false;
    if (this.dateTo && date > this.dateTo) return false;
    if (weekdayOf(date) !== this.weekday) return false;
    // соблюдаем интервал: от первой подходящей даты
    const first = firstMatchingDate(this.dateFrom, this.weekday);
    const diffDays = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86400000);
    if (diffDays < 0) return false;
    return diffDays % (this.intervalWeeks * 7) === 0;
  }
}

/** Ближайшая дата >= from с нужным днём недели */
export function firstMatchingDate(from, weekday) {
  let d = from || todayStr();
  for (let i = 0; i < 7; i++) {
    if (weekdayOf(d) === Number(weekday)) return d;
    d = addDaysStr(d, 1);
  }
  return from;
}

/** Список дат серии в горизонте планирования */
export function seriesDates(series, { from = null, horizonWeeks = null } = {}) {
  const weeks = horizonWeeks || series.horizonWeeks || DEFAULT_HORIZON_WEEKS;
  const start = from || series.dateFrom;
  const horizonEnd = addDaysStr(todayStr(), weeks * 7);
  const hardEnd = series.dateTo && series.dateTo < horizonEnd ? series.dateTo : horizonEnd;
  if (start > hardEnd) return [];
  let d = firstMatchingDate(start, series.weekday);
  const out = [];
  let guard = 0;
  while (d <= hardEnd && guard++ < 400) {
    if (d >= start && series.coversDate(d)) out.push(d);
    d = addDaysStr(d, 7);
  }
  return out;
}

export class SessionSeriesService {
  constructor() {
    this._cache = [];
    this._loadedFor = null;
    /** состояние серверной синхронизации: null=не проверяли, true/false */
    this.serverState = { series: null, sessionsSeriesId: null };
  }

  // ——— чтение ———

  /** Все серии психолога (из локального зеркала) */
  list(psychologistId) {
    if (!psychologistId) return [];
    return this._cache
      .filter(s => s.psychologistId === psychologistId)
      .sort((a, b) => (a.weekday - b.weekday) || a.time.localeCompare(b.time));
  }

  get(id) {
    return this._cache.find(s => s.id === id) || null;
  }

  /** Серия, к которой относится сессия (или null) */
  seriesForSession(session) {
    if (!session) return null;
    const explicit = session.seriesId ? this.get(session.seriesId) : null;
    if (explicit) return explicit;
    return this.list(session.psychologistId).find(sr =>
      sr.clientId === session.clientId &&
      (!sr.serviceId || !session.serviceId || sr.serviceId === session.serviceId) &&
      sr.time === session.time &&
      sr.coversDate(session.date)
    ) || null;
  }

  /** Будущие сессии серии (не отменённые) */
  sessionsOfSeries(series, { includePast = false } = {}) {
    if (!series) return [];
    const today = todayStr();
    return db.sessions
      .filter(s => s.psychologistId === series.psychologistId)
      .filter(s => (s.seriesId === series.id) || (
        s.clientId === series.clientId &&
        (!series.serviceId || !s.serviceId || s.serviceId === series.serviceId) &&
        series.coversDate(s.date) &&
        s.time === series.time
      ))
      .filter(s => !['cancelled'].includes(s.status))
      .filter(s => includePast || s.date >= today)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }

  /** Сколько встреч впереди по серии */
  upcomingCount(series) {
    return this.sessionsOfSeries(series).length;
  }

  // ——— запись ———

  /**
   * Создать серию и сгенерировать встречи.
   * @returns {{ok: boolean, series?: SessionSeries, created?: number, skipped?: Array, message?: string}}
   */
  create(psychologistId, data = {}) {
    const error = this.validate(data);
    if (error) return { ok: false, message: error };
    if (!psychologistId) return { ok: false, message: 'Нет кабинета' };

    const dateFrom = data.dateFrom && data.dateFrom >= todayStr() ? data.dateFrom : todayStr();
    const series = new SessionSeries({
      ...data,
      psychologistId,
      dateFrom,
      horizonWeeks: data.horizonWeeks || DEFAULT_HORIZON_WEEKS
    });
    this._cache.push(series);
    this._persistLocal();
    this._pushToServer(series);

    const gen = this.generateSessions(series);
    this._notifyClient(series, 'created');
    return { ok: true, series, ...gen };
  }

  /**
   * Сгенерировать встречи серии на горизонт (идемпотентно: занятые/существующие пропускаются).
   * @returns {{created: number, skipped: Array<{date: string, reason: string}>}}
   */
  generateSessions(series, { from = null, notify = false } = {}) {
    if (!series || series.paused) return { created: 0, skipped: [] };
    const dates = seriesDates(series, { from });
    const client = db.clients.find(c => c.id === series.clientId);
    const service = series.serviceId ? db.services.find(s => s.id === series.serviceId) : null;
    const settings = db.settingsOf(series.psychologistId);
    const conditions = client?._conditions || defaultConditions(service, settings);
    const skipped = [];
    let created = 0;

    for (const date of dates) {
      const taken = db.sessions.find(s =>
        s.psychologistId === series.psychologistId &&
        s.date === date &&
        s.time === series.time &&
        !['cancelled', 'expired', 'no_show'].includes(s.status)
      );
      if (taken) {
        skipped.push({ date, reason: taken.clientId === series.clientId ? 'уже в расписании' : 'слот занят' });
        continue;
      }
      if (db.isSlotBlocked(series.psychologistId, date, series.time)) {
        skipped.push({ date, reason: 'в это время блокировка занятости' });
        continue;
      }
      const session = db.addSession({
        psychologistId: series.psychologistId,
        clientId: series.clientId,
        serviceId: series.serviceId,
        date,
        time: series.time,
        status: 'confirmed',
        note: series.note ? `Постоянное время: ${series.note}` : 'Постоянное время (серия)',
        videoPlatform: conditions.videoPlatform || '',
        meetLink: conditions.meetLink || '',
        currency: conditions.currency || 'BYN',
        amountDue: Number(conditions.price ?? 0) || 0,
        paymentPolicy: conditions.paymentPolicy || undefined
      });
      // связь с серией: локально свойство, на сервере — sessions.series_id (SR-102)
      session.seriesId = series.id;
      session.seriesLabel = series.label();
      if (series.clientTimezone) session.clientTimezone = series.clientTimezone;
      session.conditionsApplied = true;
      if (!conditions.paymentPolicy) delete session.paymentPolicy;
      cabinetApi.pushSession(series.psychologistId, session);
      try { reminderService.scheduleForSession(session.id); } catch { /* напоминания не критичны */ }
      created++;
    }
    db.saveChanges();
    if (created && notify) this._notifyClient(series, 'generated');
    return { created, skipped };
  }

  /** Перенос всей серии: новый день недели/время, перегенерация будущих (T-06) */
  reschedule(id, { weekday, time, dateFrom, intervalWeeks, horizonWeeks, reason = '' } = {}) {
    const series = this.get(id);
    if (!series) return { ok: false, message: 'Серия не найдена' };

    const removed = this.removeFutureSessions(series);
    if (weekday != null) series.weekday = Number(weekday);
    if (time) series.time = String(time).slice(0, 5);
    if (intervalWeeks != null) series.intervalWeeks = Math.min(8, Math.max(1, Number(intervalWeeks) || 1));
    if (horizonWeeks != null) series.horizonWeeks = Math.min(104, Math.max(1, Number(horizonWeeks) || DEFAULT_HORIZON_WEEKS));
    if (dateFrom && dateFrom >= todayStr()) series.dateFrom = dateFrom;
    series.updatedAt = new Date().toISOString();
    this._persistLocal();
    this._pushToServer(series);

    const gen = this.generateSessions(series, { from: todayStr() });
    this._notifyClient(series, 'rescheduled', reason);
    return { ok: true, series, removed: removed.removed, created: gen.created, skipped: gen.skipped };
  }

  /** Пауза серии: будущие встречи убираются, слоты освобождаются (T-07) */
  pause(id, { reason = 'пауза' } = {}) {
    const series = this.get(id);
    if (!series) return { ok: false, message: 'Серия не найдена' };
    const removed = this.removeFutureSessions(series, reason);
    series.paused = true;
    series.updatedAt = new Date().toISOString();
    this._persistLocal();
    this._pushToServer(series);
    this._notifyClient(series, 'paused');
    return { ok: true, series, removed: removed.removed };
  }

  /** Возобновление серии: встречи генерируются заново с сегодняшнего дня */
  resume(id) {
    const series = this.get(id);
    if (!series) return { ok: false, message: 'Серия не найдена' };
    series.paused = false;
    series.dateFrom = series.dateFrom < todayStr() ? todayStr() : series.dateFrom;
    series.updatedAt = new Date().toISOString();
    this._persistLocal();
    this._pushToServer(series);
    const gen = this.generateSessions(series, { from: todayStr() });
    this._notifyClient(series, 'resumed');
    return { ok: true, series, created: gen.created, skipped: gen.skipped };
  }

  remove(id) {
    const series = this.get(id);
    if (!series) return { ok: false, message: 'Серия не найдена' };
    const removed = this.removeFutureSessions(series, 'серия удалена');
    this._cache = this._cache.filter(s => s.id !== id);
    this._persistLocal();
    if (this.serverState.series !== false) {
      this._req(`session_series?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' })
        .catch(() => { /* нет таблицы — локальный режим */ });
    }
    return { ok: true, removed: removed.removed };
  }

  /**
   * Убрать будущие сгенерированные встречи серии.
   * Неоплаченные и неизменённые — удаляются (слот свободен и не мусорит в журнале),
   * с оплатой/переносом — отменяются с пояснением, чтобы не потерять деньги.
   */
  removeFutureSessions(series, reason = '') {
    const list = this.sessionsOfSeries(series);
    let removed = 0;
    for (const s of list) {
      const untouched = ['pending', 'confirmed'].includes(s.status) && !s.amountPaid && !s.pendingChange;
      if (untouched) {
        db.removeSession(s.id);
        cabinetApi.pushSessionDelete(s.id);
      } else {
        s.status = 'cancelled';
        s.note = (s.note ? s.note + '\n' : '') + `Серия: ${reason || 'встреча снята'}`;
        db.saveChanges();
        cabinetApi.pushSessionPatch(s.id, { status: 'cancelled', note: s.note });
      }
      removed++;
    }
    return { removed };
  }

  /** Проверка полей перед созданием серии */
  validate(data = {}) {
    if (!data.clientId) return 'Выберите клиента';
    if (!data.time || !/^\d{2}:\d{2}$/.test(String(data.time))) return 'Укажите время (ЧЧ:ММ)';
    const wd = Number(data.weekday);
    if (!(wd >= 1 && wd <= 7)) return 'Выберите день недели';
    if (data.dateTo && data.dateFrom && data.dateTo < data.dateFrom) return 'Дата «по» раньше даты «с»';
    return '';
  }

  // ——— синхронизация ———

  /**
   * Загрузить серии с сервера (один раз на вход). Ошибка/отсутствие таблицы
   * не ломает кабинет: остаёмся на локальном зеркале.
   */
  async pull(psychologistId, { force = false } = {}) {
    if (!psychologistId) return { ok: false, reason: 'no-psy' };
    this._loadLocal();
    if (this._loadedFor === psychologistId && !force) return { ok: true, cached: true };
    this._loadedFor = psychologistId;
    if (!supabaseApi.hasSession()) return { ok: true, localOnly: true };

    try {
      const rows = await this._req(
        `session_series?psychologist_id=eq.${encodeURIComponent(psychologistId)}&select=*&order=created_at.asc`
      );
      this.serverState.series = true;
      const serverIds = new Set(rows.map(r => r.id));
      // серверные записи побеждают локальные копии
      this._cache = this._cache.filter(s => s.psychologistId !== psychologistId || serverIds.has(s.id));
      for (const row of rows) {
        if (this._cache.some(s => s.id === row.id)) continue;
        this._cache.push(new SessionSeries({
          id: row.id,
          psychologistId: row.psychologist_id,
          clientId: row.client_id,
          serviceId: row.service_id,
          weekday: row.weekday,
          time: row.slot_time || row.time,
          intervalWeeks: row.interval_weeks,
          dateFrom: row.date_from,
          dateTo: row.date_to || '',
          paused: row.paused,
          horizonWeeks: row.horizon_weeks,
          note: row.note || '',
          clientTimezone: row.client_timezone || '',
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
      }
      // то, что создано локально до применения миграции, досылаем наверх
      for (const s of this.list(psychologistId)) {
        if (!serverIds.has(s.id)) this._pushToServer(s);
      }
      this._persistLocal();
      return { ok: true, count: rows.length };
    } catch (e) {
      this.serverState.series = false;
      return { ok: true, localOnly: true, message: String(e?.message || e) };
    }
  }

  /** Пояснение для UI, почему часть данных только локальная */
  serverHint() {
    if (this.serverState.series === false) {
      return 'Серии пока хранятся в этом браузере: серверная таблица session_series ещё не применена (заявка SR-101). Расписание и напоминания работают как обычно.';
    }
    return '';
  }

  _pushToServer(series) {
    if (!supabaseApi.hasSession() || this.serverState.series === false) return;
    const body = {
      id: series.id,
      psychologist_id: series.psychologistId,
      client_id: series.clientId,
      service_id: series.serviceId || null,
      weekday: series.weekday,
      slot_time: series.time,
      interval_weeks: series.intervalWeeks,
      date_from: series.dateFrom,
      date_to: series.dateTo || '',
      paused: !!series.paused,
      horizon_weeks: series.horizonWeeks,
      note: series.note || '',
      updated_at: new Date().toISOString()
    };
    this._req('session_series?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(body)
    }).then(() => { this.serverState.series = true; })
      .catch(() => { this.serverState.series = false; });
  }

  _notifyClient(series, kind, reason = '') {
    const client = db.clients.find(c => c.id === series.clientId);
    if (!client?.telegramChat) return; // без подключённого Telegram просто ничего не отправляем
    const when = weekdayTimeLabel(series.weekday, series.time, { full: true });
    const text = {
      created: `📅 Вам назначено постоянное время: ${when}. Встречи созданы на ${series.horizonWeeks} нед. вперёд.`,
      rescheduled: `📅 Постоянное время изменено: теперь ${when}.${reason ? `\nПричина: ${reason}` : ''}`,
      paused: '⏸ Постоянные встречи приостановлены. Возобновим по договорённости.',
      resumed: `▶️ Постоянные встречи возобновлены: ${when}.`,
      generated: `📅 Добавлены новые встречи: ${when}.`
    }[kind];
    if (!text) return;
    telegramService.sendToClient(client, text).catch(() => { /* канал не настроен */ });
  }

  _req(path, options) {
    return supabaseApi.request(path, options);
  }

  // ——— локальное зеркало ———

  _loadLocal() {
    if (this._localLoaded) return;
    this._localLoaded = true;
    try {
      const raw = storeGet(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      const rows = Array.isArray(data?.series) ? data.series : [];
      this._cache = rows.map(r => new SessionSeries(r));
    } catch {
      this._cache = [];
    }
  }

  _persistLocal() {
    this._localLoaded = true;
    try {
      storeSet(STORAGE_KEY, JSON.stringify({ v: 1, series: this._cache }));
    } catch { /* переполнение/приватный режим — не критично */ }
  }

  /** Очистка кэша (выход из кабинета, смена пользователя) */
  reset() {
    this._cache = [];
    this._localLoaded = false;
    this._loadedFor = null;
  }
}

/** Условия клиента по умолчанию (услуга кабинета), если индивидуальных нет */
export function defaultConditions(service, settings) {
  return {
    price: service?.price ?? 0,
    currency: service?.currency || 'BYN',
    paymentMethod: '',
    meetLink: '',
    paymentUrl: service?.payUrl || '',
    videoPlatform: settings?.defaultVideoPlatform || 'google_meet'
  };
}

export const sessionSeriesService = new SessionSeriesService();
export const SERIES_TIMEZONE = DEFAULT_TIMEZONE;
