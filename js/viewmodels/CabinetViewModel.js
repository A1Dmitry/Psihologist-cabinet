import { BaseViewModel } from './BaseViewModel.js';
import { db } from '../core/dbContext.js';
import { paymentService } from '../services/paymentService.js';
import { fraudProtectionService } from '../services/fraudProtectionService.js';
import { reminderService } from '../services/reminderService.js';
import { telegramService } from '../services/telegramService.js';
import { clientVaultService } from '../services/clientVaultService.js';
import { cryptoService } from '../services/cryptoService.js';
import { supabaseSync } from '../services/supabaseSync.js';
import { fetchGoogleBusyBlocks } from '../services/calendarService.js';
import { cabinetApi } from '../services/cabinetApi.js';
import { ScheduleBlockKind } from '../models/entities.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * ViewModel кабинета психолога (только данные текущего пользователя)
 */
export class CabinetViewModel extends BaseViewModel {
  constructor() {
    super();
    this.tab = 'home';
    this.selectedDate = todayStr();
    this.scheduleRange = 'week'; // today | tomorrow | week | biweek | month
    this.editingSession = null;
    this.editingClient = null;
    // книга записей / клиенты / задачи / блокнот
    this.journalFilter = 'upcoming'; // upcoming | pending | past | all
    this.selectedClientId = null;
  }

  get scheduleRangeOptions() {
    return [
      { id: 'today', label: 'Сегодня', days: 1 },
      { id: 'tomorrow', label: 'Сегодня–завтра', days: 2 },
      { id: 'week', label: 'Неделя', days: 7 },
      { id: 'biweek', label: '2 недели', days: 14 },
      { id: 'month', label: 'Месяц', days: 30 }
    ];
  }

  get scheduleDays() {
    const opt = this.scheduleRangeOptions.find(o => o.id === this.scheduleRange) || this.scheduleRangeOptions[2];
    return Array.from({ length: opt.days }, (_, i) => addDays(i));
  }

  setScheduleRange(rangeId) {
    if (!this.scheduleRangeOptions.some(o => o.id === rangeId)) return;
    this.scheduleRange = rangeId;
    const days = this.scheduleDays;
    if (!days.includes(this.selectedDate)) this.selectedDate = days[0];
    this.notify();
  }

  get psychologist() {
    return db.currentPsychologist;
  }

  get psyId() {
    return this.psychologist?.id;
  }

  get services() {
    return this.psyId ? db.servicesOf(this.psyId) : [];
  }

  get clients() {
    // расшифрованный кэш (только свой кабинет)
    return this._decryptedClients || [];
  }

  get vaultUnlocked() {
    return this.psyId ? cryptoService.isUnlocked(this.psyId) : false;
  }

  async refreshClients() {
    if (!this.psyId) {
      this._decryptedClients = [];
      this.notify();
      return;
    }
    this._decryptedClients = await clientVaultService.listDecrypted(this.psyId);
    this.notify();
  }

  get sessions() {
    return this.psyId ? db.sessionsOf(this.psyId) : [];
  }

  get waiting() {
    return this.psyId ? db.waitingOf(this.psyId) : [];
  }

  get settings() {
    return this.psyId ? db.settingsOf(this.psyId) : null;
  }

  get upcomingSessions() {
    return this.sessions
      .filter(s => s.status !== 'cancelled' && s.date >= todayStr())
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .slice(0, 12);
  }

  get todaySessions() {
    return this.sessions.filter(s => s.date === todayStr() && s.status !== 'cancelled');
  }

