/**
 * ReminderService — напоминания о записи с подтверждением / отказом
 *
 * Рекомендуемая практика (therapy / healthcare):
 * - основной запрос подтверждения: за 24 часа
 * - повтор, если молчание: за 12 часов
 * - опционально короткий nudge за 2 часа (день сессии)
 *
 * Канал в демо: «сообщение» (SMS/Telegram/email); в проде — провайдер.
 */
import { db } from '../core/dbContext.js';
import { SessionReminder } from '../models/entities.js';
import { fraudProtectionService, normalizePhone } from './fraudProtectionService.js';

function uid(prefix = 'rem') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function token() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function sessionDateTime(session) {
  // local interpretation of date+time
  return new Date(`${session.date}T${session.time || '12:00'}:00`);
}

function formatWhen(session) {
  try {
    const d = sessionDateTime(session);
    return d.toLocaleString('ru-RU', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return `${session.date} ${session.time}`;
  }
}

export class ReminderService {
  buildMessage(session, psychologist, client, kind = 'confirm_request') {
    const when = formatWhen(session);
    const display = client?.nickname || client?.name || 'Здравствуйте';
    const psy = psychologist?.fullName || 'психолог';
    const meet = session.meetLink
      ? `\nСсылка на встречу: ${session.meetLink}`
      : (session.videoPlatform === 'google_meet' ? '\nФормат: онлайн (Google Meet) — ссылку пришлём отдельно.' : '\nФормат: очная встреча.');

    if (kind === 'day_of_nudge') {
      return `${display}, напоминание: сегодня сессия с ${psy} в ${session.time}.${meet}\nДо встречи.`;
    }

    if (kind === 'reschedule_request' && session.pendingChange) {
      const ch = session.pendingChange;
      const old = session.previousSlot
        ? `${session.previousSlot.date} ${session.previousSlot.time}`
        : `${session.date} ${session.time}`;
      const reason = ch.reason ? `\nПричина: ${ch.reason}` : '';
      return `${display}, психолог ${psy} предлагает перенести вашу сессию.

Было: ${old}
Предлагается: ${ch.date} в ${ch.time}${reason}

Пожалуйста, ответьте:
• ПОДТВЕРДИТЬ — согласны на новое время
• ОТКАЗАТЬСЯ — оставить как было или отменить (психолог свяжется с вами)`;
    }

    return `${display}, напоминание о записи к ${psy}: ${when}.${meet}

Пожалуйста, ответьте:
• ПОДТВЕРДИТЬ — если придёте
• ОТКАЗАТЬСЯ — если нужно отменить (освободим слот)

Это помогает сохранить время для вас и для других клиентов.`;
  }

  /** Уведомление клиенту о переносе — нужно согласие */
  notifyReschedule(sessionId, { newDate, newTime, reason = '' } = {}) {
    const session = db.sessions.find(s => s.id === sessionId);
    if (!session) return { ok: false, message: 'Сессия не найдена' };

    session.previousSlot = { date: session.date, time: session.time };
    session.pendingChange = {
      date: newDate,
      time: newTime,
      reason: reason || '',
      proposedAt: new Date().toISOString()
    };
    session.changeConsentStatus = 'pending';
    // слот в UI: держим старый до согласия; блокируем и новый через pendingChange в slots logic optional

    const client = db.clients.find(c => c.id === session.clientId);
    const psy = db.psychologists.find(p => p.id === session.psychologistId);
    const rem = new SessionReminder({
      id: uid('rem'),
      sessionId: session.id,
      psychologistId: session.psychologistId,
      clientId: session.clientId,
      kind: 'reschedule_request',
      scheduledFor: new Date().toISOString(),
      status: 'sent',
      sentAt: new Date().toISOString(),
      channel: 'telegram_sms',
      messageBody: this.buildMessage(session, psy, client, 'reschedule_request'),
      responseToken: token()
    });
    db.reminders.push(rem);
    db.saveChanges();
    return { ok: true, reminder: rem, message: 'Клиенту отправлен запрос на согласие с переносом' };
  }

  /** Запланировать напоминания при создании/подтверждении сессии */
  scheduleForSession(sessionId) {
    const session = db.sessions.find(s => s.id === sessionId);
    if (!session) return [];
    if (['cancelled', 'expired', 'no_show', 'done'].includes(session.status)) return [];

    const settings = db.settingsOf(session.psychologistId);
    if (!settings.reminderEnabled) return [];

    // не дублировать
    const existing = db.reminders.filter(r => r.sessionId === sessionId && r.status === 'scheduled');
    if (existing.length) return existing;

    const start = sessionDateTime(session);
    const now = Date.now();
    const hoursMain = settings.reminderHoursBefore ?? 24;
    const hoursSecond = settings.reminderSecondHoursBefore; // 12 default, 0 = off
    const created = [];

    const plan = (hours, kind) => {
      const at = new Date(start.getTime() - hours * 60 * 60 * 1000);
      // если уже позже — отправить «скоро» (через 1 мин в демо) только если сессия ещё в будущем
      let scheduledFor = at;
      if (at.getTime() < now) {
        if (start.getTime() <= now) return; // сессия прошла
        scheduledFor = new Date(now + 30 * 1000); // демо: почти сразу
      }
      const client = db.clients.find(c => c.id === session.clientId);
      const psy = db.psychologists.find(p => p.id === session.psychologistId);
      const rem = new SessionReminder({
        id: uid('rem'),
        sessionId: session.id,
        psychologistId: session.psychologistId,
        clientId: session.clientId,
        kind,
        scheduledFor: scheduledFor.toISOString(),
        status: 'scheduled',
        channel: settings.reminderChannel || 'telegram_sms',
        messageBody: this.buildMessage(session, psy, client, kind),
        responseToken: token()
      });
      db.reminders.push(rem);
      created.push(rem);
    };

    plan(hoursMain, 'confirm_request');
    if (hoursSecond > 0 && hoursSecond < hoursMain) {
      plan(hoursSecond, 'confirm_request');
    }

    db.saveChanges();
    return created;
  }

  /** «Отправка» due-напоминаний (демо-тик / кнопка в кабинете) */
  processDue(psychologistId = null) {
    const now = Date.now();
    let sent = 0;
    const outbox = [];

    db.reminders.forEach(r => {
      if (r.status !== 'scheduled') return;
      if (psychologistId && r.psychologistId !== psychologistId) return;
      if (new Date(r.scheduledFor).getTime() > now) return;

      const session = db.sessions.find(s => s.id === r.sessionId);
      if (!session || ['cancelled', 'expired', 'no_show', 'done'].includes(session.status)) {
        r.status = 'skipped';
        return;
      }
      // уже ответил клиент
      if (session.clientResponse === 'confirmed' || session.clientResponse === 'declined') {
        r.status = 'skipped';
        return;
      }

      r.status = 'sent';
      r.sentAt = new Date().toISOString();
      sent++;
      const client = db.clients.find(c => c.id === r.clientId);
      outbox.push({
        reminderId: r.id,
        to: client?.phone || client?.contact || 'клиент',
        body: r.messageBody,
        token: r.responseToken
      });
    });

    if (sent) db.saveChanges();
    return { sent, outbox };
  }

  /** Клиент подтверждает или отказывается по токену */
  respond(token, response) {
    const r = db.reminders.find(x => x.responseToken === token);
    if (!r) return { ok: false, message: 'Ссылка устарела или неверна' };
    if (!['sent', 'scheduled'].includes(r.status) && r.status !== 'confirmed' && r.status !== 'declined') {
      // allow respond on sent
    }
    const session = db.sessions.find(s => s.id === r.sessionId);
    if (!session) return { ok: false, message: 'Сессия не найдена' };
    if (['cancelled', 'done', 'expired'].includes(session.status)) {
      return { ok: false, message: 'Сессия уже закрыта' };
    }

    const resp = response === 'declined' ? 'declined' : 'confirmed';
    const now = new Date().toISOString();

    r.status = resp;
    r.respondedAt = now;
    session.clientRespondedAt = now;

    db.reminders.forEach(x => {
      if (x.sessionId === session.id && x.id !== r.id && x.status === 'scheduled') {
        x.status = 'skipped';
      }
    });

    // —— Перенос: согласие на новое время ——
    if (r.kind === 'reschedule_request' && session.pendingChange) {
      if (resp === 'confirmed') {
        session.date = session.pendingChange.date;
        session.time = session.pendingChange.time;
        session.changeConsentStatus = 'confirmed';
        session.clientResponse = 'change_confirmed';
        session.pendingChange = null;
        // перепланировать обычные напоминания
        db.reminders.filter(x => x.sessionId === session.id && x.status === 'scheduled').forEach(x => { x.status = 'skipped'; });
        db.saveChanges();
        this.scheduleForSession(session.id);
        return { ok: true, response: resp, session, message: 'Перенос подтверждён. Новое время сохранено.' };
      }
      // отказ от переноса — оставляем старый слот
      session.changeConsentStatus = 'declined';
      session.clientResponse = 'change_declined';
      session.pendingChange = null;
      session.previousSlot = null;
      db.saveChanges();
      return { ok: true, response: resp, session, message: 'Перенос отклонён. Остаётся прежнее время; психолог может связаться с вами.' };
    }

    session.clientResponse = resp;

    if (resp === 'declined') {
      session.status = 'cancelled';
      fraudProtectionService.recordCancel(session.clientId);
    } else if (session.status === 'pending' || session.status === 'held') {
      if (!session.requiresPayment || session.paymentStatus === 'deposit_paid' || session.paymentStatus === 'fully_paid') {
        if (session.status !== 'paid') session.status = 'confirmed';
      }
    }

    db.saveChanges();
    return {
      ok: true,
      response: resp,
      session,
      message: resp === 'confirmed'
        ? 'Спасибо! Запись подтверждена.'
        : 'Запись отменена. Слот освобождён.'
    };
  }

  remindersOf(psychologistId) {
    return db.reminders
      .filter(r => r.psychologistId === psychologistId)
      .sort((a, b) => (b.scheduledFor || '').localeCompare(a.scheduledFor || ''));
  }

  forSession(sessionId) {
    return db.reminders.filter(r => r.sessionId === sessionId);
  }

  /** Демо: найти последнее отправленное напоминание клиента для UI ответа */
  latestOpenForClientPhone(phone) {
    const key = normalizePhone(phone);
    const clients = db.clients.filter(c => normalizePhone(c.phone) === key);
    const ids = new Set(clients.map(c => c.id));
    return db.reminders
      .filter(r => ids.has(r.clientId) && (r.status === 'sent' || r.status === 'scheduled'))
      .sort((a, b) => (b.sentAt || b.scheduledFor || '').localeCompare(a.sentAt || a.scheduledFor || ''))[0] || null;
  }
}

export const reminderService = new ReminderService();
