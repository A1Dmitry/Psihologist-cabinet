import { safeStorage } from '../core/safeStorage.js';
import { supabaseApi } from './supabaseApi.js';
import { GOOGLE_CLIENT_ID, isSupabaseConfigured } from './supabaseConfig.js';

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const PROFILE_STORAGE_KEY = 'psihologist_client_auth';
const SESSION_STORAGE_KEY = 'psy_client_google_session_v1';
const EXPIRY_SKEW_SECONDS = 60;

let gisScriptPromise = null;
let activeAttempt = null;
let attemptSequence = 0;
let currentSession = null;
let currentUser = null;

function clone(value) {
  return value ? { ...value } : null;
}

function sessionStorageOrNull() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function readStoredSession() {
  try {
    const raw = sessionStorageOrNull()?.getItem(SESSION_STORAGE_KEY);
    const session = raw ? JSON.parse(raw) : null;
    return session?.access_token && session?.refresh_token ? session : null;
  } catch {
    return null;
  }
}

function storeSession(session) {
  currentSession = session;
  try {
    sessionStorageOrNull()?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch { /* private browsing / storage disabled — keep the tab's memory session */ }
}

function clearSessionStorage() {
  try { sessionStorageOrNull()?.removeItem(SESSION_STORAGE_KEY); } catch { /* storage may be disabled */ }
}

function normalizeSession(data) {
  if (!data?.access_token || !data?.refresh_token) {
    throw new Error('Supabase Auth не вернул клиентскую сессию');
  }
  const expiresIn = Number(data.expires_in) || 3600;
  return {
    access_token: String(data.access_token),
    refresh_token: String(data.refresh_token),
    expires_at: Number(data.expires_at) || Math.floor(Date.now() / 1000) + expiresIn,
    token_type: data.token_type || 'bearer'
  };
}

function isExpiring(session) {
  return !session?.expires_at || Number(session.expires_at) <= Math.floor(Date.now() / 1000) + EXPIRY_SKEW_SECONDS;
}

function googleProfileFromAuthUser(authUser) {
  if (!authUser || typeof authUser !== 'object') {
    throw new Error('Supabase Auth не вернул пользователя Google');
  }
  const identities = Array.isArray(authUser.identities) ? authUser.identities : [];
  const identity = identities.find(item => item?.provider === 'google') || null;
  const identityData = identity?.identity_data || {};
  const metadata = authUser.user_metadata || {};
  const identityEmail = String(identityData.email || '').trim().toLowerCase();
  const authEmail = String(authUser.email || '').trim().toLowerCase();
  const email = identityEmail || authEmail || String(metadata.email || '').trim().toLowerCase();
  const verified = !!(
    identityData.email_verified === true ||
    (authUser.email_confirmed_at && authEmail && authEmail === email)
  );
  const googleId = String(identityData.sub || identity?.id || '');

  if (!identity) throw new Error('Подтвердите вход именно через Google');
  if (!email || !verified) throw new Error('Google не подтвердил email — опрос не прикреплён');
  if (!googleId) throw new Error('Supabase не вернул подтверждённый Google ID');
  if (!authUser.id) throw new Error('Supabase не вернул ID учётной записи');

  const name = String(
    identityData.name || metadata.full_name || metadata.name ||
    [metadata.given_name, metadata.family_name].filter(Boolean).join(' ') || email
  ).trim();
  const picture = String(identityData.picture || metadata.avatar_url || metadata.picture || '').trim();
  return {
    google_id: googleId,
    auth_user_id: String(authUser.id || ''),
    name: name || email,
    email,
    picture,
    email_verified: true,
    provider: 'google'
  };
}

function cacheDisplayProfile(user) {
  // Display-only cache. It is never accepted as proof of identity; every use of
  // the auth session is checked/refreshed through Supabase Auth first.
  safeStorage.setJSON(PROFILE_STORAGE_KEY, {
    name: user.name,
    email: user.email,
    picture: user.picture,
    provider: 'google'
  });
}

function nonceHex(bytes = 32) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error('Для безопасного входа нужен современный браузер');
  const random = new Uint8Array(bytes);
  cryptoApi.getRandomValues(random);
  return Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle?.digest || typeof TextEncoder === 'undefined') {
    throw new Error('Браузер не поддерживает безопасный nonce для Google');
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function gisAvailable() {
  return !!globalThis.google?.accounts?.id;
}

function loadGoogleIdentityServices() {
  if (gisAvailable()) return Promise.resolve(globalThis.google);
  if (gisScriptPromise) return gisScriptPromise;
  if (typeof document === 'undefined') return Promise.reject(new Error('Google Sign-In доступен только в браузере'));

  gisScriptPromise = new Promise((resolve, reject) => {
    const onLoaded = () => {
      if (gisAvailable()) resolve(globalThis.google);
      else reject(new Error('Библиотека Google Sign-In загрузилась некорректно'));
    };
    const onFailed = () => reject(new Error('Не удалось загрузить Google Sign-In. Проверьте соединение и блокировщик рекламы.'));
    const existing = document.querySelector?.(`script[src="${GIS_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener?.('load', onLoaded, { once: true });
      existing.addEventListener?.('error', onFailed, { once: true });
      // A script injected by another feature may already have fired load.
      if (gisAvailable()) onLoaded();
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = onLoaded;
    script.onerror = onFailed;
    (document.head || document.body).appendChild(script);
  }).catch(error => {
    gisScriptPromise = null;
    throw error;
  });
  return gisScriptPromise;
}

function dispatchAuthenticated(user) {
  try {
    const detail = {
      name: user.name,
      email: user.email,
      picture: user.picture,
      google_id: user.google_id,
      auth_user_id: user.auth_user_id,
      email_verified: true
    };
    if (typeof globalThis.CustomEvent === 'function') {
      globalThis.dispatchEvent?.(new globalThis.CustomEvent('user_authenticated', { detail }));
      globalThis.document?.dispatchEvent?.(new globalThis.CustomEvent('user_authenticated', { detail }));
    }
  } catch { /* the app also receives the result through the explicit callback */ }
}

async function exchangeCredential(credential, attempt) {
  if (!credential) throw new Error('Google не вернул ID token');
  if (activeAttempt !== attempt || attempt.consumed) return null;
  attempt.consumed = true;
  activeAttempt = null;

  // The raw Google ID token is sent directly to Supabase Auth and is never
  // logged or persisted. Supabase verifies signature, audience, expiry and nonce.
  const data = await supabaseApi.signInWithGoogleIdToken({
    token: credential,
    nonce: attempt.rawNonce
  });
  const session = normalizeSession(data);
  const user = googleProfileFromAuthUser(data.user);
  storeSession(session);
  currentUser = user;
  cacheDisplayProfile(user);
  dispatchAuthenticated(user);
  return { session: clone(session), user: clone(user) };
}

function requireConfigured() {
  if (!GOOGLE_CLIENT_ID) throw new Error('Вход Google пока не настроен: добавьте Web Client ID владельца');
  if (!isSupabaseConfigured()) throw new Error('Supabase не настроен');
}

export const googleClientAuthService = {
  isConfigured() {
    return !!GOOGLE_CLIENT_ID && isSupabaseConfigured();
  },

  /** Display profile only; authorization always uses a Supabase-verified session. */
  getCurrentUser() {
    return clone(currentUser);
  },

  /** The returned object is only suitable for UI. Call getVerifiedSession before use. */
  getCachedUser() {
    return safeStorage.getJSON(PROFILE_STORAGE_KEY, null);
  },

  /**
   * Restore/refresh the tab-scoped Google session and ask GoTrue for its user.
   * A localStorage profile alone is never considered authenticated.
   */
  async getVerifiedSession() {
    requireConfigured();
    let session = currentSession || readStoredSession();
    if (!session) return null;

    if (isExpiring(session)) {
      try {
        const refreshed = await supabaseApi.refreshClientAuthSession(session.refresh_token);
        session = normalizeSession(refreshed);
        storeSession(session);
      } catch {
        this.clearLocalSession();
        return null;
      }
    }

    try {
      const authUser = await supabaseApi.getClientAuthUser(session.access_token);
      const user = googleProfileFromAuthUser(authUser);
      currentSession = session;
      currentUser = user;
      cacheDisplayProfile(user);
      return { session: clone(session), user: clone(user) };
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) this.clearLocalSession();
      throw error;
    }
  },

  /** Mount the standard Google button after the user explicitly chose to attach triage. */
  async renderGoogleButton(containerOrId, { onSuccess, onError } = {}) {
    requireConfigured();
    const container = typeof containerOrId === 'string'
      ? document.getElementById(containerOrId)
      : containerOrId;
    if (!container) throw new Error('Не найдено место для кнопки Google');

    const google = await loadGoogleIdentityServices();
    const rawNonce = nonceHex();
    const hashedNonce = await sha256Hex(rawNonce);
    const attempt = {
      id: ++attemptSequence,
      rawNonce,
      consumed: false,
      onSuccess,
      onError
    };
    activeAttempt = attempt;

    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      context: 'signin',
      nonce: hashedNonce,
      auto_select: false,
      use_fedcm_for_prompt: true,
      callback: async response => {
        if (activeAttempt !== attempt || attempt.consumed) return;
        try {
          const result = await exchangeCredential(response?.credential, attempt);
          if (result) await onSuccess?.(result);
        } catch (error) {
          try { await onError?.(error); } catch { /* caller owns UI errors */ }
        }
      }
    });
    google.accounts.id.renderButton(container, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      logo_alignment: 'left',
      width: 280
    });
    return true;
  },

  /**
   * One Tap is deliberately user-triggered (never auto-prompted before consent).
   * It reuses the active, single-use nonce established with renderGoogleButton.
   */
  async promptOneTap() {
    requireConfigured();
    if (!activeAttempt || activeAttempt.consumed) {
      throw new Error('Сначала подготовьте вход Google');
    }
    const google = await loadGoogleIdentityServices();
    google.accounts.id.prompt(notification => {
      if (notification?.isNotDisplayed?.() || notification?.isSkippedMoment?.()) {
        const reason = notification.getNotDisplayedReason?.() || notification.getSkippedReason?.() || '';
        activeAttempt?.onError?.(new Error(reason ? `Google One Tap недоступен (${reason})` : 'Google One Tap недоступен'));
      }
    });
    return true;
  },

  /** Invalidate an unfinished GIS callback without signing out an existing session. */
  cancelPendingSignIn() {
    activeAttempt = null;
    attemptSequence++;
    try { globalThis.google?.accounts?.id?.cancel?.(); } catch { /* optional GIS method */ }
  },

  clearLocalSession() {
    currentSession = null;
    currentUser = null;
    clearSessionStorage();
    safeStorage.remove(PROFILE_STORAGE_KEY);
    this.cancelPendingSignIn();
  },

  async logout() {
    const session = currentSession || readStoredSession();
    try {
      if (session?.access_token) await supabaseApi.logoutClientAuth(session.access_token);
    } catch { /* clear local state even if the network is unavailable */ }
    this.clearLocalSession();
    try { globalThis.google?.accounts?.id?.disableAutoSelect?.(); } catch { /* optional GIS method */ }
    return true;
  }
};

export default googleClientAuthService;
