/**
 * GoogleAuthService — вход специалиста через Google (Supabase Auth OAuth, PKCE).
 *
 * Это НЕ тот же контур, что `googleClientAuthService.js`:
 *   • googleClientAuthService — опциональная Google-идентификация КЛИЕНТА при
 *     записи (GIS ID token → signInWithIdToken, сессия живёт в sessionStorage
 *     и никогда не наследуется публичной записью);
 *   • googleAuthService — вход СПЕЦИАЛИСТА в кабинет (OAuth redirect → PKCE →
 *     обычная Supabase-сессия в том же хранилище, что и вход по коду из письма:
 *     `psy_auth_session_v1`). Один браузер = одна сессия владельца кабинета.
 *
 * Почему PKCE, а не implicit: приложение работает в режиме Hash History
 * (`#/cabinet`, `#/auth`). При implicit-потоке GoTrue кладёт токены в
 * FRAGMENT (`#access_token=…`), то есть затирает маршрут приложения и ломает
 * роутер. PKCE возвращает `?code=…` в query string — фрагмент остаётся
 * свободным для роутера, а обмен кода на сессию выполняет сам клиент.
 *
 * Почему redirect_to — это origin + base path БЕЗ hash: GitHub Pages отдаёт
 * `/Psihologist-cabinet/index.html` на `/Psihologist-cabinet/`, поэтому
 * возврат после OAuth попадает ровно в приложение, а не в 404. Хэш в
 * redirect_to добавлять нельзя: GoTrue дописал бы `?code=` ПОСЛЕ `#`, и
 * разбор сломался бы.
 *
 * Никаких секретов: только anon key, который и так публичен. service_role,
 * Client Secret от Google и любые ключи сервера здесь не используются и в
 * браузер не попадают.
 */
import {
  SUPABASE_URL,
  APPLICATION_URL,
  isSupabaseConfigured,
  isLoopbackHost,
  resolveApplicationUrl
} from './supabaseConfig.js';
import {
  supabaseApi,
  persistSession,
  readPersistedSession,
  clearPersistedSession,
  userIdFromToken
} from './supabaseApi.js';
import { safeStorage } from '../core/safeStorage.js';

const VERIFIER_KEY = 'psy_google_oauth_verifier_v1';
const RETURN_KEY = 'psy_google_oauth_return_v1';
const PROFILE_CACHE_KEY = 'psy_google_account_display_v1';

/** Сегменты, которые НЕ являются base path приложения (это маршруты роутера). */
const ROUTE_SEGMENTS = new Set(['auth', 'cabinet', 'booking-done', 'reply', 'book', 'psy', 'onboarding']);

const state = {
  user: null,     // { id, email, name, picture, provider, emailVerified } — только для UI
  ready: false
};

const listeners = new Set();

function emit(event, payload) {
  listeners.forEach(fn => {
    try { fn(event, payload); } catch (e) { console.warn('[googleAuth] listener', e); }
  });
}

