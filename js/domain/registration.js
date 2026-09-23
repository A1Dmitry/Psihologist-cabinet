/**
 * Registration — КАНОНЧЕСКИЙ use case регистрации/входа специалиста.
 *
 * Единственное место, где живут правила аутентификации и привязки кабинета.
 * Ни ViewModel, ни сервис-обёртка не реализуют их повторно (требование
 * AUDIT-REG-DRY-001: «AuthViewModel не должен самостоятельно реализовывать
 * domain/authentication logic»).
 *
 * Контракт (ровно тот, что задан задачей):
 *   requestVerification      — запросить одноразовый код на email
 *   verifyVerification       — проверить код и получить сессию Supabase
 *   ensureAuthenticatedSession — зафиксировать сессию (токен + персистентность)
 *   claimOrCreatePsychologist — привязать или создать профиль по auth.uid()
 *   restoreAuthenticatedState — восстановить вход после перезагрузки страницы
 *
 * Инварианты:
 *   • владение кабинетом определяется ТОЛЬКО auth.uid(), никогда не email;
 *   • профиль не создаётся до подтверждения личности через Supabase Auth;
 *   • повторный вход тем же email возвращает тот же профиль (без дубля);
 *   • основной канал (Edge Function auth-code) и запасной (Supabase OTP) идут
 *     через один и тот же контракт: решение о канале принимается один раз.
 *
 * Безопасность: коды, access_token и пароль сейфа не логируются.
 */
import { db } from '../core/dbContext.js';
import {
  supabaseApi,
  setAuthToken,
  persistSession,
  readPersistedSession,
  clearPersistedSession,
  userIdFromToken
} from '../services/supabaseApi.js';
import { mapPsy } from '../services/psyMapper.js';

/** Канал доставки кода: 'fn' — Edge Function auth-code, 'otp' — почта Supabase Auth. */
export const VerificationChannel = { FN: 'fn', OTP: 'otp' };

/** Формат кода из письма: 6–8 букв и цифр. */
const CODE_PATTERN = /^[A-Z0-9]{6,8}$/;

const state = {
  channel: null,   // как был выслан ТЕКУЩИЙ код
  session: null    // { access_token, refresh_token, expires_at }
};

/* ============================================================================
 * Валидация — одна реализация на весь проект
 * ========================================================================== */

export function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

export function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function validateEmail(email) {
  const e = normalizeEmail(email);
  if (!/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(e)) return 'Укажите корректный email';
  return '';
}

export function validateCode(code) {
  if (!CODE_PATTERN.test(normalizeCode(code))) return 'Введите код из письма: 6–8 букв и цифр';
  return '';
}

/**
 * Обязательные поля регистрации. Проверка нужна именно на входе в use case:
 * профиль создаётся один раз, и недостающее поле потом неотличимо от пустого.
 */
export function validateProfile(profile = {}, { required = true } = {}) {
  if (!required) return '';
  const missing = [];
  if (!String(profile.fullName || '').trim()) missing.push('имя и фамилию');
  if (!String(profile.phone || '').trim()) missing.push('телефон');
  if (!String(profile.specialization || '').trim()) missing.push('специализацию');
  if (!String(profile.city || '').trim()) missing.push('город');
  if (!String(profile.about || '').trim()) missing.push('рассказ о себе');
  if (!missing.length) return '';
  return `Заполните ${missing.join(', ')}`;
}

/* ============================================================================
 * Ошибки — честные сообщения пользователю
 * ========================================================================== */

export function friendlyAuthError(ex) {
  const m = String(ex?.message || ex);
  if (/over_email_send_rate_limit|rate|часто/i.test(m)) return 'Слишком часто. Подождите минуту и запросите код снова.';
  if (/otp_expired|expired|истёк/i.test(m)) return 'Код истёк. Запросите новый.';
  if (/otp_already_used|already used|использован/i.test(m)) return 'Код уже использован. Запросите новый.';
  if (/invalid|token|bad|неверн/i.test(m)) return 'Код неверный или истёк. Запросите новый.';
  if (/signup|not allowed|disabled/i.test(m)) return 'Вход по коду отключён в настройках Supabase Auth.';
  if (/RESEND_API_KEY|Почта не настроена/i.test(m)) return m;
  return 'Сервер не принял код: ' + m;
}

/* ============================================================================
 * Контракт use case
 * ========================================================================== */

/**
 * Шаг 1. Запросить одноразовый код.
 * Решение о канале принимается ЗДЕСЬ и один раз: основной канал — Edge Function
 * auth-code (код живёт в БД, письмо через Resend); если функция не задеплоена
 * (404) или недоступна на уровне сети (status=0: браузер маскирует отсутствие
 * функции под CORS-ошибку preflight) — запасной канал встроенной почты
 * Supabase Auth. Любой другой отказ основного канала (задеплоена, но ответила
 * ошибкой: 429/500/502…) — честная ошибка, без тихого переключения.
 */
