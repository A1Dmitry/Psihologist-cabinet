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
// ——— Агент 3: серии, индивидуальные условия, мини-кабинет клиента, аналитика, пояса ———
import { sessionSeriesService } from '../services/sessionSeriesService.js';
import { clientCabinetService, MATERIAL_KINDS } from '../services/clientCabinetService.js';
import { cabinetStatsService, moneyLabel } from '../services/cabinetStatsService.js';
import {
  timezoneService, todayStr as zoneToday, weekdayOf, addDaysStr,
  weekdayTimeLabel, zoneCity, sessionZoneLabel, sessionZoneHint, WEEKDAY_NAMES_SHORT
} from '../services/timezoneService.js';

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
    // ——— Агент 3: регулярные сессии / выбор области переноса / загрузка боковых данных ———
    this.rescheduleScope = 'single';       // single | series (переключатель в модалке переноса)
    this.pendingSeriesChoice = null;       // ждёт выбора «одна встреча или вся серия»
    this.editingSeriesId = null;
    this._sideDataFor = null;              // для какой psy уже подтянуты серии/материалы
    this.materialKinds = MATERIAL_KINDS;
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
    await this.ensureSideData();
  }

  /**
   * Боковые данные кабинета (серии, материалы, ссылки клиентов, запросы).
   * Тянем один раз на вход, ошибки сервера не ломают кабинет: остаёмся на
   * локальном зеркале и объясняем это в UI (serverHint).
   */
  async ensureSideData(force = false) {
    if (!this.psyId) return;
    if (this._sideDataFor === this.psyId && !force) return;
    if (!force && this._sideDataLoading) return this._sideDataLoading;
    this._sideDataLoading = (async () => {
      try {
        await sessionSeriesService.pull(this.psyId, { force });
        await clientCabinetService.pull(this.psyId, { force });
        this._sideDataFor = this.psyId;
      } catch (e) {
        console.warn('[Cabinet] боковые данные не загружены:', e?.message || e);
      } finally {
        this._sideDataLoading = null;
        this.attachSeriesLinks();
        this.notify();
      }
    })();
    return this._sideDataLoading;
  }

  /** Пометить загруженные сессии привязкой к серии (для переноса «одна/вся») */
  attachSeriesLinks() {
    const list = this.series;
    if (!list.length) return 0;
    let n = 0;
    for (const s of this.sessions) {
      if (s.seriesId) continue;
      const sr = list.find(x => x.id === s.seriesId) || list.find(x =>
        x.clientId === s.clientId && x.time === s.time && x.coversDate(s.date) &&
        (!x.serviceId || !s.serviceId || x.serviceId === s.serviceId)
      );
      if (sr) { s.seriesId = sr.id; n++; }
    }
    return n;
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
    if (!this.psyId) return false;
    if (!form.clientId || !form.serviceId || !form.date || !form.time) {
      this.error = 'Заполните обязательные поля';
      this.notify();
      return false;
    }
    const client = this.clientById(form.clientId);
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
    // T-09/T-10: индивидуальные условия клиента подставляются в новую сессию
    if (!form.id) this.applyClientConditions(payload, client, { keepMeetLink: !!form.meetLink });

    if (form.id) {
      const existing = this.sessions.find(s => s.id === form.id);
      const timeChanged = existing && (existing.date !== form.date || existing.time !== form.time);
      const series = existing ? this.seriesForSession(existing) : null;

      // T-06: встреча из серии — сначала спрашиваем область переноса
      if (timeChanged && series && !form.seriesScope) {
        this.pendingSeriesChoice = {
          form: { ...form },
          seriesId: series.id,
          sessionId: existing.id,
          seriesLabel: series.label()
        };
        this.error = '';
        this.notify();
        return false;
      }
      if (timeChanged && series && form.seriesScope === 'series') {
        const res = sessionSeriesService.reschedule(series.id, {
          weekday: weekdayOf(form.date),
          time: form.time,
          reason: form.changeReason || ''
        });
        if (!res.ok) {
          this.error = res.message || 'Не удалось перенести серию';
          this.notify();
          return false;
        }
        // прочие поля — на соответствующую встречу серии (если она есть в расписании)
        const moved = res.series
          ? sessionSeriesService.sessionsOfSeries(res.series).find(s => s.date === form.date && s.time === form.time)
          : null;
        if (moved) {
          db.updateSession(moved.id, {
            serviceId: payload.serviceId,
            status: form.status || moved.status,
            note: form.note || '',
            videoPlatform: payload.videoPlatform,
            meetLink: payload.meetLink || moved.meetLink
          });
          cabinetApi.pushSessionPatch(moved.id, sessPatchOf(moved));
          reminderService.scheduleForSession(moved.id);
        }
        this.showToast(`Серия перенесена: ${weekdayTimeLabel(res.series.weekday, res.series.time)} · встреч: ${res.created}${res.skipped?.length ? `, пропущено: ${res.skipped.length}` : ''}`);
        this.notify();
        return true;
      }
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

  // ==================================================================
  //  РЕГУЛЯРНЫЕ СЕССИИ (T-05 / T-06 / T-07)
  // ==================================================================

  get series() {
    return this.psyId ? sessionSeriesService.list(this.psyId) : [];
  }

  /** Серии с подписью для UI: {series, label, upcoming, clientName, serviceName} */
  get seriesCards() {
    return this.series.map(sr => {
      const client = this.clientById(sr.clientId);
      const service = this.serviceById(sr.serviceId);
      return {
        series: sr,
        id: sr.id,
        label: sr.label(),
        when: weekdayTimeLabel(sr.weekday, sr.time),
        clientName: client?.nickname || client?.name || '—',
        serviceName: service?.name || '',
        upcoming: sessionSeriesService.upcomingCount(sr),
        paused: !!sr.paused,
        intervalWeeks: sr.intervalWeeks,
        note: sr.note
      };
    });
  }

  get seriesServerHint() {
    return sessionSeriesService.serverHint();
  }

  /** Создать серию (T-05): «каждый вторник 15:00, N недель вперёд» */
  createSeries(form = {}) {
    if (!this.psyId) return { ok: false, message: 'Нет кабинета' };
    const client = this.clientById(form.clientId);
    if (!client) {
      this.error = 'Выберите клиента для серии';
      this.notify();
      return { ok: false, message: this.error };
    }
    const service = form.serviceId ? this.serviceById(form.serviceId) : null;
    const conditions = clientVaultService.conditionsOf(client);
    const res = sessionSeriesService.create(this.psyId, {
      clientId: form.clientId,
      serviceId: form.serviceId || null,
      weekday: Number(form.weekday) || weekdayOf(form.dateFrom || zoneToday()),
      time: form.time || '10:00',
      intervalWeeks: Number(form.intervalWeeks) || 1,
      dateFrom: form.dateFrom || zoneToday(),
      dateTo: form.dateTo || '',
      horizonWeeks: Number(form.horizonWeeks) || 8,
      note: form.note || '',
      clientTimezone: conditions.clientTimezone || ''
    });
    if (!res.ok) {
      this.error = res.message || 'Не удалось создать серию';
      this.notify();
      return res;
    }
    this.attachSeriesLinks();
    const conflicts = (res.skipped || []).length;
    this.showToast(`Серия создана: ${weekdayTimeLabel(res.series.weekday, res.series.time, { full: true })} · встреч: ${res.created}${conflicts ? `, пропущено: ${conflicts}` : ''}`);
    if (conflicts) {
      this.lastSeriesSkipped = res.skipped;
    }
    this.notify();
    return res;
  }

  /** Перенос серии целиком: меняем день недели/время и перегенерируем (T-06) */
  rescheduleSeries(seriesId, patch = {}) {
    const res = sessionSeriesService.reschedule(seriesId, patch);
    if (!res.ok) {
      this.error = res.message || 'Не удалось изменить серию';
      this.notify();
      return res;
    }
    this.showToast(`Серия перенесена: ${weekdayTimeLabel(res.series.weekday, res.series.time, { full: true })} · встреч: ${res.created}`);
    this.notify();
    return res;
  }

  /** Пауза серии: будущие встречи уходят из расписания, слоты свободны (T-07) */
  pauseSeries(seriesId) {
    const res = sessionSeriesService.pause(seriesId, { reason: 'пауза' });
    if (!res.ok) {
      this.error = res.message;
      this.notify();
      return res;
    }
    this.showToast(`Серия на паузе. Снято встреч: ${res.removed}`);
    this.notify();
    return res;
  }

  resumeSeries(seriesId) {
    const res = sessionSeriesService.resume(seriesId);
    if (!res.ok) {
      this.error = res.message;
      this.notify();
      return res;
    }
    this.showToast(`Серия возобновлена · создано встреч: ${res.created}`);
    this.notify();
    return res;
  }

  removeSeries(seriesId) {
    const res = sessionSeriesService.remove(seriesId);
    if (res.ok) this.showToast(`Серия удалена, снято встреч: ${res.removed}`);
    this.notify();
    return res;
  }

  /** Продлить серию (догенерировать встречи на горизонт) */
  extendSeries(seriesId, horizonWeeks = 8) {
    const sr = this.series.find(x => x.id === seriesId);
    if (!sr) return { ok: false };
    sr.horizonWeeks = Math.max(horizonWeeks, sr.horizonWeeks || 0);
    sr.updatedAt = new Date().toISOString();
    const gen = sessionSeriesService.generateSessions(sr);
    this.showToast(`Серия продлена до ${sr.horizonWeeks} нед. · добавлено встреч: ${gen.created}`);
    this.notify();
    return gen;
  }

  seriesForSession(sessionOrId) {
    const s = typeof sessionOrId === 'string' ? this.sessions.find(x => x.id === sessionOrId) : sessionOrId;
    return s ? sessionSeriesService.seriesForSession(s) : null;
  }

  seriesSessions(seriesId) {
    const sr = this.series.find(x => x.id === seriesId);
    return sr ? sessionSeriesService.sessionsOfSeries(sr) : [];
  }

  /** Применить выбор области переноса из модалки (одна встреча / вся серия / отмена) */
  applySeriesChoice(scope) {
    const pending = this.pendingSeriesChoice;
    if (!pending) return false;
    this.pendingSeriesChoice = null;
    if (!scope || scope === 'cancel') {
      this.notify();
      return false;
    }
    return this.saveSession({ ...pending.form, seriesScope: scope });
  }

  // ==================================================================
  //  ИНДИВИДУАЛЬНЫЕ УСЛОВИЯ КЛИЕНТА (T-09 / T-10)
  // ==================================================================

  /** Условия клиента (зашифрованный сейф кабинета + пояс из мини-кабинета) */
  conditionsOf(clientOrId) {
    const c = typeof clientOrId === 'string' ? this.clientById(clientOrId) : clientOrId;
    const cond = clientVaultService.conditionsOf(c);
    if (c?.id && !cond.clientTimezone) {
      const zone = clientCabinetService.clientTimezoneOf(c.id);
      if (zone) cond.clientTimezone = zone;
    }
    return cond;
  }

  /**
   * Подставить индивидуальные условия клиента в сессию (T-09/T-10):
   * цена/валюта/способ оплаты/постоянная ссылка на встречу/ссылка на оплату.
   */
  applyClientConditions(session, client, { keepMeetLink = false } = {}) {
    const cond = clientVaultService.conditionsOf(client);
    const service = this.services.find(s => s.id === session.serviceId);
    const price = cond.priceOverride ?? service?.price ?? 0;
    session.currency = cond.currency || service?.currency || 'BYN';
    session.amountDue = Number(price) || 0;
    session.paymentMethod = cond.paymentMethod || '';
    session.paymentUrl = cond.paymentUrl || service?.payUrl || '';
    if (!keepMeetLink) {
      if (cond.meetLink) session.meetLink = cond.meetLink;
      if (!session.videoPlatform && cond.videoPlatform) session.videoPlatform = cond.videoPlatform;
    }
    if (cond.clientTimezone) session.clientTimezone = cond.clientTimezone;
    if (Object.keys(cond).length) session.conditionsApplied = true;
    return session;
  }

  /** Сохранить условия клиента из карточки */
  async saveClientConditions(clientId, patch) {
    if (!this.psyId) return false;
    if (!this.vaultUnlocked) {
      this.error = 'Сейф заблокирован — войдите с паролем, чтобы менять условия клиента';
      this.notify();
      return false;
    }
    try {
      const updated = await clientVaultService.updateConditions(this.psyId, clientId, patch);
      // не-PII часть условий — на серверные колонки (SR-102), чтобы кабинет был
      // одинаков на разных устройствах; до применения миграции вызов тихо пропускается
      cabinetApi.pushClientConditions(clientId, clientVaultService.conditionsOf(updated));
      await this.refreshClients();
      this.showToast('Условия клиента сохранены');
      this.notify();
      return true;
    } catch (e) {
      this.error = e.message || 'Не удалось сохранить условия';
      this.notify();
      return false;
    }
  }

  /** Готовая строка условий для карточки: «80 BYN · перевод · ссылка на встречу есть» */
  conditionsSummary(clientOrId) {
    const cond = this.conditionsOf(clientOrId);
    const bits = [];
    if (cond.priceOverride != null) bits.push(`${cond.priceOverride} ${cond.currency || 'BYN'}`.trim());
    else if (cond.currency) bits.push(`валюта ${cond.currency}`);
    if (cond.paymentMethod) bits.push(this.paymentMethodLabel(cond.paymentMethod));
    if (cond.meetLink) bits.push('постоянная ссылка на встречу');
    if (cond.paymentUrl) bits.push('ссылка на оплату');
    if (cond.clientTimezone) bits.push(`пояс клиента: ${zoneCity(cond.clientTimezone)}`);
    return bits.join(' · ');
  }

  paymentMethodLabel(method) {
    return ({
      transfer: 'перевод', card: 'карта', cash: 'наличные', erip: 'ЕРИП', bepaid: 'bePaid', receipt: 'чек'
    })[method] || method;
  }

  get paymentMethodOptions() {
    return [
      { id: '', label: '— как в услуге —' },
      { id: 'transfer', label: 'Перевод' },
      { id: 'card', label: 'Карта' },
      { id: 'cash', label: 'Наличные' },
      { id: 'erip', label: 'ЕРИП' },
      { id: 'bepaid', label: 'bePaid' },
      { id: 'receipt', label: 'По чеку' }
    ];
  }

  /** История платежей клиента (T-11) — данные уже в сессиях */
  paymentsSummary(clientId) {
    const list = this.sessions
      .filter(s => s.clientId === clientId && s.status !== 'cancelled')
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    const byCurrency = {};
    const rows = list.map(s => {
      const svc = this.serviceById(s.serviceId);
      const due = Number(s.amountDue) || Number(svc?.price) || 0;
      const paid = Number(s.amountPaid) || 0;
      const currency = s.currency || svc?.currency || 'BYN';
      const debt = Math.max(0, Math.round((due - paid) * 100) / 100);
      byCurrency[currency] = byCurrency[currency] || { received: 0, due: 0, debt: 0, sessions: 0 };
      byCurrency[currency].received += paid;
      byCurrency[currency].due += due;
      byCurrency[currency].debt += debt;
      byCurrency[currency].sessions += 1;
      return {
        id: s.id, date: s.date, time: s.time, status: s.status,
        serviceName: svc?.name || '', due, paid, debt, currency,
        paymentStatus: s.paymentStatus || 'unpaid',
        method: s.paymentMethod || this.conditionsOf(clientId).paymentMethod || ''
      };
    });
    const totals = Object.entries(byCurrency).map(([currency, v]) => ({ currency, ...v }));
    return {
      rows: rows.slice(0, 12),
      totals,
      totalLabel: totals.length
        ? totals.map(t => `${Math.round(t.received * 100) / 100} из ${Math.round(t.due * 100) / 100} ${t.currency}`).join(' · ')
        : 'нет данных',
      debtLabel: moneyLabel(totals.reduce((acc, t) => { acc[t.currency] = t.debt; return acc; }, {}), { empty: 'долгов нет' }),
      unpaidCount: rows.filter(r => r.debt > 0 && r.paymentStatus !== 'refunded').length
    };
  }

  // ==================================================================
  //  МИНИ-КАБИНЕТ КЛИЕНТА: ССЫЛКА, МАТЕРИАЛЫ, ДОКУМЕНТЫ (T-12 / T-13 / T-14)
  // ==================================================================

  get clientCabinetServerHint() {
    return clientCabinetService.serverHint();
  }

  /** Постоянная секретная ссылка клиента (создаётся один раз, дальше — та же) */
  clientAccessLink(clientId, { rotate = false, ttlDays = 180 } = {}) {
    if (!this.psyId || !clientId) return null;
    if (!this.vaultUnlocked) return { ok: false, message: 'Сейф заблокирован — войдите с паролем' };
    const res = clientCabinetService.issueToken({ psychologistId: this.psyId, clientId, ttlDays, rotate });
    if (!res.ok) return res;
    const base = (() => {
      try { return location.pathname.replace(/(cabinet|auth|reply|booking-done)\/?$/, ''); } catch { return '/'; }
    })();
    return { ...res, url: clientCabinetService.tokenUrl(res.token, base || '/') };
  }

  revokeClientAccessLink(token) {
    clientCabinetService.revokeToken(token);
    this.showToast('Ссылка клиента отозвана');
    this.notify();
  }

  accessTokenOf(clientId) {
    return this.psyId ? clientCabinetService.activeToken(this.psyId, clientId) : null;
  }

  /** Материалы и домашние задания клиента (T-13) */
  materialsOf(clientId) {
    return clientCabinetService.materialsOf(clientId);
  }

  addMaterial(form = {}) {
    if (!this.psyId || !form.clientId) return { ok: false };
    const res = clientCabinetService.addMaterial({
      psychologistId: this.psyId,
      clientId: form.clientId,
      kind: form.kind || 'text',
      title: form.title || '',
      body: form.body || '',
      url: form.url || ''
    });
    this.showToast(res.ok ? 'Материал добавлен — клиент увидит его по своей ссылке' : res.message, !res.ok && 0);
    this.notify();
    return res;
  }

  removeMaterial(id) {
    clientCabinetService.removeMaterial(id);
    this.showToast('Материал удалён');
    this.notify();
  }

  toggleMaterialPin(id) {
    clientCabinetService.toggleMaterialPin(id);
    this.notify();
  }

  /** Документы клиента с «подписью» (T-14 — вспомогательный уровень) */
  documentsOf(clientId) {
    return clientCabinetService.documentsOf(clientId);
  }

  addDocument(form = {}) {
    if (!this.psyId || !form.clientId) return { ok: false };
    const res = clientCabinetService.addDocument({
      psychologistId: this.psyId,
      clientId: form.clientId,
      title: form.title,
      body: form.body
    });
    this.showToast(res.ok ? 'Документ добавлен в кабинет клиента' : res.message);
    this.notify();
    return res;
  }

  removeDocument(id) {
    clientCabinetService.removeDocument(id);
    this.notify();
  }

  // ==================================================================
  //  ЛИСТ ОЖИДАНИЯ И ЗАПРОСЫ КЛИЕНТА (T-08 / T-24)
  // ==================================================================

  /** Очередь: заявки из публичной записи + запросы из мини-кабинета клиента */
  get clientRequests() {
    return this.psyId ? clientCabinetService.requestsOf(this.psyId) : [];
  }

  get pendingClientRequests() {
    return this.clientRequests.filter(r => r.status === 'pending');
  }

  get waitingQueue() {
    const requests = this.pendingClientRequests.map(r => ({
      id: r.id,
      source: 'client',
      kind: r.kind,
      kindLabel: ({ propose_time: 'Другое время', recurring: 'Постоянное время', waiting_day: 'Нужен день' })[r.kind] || 'Запрос',
      text: clientCabinetService.requestLabel(r),
      clientId: r.clientId,
      sessionId: r.sessionId,
      desiredDate: r.desiredDate,
      desiredTime: r.desiredTime,
      weekday: r.weekday,
      intervalWeeks: r.intervalWeeks,
      comment: r.comment,
      createdAt: r.createdAt
    }));
    const items = this.waiting.map(w => {
      const pref = clientCabinetService.waitingPref(w.id) || {};
      const recurring = !!(w.recurring || pref.recurring);
      return {
        id: w.id,
        source: 'booking',
        kind: recurring ? 'recurring' : (w.type === 'reschedule' ? 'propose_time' : 'wait'),
        kindLabel: recurring ? 'Постоянное время' : (w.type === 'reschedule' ? 'Перенос' : 'Очередь'),
        text: `${w.name || 'Заявка'}${w.note ? ` · ${w.note}` : ''}`,
        clientId: w.clientId || null,
        desiredDate: pref.desiredDate || '',
        desiredTime: pref.desiredTime || '',
        weekday: pref.weekday ?? null,
        intervalWeeks: pref.intervalWeeks ?? null,
        raw: w,
        pref
      };
    });
    const queue = requests.concat(items);
    return {
      all: queue,
      forDay: queue.filter(q => q.desiredDate).sort((a, b) => (a.desiredDate || '').localeCompare(b.desiredDate || '')),
      recurring: queue.filter(q => q.kind === 'recurring'),
      propose: queue.filter(q => q.kind === 'propose_time'),
      byDay: queue.filter(q => q.desiredDate).reduce((acc, q) => {
        (acc[q.desiredDate] = acc[q.desiredDate] || []).push(q);
        return acc;
      }, {})
    };
  }

  /** Уточнить пожелание к позиции очереди (день/время/«хочет постоянное время») */
  setWaitingPreference(id, patch = {}) {
    const w = this.waiting.find(x => x.id === id);
    if (!w) return false;
    const cur = clientCabinetService.waitingPref(id) || {};
    const weekday = patch.weekday ?? cur.weekday ?? (patch.desiredDate ? weekdayOf(patch.desiredDate) : null);
    // пожелание дня/времени хранится рядом с заявкой (SR-106) и зеркалится на сервер
    clientCabinetService.setWaitingPref(id, {
      desiredDate: patch.desiredDate ?? cur.desiredDate ?? '',
      desiredTime: patch.desiredTime ?? cur.desiredTime ?? '',
      recurring: patch.recurring ?? cur.recurring ?? false,
      weekday,
      intervalWeeks: patch.intervalWeeks ?? cur.intervalWeeks ?? null
    });
    this.notify();
    return true;
  }

  /** Подтвердить запрос клиента «предложить другое время» — переносим встречу */
  acceptClientRequest(id) {
    const r = this.pendingClientRequests.find(x => x.id === id);
    if (!r) return false;
    const session = r.sessionId
      ? this.sessions.find(s => s.id === r.sessionId)
      : this.sessions.find(s => s.clientId === r.clientId && s.date >= zoneToday());
    if (r.kind === 'propose_time' && session && r.desiredDate && r.desiredTime) {
      const busy = this.sessions.some(s =>
        s.id !== session.id && s.date === r.desiredDate && s.time === r.desiredTime &&
        !['cancelled', 'expired', 'no_show'].includes(s.status)
      );
      if (busy || db.isSlotBlocked(this.psyId, r.desiredDate, r.desiredTime)) {
        this.error = 'Это время уже занято — предложите клиенту другой слот';
        this.notify();
        return false;
      }
      session.previousSlot = { date: session.date, time: session.time };
      session.date = r.desiredDate;
      session.time = r.desiredTime;
      session.pendingChange = null;
      session.changeConsentStatus = 'confirmed_client_request';
      session.clientResponse = 'change_confirmed';
      db.saveChanges();
      cabinetApi.pushSessionPatch(session.id, sessPatchOf(session));
      reminderService.scheduleForSession(session.id);
      clientCabinetService.resolveRequest(id, 'accepted');
      this._notifyClientTelegram(session, `✅ Новое время согласовано: ${r.desiredDate} в ${r.desiredTime}`);
      this.showToast('Запрос клиента принят — встреча перенесена');
      this.notify();
      return true;
    }
    if (r.kind === 'recurring') {
      // подтверждение постоянного времени = создание серии (психолог может поменять параметры)
      const res = this.createSeries({
        clientId: r.clientId,
        serviceId: r.sessionId ? this.sessions.find(s => s.id === r.sessionId)?.serviceId : null,
        weekday: r.weekday || (r.desiredDate ? weekdayOf(r.desiredDate) : 1),
        time: r.desiredTime || '10:00',
        intervalWeeks: r.intervalWeeks || 1,
        dateFrom: zoneToday(),
        horizonWeeks: 8
      });
      if (res.ok) {
        clientCabinetService.resolveRequest(id, 'accepted');
        this.showToast('Постоянное время назначено');
      }
      this.notify();
      return res.ok;
    }
    // «нужен день» из очереди — открываем расписание на этом дне
    if (r.desiredDate) this.selectedDate = r.desiredDate;
    this.tab = 'schedule';
    clientCabinetService.resolveRequest(id, 'accepted');
    this.showToast('Пожелание клиента учтено — выберите слот в расписании');
    this.notify();
    return true;
  }

  declineClientRequest(id) {
    clientCabinetService.resolveRequest(id, 'declined');
    this.showToast('Запрос отклонён');
    this.notify();
  }

  removeClientRequest(id) {
    clientCabinetService.removeRequest(id);
    this.notify();
  }

  /**
   * «Записать» заявку из листа ожидания: завести карточку клиента (если её нет)
   * и сразу создать серию, если человек просил постоянное время (T-08/T-24).
   * Без выбранного «постоянного времени» просто сохраняет пожелание.
   */
  async createSeriesFromWaiting(waitingId, form = {}) {
    const w = this.waiting.find(x => x.id === waitingId);
    if (!w) return { ok: false, message: 'Заявка не найдена' };
    const pref = clientCabinetService.waitingPref(waitingId) || {};
    const desiredDate = pref.desiredDate || '';
    const desiredTime = pref.desiredTime || '';
    const wantsRecurring = !!(pref.recurring || w.recurring);
    const wanted = form.weekday || pref.weekday || (desiredDate ? weekdayOf(desiredDate) : null);
    const time = form.time || desiredTime || '10:00';
    const dateFrom = form.dateFrom || (desiredDate && desiredDate >= zoneToday() ? desiredDate : zoneToday());
    // постоянное время не просили — ограничиваемся пожеланием
    if (!(form.recurring || wantsRecurring || (wanted && desiredDate))) {
      this.setWaitingPreference(waitingId, { desiredTime: time });
      return { ok: false, message: 'Пожелание сохранено' };
    }
    let client = w.clientId ? this.clientById(w.clientId) : this.clients.find(c => c.phone && c.phone === w.phone);
    if (!client) {
      client = db.addClient({
        psychologistId: this.psyId,
        name: w.name || 'Клиент',
        phone: w.phone || '',
        note: w.note || ''
      });
      cabinetApi.pushClient(this.psyId, client);
      await this.refreshClients();
    }
    const res = this.createSeries({
      clientId: client.id,
      serviceId: form.serviceId || null,
      weekday: wanted || weekdayOf(dateFrom),
      time,
      intervalWeeks: Number(form.intervalWeeks) || 1,
      dateFrom,
      horizonWeeks: Number(form.horizonWeeks) || 8
    });
    if (res.ok) {
      db.removeWaiting(waitingId);
      cabinetApi.pushWaitingDelete(waitingId);
      clientCabinetService.clearWaitingPref(waitingId);
      this.tab = 'schedule';
      this.notify();
    }
    return res;
  }

  /** Из заявки «хочу постоянное время» собрать серию (форма психолога) */
  createSeriesFromRequest(requestId, form = {}) {
    const r = this.clientRequests.find(x => x.id === requestId);
    if (!r) return { ok: false };
    const res = this.createSeries({
      clientId: r.clientId,
      serviceId: form.serviceId || null,
      weekday: form.weekday || r.weekday || 1,
      time: form.time || r.desiredTime || '10:00',
      intervalWeeks: form.intervalWeeks || r.intervalWeeks || 1,
      dateFrom: form.dateFrom || zoneToday(),
      horizonWeeks: form.horizonWeeks || 8
    });
    if (res.ok) clientCabinetService.resolveRequest(requestId, 'accepted');
    return res;
  }

  _notifyClientTelegram(session, text) {
    const client = this.clientById(session?.clientId);
    if (!client?.telegramChat) return;
    telegramService.sendToClient(client, text).catch(() => {});
  }

  // ==================================================================
  //  АНАЛИТИКА (T-20)
  // ==================================================================

  get stats() {
    return cabinetStatsService.buildStats({
      sessions: this.sessions,
      services: this.services,
      settings: this.settings,
      blocks: this.blocks,
      clients: this.clients,
      today: zoneToday()
    });
  }

  moneyLabel = (map, opts) => moneyLabel(map, opts);

  // ==================================================================
  //  ЧАСОВЫЕ ПОЯСА (T-23)
  // ==================================================================

  get scheduleZone() {
    return this.settings?.timezone || timezoneService.DEFAULT_TIMEZONE;
  }

  get scheduleZoneLabel() {
    return timezoneService.zoneLabel(this.scheduleZone);
  }

  /** Подпись времени сессии с поясом клиента (если он известен) */
  sessionZone(session) {
    const info = sessionZoneLabel(session, this.scheduleZone);
    return { ...info, hint: sessionZoneHint(session, this.scheduleZone) };
  }

  /** Сохранить пояс клиента (когда клиент открыл свою ссылку из другого пояса) */
  async setClientTimezone(clientId, tz) {
    const client = this.clientById(clientId);
    if (!client || !tz || !timezoneService.isValidZone(tz)) return false;
    if (this.conditionsOf(client).clientTimezone === tz) return true;
    return this.saveClientConditions(clientId, { clientTimezone: tz });
  }

  /** Пояс, который прислал клиент из мини-кабинета (для T-23) */
  applyClientTimezoneFromRequest(requestId, tz) {
    const r = this.clientRequests.find(x => x.id === requestId);
    if (!r) return false;
    return this.setClientTimezone(r.clientId, tz);
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
