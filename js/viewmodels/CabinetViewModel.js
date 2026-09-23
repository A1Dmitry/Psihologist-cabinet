import { BaseViewModel } from './BaseViewModel.js';
import { db } from '../core/dbContext.js';
import { paymentService } from '../services/paymentService.js';
import { fraudProtectionService } from '../services/fraudProtectionService.js';
import { reminderService } from '../services/reminderService.js';
import { clientVaultService } from '../services/clientVaultService.js';
import { cryptoService } from '../services/cryptoService.js';
import { supabaseSync } from '../services/supabaseSync.js';

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
    } else {
      const s = db.addSession(payload);
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
    reminderService.scheduleForSession(sessionId);
    this.showToast('Время изменено без согласия клиента');
    this.notify();
    return true;
  }

  deleteSession(id) {
    db.removeSession(id);
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
    this.refreshClients();
    this.showToast('Клиент удалён');
    this.notify();
  }

  addService(form) {
    if (!this.psyId || !form.name?.trim()) return false;
    db.addService({
      psychologistId: this.psyId,
      name: form.name.trim(),
      price: form.price,
      currency: form.currency || 'BYN',
      duration: form.duration || 60,
      format: form.format || 'offline'
    });
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
    db.removeWaiting(id);
    this.notify();
    return client;
  }

  removeWaiting(id) {
    db.removeWaiting(id);
    this.notify();
  }


  markSessionPaid(sessionId, receiptCode = '') {
    const res = paymentService.markPaidByPsychologist(sessionId, { receiptCode });
    if (!res.ok) {
      this.error = res.message;
      this.notify();
      return false;
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
}
