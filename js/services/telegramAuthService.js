/**
 * Безопасный вход специалиста из Telegram Mini App.
 * Telegram initData никогда не считается проверенным в браузере: его
 * подпись проверяет Edge Function, а привязка выполняется только после входа
 * в существующий кабинет через Supabase Auth.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, TELEGRAM_AUTH_URL } from './supabaseConfig.js';
import { persistSession, readPersistedSession, supabaseApi } from './supabaseApi.js';
import { googleAuthService } from './googleAuthService.js';

function webApp() {
  return globalThis.Telegram?.WebApp || globalThis.window?.Telegram?.WebApp || null;
}

export const telegramAuthService = {
  prepare() {
    const app = webApp();
    if (!app) return false;
    try { app.ready?.(); } catch { /* SDK methods are optional across clients */ }
    try { app.expand?.(); } catch { /* SDK methods are optional across clients */ }
    return true;
  },

  isAvailable() {
    return !!String(webApp()?.initData || '').trim();
  },

  async request(action, extra = {}) {
    const initData = String(webApp()?.initData || '').trim();
    if (!initData) throw new Error('Откройте кабинет из Telegram Mini App, чтобы использовать вход через Telegram.');
    const session = readPersistedSession();
    const response = await fetch(TELEGRAM_AUTH_URL, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${action === 'link' ? session?.access_token || SUPABASE_ANON_KEY : SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action, init_data: initData, ...extra })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok !== true) {
      throw new Error(data?.error || 'Не удалось подтвердить аккаунт Telegram. Повторите попытку.');
    }
    return data;
  },

  async signIn({ createIfMissing = false } = {}) {
    const result = await this.request('login', { create_if_missing: !!createIfMissing });
    if (result.needs_signup) return { needsSignup: true };
    const tokenHash = result.token_hash;
    if (!tokenHash) throw new Error('Сервер Telegram-входа не вернул одноразовый токен.');
    const session = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_hash: tokenHash, type: 'magiclink' })
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.access_token) {
        throw new Error(data?.msg || data?.message || 'Supabase не создал сессию Telegram-входа.');
      }
      return data;
    });
    persistSession(session);
    await googleAuthService.refreshUser();
    return { session, created: !!result.created };
  },

  async linkOrCreateCabinet() {
    try {
      const result = await supabaseApi.linkTelegramSpecialist();
      if (result?.ok !== true) {
        return { ok: false, head: String(result?.error || 'Не удалось создать кабинет Telegram.'), code: result?.code || '' };
      }
      return { ok: true, id: result.id, profileCompleted: result.profile_completed !== false, created: !!result.created };
    } catch (error) {
      return { ok: false, head: String(error?.message || 'Не удалось создать кабинет Telegram.') };
    }
  },

  async completeProfile(profile) {
    try {
      const result = await supabaseApi.completeTelegramProfile(profile);
      return result?.ok === true
        ? { ok: true, id: result.id }
        : { ok: false, message: String(result?.error || 'Не удалось сохранить Telegram-профиль.') };
    } catch (error) {
      return { ok: false, message: String(error?.message || 'Не удалось сохранить Telegram-профиль.') };
    }
  },

  async linkCurrentAccount() {
    await this.request('link');
    return true;
  }
};