export async function requestVerification(email) {
  const e = normalizeEmail(email);
  const err = validateEmail(e);
  if (err) return { ok: false, message: err };

  let channel = VerificationChannel.FN;
  try {
    await supabaseApi.requestLoginCode(e);
  } catch (ex) {
    if (ex?.status !== 404 && ex?.status !== 0) {
      return {
        ok: false,
        message: ex?.message ? `Не удалось отправить код: ${ex.message}` : friendlyAuthError(ex)
      };
    }
    channel = VerificationChannel.OTP;
    try {
      await supabaseApi.requestEmailOtp(e);
    } catch (ex2) {
      return { ok: false, message: friendlyAuthError(ex2) };
    }
  }

  state.channel = channel;
  return {
    ok: true,
    channel,
    message: channel === VerificationChannel.FN
      ? `Код отправлен на ${e}. Он действует 2 минуты.`
      : `Код отправлен на ${e} (запасной канал Supabase). Проверьте письмо и «Спам», окно ввода — 2 минуты.`
  };
}

/**
 * Шаг 2. Проверить код и получить аутентифицированную сессию Supabase.
 * Возвращает сессию, но НЕ создаёт профиль: создание — только после
 * ensureAuthenticatedSession + claimOrCreatePsychologist.
 */
export async function verifyVerification(email, code) {
  const e = normalizeEmail(email);
  const err = validateEmail(e) || validateCode(code);
  if (err) return { ok: false, message: err };

  let session;
  try {
    if (state.channel === VerificationChannel.OTP) {
      session = await supabaseApi.verifyEmailOtp(e, normalizeCode(code));
    } else if (state.channel === VerificationChannel.FN) {
      session = await supabaseApi.verifyLoginCode(e, normalizeCode(code));
    } else {
      // Канал неизвестен (например, страница перезагружена между шагами).
      // Это единственная допустимая ветка перебора — она не дублирует логику,
      // а лишь выбирает транспорт, после чего путь общий.
      session = await supabaseApi.verifyLoginCode(e, normalizeCode(code))
        .catch(() => supabaseApi.verifyEmailOtp(e, normalizeCode(code)));
    }
  } catch (ex) {
    return { ok: false, message: friendlyAuthError(ex) };
  }

  if (!session?.access_token) return { ok: false, message: 'Код не принят сервером' };
  return { ok: true, session };
}

/**
 * Шаг 3. Зафиксировать аутентифицированную сессию: токен для RLS-запросов
 * и персистентность для восстановления после перезагрузки страницы.
 */
export function ensureAuthenticatedSession(session) {
  if (!session?.access_token) return { ok: false, message: 'Сессия не получена' };
  const stored = persistSession(session);
  state.session = stored;
  const ownerId = userIdFromToken(stored.access_token);
  return { ok: true, session: stored, ownerId };
}

/**
 * Шаг 4. Привязать существующий профиль или создать новый.
 * Сервер определяет владельца по auth.uid(); email используется только для
 * поиска существующей записи.
 */
export async function claimOrCreatePsychologist(email, profile = {}) {
  const e = normalizeEmail(email);
  let claimed;
  try {
    claimed = await supabaseApi.claimPsychologist({
      email: e,
      fullName: profile.fullName || '',
      phone: profile.phone || '',
      specialization: profile.specialization || '',
      city: profile.city || '',
      about: profile.about || ''
    });
  } catch (ex) {
    return { ok: false, message: `Сервер не смог привязать профиль: ${ex?.message || ex}` };
  }

  if (!claimed?.ok || !claimed.id) {
    return { ok: false, message: claimed?.error || 'Не удалось привязать профиль' };
  }

  // Инвариант: владелец — текущий auth.uid(), а не «кто ввёл email».
  const ownerId = userIdFromToken(state.session?.access_token || '');
  if (claimed.owner_id && ownerId && claimed.owner_id !== ownerId) {
    return { ok: false, message: 'Профиль привязан к другой учётной записи' };
  }

  return { ok: true, id: claimed.id, created: !!claimed.created, ownerId: claimed.owner_id || ownerId };
}

/**
 * Шаг 5. Загрузить профиль с сервера и инициализировать локальное
 * аутентифицированное состояние (единая реализация для входа и для reload).
 */
export async function loadOwnedProfile(psychologistId) {
  const row = await supabaseApi.fetchOwnPsychologist(psychologistId);
  if (!row) return { ok: false, message: 'Профиль не найден на сервере' };
  applyPsychologistToLocalState(row);
  return { ok: true, psychologist: db.currentPsychologist };
}

