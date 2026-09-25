/**
 * Supabase project (бесплатно, без карты)
 * URL: https://phiavtroybgwyjdhqqkh.supabase.co
 *
 * anon key: Dashboard → Project Settings → API → anon public
 * НЕ вставляйте service_role.
 */
export const SUPABASE_URL = 'https://phiavtroybgwyjdhqqkh.supabase.co';

/**
 * Вставьте anon public key из:
 * Dashboard → Project Settings → API → Project API keys → anon public
 * Вид: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 * (НЕ project ref и НЕ service_role)
 */
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoaWF2dHJveWJnd3lqZGhxcWtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5ODc3NDQsImV4cCI6MjEwNTU2Mzc0NH0.ioK3zmYd_CbhXxsN5PbDlNvYSzppHz77fSbZZir8uJQ';

/**
 * Google OAuth Web Client ID (public; never put a Client Secret in this file).
 * Configure either this constant or inject `window.PSY_GOOGLE_CLIENT_ID` before
 * loading js/app.js. Empty by default so the triage-attachment flow stays
 * disabled until the owner configures the Google + Supabase providers.
 */
export const GOOGLE_CLIENT_ID = String(globalThis.PSY_GOOGLE_CLIENT_ID || '').trim();

/**
 * Канонический URL приложения для писем и Auth redirect (issue #23).
 *
 * Единственный клиентский source of truth для «куда вести пользователя из email».
 * НЕ брать window.location при генерации письма на сервере — email открывают
 * на другом устройстве; localhost из dev-сессии туда попадать не должен.
 *
 * GitHub Pages: https://{owner}.github.io/{repo}/
 * Кастомный домен: заменить на https://ваш-домен/ и Site URL в Supabase Auth.
 *
 * Edge Function auth-code читает тот же URL из секрета APP_URL (см. docs/INFRA.md);
 * если секрет не задан — функция использует это же значение по умолчанию.
 */
export const APPLICATION_URL = 'https://a1dmitry.github.io/Psihologist-cabinet/';

/**
 * Первые сегменты пути, которые являются МАРШРУТАМИ роутера, а не base path
 * приложения (`/Psihologist-cabinet/`, `/`). Единый список для всех мест, где
 * приложение вычисляет свою базу: раньше сегменты были перечислены в двух
 * функциях по-разному, и новый маршрут легко забыть (§6.14 — один источник
 * истины для канонической логики).
 */
const ROUTE_SEGMENTS = new Set([
  'auth', 'cabinet', 'onboarding', 'booking-done', 'reply', 'book', 'psy'
]);

/**
 * URL приложения «здесь и сейчас» для client-side redirect_to.
 * - на production/preview origin (не loopback) — текущий origin + base path;
 * - на localhost/127.0.0.1 — всегда APPLICATION_URL (письмо/OTP не должны
 *   уводить на машину разработчика).
 */
export function resolveApplicationUrl() {
  const fallback = normalizeAppUrl(APPLICATION_URL);
  try {
    const loc = globalThis.location;
    if (!loc?.origin) return fallback;
    if (isLoopbackHost(loc.hostname || '')) return fallback;
    const baseEl = globalThis.document?.querySelector?.('base[href]');
    if (baseEl?.href) return normalizeAppUrl(baseEl.href);
    // Pages path: /Psihologist-cabinet/… → base = origin + first segment
    const seg = String(loc.pathname || '/').split('/').filter(Boolean)[0];
    if (seg && !ROUTE_SEGMENTS.has(seg.toLowerCase())) {
      return normalizeAppUrl(`${loc.origin}/${seg}/`);
    }
    return normalizeAppUrl(`${loc.origin}/`);
  } catch {
    return fallback;
  }
}

/** Страница входа для deep-link из письма: …/#/auth */
export function resolveAuthEntryUrl(query = {}) {
  const base = resolveApplicationUrl().replace(/\/?$/, '/');
  const qs = new URLSearchParams();
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v != null && String(v) !== '') qs.set(k, String(v));
  });
  const q = qs.toString();
  return `${base}#/auth${q ? `?${q}` : ''}`;
}

export function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

function normalizeAppUrl(url) {
  const s = String(url || '').trim();
  if (!s) return 'https://a1dmitry.github.io/Psihologist-cabinet/';
  return s.endsWith('/') ? s : `${s}/`;
}

export function isSupabaseConfigured() {
  return !!(
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    SUPABASE_ANON_KEY.startsWith('eyJ') &&
    SUPABASE_ANON_KEY.length > 40
  );
}

/**
 * Опционально: URL Edge Function для мгновенных Telegram-уведомлений с ПУБЛИЧНОЙ
 * страницы записи (токен бота нельзя светить на клиенте). Код функции —
 * supabase/functions/telegram-notify/index.ts. Пусто = уведомления уходят,
 * когда психолог открывает кабинет (outbox-режим).
 */
export const NOTIFY_WEBHOOK_URL = '';