  get sessionsOnSelectedDate() {
    return this.sessions
      .filter(s => s.date === this.selectedDate)
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  get weekStats() {
    const from = addDays(-6);
    const list = this.sessions.filter(s => s.date >= from && s.status !== 'cancelled');
    let byn = 0, rub = 0;
    list.forEach(s => {
      const sv = this.services.find(x => x.id === s.serviceId);
      if (!sv) return;
      if (sv.currency === 'RUB') rub += sv.price; else byn += sv.price;
    });
    return { count: list.length, byn, rub, clients: this.clients.length };
  }

  switchTab(tab) {
    this.tab = tab;
    this.notify();
  }

  setSelectedDate(date) {
    this.selectedDate = date;
    this.notify();
  }

  clientById(id) {
    return (this._decryptedClients || []).find(c => c.id === id);
  }

  serviceById(id) {
    return this.services.find(s => s.id === id);
  }

  // ——— Commands ———
  saveSession(form) {
    if (!this.psyId) return;
    if (!form.clientId || !form.serviceId || !form.date || !form.time) {
      this.error = 'Заполните обязательные поля';
      this.notify();
      return false;
    }
    const payload = {
      psychologistId: this.psyId,
      clientId: form.clientId,
      serviceId: form.serviceId,
      date: form.date,
      time: form.time,
      status: form.status || 'confirmed',
      note: form.note || '',
      videoPlatform: form.videoPlatform || '',
      meetLink: form.meetLink || ''
    };

    if (form.id) {
      const existing = this.sessions.find(s => s.id === form.id);
      const timeChanged = existing && (existing.date !== form.date || existing.time !== form.time);
      if (timeChanged && form.notifyClient !== false) {
        // владелец переставил запись → клиенту запрос согласия, слот пока старый
        const res = reminderService.notifyReschedule(form.id, {
          newDate: form.date,
          newTime: form.time,
          reason: form.changeReason || form.note || ''
        });
        // прочие поля без даты/времени
        db.updateSession(form.id, {
          serviceId: payload.serviceId,
          status: payload.status,
          note: payload.note,
          videoPlatform: payload.videoPlatform,
          meetLink: payload.meetLink
        });
        this.showToast(res.ok ? res.message : 'Сохранено; уведомление не отправлено');
        this.lastRescheduleToken = res.reminder?.responseToken || null;
        this.notify();
        return true;
      }
      db.updateSession(form.id, payload);
      const updated = this.sessions.find(x => x.id === form.id);
      if (updated) cabinetApi.pushSessionPatch(form.id, sessPatchOf(updated));
    } else {
      const s = db.addSession(payload);
      cabinetApi.pushSession(this.psyId, s);
      reminderService.scheduleForSession(s.id);
    }
    this.showToast('Сессия сохранена');
    this.notify();
    return true;
  }

  /** Принудительный перенос без ожидания (если клиент недоступен) — только с явного флага */
  forceReschedule(sessionId, { date, time, reason = '' }) {
    const s = this.sessions.find(x => x.id === sessionId);
    if (!s) return false;
    s.previousSlot = { date: s.date, time: s.time };
    s.date = date;
    s.time = time;
    s.pendingChange = null;
    s.changeConsentStatus = 'forced';
    s.note = (s.note ? s.note + '\n' : '') + (reason ? `Перенос (без согласия): ${reason}` : 'Перенос без согласия клиента');
    db.saveChanges();
    cabinetApi.pushSessionPatch(sessionId, sessPatchOf(s));
    reminderService.scheduleForSession(sessionId);
    this.showToast('Время изменено без согласия клиента');
    this.notify();
    return true;
  }

  deleteSession(id) {
    db.removeSession(id);
    cabinetApi.pushSessionDelete(id);
    this.showToast('Сессия удалена');
    this.notify();
  }

  async saveClient(form) {
    if (!this.psyId || !form.name?.trim()) {
      this.error = 'Укажите имя / никнейм';
      this.notify();
      return false;
    }
    if (!this.vaultUnlocked) {
      this.error = 'Сейф заблокирован — войдите с паролем';
      this.notify();
      return false;
    }
    try {
      await clientVaultService.saveClient(this.psyId, {
        id: form.id || null,
        name: form.name.trim(),
        nickname: form.nickname?.trim() || form.name.trim(),
        phone: form.phone || '',
        contact: form.contact || '',
        note: form.note || ''
      });
      await this.refreshClients();
      this.showToast('Клиент сохранён (зашифровано)');
      this.notify();
      return true;
    } catch (e) {
      this.error = e.message || 'Ошибка сохранения';
      this.notify();
      return false;
    }
  }

  deleteClient(id) {
    if (!this.psyId) return;
    const row = db.clients.find(c => c.id === id && c.psychologistId === this.psyId);
    if (!row) {
      this.error = 'Клиент не найден в вашем кабинете';
      this.notify();
      return;
    }
    db.removeClient(id);
    cabinetApi.pushClientDelete(id);
    this.refreshClients();
    this.showToast('Клиент удалён');
    this.notify();
  }

  addService(form) {
    if (!this.psyId || !form.name?.trim()) return false;
    const created = db.addService({
      psychologistId: this.psyId,
      name: form.name.trim(),
      price: form.price,
      currency: form.currency || 'BYN',
      duration: form.duration || 60,
      format: form.format || 'offline'
    });
    cabinetApi.pushService(this.psyId, created);
    this.showToast('Услуга добавлена');
    this.notify();
    return true;
  }

  deleteService(id) {
    const ok = db.removeService(id);
    if (!ok) {
      this.error = 'Нужна хотя бы одна услуга';
      this.notify();
      return;
    }
    cabinetApi.pushServiceDelete(id);
    this.showToast('Услуга удалена');
    this.notify();
  }

  acceptWaiting(id) {
    const w = this.waiting.find(x => x.id === id);
    if (!w) return null;
    let client = w.clientId ? this.clientById(w.clientId) : this.clients.find(c => c.phone === w.phone);
    if (!client) {
      client = db.addClient({
        psychologistId: this.psyId,
        name: w.name,
        phone: w.phone || '',
        note: w.note || ''
      });
    }
    cabinetApi.pushClient(this.psyId, client);
    db.removeWaiting(id);
    cabinetApi.pushWaitingDelete(id);
    this.notify();
    return client;
  }

  removeWaiting(id) {
    db.removeWaiting(id);
    cabinetApi.pushWaitingDelete(id);
    this.notify();
  }


  markSessionPaid(sessionId, receiptCode = '') {
    const res = paymentService.markPaidByPsychologist(sessionId, { receiptCode });
    if (!res.ok) {
      this.error = res.message;
      this.notify();
      return false;
    }
    const s2 = this.sessions.find(x => x.id === sessionId);
    if (s2) cabinetApi.pushSessionPatch(sessionId, sessPatchOf(s2));
    if (s2) {
      const c = this.clientById(s2.clientId);
      const sv = this.serviceById(s2.serviceId);
      telegramService.sendToPsychologist('payment',
        `💰 <b>Оплата отмечена</b>\nКлиент: ${c?.name || c?.nickname || '—'}\nКогда: ${s2.date} в ${s2.time}${sv ? `\nУслуга: ${sv.name} · ${sv.priceLabel()}` : ''}${receiptCode ? `\nКвитанция: ${receiptCode}` : ''}`
      ).catch(() => {});
    }
    this.showToast(res.message);
    reminderService.scheduleForSession(sessionId);
    this.notify();
    return true;
  }

  processReminders() {
    const res = reminderService.processDue(this.psyId);
    this.showToast(res.sent ? `Отправлено напоминаний: ${res.sent}` : 'Нет напоминаний к отправке');
    this.lastReminderOutbox = res.outbox || [];
    this.notify();
    return res;
  }

  get reminders() {
    return this.psyId ? reminderService.remindersOf(this.psyId) : [];
  }

  markNoShow(sessionId) {
    const s = this.sessions.find(x => x.id === sessionId);
    if (!s) return;
    db.updateSession(sessionId, { status: 'no_show' });
    fraudProtectionService.recordNoShow(s.clientId);
    this.showToast('Отмечена неявка');
    this.notify();
  }

  cancelSession(sessionId) {
    const s = this.sessions.find(x => x.id === sessionId);
    if (!s) return;
    db.updateSession(sessionId, { status: 'cancelled' });
    fraudProtectionService.recordCancel(s.clientId);
    this.showToast('Сессия отменена');
    this.notify();
  }

  savePaymentSettings(form) {
    const st = this.settings;
    if (!st) return;
    Object.assign(st, {
      paymentPolicy: form.paymentPolicy,
      depositPercent: Number(form.depositPercent) || 30,
      holdMinutes: Number(form.holdMinutes) || 60,
      maxActiveUnpaidPerPhone: Number(form.maxActiveUnpaidPerPhone) || 1,
      maxBookingsPerDayPerPhone: Number(form.maxBookingsPerDayPerPhone) || 2,
      blockAfterNoShows: Number(form.blockAfterNoShows) || 2,
      reminderEnabled: form.reminderEnabled !== false,
      reminderHoursBefore: Number(form.reminderHoursBefore) || 24,
      reminderSecondHoursBefore: form.reminderSecondHoursBefore === '' || form.reminderSecondHoursBefore == null
        ? 0
        : Number(form.reminderSecondHoursBefore)
    });
    db.saveChanges();
    cabinetApi.pushSettings(this.psyId, st);
    this.showToast('Настройки оплаты и защиты сохранены');
    this.notify();
  }

  get heldUnpaid() {
    paymentService.expireStaleHolds(this.psyId);
    return this.sessions.filter(s => s.status === 'held' || (s.requiresPayment && s.paymentStatus === 'unpaid' && s.status !== 'expired'));
  }

  updateProfile(patch) {
    const p = this.psychologist;
    if (!p) return;
    Object.assign(p, patch);
    db.saveChanges();
    // фоновая синхронизация расширенного профиля с серверной БД
    supabaseSync.pushProfile(p).then(res => {
      if (!res.ok && !res.localOnly) console.warn('[Supabase] профиль не синхронизирован:', res.message);
    }).catch(() => { /* offline — остаёмся в localStorage */ });
    this.showToast('Профиль обновлён');
    this.notify();
  }

  // ——— Занятость: блокировки (выходной, занят, отпуск…) ———

  get blocks() {
    return this.psyId ? db.blocksOf(this.psyId) : [];
  }

  get blockKindLabels() {
    return {
      [ScheduleBlockKind.DAY_OFF]: 'Выходной',
      [ScheduleBlockKind.BUSY]: 'Занят',
      [ScheduleBlockKind.VACATION]: 'Отпуск',
      [ScheduleBlockKind.HOLIDAY]: 'Праздник',
      [ScheduleBlockKind.OTHER]: 'Другое'
    };
  }

  addBlock(form) {
    if (!this.psyId || !form.dateFrom) return false;
    const created = db.addScheduleBlock({
      psychologistId: this.psyId,
      dateFrom: form.dateFrom,
      dateTo: form.dateTo || form.dateFrom,
      timeFrom: form.timeFrom || '',
      timeTo: form.timeTo || '',
      kind: form.kind || ScheduleBlockKind.BUSY,
      title: form.title || this.blockKindLabels[form.kind] || 'Занят',
      note: form.note || '',
      source: 'manual'
    });
    cabinetApi.pushBlock(this.psyId, created);
    this.showToast('Занятость заблокирована');
    this.notify();
    return true;
  }

  removeBlock(id) {
    db.removeScheduleBlock(id);
    cabinetApi.pushBlockDelete(id);
    this.showToast('Блокировка снята');
    this.notify();
  }

  saveTelegramSettings({ botToken, chatId, botName, notifyBooking, notifyReminders, notifyPayments }) {
    const st = this.settings;
    if (!st) return;
    if (botToken != null) st.telegramBotToken = botToken;
    if (chatId != null) st.telegramChatId = chatId;
    if (botName != null) st.telegramBotName = botName;
    st.telegramNotifyBooking = notifyBooking !== false;
    st.telegramNotifyReminders = notifyReminders !== false;
    st.telegramNotifyPayments = notifyPayments !== false;
    db.saveChanges();
    cabinetApi.pushSettings(this.psyId, st);
    this.notify();
  }

  setClientTelegramChat(clientId, chat) {
    const c = this.clientById(clientId);
    if (!c) return;
    c.telegramChat = chat || '';
    db.saveChanges();
    cabinetApi.pushClientChat(clientId, c.telegramChat);
    this.notify();
  }

  saveCalendarSettings({ googleCalendarIcalUrl, googleSyncBusy }) {
    const st = this.settings;
    if (!st) return;
    st.googleCalendarIcalUrl = (googleCalendarIcalUrl || '').trim();
    st.googleSyncBusy = !!googleSyncBusy;
    db.saveChanges();
    cabinetApi.pushSettings(this.psyId, st);
    this.showToast('Настройки календаря сохранены');
    this.notify();
  }

  /** Импорт занятости из Google Calendar (iCal secret address) в блокировки */
  async syncGoogleCalendar() {
    const st = this.settings;
    if (!this.psyId || !st?.googleCalendarIcalUrl) {
      this.error = 'Укажите секретный iCal-адрес Google Calendar';
      this.notify();
      return false;
    }
    this.busy = true;
    const res = await fetchGoogleBusyBlocks(st.googleCalendarIcalUrl, this.psyId);
    this.busy = false;
    if (!res.ok) {
      this.error = res.reason === 'cors'
        ? 'Браузер заблокировал доступ к календарю (CORS). Проверьте, что календарь опубликован, или используйте ручные блокировки.'
        : `Не удалось скачать календарь: ${res.message || res.reason}`;
      this.notify();
      return false;
    }
    // блокировки из Google пересоздаём целиком (идемпотентно по googleEventId)
    db.scheduleBlocks = db.scheduleBlocks.filter(b => !(b.psychologistId === this.psyId && b.source === 'google'));
    res.blocks.forEach(b => db.addScheduleBlock(b));
    db.saveChanges();
    this.showToast(`Синхронизировано событий: ${res.count}`);
    this.notify();
    return true;
  }

  // ——— Книга записей (журнал всех записей с взаимодействием) ———

  get journalSessions() {
    const today = todayStr();
    const all = [...this.sessions].sort((a, b) =>
      (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || ''));
    switch (this.journalFilter) {
      case 'upcoming': return all.filter(s => s.date >= today && !['cancelled', 'expired'].includes(s.status)).reverse();
      case 'pending': return all.filter(s => ['pending', 'held'].includes(s.status) || s.changeConsentStatus === 'pending').reverse();
      case 'past': return all.filter(s => s.date < today || ['done', 'no_show', 'cancelled'].includes(s.status)).reverse();
      default: return all.slice().reverse();
    }
  }

  setJournalFilter(f) {
    if (!['upcoming', 'pending', 'past', 'all'].includes(f)) return;
    this.journalFilter = f;
    this.notify();
  }

  confirmSession(id) {
    const s = this.sessions.find(x => x.id === id);
    if (!s) return;
    s.status = 'confirmed';
    db.saveChanges();
    cabinetApi.pushSessionPatch(id, { status: 'confirmed' });
    this.showToast('Запись подтверждена');
    this.notify();
  }

  // ——— Задачи ———

  get tasks() {
    return this.psyId ? db.tasksOf(this.psyId) : [];
  }

  addTask({ title, details, dueDate, clientId }) {
    if (!title?.trim()) return;
    const t = db.addTask({ psychologistId: this.psyId, title: title.trim(), details: (details || '').trim(), dueDate: dueDate || '', clientId: clientId || null });
    cabinetApi.pushTask(this.psyId, t);
    this.notify();
  }

  toggleTask(id) {
    const t = db.toggleTask(id);
    if (t) cabinetApi.pushTaskPatch(id, { done: t.done });
    this.notify();
  }

  removeTask(id) {
    db.removeTask(id);
    cabinetApi.pushTaskDelete(id);
    this.notify();
  }

  // ——— Блокнот (планировщик) ———

  get notes() {
    return this.psyId ? db.notesOf(this.psyId) : [];
  }

  addNote({ title, body, date }) {
    if (!title?.trim() && !body?.trim()) return;
    const n = db.addNote({ psychologistId: this.psyId, title: (title || '').trim(), body: (body || '').trim(), date: date || '' });
    cabinetApi.pushNote(this.psyId, n);
    this.notify();
  }

  toggleNotePin(id) {
    const n = db.toggleNotePin(id);
    if (n) cabinetApi.pushNotePatch(id, { pinned: n.pinned });
    this.notify();
  }

  removeNote(id) {
    db.removeNote(id);
    cabinetApi.pushNoteDelete(id);
    this.notify();
  }

  // ——— Записи о клиентах (журнал работы с клиентом) ———

  get selectedClient() {
    return this.selectedClientId ? this.clients.find(c => c.id === this.selectedClientId) : null;
  }

  selectClient(id) {
    this.selectedClientId = this.selectedClientId === id ? null : id;
    this.notify();
  }

  clientEntriesOf(clientId) {
    return clientId ? db.entriesOf(clientId) : [];
  }

  addClientEntry({ clientId, text, date, sessionId }) {
    if (!clientId || !text?.trim()) return;
    const e = db.addClientEntry({ psychologistId: this.psyId, clientId, sessionId: sessionId || null, date: date || todayStr(), text: text.trim() });
    cabinetApi.pushEntry(this.psyId, e);
    this.showToast('Запись добавлена');
    this.notify();
  }

  removeClientEntry(id) {
    db.removeClientEntry(id);
    cabinetApi.pushEntryDelete(id);
    this.notify();
  }
}

/** Патч сессии для сервера (snake_case) из локальной сущности */
function sessPatchOf(x) {
  return {
    session_date: x.date, session_time: x.time, status: x.status, note: x.note || '',
    video_platform: x.videoPlatform || '', meet_link: x.meetLink || '',
    payment_policy: x.paymentPolicy || 'none', payment_status: x.paymentStatus || 'unpaid',
    amount_due: x.amountDue || 0, amount_paid: x.amountPaid || 0, currency: x.currency || 'BYN',
    hold_expires_at: x.holdExpiresAt, requires_payment: !!x.requiresPayment,
    client_response: x.clientResponse, client_responded_at: x.clientRespondedAt,
    pending_change: x.pendingChange, previous_slot: x.previousSlot,
    change_consent_status: x.changeConsentStatus
  };
}
