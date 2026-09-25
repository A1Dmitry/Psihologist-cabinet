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
 *     через один и тот же контракт: решение о канале принимается один раз и
 *     СОХРАНЯЕТСЯ (issue #14, п.3): после перезагрузки страницы код проверяется
 *     только тем транспортом, которым он был выслан. Перебор каналов удалён —
 *     он жёг код на «чужом» сервере и мог выдать сессию не тем транспортом.
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
import { safeStorage } from '../core/safeStorage.js';

/** Канал доставки кода: 'fn' — Edge Function auth-code, 'otp' — почта Supabase Auth. */
export const VerificationChannel = { FN: 'fn', OTP: 'otp' };

/**
 * Абсолютный срок жизни сессии — один месяц (issue #40, п.7 / #46, TASK 3).
 *
 * Серверная граница задаётся в Supabase Auth (настройка владельца,
 * docs/INFRA.md → «Срок сессии»); клиентская — защита в глубину: без неё
 * refresh-токен продлевал бы сессию бесконечно, если серверная настройка
 * не выставлена. Отсчёт — от ПЕРВОЙ выдачи сессии (persistSession хранит
 * issued_at и не сбрасывает его при продлении), а не от `iat` нового токена.
 */
export const MAX_SESSION_AGE_DAYS = 30;
export const MAX_SESSION_AGE_MS = MAX_SESSION_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Сообщение об отключённой учётной записи — единое для входа, reload и
 * перехода по ссылке из письма (аккаунт не реактивируется login-операцией).
 */
export const INACTIVE_ACCOUNT_MESSAGE =
  'Учётная запись отключена. Для восстановления доступа обратитесь к администратору портала.';

/**
 * Сессия старше абсолютного срока?
 * Fail-closed: без отметки issued_at (сессия сохранена старой сборкой)
 * доказать возраст нельзя — требуем повторный вход.
 */
export function isBeyondMaxSessionAge(session) {
  const issued = Number(session?.issued_at);
  if (!Number.isFinite(issued) || issued <= 0) return true;
  const ms = issued < 1e12 ? issued * 1000 : issued;
  return Date.now() - ms > MAX_SESSION_AGE_MS;
}

/** Формат кода из письма: 6–8 букв и цифр. */
const CODE_PATTERN = /^[A-Z0-9]{6,8}$/;

/**
 * Ожидающее подтверждение: email + выбранный канал + окно жизни кода.
 * Живёт в safeStorage, поэтому переживает перезагрузку страницы (issue #14, п.3).
 * Секретов здесь нет: только email, имя канала и две отметки времени.
 */
const PENDING_KEY = 'psy_pending_verification_v1';

/** Окно ввода кода — то же, что на сервере (TTL кода в auth-code / Supabase OTP). */
const VERIFICATION_WINDOW_MS = 2 * 60e3;

const state = {
  channel: null,   // зеркало канала из сохранённого pending-состояния
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
  const m = String(ex?.message || ex?.error_description || ex?.errorCode || ex);
  if (/over_email_send_rate_limit|rate|часто/i.test(m)) return 'Слишком часто. Подождите минуту и запросите код снова.';
  if (/otp_expired|email link is invalid|link is invalid|has expired|истёк/i.test(m)) {
    return 'Ссылка или код из письма истекли. Запросите новый код на странице входа.';
  }
  if (/otp_already_used|already used|использован/i.test(m)) return 'Код уже использован. Запросите новый.';
  if (/access_denied/i.test(m)) return 'Вход по ссылке из письма отклонён. Запросите новый код.';
  if (/invalid|token|bad|неверн/i.test(m)) return 'Код неверный или истёк. Запросите новый.';
  if (/signup|not allowed|disabled/i.test(m)) return 'Вход по коду отключён в настройках Supabase Auth.';
  if (/RESEND_API_KEY|Почта не настроена/i.test(m)) return m;
  return 'Сервер не принял код: ' + m;
}

/* ============================================================================
 * Pending-состояние подтверждения (канал переживает reload)
 * ========================================================================== */

function storePendingVerification(email, channel) {
  const requestedAt = Date.now();
  const pending = {
    email,
    channel,
    requestedAt,
    expiresAt: requestedAt + VERIFICATION_WINDOW_MS
  };
  safeStorage.setJSON(PENDING_KEY, pending);
  state.channel = channel;
  return pending;
}

/**
 * Прочитать сохранённое ожидание кода. Истёкшее окно — не «состояние»: сервер
 * такой код всё равно отвергнет, поэтому оно сразу выбрасывается, а вызывающий
 * получает явный сигнал «нужен новый код».
 */
export function readPendingVerification() {
  const p = safeStorage.getJSON(PENDING_KEY, null);
  if (!p || !p.email || !p.channel) return null;
  if (!Number.isFinite(p.expiresAt) || p.expiresAt <= Date.now()) {
    // Не удаляем запись здесь: peekPendingVerification должен отличить
    // «истекло на этом устройстве» от «pending никогда не было» (другое
    // устройство, issue #23). Удаляет clearPendingVerification / UI / verify.
    state.channel = null;
    return null;
  }
  return p;
}

export function clearPendingVerification() {
  safeStorage.remove(PENDING_KEY);
  state.channel = null;
}

/**
 * Прочитать ожидание БЕЗ проверки срока — нужно только UI, чтобы отличить
 * «код никогда не запрашивали» от «код запрашивали, но окно ввода истекло»
 * и сказать об этом пользователю. Для проверки кода не используется.
 */
export function peekPendingVerification() {
  const p = safeStorage.getJSON(PENDING_KEY, null);
  return p?.email && p?.channel ? p : null;
}

/**
 * Для UI: живое ожидание + остаток окна ввода в миллисекундах.
 * Истёкшая запись возвращается как null, но ИЗ ХРАНИЛИЩА НЕ УДАЛЯЕТСЯ:
 * UI должен уметь показать «окно истекло, запросите новый код», а для этого
 * запись читается через peekPendingVerification(). Удаляет её тот, кто
 * принимает решение (readPendingVerification / clearPendingVerification).
 */
export function pendingVerification() {
  const p = peekPendingVerification();
  if (!p) return null;
  if (!Number.isFinite(p.expiresAt) || p.expiresAt <= Date.now()) return null;
  return { ...p, remainingMs: p.expiresAt - Date.now() };
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
 *
 * Выбранный канал сохраняется (storePendingVerification) — это единственный
 * источник правды для шага 2, в том числе после перезагрузки страницы.
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

  const pending = storePendingVerification(e, channel);
  return {
    ok: true,
    channel,
    requestedAt: pending.requestedAt,
    expiresAt: pending.expiresAt,
    message: channel === VerificationChannel.FN
      ? `Код отправлен на ${e}. Он действует 2 минуты.`
      : `Код отправлен на ${e} (запасной канал Supabase). Проверьте письмо и «Спам», окно ввода — 2 минуты.`
  };
}

/**
 * Шаг 2. Проверить код и получить аутентифицированную сессию Supabase.
 * Возвращает сессию, но НЕ создаёт профиль: создание — только после
 * ensureAuthenticatedSession + claimOrCreatePsychologist.
 *
 * Транспорт:
 *   1) если pending на этом устройстве жив — ТОЛЬКО его канал (issue #14);
 *   2) если pending истёк на этом устройстве — честный «запросите новый»,
 *      без похода на сервер (окно ввода закончилось локально);
 *   3) если pending никогда не было (другое устройство, issue #23) —
 *      канал auth-code (код на сервере), без OTP-перебора.
 */
export async function verifyVerification(email, code) {
  const e = normalizeEmail(email);
  const err = validateEmail(e) || validateCode(code);
  if (err) return { ok: false, message: err };

  const livePending = readPendingVerification();
  const peeked = peekPendingVerification();

  // Локальное окно истекло: не ходим на сервер и не маскируем под «другой девайс».
  if (!livePending && peeked?.email) {
    if (peeked.email === e) {
      clearPendingVerification();
      return {
        ok: false,
        message: 'Окно ввода кода истекло. Запросите новый код.'
      };
    }
    // pending на другой email — не мешает вводу «чужого» с другого сценария
  }

  if (livePending && livePending.email !== e) {
    return {
      ok: false,
      message: `Код отправлен на ${livePending.email}. Вернитесь к этому email или запросите новый код.`
    };
  }

  const normalized = normalizeCode(code);
  let session;
  let codeId = null;

  const tryFn = async () => {
    const verified = await supabaseApi.verifyLoginCode(e, normalized);
    return { session: verified?.session, codeId: verified?.codeId || null };
  };
  const tryOtp = async () => {
    const s = await supabaseApi.verifyEmailOtp(e, normalized);
    return { session: s, codeId: null };
  };

  try {
    if (livePending?.channel === VerificationChannel.OTP) {
      ({ session, codeId } = await tryOtp());
    } else if (livePending?.channel === VerificationChannel.FN) {
      ({ session, codeId } = await tryFn());
    } else if (!peeked) {
      // Нет pending вовсе: different-device / deep-link с auth-code письмом.
      try {
        ({ session, codeId } = await tryFn());
      } catch (fnEx) {
        if (fnEx?.status === 404 || fnEx?.status === 0) {
          return {
            ok: false,
            message: 'Сервер входа по коду недоступен. Откройте ссылку из письма на этом устройстве или запросите новый код там, где начинали вход.'
          };
        }
        // Код не запрошен на сервере / неверный — дружелюбно.
        const msg = friendlyAuthError(fnEx);
        if (/не запрошен|not requested|сначала получите/i.test(String(fnEx?.message || ''))) {
          return {
            ok: false,
            message: 'Код не запрошен или уже недействителен. Запросите новый код на странице входа.'
          };
        }
        return { ok: false, message: msg };
      }
    } else {
      // peeked на другой email, live пуст — не угадываем канал
      return {
        ok: false,
        message: 'Состояние подтверждения кода потеряно или окно ввода истекло. Запросите новый код.'
      };
    }
  } catch (ex) {
    // Код не погашен (или сервер честно сказал «неверный/истёк») — окно ввода
    // оставляем, чтобы пользователь мог исправить опечатку.
    return { ok: false, message: friendlyAuthError(ex) };
  }

  if (!session?.access_token) return { ok: false, message: 'Код не принят сервером' };

  // Сессия получена: ожидание больше не нужно (и повторное его использование
  // невозможно — код на сервере погашен).
  clearPendingVerification();
  return { ok: true, session, codeId };
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
    // Отключённый аккаунт: сессию не оставляем — «доступ закрыт» должно
    // означать и «токена на руках нет», а не только пустой кабинет.
    if (claimed?.inactive) {
      clearPersistedSession();
      return { ok: false, inactive: true, message: claimed.error || INACTIVE_ACCOUNT_MESSAGE };
    }
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
  // Отключённый кабинет: доступ не выдаём ни по коду, ни по ссылке из письма.
  // Сервер при этом тоже отказывает (claim_psychologist_profile + RLS),
  // клиентская проверка — только внятное сообщение вместо пустого кабинета.
  if (row.is_active === false) {
    db.clearCurrentPsychologist();
    return { ok: false, inactive: true, message: INACTIVE_ACCOUNT_MESSAGE };
  }
  applyPsychologistToLocalState(row);
  return { ok: true, psychologist: db.currentPsychologist };
}

/** Полный цикл после подтверждения кода: сессия → профиль → локальное состояние. */
export async function completeVerification(email, code, profile = {}, { requireProfileFields = false } = {}) {
  const verified = await verifyVerification(email, code);
  if (!verified.ok) return verified;

  return finishAuthenticatedLogin(email, verified.session, profile, { requireProfileFields });
}

/**
 * Завершить вход, когда сессия уже получена (код ИЛИ magic-link redirect).
 * Единая граница: session → persist → claim → load owned profile.
 */
export async function finishAuthenticatedLogin(email, session, profile = {}, { requireProfileFields = false } = {}) {
  const ensured = ensureAuthenticatedSession(session);
  if (!ensured.ok) return ensured;

  const e = normalizeEmail(email);
  // email из JWT, если форма пуста (клик по ссылке на другом устройстве)
  const mail = e || emailFromSession(session) || '';
  if (!mail) {
    return {
      ok: false,
      message: 'Сессия получена, но email не определён. Запросите код снова и введите его на странице входа.'
    };
  }

  const profileError = validateProfile(profile, { required: requireProfileFields });
  if (profileError) return { ok: false, message: profileError };

  const claimed = await claimOrCreatePsychologist(mail, profile);
  if (!claimed.ok) return claimed;

  const loaded = await loadOwnedProfile(claimed.id);
  if (!loaded.ok) return loaded;

  clearPendingVerification();
  return {
    ok: true,
    psychologist: loaded.psychologist,
    created: claimed.created,
    ownerId: claimed.ownerId,
    email: mail,
    message: loaded.psychologist.keyVerifier
      ? 'Email подтверждён, вход выполнен. Сейф клиентов закрыт — откройте его паролем во вкладке «Клиенты».'
      : 'Email подтверждён, вход выполнен. Задайте пароль сейфа во вкладке «Клиенты».'
  };
}

/**
 * Boot-path (issue #23): разобрать Supabase Auth redirect из URL.
 *
 * Успех → session → claim/load (login без ручного кода).
 * Ошибка otp_expired/access_denied → честное сообщение, URL очищен.
 * Нет Auth-параметров → { ok: false, reason: 'none' } (не ошибка UX).
 */
export async function consumeAuthRedirect(profile = {}) {
  let parsed;
  try {
    parsed = await supabaseApi.consumeAuthRedirectFromUrl();
  } catch (ex) {
    return { ok: false, reason: 'parse-failed', message: friendlyAuthError(ex) };
  }
  if (!parsed || parsed.kind === 'none') return { ok: false, reason: 'none' };
  if (parsed.kind === 'error') {
    return {
      ok: false,
      reason: 'auth-error',
      errorCode: parsed.errorCode,
      message: friendlyAuthError(parsed)
    };
  }
  if (parsed.kind !== 'session' || !parsed.session?.access_token) {
    return { ok: false, reason: 'no-session', message: 'Ссылка из письма не содержит сессию. Запросите новый код.' };
  }

  const email = emailFromSession(parsed.session) || readPendingVerification()?.email || '';
  const finished = await finishAuthenticatedLogin(email, parsed.session, profile, {
    requireProfileFields: false
  });
  if (!finished.ok) return { ...finished, reason: 'login-failed' };
  return { ...finished, reason: 'session' };
}

/** email из JWT payload (claim email / user_metadata). Без логирования токена. */
function emailFromSession(session) {
  try {
    const token = session?.access_token || '';
    const payload = String(token).split('.')[1] || '';
    if (!payload) return '';
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    const e = json?.email || json?.user_metadata?.email || '';
    return normalizeEmail(e);
  } catch {
    return '';
  }
}

/**
 * Восстановить аутентифицированное состояние после перезагрузки страницы.
 * Возвращает { authenticated, psychologist, refreshed, reason }.
 */
export async function restoreAuthenticatedState() {
  const persisted = readPersistedSession();
  if (!persisted) return { authenticated: false, reason: 'no-session' };

  // Абсолютный срок сессии (месяц) важнее продления refresh-токеном.
  if (isBeyondMaxSessionAge(persisted)) {
    clearPersistedSession();
    return {
      authenticated: false,
      reason: 'session-max-age',
      message: `Сессия старше ${MAX_SESSION_AGE_DAYS} дней. Войдите снова — запросите код на странице входа.`
    };
  }

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
    // Сессия валидна, а профиля нет: например, вход прошёл, а привязка
    // (claim_psychologist_profile) не удалась. Сессию НЕ выбрасываем — иначе
    // пользователь вынужден заново получать одноразовый код из письма.
    // Кабинет при этом не открывается: currentPsychologist остаётся пустым.
    return {
      authenticated: false,
      reason: 'no-profile',
      message: 'Вход подтверждён, но кабинет не привязан к аккаунту. Повторите привязку профиля.'
    };
  }

  // Кабинет отключён владельцем, пока сессия была жива: доступ закрываем
  // (RLS на сервере закрывает его же), сессию оставляем — после реактивации
  // вход восстановится без нового кода.
  if (row.is_active === false) {
    db.clearCurrentPsychologist();
    return { authenticated: false, reason: 'inactive', inactive: true, ownerId, message: INACTIVE_ACCOUNT_MESSAGE };
  }

  applyPsychologistToLocalState(row);
  return { authenticated: true, psychologist: db.currentPsychologist, refreshed, ownerId };
}

/** Выйти: гасим сессию и локальное состояние. */
export function signOut() {
  state.session = null;
  clearPendingVerification();
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

/** Канал, которым выслан текущий код (из сохранённого ожидания, не из памяти). */
export function currentChannel() {
  return readPendingVerification()?.channel || null;
}

/** Сброс состояния канала (нужно тестам между сценариями). */
export function resetVerificationChannel() {
  clearPendingVerification();
}

export const registration = {
  VerificationChannel,
  MAX_SESSION_AGE_DAYS,
  MAX_SESSION_AGE_MS,
  INACTIVE_ACCOUNT_MESSAGE,
  isBeyondMaxSessionAge,
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
  finishAuthenticatedLogin,
  consumeAuthRedirect,
  restoreAuthenticatedState,
  signOut,
  currentSession,
  currentChannel,
  pendingVerification,
  peekPendingVerification,
  readPendingVerification,
  clearPendingVerification,
  resetVerificationChannel
};
