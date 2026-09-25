/**
 * TelegramService — уведомления через Telegram-бота психолога.
 * Настройка — в кабинете, вкладка «Уведомления» (админ-часть): токен бота,
 * чат психолога, переключатели событий. Токен хранится в настройках кабинета
 * (сервер, RLS-владелец) и НЕ публикуется на публичных страницах.
 *
 * События:
 *  - новая запись → психолог (outbox: если запись пришла, когда браузер психолога
 *    был закрыт, уведомление уйдёт при следующем открытии кабинета/по таймеру);
 *  - напоминание о сессии → клиенту, подключившему бота (/start <clientId>);
 *  - оплаты → психологу (через cabinetApi.pushSessionPatch точки).
 * Для мгновенной доставки с публичной страницы записи — опциональный
 * NOTIFY_WEBHOOK_URL (Edge Function, см. supabase/functions/telegram-notify).
 */
import { db } from '../core/dbContext.js';
import { cabinetApi } from './cabinetApi.js';
import { NOTIFY_WEBHOOK_URL } from './supabaseConfig.js';

function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function call(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram HTTP ${res.status}`);
  return data.result;
}

export const telegramService = {
  /** Настройки кабинета (или заглушка) */
  config() {
    const st = db.settings.find(x => x.psychologistId === db.currentPsychologistId)
      || db.settings[0] || null;
    return {
      enabled: !!(st?.telegramBotToken && st?.telegramChatId),
      botToken: st?.telegramBotToken || '',
      chatId: st?.telegramChatId || '',
      botName: st?.telegramBotName || '',
      notifyBooking: st ? st.telegramNotifyBooking !== false : true,
      notifyReminders: st ? st.telegramNotifyReminders !== false : true,
      notifyPayments: st ? st.telegramNotifyPayments !== false : true,
      settings: st
    };
  },

  /** Проверка токена: возвращает @username бота */
  async testToken(botToken) {
    const me = await call(botToken, 'getMe', {});
    return me.username || '';
  },

  /** Последние чаты, написавшие боту (для выбора «это я» и привязки клиентов) */
  async recentChats(botToken) {
    const updates = await call(botToken, 'getUpdates', { limit: 50, allowed_updates: ['message'] });
    const seen = new Map();
    (updates || []).forEach(u => {
      const m = u.message;
      if (!m || !m.chat) return;
      seen.set(String(m.chat.id), {
        chatId: String(m.chat.id),
        name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.chat.title || '',
        text: m.text || '',
        date: m.date || 0
      });
    });
    return [...seen.values()].sort((a, b) => b.date - a.date);
  },

  /** Отправить текст психологу (уважает переключатели событий) */
  async sendToPsychologist(event, html) {
    const cfg = this.config();
    if (!cfg.enabled) return { ok: false, reason: 'not-configured' };
    if (event === 'booking' && !cfg.notifyBooking) return { ok: false, reason: 'disabled' };
    if (event === 'payment' && !cfg.notifyPayments) return { ok: false, reason: 'disabled' };
    try {
      await call(cfg.botToken, 'sendMessage', {
        chat_id: cfg.chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      return { ok: true };
    } catch (e) {
      console.warn('[Telegram] психологу не отправлено:', e.message);
      return { ok: false, reason: String(e.message || e) };
    }
  },

  /** Отправить клиенту (если подключил бота) */
  async sendToClient(client, html) {
    const cfg = this.config();
    if (!cfg.enabled || !client?.telegramChat) return { ok: false, reason: 'not-configured' };
    if (!cfg.notifyReminders) return { ok: false, reason: 'disabled' };
    try {
      await call(cfg.botToken, 'sendMessage', {
        chat_id: client.telegramChat,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      return { ok: true };
    } catch (e) {
      console.warn('[Telegram] клиенту не отправлено:', e.message);
      return { ok: false, reason: String(e.message || e) };
    }
  },

  /**
   * Мгновенное уведомление с публичной страницы (без токена на клиенте):
   * POST на NOTIFY_WEBHOOK_URL (Edge Function telegram-notify с секретом бота).
   * session_created_at → функция двигает watermark last_notified_session_at,
   * чтобы outbox в кабинете не продублировал уведомление.
   * Без настроенного webhook уведомление уйдёт при следующем открытии кабинета (outbox).
   */
  async notifyViaWebhook(psychologistId, event, text, createdAt) {
    if (!NOTIFY_WEBHOOK_URL) return { ok: false, reason: 'no-webhook' };
    try {
      await fetch(NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          psychologist_id: psychologistId,
          event,
          text,
          session_created_at: createdAt || null
        })
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    }
  },

  /** Уведомление о новой записи (психологу) */
  bookingText(s, client, service, { hasAdditionalInfo = !!s.note } = {}) {
    return [
      '🟢 <b>Новая запись</b>',
      `Клиент: ${escHtml(client?.name || client?.nickname || '—')}`,
      `Когда: ${escHtml(s.date)} в ${escHtml(s.time)}`,
      service ? `Услуга: ${escHtml(service.name)} · ${service.priceLabel()}` : '',
      // Не отправляем свободный текст и ответы анкеты во внешний мессенджер.
      hasAdditionalInfo ? 'Дополнительная информация есть в кабинете.' : ''
    ].filter(Boolean).join('\n');
  },

  /**
   * Outbox: новые записи, о которых психолог ещё не уведомлён
   * (созданы после lastNotifiedSessionAt). Вызывается при открытии кабинета и по таймеру.
   */
  async notifyNewBookings(psychologistId) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.notifyBooking || !cfg.settings) return { sent: 0 };
    const since = cfg.settings.lastNotifiedSessionAt || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const fresh = db.sessions
      .filter(s => s.psychologistId === psychologistId && s.createdAt && s.createdAt > since)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    let sent = 0;
    for (const s of fresh) {
      const client = db.clients.find(c => c.id === s.clientId);
      const service = db.services.find(x => x.id === s.serviceId);
      const r = await this.sendToPsychologist('booking', this.bookingText(s, client, service));
      if (r.ok) sent++;
    }
    if (fresh.length) {
      cfg.settings.lastNotifiedSessionAt = new Date().toISOString();
      db.saveChanges();
      cabinetApi.pushSettings(psychologistId, cfg.settings);
    }
    return { sent, total: fresh.length };
  },

  /** Должные напоминания → клиенту в Telegram (помечает отправленными) */
  async sendDueReminders(psychologistId) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.notifyReminders) return { sent: 0 };
    const now = Date.now();
    let sent = 0;
    for (const r of db.reminders) {
      if (r.psychologistId !== psychologistId) continue;
      if (r.status !== 'scheduled' || !r.scheduledFor) continue;
      if (new Date(r.scheduledFor).getTime() > now) continue;
      const s = db.sessions.find(x => x.id === r.sessionId);
      const client = db.clients.find(c => c.id === r.clientId);
      if (!s || !client?.telegramChat) continue;
      const text = [
        `⏰ <b>Напоминание о сессии</b>`,
        `${escHtml(s.date)} в ${escHtml(s.time)}${s.meetLink ? `\nПодключиться: ${escHtml(s.meetLink)}` : ''}`,
        `Если время не подходит — ответьте на это сообщение.`
      ].join('\n');
      const res = await this.sendToClient(client, text);
      if (res.ok) {
        r.status = 'sent';
        r.sentAt = new Date().toISOString();
        r.channel = 'telegram';
        sent++;
      }
    }
    if (sent) db.saveChanges();
    return { sent };
  },

  /**
   * Привязка чатов клиентов: клиент пишет боту «/start <clientId>» →
   * chat_id сохраняется в карточке клиента. Возвращает число новых привязок.
   */
  async linkClientChats(psychologistId) {
    const cfg = this.config();
    if (!cfg.botToken) return { linked: 0, chats: [] };
    const updates = await call(cfg.botToken, 'getUpdates', { limit: 50, allowed_updates: ['message'] });
    const chats = await this.recentChats(cfg.botToken);
    let linked = 0;
    for (const u of updates || []) {
      const m = u.message;
      const mm = /^\/start\s+([A-Za-z0-9_-]+)/.exec(m?.text || '');
      if (!mm) continue;
      const client = db.clients.find(c => c.id === mm[1] && c.psychologistId === psychologistId);
      if (client && !client.telegramChat) {
        client.telegramChat = String(m.chat.id);
        linked++;
      }
    }
    if (linked) db.saveChanges();
    return { linked, chats };
  }
};
