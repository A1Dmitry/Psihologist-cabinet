/**
 * CabinetApi — кабинет психолога работает ЧЕРЕЗ СЕРВЕР (без заглушек).
 * pull-режим: после входа все данные владельца (clients, sessions, settings,
 * schedule_blocks, tasks, psy_notes, client_entries, waiting_items, services)
 * загружаются из Supabase по RLS-политике владельца.
 * write-through: каждая мутация кабинета сразу уходит в БД
 * (POST/PATCH/DELETE под пользовательским JWT), локально — зеркало для рендера.
 *
 * PII клиентов: серверная строка хранит только привязку (nickname/id);
 * расшифрованные карточки и шифрованные блобы живут в клиентском сейфе
 * (clientVaultService) и на сервер не выгружаются в открытом виде.
 */
import { supabaseApi } from './supabaseApi.js';
import { db } from '../core/dbContext.js';
import { Client, Session, SessionSettings, WaitingItem, ScheduleBlock, Task, PsyNote, ClientEntry } from '../models/entities.js';

const on = () => supabaseApi.hasSession();

/** fire-and-forget запись на сервер */
function push(label, fn) {
  if (!on()) return;
  Promise.resolve()
    .then(fn)
    .catch(e => console.warn(`[CabinetApi] ${label} не записано на сервер:`, e?.message || e));
}

const mapSession = r => new Session({
  id: r.id,
  psychologistId: r.psychologist_id,
  clientId: r.client_id,
  serviceId: r.service_id,
  date: r.session_date,
  time: r.session_time,
  status: r.status || 'pending',
  note: r.note || '',
  videoPlatform: r.video_platform || '',
  meetLink: r.meet_link || '',
  paymentPolicy: r.payment_policy || 'none',
  paymentStatus: r.payment_status || 'unpaid',
  amountDue: Number(r.amount_due) || 0,
  amountPaid: Number(r.amount_paid) || 0,
  currency: r.currency || 'BYN',
  holdExpiresAt: r.hold_expires_at,
  requiresPayment: !!r.requires_payment,
  clientResponse: r.client_response,
  clientRespondedAt: r.client_responded_at,
  googleEventId: r.google_event_id || '',
  pendingChange: r.pending_change || null,
  previousSlot: r.previous_slot || null,
  changeConsentStatus: r.change_consent_status || null,
  createdAt: r.created_at
});

const sessRow = x => ({
  session_date: x.date,
  session_time: x.time,
  status: x.status,
  note: x.note || '',
  video_platform: x.videoPlatform || '',
  meet_link: x.meetLink || '',
  payment_policy: x.paymentPolicy || 'none',
  payment_status: x.paymentStatus || 'unpaid',
  amount_due: x.amountDue || 0,
  amount_paid: x.amountPaid || 0,
  currency: x.currency || 'BYN',
  hold_expires_at: x.holdExpiresAt,
  requires_payment: !!x.requiresPayment,
  client_response: x.clientResponse,
  client_responded_at: x.clientRespondedAt,
  pending_change: x.pendingChange,
  previous_slot: x.previousSlot,
  change_consent_status: x.changeConsentStatus,
  google_event_id: x.googleEventId || ''
});

const blockRow = b => ({
  date_from: b.dateFrom,
  date_to: b.dateTo || b.dateFrom,
  time_from: b.timeFrom || '',
  time_to: b.timeTo || '',
  kind: b.kind || 'busy',
  title: b.title || '',
  note: b.note || '',
  source: b.source || 'manual',
  google_event_id: b.googleEventId || ''
});

const taskRow = t => ({
  title: t.title, details: t.details || '', due_date: t.dueDate || '',
  client_id: t.clientId || null, done: !!t.done
});

const noteRow = n => ({
  title: n.title || '', body: n.body || '', date: n.date || '', pinned: !!n.pinned
});

const entryRow = e => ({
  client_id: e.clientId, session_id: e.sessionId || null, date: e.date, text: e.text || ''
});

