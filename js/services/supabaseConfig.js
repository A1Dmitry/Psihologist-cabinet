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