/** Полный цикл после подтверждения кода: сессия → профиль → локальное состояние. */
export async function completeVerification(email, code, profile = {}, { requireProfileFields = false } = {}) {
  const verified = await verifyVerification(email, code);
  if (!verified.ok) return verified;

  const ensured = ensureAuthenticatedSession(verified.session);
  if (!ensured.ok) return ensured;

  const profileError = validateProfile(profile, { required: requireProfileFields });
  if (profileError) return { ok: false, message: profileError };

  const claimed = await claimOrCreatePsychologist(email, profile);
  if (!claimed.ok) return claimed;

  const loaded = await loadOwnedProfile(claimed.id);
  if (!loaded.ok) return loaded;

  return {
    ok: true,
    psychologist: loaded.psychologist,
    created: claimed.created,
    ownerId: claimed.ownerId,
    message: loaded.psychologist.keyVerifier
      ? 'Email подтверждён, вход выполнен. Сейф клиентов закрыт — откройте его паролем во вкладке «Клиенты».'
      : 'Email подтверждён, вход выполнен. Задайте пароль сейфа во вкладке «Клиенты».'
  };
}

/**
 * Восстановить аутентифицированное состояние после перезагрузки страницы.
 * Возвращает { authenticated, psychologist, refreshed, reason }.
 */
export async function restoreAuthenticatedState() {
  const persisted = readPersistedSession();
  if (!persisted) return { authenticated: false, reason: 'no-session' };

  let session = persisted;
  let refreshed = false;

  if (isExpired(persisted)) {
    if (!persisted.refresh_token) {
      clearPersistedSession();
      return { authenticated: false, reason: 'expired' };
    }
    try {
      const fresh = await supabaseApi.refreshSession(persisted.refresh_token);
      if (!fresh?.access_token) throw new Error('Пустой ответ сервера');
      session = persistSession(fresh);
      refreshed = true;
    } catch {
      clearPersistedSession();
      return { authenticated: false, reason: 'refresh-failed' };
    }
  } else {
    setAuthToken(persisted.access_token);
  }

  state.session = session;

  const ownerId = userIdFromToken(session.access_token);
  if (!ownerId) {
    clearPersistedSession();
    return { authenticated: false, reason: 'bad-token' };
  }

  let row;
  try {
    row = await supabaseApi.fetchOwnedPsychologist(ownerId);
  } catch (ex) {
    // Сеть/сервер недоступны — сессию не выбрасываем, но честно говорим об этом.
    return { authenticated: false, reason: 'profile-unavailable', message: String(ex?.message || ex) };
  }
  if (!row) {
    clearPersistedSession();
    return { authenticated: false, reason: 'no-profile' };
  }

  applyPsychologistToLocalState(row);
  return { authenticated: true, psychologist: db.currentPsychologist, refreshed, ownerId };
}

/** Выйти: гасим сессию и локальное состояние. */
export function signOut() {
  state.session = null;
  state.channel = null;
  clearPersistedSession();
  db.clearCurrentPsychologist();
}

/* ============================================================================
 * Внутреннее
 * ========================================================================== */

function isExpired(session) {
  const exp = Number(session?.expires_at);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  // GoTrue отдаёт expires_at в секундах; допускаем и миллисекунды
  const ms = exp < 1e12 ? exp * 1000 : exp;
  return Date.now() >= ms - 30e3; // запас 30 с на часы и сеть
}

/**
 * Положить серверный профиль в локальный DbContext и сделать его текущим.
 * Единственная точка инициализации аутентифицированного состояния.
 */
function applyPsychologistToLocalState(row) {
  const psy = mapPsy(row);
  const idx = db.psychologists.findIndex(x => x.id === psy.id);
  if (idx >= 0) db.psychologists[idx] = psy;
  else db.psychologists.push(psy);
  db.setCurrentPsychologist(psy.id);
  db.saveChanges();
  return psy;
}

/** Текущая сессия (для диагностики; в UI не выводится и не логируется). */
export function currentSession() {
  return state.session;
}

export function currentChannel() {
  return state.channel;
}

/** Сброс состояния канала (нужно тестам между сценариями). */
export function resetVerificationChannel() {
  state.channel = null;
}

export const registration = {
  VerificationChannel,
  normalizeEmail,
  normalizeCode,
  validateEmail,
  validateCode,
  validateProfile,
  friendlyAuthError,
  requestVerification,
  verifyVerification,
  ensureAuthenticatedSession,
  claimOrCreatePsychologist,
  loadOwnedProfile,
  completeVerification,
  restoreAuthenticatedState,
  signOut,
  currentSession,
  currentChannel,
  resetVerificationChannel
};