export const cabinetApi = {
  enabled: on,

  /** Применить результат pullCabinet к локальному зеркалу (для рендера).
   *  Клиенты: только ДОБАВЛЕНИЕ отсутствующих строк (локальные несут
   *  encryptedPii сейфа — их заменять нельзя). Остальное — замена на серверное. */
  applyPull(psyId, r) {
    if (!r?.ok) return;
    const have = new Set(db.clients.map(c => c.id));
    (r.clients || []).forEach(row => {
      if (have.has(row.id)) return;
      const client = new Client({
        id: row.id, psychologistId: row.psychologist_id, name: row.name || '',
        nickname: row.nickname || '', phone: row.phone || '', contact: row.contact || '',
        note: row.note || '', telegramChat: row.telegram_chat || '',
        consent: !!row.consent, consentAt: row.consent_at || null, // T-25: факт согласия
        createdAt: row.created_at
      });
      // индивидуальные условия (SR-102): серверные значения — fallback для сейфа
      const cond = {};
      if (row.price_override != null) cond.priceOverride = Number(row.price_override);
      if (row.currency) cond.currency = row.currency;
      if (row.payment_method) cond.paymentMethod = row.payment_method;
      if (row.meet_link) cond.meetLink = row.meet_link;
      if (row.payment_url) cond.paymentUrl = row.payment_url;
      client._conditionsServer = cond;
      db.clients.push(client);
    });
    db.sessions = db.sessions.filter(x => x.psychologistId !== psyId)
      .concat((r.sessions || []).map(mapSession));
    db.scheduleBlocks = db.scheduleBlocks.filter(x => x.psychologistId !== psyId)
      .concat((r.blocks || []).map(row => new ScheduleBlock({
        id: row.id, psychologistId: row.psychologist_id,
        dateFrom: row.date_from, dateTo: row.date_to || row.date_from,
        timeFrom: row.time_from || '', timeTo: row.time_to || '',
        kind: row.kind || 'busy', title: row.title || '', note: row.note || '',
        source: row.source || 'manual', googleEventId: row.google_event_id || '', createdAt: row.created_at
      })));
    db.tasks = db.tasks.filter(x => x.psychologistId !== psyId)
      .concat((r.tasks || []).map(row => new Task({
        id: row.id, psychologistId: row.psychologist_id, title: row.title || '',
        details: row.details || '', dueDate: row.due_date || '', clientId: row.client_id || null,
        done: !!row.done, createdAt: row.created_at
      })));
    db.notes = db.notes.filter(x => x.psychologistId !== psyId)
      .concat((r.notes || []).map(row => new PsyNote({
        id: row.id, psychologistId: row.psychologist_id, title: row.title || '',
        body: row.body || '', date: row.date || '', pinned: !!row.pinned, createdAt: row.created_at
      })));
    db.clientEntries = db.clientEntries.filter(x => x.psychologistId !== psyId)
      .concat((r.entries || []).map(row => new ClientEntry({
        id: row.id, psychologistId: row.psychologist_id, clientId: row.client_id,
        sessionId: row.session_id || null, date: row.date || '', text: row.text || '', createdAt: row.created_at
      })));
    db.waitingItems = db.waitingItems.filter(x => x.psychologistId !== psyId)
      .concat((r.waiting || []).map(row => new WaitingItem({
        id: row.id, psychologistId: row.psychologist_id, name: row.name || '',
        phone: row.phone || '', note: row.note || '', createdAt: row.created_at
      })));
    if (r.settings) {
      const prev = db.settings.find(x => x.psychologistId === psyId);
      db.settings = db.settings.filter(x => x.psychologistId !== psyId);
      db.settings.push(new SessionSettings({
        psychologistId: psyId,
        workHours: r.settings.work_hours || 'Пн–Пт 10:00–19:00',
        workDays: r.settings.work_days || [1, 2, 3, 4, 5],
        timezone: r.settings.timezone || 'Europe/Minsk',
        slotTimes: r.settings.slot_times || null,
        slotStart: r.settings.slot_start || '10:00',
        slotEnd: r.settings.slot_end || '18:00',
        slotStepMin: r.settings.slot_step_min || 60,
        defaultVideoPlatform: r.settings.default_video_platform || 'google_meet',
        paymentPolicy: r.settings.payment_policy || 'none',
        depositPercent: Number(r.settings.deposit_percent) || 30,
        holdMinutes: r.settings.hold_minutes || 30,
        googleCalendarIcalUrl: prev?.googleCalendarIcalUrl || '',
        googleSyncBusy: prev ? prev.googleSyncBusy !== false : true,
        telegramBotToken: r.settings.telegram_bot_token ?? prev?.telegramBotToken ?? '',
        telegramChatId: r.settings.telegram_chat_id ?? prev?.telegramChatId ?? '',
        telegramBotName: r.settings.telegram_bot_name ?? prev?.telegramBotName ?? '',
        telegramNotifyBooking: (r.settings.telegram_notify_booking ?? prev?.telegramNotifyBooking ?? true) !== false,
        telegramNotifyReminders: (r.settings.telegram_notify_reminders ?? prev?.telegramNotifyReminders ?? true) !== false,
        telegramNotifyPayments: (r.settings.telegram_notify_payments ?? prev?.telegramNotifyPayments ?? true) !== false,
        lastNotifiedSessionAt: r.settings.last_notified_session_at || prev?.lastNotifiedSessionAt || null
      }));
    }
    db.saveChanges();
  },

  /** Загрузить и применить данные кабинета (вызывается после входа). */
  async refresh(psychologistId) {
    if (!on() || !psychologistId) return false;
    const r = await this.pullCabinet(psychologistId);
    if (r.ok) this.applyPull(psychologistId, r);
    return r.ok;
  },

  /**
   * Полная загрузка данных кабинета с сервера (после входа).
   * Заменяет локальные зеркала данными сервера (кроме vault-блобов клиентов).
   */
  async pullCabinet(psychologistId) {
    if (!on() || !psychologistId) return { ok: false };
    const pid = psychologistId;

    const [clients, sessions, settings, blocks, tasks, notes, entries, waiting] = await Promise.all([
      supabaseApi.request(`clients?psychologist_id=eq.${pid}&select=*`).catch(() => []),
      supabaseApi.request(`sessions?psychologist_id=eq.${pid}&select=*&order=session_date.asc`).catch(() => []),
      supabaseApi.request(`session_settings?psychologist_id=eq.${pid}&select=*&limit=1`).catch(() => []),
      supabaseApi.request(`schedule_blocks?psychologist_id=eq.${pid}&select=*&order=date_from.asc`).catch(() => []),
      supabaseApi.request(`tasks?psychologist_id=eq.${pid}&select=*&order=created_at.asc`).catch(() => []),
      supabaseApi.request(`psy_notes?psychologist_id=eq.${pid}&select=*&order=created_at.desc`).catch(() => []),
      supabaseApi.request(`client_entries?psychologist_id=eq.${pid}&select=*&order=date.desc`).catch(() => []),
      supabaseApi.request(`waiting_items?psychologist_id=eq.${pid}&select=*&order=created_at.asc`).catch(() => [])
    ]);

    return { ok: true, clients, sessions, settings: settings?.[0] || null, blocks, tasks, notes, entries, waiting };
  },

  // ——— Клиенты (привязочные строки; PII в сейфе) ———
  pushClient(psyId, c) {
    push('client', () => supabaseApi.request('clients', {
      method: 'POST',
      body: JSON.stringify({ psychologist_id: psyId, name: '', nickname: c.nickname || c.name || '', phone: '', contact: '', note: '' })
    }).then(rows => {
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.id) { c.id = row.id; } // локальный id → серверный
      return row;
    }));
  },

  pushClientDelete(serverId) {
    push('client:delete', () => supabaseApi.request(`clients?id=eq.${serverId}`, { method: 'DELETE' }));
  },

  /**
   * Индивидуальные условия клиента (T-09/T-10, Агент 3).
   * Колонки clients.price_override/currency/payment_method/meet_link/payment_url —
   * заявка SR-102. До её применения PATCH тихо не проходит, а условия остаются
   * в зашифрованном сейфе кабинета (clientVaultService) — фича работает локально.
   * Приватный текст (имя/телефон/заметки) сюда НЕ попадает.
   */
  pushClientConditions(serverId, conditions = {}) {
    const row = {};
    if ('priceOverride' in conditions) row.price_override = conditions.priceOverride;
    if ('currency' in conditions) row.currency = conditions.currency;
    if ('paymentMethod' in conditions) row.payment_method = conditions.paymentMethod;
    if ('meetLink' in conditions) row.meet_link = conditions.meetLink;
    if ('paymentUrl' in conditions) row.payment_url = conditions.paymentUrl;
    if (!Object.keys(row).length) return;
    push('client:conditions', () => supabaseApi.request(`clients?id=eq.${serverId}`, {
      method: 'PATCH', body: JSON.stringify(row)
    }));
  },

  // ——— Сессии ———
  pushSession(psyId, x) {
    push('session', () => supabaseApi.request('sessions', {
      method: 'POST',
      body: JSON.stringify({ psychologist_id: psyId, client_id: x.clientId || null, service_id: x.serviceId || null, ...sessRow(x) })
    }).then(rows => {
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.id) x.id = row.id;
      return row;
    }));
  },

  pushSessionPatch(id, patch) {
    push('session:patch', () => supabaseApi.request(`sessions?id=eq.${id}`, {
      method: 'PATCH', body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
    }));
  },

  pushSessionDelete(id) {
    push('session:delete', () => supabaseApi.request(`sessions?id=eq.${id}`, { method: 'DELETE' }));
  },

  // ——— Настройки кабинета ———
  pushSettings(psyId, st) {
    push('settings', () => supabaseApi.upsertSettings(psyId, {
      work_hours: st.workHours || '',
      work_days: st.workDays || [1, 2, 3, 4, 5],
      timezone: st.timezone || 'Europe/Minsk',
      slot_times: st.slotTimes || null,
      slot_start: st.slotStart || '10:00',
      slot_end: st.slotEnd || '18:00',
      slot_step_min: st.slotStepMin || 60,
      default_video_platform: st.defaultVideoPlatform || 'google_meet',
      payment_policy: st.paymentPolicy || 'none',
      deposit_percent: st.depositPercent ?? 30,
      deposit_amount: st.depositAmount ?? null,
      hold_minutes: st.holdMinutes ?? 60,
      max_active_unpaid_per_phone: st.maxActiveUnpaidPerPhone ?? 1,
      max_bookings_per_day_per_phone: st.maxBookingsPerDayPerPhone ?? 2,
      block_after_no_shows: st.blockAfterNoShows ?? 2,
      reminder_hours_before: st.reminderHoursBefore ?? 24,
      reminder_second_hours_before: st.reminderSecondHoursBefore ?? 12,
      google_calendar_ical_url: st.googleCalendarIcalUrl || '',
      google_sync_busy: st.googleSyncBusy !== false,
      telegram_bot_token: st.telegramBotToken || '',
      telegram_chat_id: st.telegramChatId || '',
      telegram_bot_name: st.telegramBotName || '',
      telegram_notify_booking: st.telegramNotifyBooking !== false,
      telegram_notify_reminders: st.telegramNotifyReminders !== false,
      telegram_notify_payments: st.telegramNotifyPayments !== false,
      last_notified_session_at: st.lastNotifiedSessionAt || null
    }));
  },

  // ——— Услуги ———
  pushService(psyId, x) {
    push('service', () => supabaseApi.request('services', {
      method: 'POST',
      body: JSON.stringify({
        psychologist_id: psyId, title: x.name, duration_min: x.duration || 60,
        price: x.price || 0, currency: x.currency || 'BYN', format: x.format || 'offline',
        sort_order: x.sortOrder || 0
      })
    }).then(rows => {
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.id) x.id = row.id;
      return row;
    }));
  },

  pushServiceDelete(id) {
    push('service:delete', () => supabaseApi.request(`services?id=eq.${id}`, { method: 'DELETE' }));
  },

  // ——— Блокировки занятости ———
  pushBlock(psyId, b) {
    push('block', () => supabaseApi.request('schedule_blocks', {
      method: 'POST', body: JSON.stringify({ psychologist_id: psyId, ...blockRow(b) })
    }).then(rows => {
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.id) b.id = row.id;
      return row;
    }));
  },

  pushBlockDelete(id) {
    push('block:delete', () => supabaseApi.request(`schedule_blocks?id=eq.${id}`, { method: 'DELETE' }));
  },

  // ——— Задачи / Блокнот / Записи о клиентах ———
  pushTask(psyId, t) {
    push('task', () => supabaseApi.request('tasks', {
      method: 'POST', body: JSON.stringify({ psychologist_id: psyId, ...taskRow(t) })
    }).then(rows => {
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.id) t.id = row.id;
      return row;
    }));
  },

  pushTaskPatch(id, patch) {
    push('task:patch', () => supabaseApi.request(`tasks?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) }));
  },

  pushTaskDelete(id) {
    push('task:delete', () => supabaseApi.request(`tasks?id=eq.${id}`, { method: 'DELETE' }));
  },

  pushNote(psyId, n) {
    push('note', () => supabaseApi.request('psy_notes', {
      method: 'POST', body: JSON.stringify({ psychologist_id: psyId, ...noteRow(n) })
    }).then(rows => {
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.id) n.id = row.id;
      return row;
    }));
  },

  pushNotePatch(id, patch) {
    push('note:patch', () => supabaseApi.request(`psy_notes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) }));
  },

  pushNoteDelete(id) {
    push('note:delete', () => supabaseApi.request(`psy_notes?id=eq.${id}`, { method: 'DELETE' }));
  },

  pushEntry(psyId, e) {
    push('entry', () => supabaseApi.request('client_entries', {
      method: 'POST', body: JSON.stringify({ psychologist_id: psyId, ...entryRow(e) })
    }).then(rows => {
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.id) e.id = row.id;
      return row;
    }));
  },

  pushEntryDelete(id) {
    push('entry:delete', () => supabaseApi.request(`client_entries?id=eq.${id}`, { method: 'DELETE' }));
  },

  /** chat_id клиента (подключение Telegram-уведомлений) */
  pushClientChat(id, telegramChat) {
    push('client:chat', () => supabaseApi.request(`clients?id=eq.${id}`, {
      method: 'PATCH', body: JSON.stringify({ telegram_chat: telegramChat || '' })
    }));
  },

  // ——— Ожидание ———
  pushWaitingDelete(id) {
    push('waiting:delete', () => supabaseApi.request(`waiting_items?id=eq.${id}`, { method: 'DELETE' }));
  },

  /** Пожелание из листа ожидания: день/время/«постоянное время» (T-24, заявка SR-106) */
  pushWaitingPatch(id, patch = {}) {
    push('waiting:patch', () => supabaseApi.request(`waiting_items?id=eq.${id}`, {
      method: 'PATCH', body: JSON.stringify(patch)
    }));
  }
};