function clone(value) {
  return value ? { ...value } : null;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** code_verifier: 32 случайных байта → 43 символа base64url (требование PKCE). */
function randomCodeVerifier() {
  const bytes = new Uint8Array(32);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error('Браузер не поддерживает безопасный вход (нет crypto.getRandomValues)');
  cryptoApi.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** S256: base64url(SHA-256(ASCII(code_verifier))). */
async function codeChallengeS256(verifier) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle?.digest || typeof TextEncoder === 'undefined') {
    throw new Error('Браузер не поддерживает PKCE (нет WebCrypto SHA-256)');
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function readUrl(url = globalThis.location) {
  try {
    return {
      href: String(url?.href || ''),
      origin: String(url?.origin || ''),
      pathname: String(url?.pathname || '/'),
      search: String(url?.search || '')
    };
  } catch {
    return { href: '', origin: '', pathname: '/', search: '' };
  }
}

/**
 * Канонический callback приложения для Supabase Auth — БЕЗ hash.
 *
 * - loopback (локальная разработка) → текущий origin + base path: OAuth
 *   возвращается в ТОТ ЖЕ браузер, поэтому localhost здесь уместен (в отличие
 *   от ссылок из письма, которые открывают на другом устройстве);
 * - любой другой origin (GitHub Pages, preview) → APPLICATION_URL / текущий
 *   origin + первый сегмент пути (base path Pages).
 *
 * Значение должно совпадать с allowlist в Supabase Dashboard →
 * Authentication → URL Configuration → Redirect URLs.
 */
export function googleOAuthRedirectUrl() {
  const loc = globalThis.location;
  if (!loc?.origin) return withTrailingSlash(APPLICATION_URL);
  if (isLoopbackHost(loc.hostname || '')) {
    const first = String(loc.pathname || '/').split('/').filter(Boolean)[0];
    const base = first && !ROUTE_SEGMENTS.has(first.toLowerCase()) ? `/${first}/` : '/';
    return withTrailingSlash(`${loc.origin}${base}`);
  }
  return resolveApplicationUrl();
}

function withTrailingSlash(url) {
  const s = String(url || '').trim();
  if (!s) return withTrailingSlash(APPLICATION_URL);
  return s.endsWith('/') ? s : `${s}/`;
}

/**
 * Профиль Google из ответа GoTrue `/auth/v1/user`.
 * Только для отображения: авторизацию решает сервер по access token.
 */
function profileFromAuthUser(authUser) {
  if (!authUser || typeof authUser !== 'object') return null;
  const identities = Array.isArray(authUser.identities) ? authUser.identities : [];
  const google = identities.find(i => i?.provider === 'google') || null;
  const identityData = google?.identity_data || {};
  const meta = authUser.user_metadata || {};
  const email = String(
    identityData.email || authUser.email || meta.email || ''
  ).trim().toLowerCase();
  const name = String(
    identityData.name || meta.full_name || meta.name ||
    [meta.given_name, meta.family_name].filter(Boolean).join(' ') || email
  ).trim();
  return {
    id: String(authUser.id || ''),
    email,
    name: name || email,
    picture: String(identityData.picture || meta.avatar_url || meta.picture || '').trim(),
    provider: google ? 'google' : String(meta.provider || identities[0]?.provider || 'unknown'),
    emailVerified: !!(
      identityData.email_verified === true ||
      meta.email_verified === true ||
      !!authUser.email_confirmed_at
    )
  };
}

function cacheDisplayProfile(user) {
  if (!user) {
    safeStorage.remove(PROFILE_CACHE_KEY);
    return;
  }
  safeStorage.setJSON(PROFILE_CACHE_KEY, {
    name: user.name,
    email: user.email,
    picture: user.picture,
    provider: user.provider
  });
}

/** Описание ошибки привязки/создания кабинета — человеческим языком. */
export function describeLinkResult(result) {
  const code = String(result?.code || '');
  const serverMessage = String(result?.message || result?.error || '').trim();
  const resolution = String(result?.resolution || '').trim();
  const known = {
    not_authenticated: 'Вход не выполнен: нет активной сессии. Нажмите «Войти через Google» снова.',
    no_email: 'В Google-аккаунте нет email. Войдите аккаунтом с подтверждённым email.',
    email_unconfirmed: 'Email Google-аккаунта не подтверждён. Повторите вход; если ошибка повторяется — обратитесь к администратору портала.',
    email_taken: 'Запись специалиста с таким email уже привязана к другой учётной записи. Доступ не выдан.',
    duplicate_email: 'Найдено несколько записей специалиста с таким email. Автоматически выбрать нельзя.',
    profile_inactive: 'Учётная запись отключена. Для восстановления доступа обратитесь к администратору портала.',
    multiple_owned: 'К этому аккаунту привязано несколько кабинетов. Обратитесь к администратору портала.',
    migration_missing: 'Вход через Google ещё не настроен на сервере: не применена миграция supabase/migrations/20260925_google_specialist_signup.sql.'
  };
  const head = known[code] || serverMessage || 'Не удалось открыть кабинет.';
  return { head, resolution, code };
}

/**
 * Постгрес/PGRST202 = RPC нет в схеме → миграция не применена.
 * Fail-closed: молча «войти» без кабинета нельзя, пользователь должен видеть
 * причину.
 */
function isMissingRpcError(error) {
  const msg = String(error?.message || error || '');
  return /PGRST202|Could not find the function|function .* does not exist/i.test(msg);
}

export const googleAuthService = {
  isConfigured() {
    return isSupabaseConfigured();
  },

  /** Профиль для UI (память + display-кэш); авторизацию этим не проверяем. */
  getCurrentUser() {
    return clone(state.user);
  },

  /** Только для отображения в шапке до первого запроса к GoTrue. */
  getCachedUser() {
    return safeStorage.getJSON(PROFILE_CACHE_KEY, null);
  },

  /** Есть ли сохранённая сессия Supabase Auth (общая с входом по коду). */
  hasSession() {
    return !!readPersistedSession()?.access_token;
  },

  /**
   * Шаг 1. Начать вход: сгенерировать PKCE, сохранить verifier, уйти на
   * Supabase Auth → Google → обратно на callback приложения.
   */
  async startGoogleSignIn({ returnTo = '#/cabinet' } = {}) {
    if (!isSupabaseConfigured()) throw new Error('Supabase не настроен: укажите anon key в js/services/supabaseConfig.js');
    if (typeof globalThis.location === 'undefined') throw new Error('Вход через Google доступен только в браузере');

    const verifier = randomCodeVerifier();
    const challenge = await codeChallengeS256(verifier);
    safeStorage.set(VERIFIER_KEY, verifier);
    safeStorage.set(RETURN_KEY, returnTo || '#/cabinet');

    const redirectTo = googleOAuthRedirectUrl();
    const params = new URLSearchParams({
      provider: 'google',
      redirect_to: redirectTo,
      code_challenge: challenge,
      code_challenge_method: 's256'
    });
    globalThis.location.assign(`${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`);
    return true;
  },

  /**
   * Шаг 2 (boot). Разобрать возврат после OAuth: `?code=…` (успех) или
   * `?error=…&error_description=…` (отказ/ошибка провайдера).
   *
   * Возвращает { kind: 'session', session } | { kind:'error', code, message } |
   * { kind: 'none' }. URL очищается в обоих случаях, чтобы reload не
   * повторял обмен одноразового кода.
   */
  async consumeGoogleRedirect(loc = globalThis.location) {
    // URLSearchParams сам игнорирует ведущий «?».
    const params = new URLSearchParams(readUrl(loc).search);
    const code = params.get('code');
    const error = params.get('error') || params.get('error_code');
    const errorDescription = params.get('error_description');
    const verifier = safeStorage.get(VERIFIER_KEY) || '';
    const startedHere = !!verifier || !!safeStorage.get(RETURN_KEY);

    if (!code && !error) return { kind: 'none' };
    // Не трогаем чужой PKCE/magic-link: `?code=` без нашего verifier/return
    // принадлежит существующему consumeAuthRedirect (вход по письму).
    if (!startedHere) return { kind: 'none' };

    this._clearReturnParams(loc);
    safeStorage.remove(VERIFIER_KEY);
    safeStorage.remove(RETURN_KEY);

    if (error) {
      return {
        kind: 'error',
        code: String(error),
        message: describeOAuthError(error, errorDescription)
      };
    }

    if (!verifier) {
      return {
        kind: 'error',
        code: 'missing_verifier',
        message: 'Вход был начат в другой вкладке или хранилище браузера очищено. Нажмите «Войти через Google» ещё раз.'
      };
    }

    try {
      const session = await supabaseApi.exchangeCodeForSession(code, verifier);
      if (!session?.access_token) throw new Error('Supabase Auth не вернул сессию');
      persistSession(session);
      await this.refreshUser();
      emit('signedIn', { user: clone(state.user), via: 'redirect' });
      return { kind: 'session', session };
    } catch (ex) {
      clearPersistedSession();
      return { kind: 'error', code: 'exchange_failed', message: describeOAuthError('exchange_failed', ex?.message) };
    }
  },

  /**
   * Обновить display-профиль из GoTrue по текущей сессии.
   * Возвращает null, если сессии нет или она недействительна.
   */
  async refreshUser() {
    const persisted = readPersistedSession();
    if (!persisted?.access_token) {
      state.user = null;
      state.ready = true;
      cacheDisplayProfile(null);
      return null;
    }
    try {
      const authUser = await supabaseApi.getClientAuthUser(persisted.access_token);
      state.user = profileFromAuthUser(authUser);
      state.ready = true;
      cacheDisplayProfile(state.user);
      return clone(state.user);
    } catch (ex) {
      if (ex?.status === 401 || ex?.status === 403) {
        state.user = null;
        cacheDisplayProfile(null);
        return null;
      }
      // Сеть недоступна — оставляем display-кэш, авторизацию решает сервер.
      state.ready = true;
      return clone(state.user);
    }
  },

  /**
   * Шаг 3. Атомарно найти/привязать/создать кабинет специалиста.
   * Identity берётся СЕРВЕРОМ из auth.uid(); из браузера не передаётся ничего.
   */
  async linkOrCreateCabinet() {
    try {
      const result = await supabaseApi.linkGoogleSpecialist();
      if (!result || result.ok !== true) {
        return { ok: false, ...describeLinkResult(result) };
      }
      return { ok: true, id: result.id, code: result.code, profileCompleted: result.profile_completed !== false };
    } catch (ex) {
      if (isMissingRpcError(ex)) {
        return {
          ok: false,
          code: 'migration_missing',
          ...describeLinkResult({ code: 'migration_missing' })
        };
      }
      return { ok: false, code: 'server_error', head: String(ex?.message || ex), resolution: '' };
    }
  },

  /** Онбординг: сохранить поля профиля (только поля существующей схемы). */
  async completeProfile({ fullName, phone, specialization, city, about }) {
    try {
      const result = await supabaseApi.completeGoogleProfile({ fullName, phone, specialization, city, about });
      if (!result || result.ok !== true) {
        const known = {
          validation: 'Заполните ФИО, телефон, специализацию, город и рассказ о себе.',
          not_authenticated: 'Вход не выполнен. Войдите через Google снова.',
          no_profile: 'Кабинет не привязан к аккаунту. Повторите вход через Google.'
        };
        return { ok: false, message: known[String(result?.code)] || String(result?.error || 'Не удалось сохранить профиль') };
      }
      return { ok: true, id: result.id };
    } catch (ex) {
      if (isMissingRpcError(ex)) {
        return { ok: false, message: describeLinkResult({ code: 'migration_missing' }).head };
      }
      return { ok: false, message: String(ex?.message || ex) };
    }
  },

  /** Куда вернуть пользователя после входа (сохраняется перед редиректом). */
  takeReturnTo() {
    const value = safeStorage.get(RETURN_KEY) || '';
    safeStorage.remove(RETURN_KEY);
    return value || '#/cabinet';
  },

  subscribe(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  },

  async signOut() {
    const session = readPersistedSession();
    try {
      if (session?.access_token) await supabaseApi.logoutClientAuth(session.access_token);
    } catch { /* сеть недоступна — локальный выход всё равно выполняем */ }
    clearPersistedSession();
    state.user = null;
    state.ready = false;
    cacheDisplayProfile(null);
    safeStorage.remove(VERIFIER_KEY);
    safeStorage.remove(RETURN_KEY);
    emit('signedOut', {});
    return true;
  },

  /** Убрать ?code/?error из адресной строки, сохранив путь и hash-маршрут. */
  _clearReturnParams(loc = globalThis.location) {
    try {
      const hist = globalThis.history;
      if (!hist?.replaceState || !loc) return;
      const { pathname, href } = readUrl(loc);
      const hash = String(loc.hash || '');
      hist.replaceState(null, '', `${pathname || '/'}${hash || ''}`);
      return href;
    } catch { /* не браузер / запрет истории */ }
    return null;
  }
};

function describeOAuthError(code, description) {
  const raw = decodeURIComponent(String(description || '').replaceAll('+', ' ')).trim();
  const known = {
    access_denied: 'Вход через Google отменён или доступ не выдан. Попробуйте ещё раз и подтвердите согласие.',
    server_error: 'Supabase Auth не смог завершить вход через Google. Попробуйте ещё раз.',
    temporarily_unavailable: 'Сервис входа временно недоступен. Попробуйте через несколько минут.',
    exchange_failed: 'Не удалось обменять код входа на сессию. Попробуйте войти ещё раз.',
    validation_failed: 'Supabase Auth отклонил запрос входа. Проверьте настройки провайдера Google и redirect URL.',
    unauthorized_client: 'Google отклонил приложение (unauthorized_client). Проверьте Client ID и разрешённые redirect URI в Google Cloud.'
  };
  const head = known[String(code)] || 'Не удалось войти через Google.';
  return raw && !known[String(code)] ? `${head} ${raw}` : (known[String(code)] || `${head} ${raw}`.trim());
}

export default googleAuthService;
