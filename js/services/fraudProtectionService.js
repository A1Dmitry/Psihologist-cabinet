/**
 * FraudProtectionService — защита записи от спама, недобросовестных клиентов, мошенничества
 *
 * Известные практики:
 * 1. Honeypot (скрытое поле)
 * 2. Минимальное время заполнения формы
 * 3. Rate limit по телефону / fingerprint
 * 4. Лимит неоплаченных hold
 * 5. Блок по no-show / массовым отменам
 * 6. Нормализация телефона
 * 7. Журнал попыток
 */
import { db } from '../core/dbContext.js';
import { BookingAttempt, ClientRisk } from '../models/entities.js';

function uid(prefix = 'att') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 9) return digits.slice(-9); // last 9 digits as key
  return digits;
}

function getFingerprint() {
  try {
    let fp = sessionStorage.getItem('psy_fp');
    if (!fp) {
      fp = `fp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('psy_fp', fp);
    }
    return fp;
  } catch {
    return `fp_mem_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export class FraudProtectionService {
  constructor() {
    this.formOpenedAt = Date.now();
  }

  markFormOpened() {
    this.formOpenedAt = Date.now();
  }

  getOrCreateRisk(phoneKey) {
    let risk = db.clientRisks.find(r => r.phoneKey === phoneKey);
    if (!risk) {
      risk = new ClientRisk({ id: uid('risk'), phoneKey });
      db.clientRisks.push(risk);
      db.saveChanges();
    }
    return risk;
  }

  logAttempt({ psychologistId, phone, success, reason, consent = false, consentAt = null }) {
    const phoneKey = normalizePhone(phone);
    db.bookingAttempts.push(new BookingAttempt({
      id: uid('att'),
      psychologistId,
      phoneKey,
      fingerprint: getFingerprint(),
      success,
      reason,
      consent,
      consentAt
    }));
    // keep last 500
    if (db.bookingAttempts.length > 500) {
      db.bookingAttempts = db.bookingAttempts.slice(-400);
    }
    db.saveChanges();
  }

  /**
   * Полная проверка перед созданием записи
   * @returns {{ ok: boolean, message?: string, riskLevel?: string }}
   */
  validateBooking({
    psychologistId,
    phone,
    name,
    honeypot = '',
    contact = '',
    settings
  }) {
    // 1. Honeypot — боты заполняют скрытое поле
    if (honeypot && String(honeypot).trim() !== '') {
      this.logAttempt({ psychologistId, phone, success: false, reason: 'honeypot' });
      return { ok: false, message: 'Не удалось создать запись. Попробуйте позже.' };
    }

    // 2. Слишком быстрая отправка (бот)
    const elapsedSec = (Date.now() - this.formOpenedAt) / 1000;
    const minSec = settings?.minSecondsOnForm ?? 4;
    if (elapsedSec < minSec) {
      this.logAttempt({ psychologistId, phone, success: false, reason: 'too_fast' });
      return { ok: false, message: 'Подождите несколько секунд и отправьте форму ещё раз.' };
    }

    const phoneKey = normalizePhone(phone);
    if (phoneKey.length < 7) {
      return { ok: false, message: 'Укажите корректный номер телефона' };
    }
    if (!name || String(name).trim().length < 2) {
      return { ok: false, message: 'Укажите имя' };
    }

    // 3. Глобальный блок
    const risk = this.getOrCreateRisk(phoneKey);
    if (risk.blocked) {
      this.logAttempt({ psychologistId, phone, success: false, reason: 'blocked' });
      return { ok: false, message: 'Запись с этого номера временно недоступна. Свяжитесь с психологом напрямую.' };
    }

    const blockAfter = settings?.blockAfterNoShows ?? 2;
    if (risk.noShowTotal >= blockAfter) {
      risk.blocked = true;
      risk.blockReason = `no-show × ${risk.noShowTotal}`;
      risk.updatedAt = new Date().toISOString();
      db.saveChanges();
      this.logAttempt({ psychologistId, phone, success: false, reason: 'no_show_block' });
      return { ok: false, message: 'Запись ограничена из‑за пропусков предыдущих сессий. Напишите психологу.' };
    }

    // 4. Rate limit: попытки с одного fingerprint за 10 мин
    const since = Date.now() - 10 * 60 * 1000;
    const fp = getFingerprint();
    const recentFp = db.bookingAttempts.filter(a =>
      a.fingerprint === fp && new Date(a.createdAt).getTime() > since
    );
    if (recentFp.length >= 8) {
      this.logAttempt({ psychologistId, phone, success: false, reason: 'fp_rate' });
      return { ok: false, message: 'Слишком много попыток. Подождите 10 минут.' };
    }

    // 5. Rate limit по телефону к этому психологу за сутки
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const phoneAttempts = db.bookingAttempts.filter(a =>
      a.psychologistId === psychologistId &&
      a.phoneKey === phoneKey &&
      a.success &&
      new Date(a.createdAt).getTime() > dayAgo
    );
    const maxPerDay = settings?.maxBookingsPerDayPerPhone ?? 2;
    if (phoneAttempts.length >= maxPerDay) {
      this.logAttempt({ psychologistId, phone, success: false, reason: 'phone_day_limit' });
      return { ok: false, message: 'Лимит записей на сегодня для этого номера исчерпан.' };
    }

    // 6. Активные неоплаченные hold
    const maxUnpaid = settings?.maxActiveUnpaidPerPhone ?? 1;
    const unpaid = db.sessions.filter(s => {
      if (s.psychologistId !== psychologistId) return false;
      if (!['held', 'pending'].includes(s.status)) return false;
      if (s.paymentStatus !== 'unpaid') return false;
      const client = db.clients.find(c => c.id === s.clientId);
      return client && normalizePhone(client.phone) === phoneKey;
    });
    if (unpaid.length >= maxUnpaid) {
      this.logAttempt({ psychologistId, phone, success: false, reason: 'unpaid_hold' });
      return { ok: false, message: 'У вас уже есть неоплаченная заявка. Оплатите её или дождитесь истечения резерва.' };
    }

    // 7. Cooldown после отмены
    const cooldownMs = (settings?.cooldownMinutesAfterCancel ?? 120) * 60 * 1000;
    const recentCancel = db.sessions
      .filter(s => {
        if (s.psychologistId !== psychologistId || s.status !== 'cancelled') return false;
        const client = db.clients.find(c => c.id === s.clientId);
        return client && normalizePhone(client.phone) === phoneKey;
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
    // use updated - we don't have cancelledAt; approximate via createdAt is weak.
    // Better: check clients cancelCount cooldown via last session cancel - skip if no timestamp

    // 8. Риск-уровень
    let riskLevel = 'low';
    if (risk.noShowTotal > 0 || risk.cancelTotal >= 3) riskLevel = 'medium';
    if (risk.fraudFlags > 0 || risk.cancelTotal >= 5) riskLevel = 'high';

    // 9. Новый клиент + высокая политика оплаты уже обрабатывается payment layer

    return { ok: true, riskLevel, phoneKey, risk };
  }

  recordNoShow(clientId) {
    const client = db.clients.find(c => c.id === clientId);
    if (!client) return;
    client.noShowCount = (client.noShowCount || 0) + 1;
    client.trustLevel = client.noShowCount >= 2 ? 'caution' : client.trustLevel;
    const key = normalizePhone(client.phone);
    if (key) {
      const risk = this.getOrCreateRisk(key);
      risk.noShowTotal = (risk.noShowTotal || 0) + 1;
      risk.updatedAt = new Date().toISOString();
      if (risk.noShowTotal >= 2) {
        risk.blocked = true;
        risk.blockReason = 'Повторные неявки';
      }
    }
    db.saveChanges();
  }

  recordCancel(clientId) {
    const client = db.clients.find(c => c.id === clientId);
    if (!client) return;
    client.cancelCount = (client.cancelCount || 0) + 1;
    const key = normalizePhone(client.phone);
    if (key) {
      const risk = this.getOrCreateRisk(key);
      risk.cancelTotal = (risk.cancelTotal || 0) + 1;
      risk.updatedAt = new Date().toISOString();
    }
    db.saveChanges();
  }

  unblockPhone(phone) {
    const key = normalizePhone(phone);
    const risk = db.clientRisks.find(r => r.phoneKey === key);
    if (risk) {
      risk.blocked = false;
      risk.blockReason = '';
      risk.updatedAt = new Date().toISOString();
      db.saveChanges();
    }
  }

  markTrusted(clientId) {
    const client = db.clients.find(c => c.id === clientId);
    if (client) {
      client.trustLevel = 'trusted';
      client.verifiedContact = true;
      db.saveChanges();
    }
  }
}

export const fraudProtectionService = new FraudProtectionService();
