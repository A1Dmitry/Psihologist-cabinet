/**
 * ErrorLogService — отправка критичных фронтенд-ошибок в Supabase
 * (таблица client_error_logs, см. supabase/schema.sql).
 *
 * Зачем: визуальный баннер boot-error видит только сам пользователь;
 * здесь та же ошибка уходит на сервер, чтобы не зависеть от скриншотов.
 *
 * Гарантии:
 *  - fire-and-forget: никогда не бросает исключений и не блокирует UI;
 *  - лимит MAX_REPORTS на загрузку страницы + дедупликация сообщений
 *    (всплеск одинаковых ошибок не зафлудит таблицу);
 *  - без PII: url, user-agent, текст ошибки, стек (обрезаны), произвольный extra.
 *  - если Supabase не настроен/недоступен — молча деградирует (баннер в index.html
 *    по-прежнему показывает ошибку пользователю).
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from './supabaseConfig.js';

const MAX_REPORTS = 5;                 // на одну загрузку страницы
const MAX_FIELD = 2000;                // message / url
const MAX_STACK = 4000;
const sent = new Set();
let sentCount = 0;

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);

/**
 * @param {'error'|'rejection'|'boot'|'catalog'} level
 * @param {{message?:unknown, stack?:unknown, route?:string, url?:string, extra?:object}} payload
 */
export function reportClientError(level, payload = {}) {
  try {
    if (!isSupabaseConfigured()) return;
    if (sentCount >= MAX_REPORTS) return;

    const message = cut(payload.message, MAX_FIELD);
    if (!message) return;
    const dedupeKey = `${level}|${message}`;
    if (sent.has(dedupeKey)) return;
    sent.add(dedupeKey);
    sentCount += 1;

    const loc = (typeof window !== 'undefined' && window.location) || {};
    const body = {
      level: cut(level, 24),
      message,
      stack: cut(payload.stack, MAX_STACK),
      route: cut(payload.route ?? loc.pathname, 512),
      url: cut(payload.url ?? loc.href, 512),
      user_agent: cut(typeof navigator !== 'undefined' ? navigator.userAgent : '', 512),
      app_version: cut(document?.querySelector?.('script[type="module"][src*="js/app.js"]')?.src?.split('v=')[1] || '', 64),
      extra: payload.extra && typeof payload.extra === 'object' ? payload.extra : {}
    };

    fetch(`${SUPABASE_URL}/rest/v1/client_error_logs`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body),
      keepalive: true
    }).catch(() => { /* логер не должен падать */ });
  } catch { /* никогда не мешаем основному коду */ }
}
