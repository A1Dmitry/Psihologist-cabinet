/**
 * AuthService — вход/регистрация ТОЛЬКО через сервер, по одноразовому коду
 * из письма (6–8 букв и цифр, окно ввода 2 минуты):
 *   1) «Получить код» → код генерируется в БД (auth_login_codes) и отправляется
 *      на email специалиста Edge Function auth-code (Resend); сессия браузера —
 *      через hashed_token → /auth/v1/verify, код после входа гасится (used_at);
 *   2) если функция auth-code ещё не задеплоена — запасной канал: встроенная
 *      почта Supabase Auth (OTP; требует шаблона с {{ .Token }} в дашборде);
 *   3) код совпал → email подтверждён → claim профиля по email:
 *      существующая запись психолога становится его кабинетом (owner_id),
 *      отсутствующая — создаётся (регистрация).
 * Пароль кабинета (ключ AES-сейфа клиентов) — отдельная опция, задаётся/вводится
 * в кабинете; вход в кабинет он не блокирует.
 */
import { db } from '../core/dbContext.js';
import { cryptoService } from './cryptoService.js';
import { clientVaultService } from './clientVaultService.js';
import { supabaseApi, setAuthToken } from './supabaseApi.js';
import { mapPsy } from './psyMapper.js';

const RESEND_SECONDS = 120; // окно ожидания ввода кода

function emailError(email) {
  if (!/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(email)) return 'Укажите корректный email';
  return '';
}

export class AuthService {
  constructor() {
    this.session = null; // { access_token, refresh_token, expires_at }
    this.channel = null; // как был выслан текущий код: 'fn' (auth-code) | 'otp' (Supabase)
    this.resendIn = 0;   // сек до возможности повторной отправки
    this._timer = null;
  }

  // ——— Шаг 1: отправить код на email (сервер) ———
  async requestCode(email) {
    const e = String(email || '').toLowerCase().trim();
    const err = emailError(e);
    if (err) return { ok: false, message: err };

    let viaFn = true;
    try {
      await supabaseApi.requestLoginCode(e);
    } catch (ex) {
      if (ex?.status === 404) {
        // функция auth-code не задеплоена → запасной канал: встроенная почта Supabase
        viaFn = false;
        try { await supabaseApi.requestEmailOtp(e); }
        catch (ex2) { return { ok: false, message: friendlyAuthError(ex2) }; }
      } else {
        // функция есть, но отказ (нет RESEND_API_KEY, частые запросы…) — честная ошибка
        return { ok: false, message: ex?.message ? `Не удалось отправить код: ${ex.message}` : friendlyAuthError(ex) };
      }
    }
    this.channel = viaFn ? 'fn' : 'otp';
    this._startResendCountdown();
    return {
      ok: true,
      message: viaFn
        ? `Код отправлен на ${e}. Он действует 2 минуты.`
        : `Код отправлен на ${e} (запасной канал Supabase). Проверьте письмо и «Спам», окно ввода — 2 минуты.`
    };
  }

  _startResendCountdown() {
    clearInterval(this._timer);
    this.resendIn = RESEND_SECONDS;
    this._timer = setInterval(() => {
      this.resendIn = Math.max(0, this.resendIn - 1);
      if (this.resendIn === 0) clearInterval(this._timer);
    }, 1000);
  }

  // ——— Шаг 2: проверить код из письма → подтверждение → вход ———
  async verifyCode(email, code, profile = {}) {
    const e = String(email || '').toLowerCase().trim();
    const c = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const err = emailError(e);
    if (err) return { ok: false, message: err };
    if (!/^[A-Z0-9]{6,8}$/.test(c)) return { ok: false, message: 'Введите код из письма: 6–8 букв и цифр' };

    let session;
    try {
      if (this.channel === 'otp') {
        session = await supabaseApi.verifyEmailOtp(e, c);
      } else if (this.channel === 'fn') {
        session = await supabaseApi.verifyLoginCode(e, c);
      } else {
        // канал неизвестен (например, страница перезагружена между шагами)
        session = await supabaseApi.verifyLoginCode(e, c)
          .catch(() => supabaseApi.verifyEmailOtp(e, c));
      }
    } catch (ex) {
      return { ok: false, message: friendlyAuthError(ex) };
    }
    if (!session?.access_token) return { ok: false, message: 'Код не принят сервером' };
    this.session = session;
    setAuthToken(session.access_token);

    // 3) привязать/создать кабинет по подтверждённому email
    const claimed = await supabaseApi.claimPsychologist({
      email: e,
      fullName: profile.fullName || '',
      specialization: profile.specialization || '',
      city: profile.city || ''
    });
    if (!claimed?.ok || !claimed.id) {
      return { ok: false, message: claimed?.error || 'Не удалось привязать профиль' };
    }

    // 4) загрузить свой профиль с сервера и открыть кабинет
    const row = await supabaseApi.fetchOwnPsychologist(claimed.id);
    if (!row) return { ok: false, message: 'Профиль не найден на сервере' };
    const psy = mapPsy(row);
    const idx = db.psychologists.findIndex(x => x.id === psy.id);
    if (idx >= 0) db.psychologists[idx] = psy; else db.psychologists.push(psy);
    db.saveChanges();
    db.setCurrentPsychologist(psy.id);

    return {
      ok: true,
      psychologist: psy,
      message: psy.keyVerifier
        ? 'Email подтверждён, вход выполнен. Сейф клиентов закрыт — откройте его паролем во вкладке «Клиенты».'
        : 'Email подтверждён, вход выполнен. Задайте пароль сейфа во вкладке «Клиенты».'
    };
  }

  // ——— Сейф клиентов (пароль — только для шифрования, не для входа) ———
  /** Задать пароль сейфа (если ещё не задан) */
  async initVaultPassword(psychologistId, password) {
    const psy = db.psychologists.find(x => x.id === psychologistId);
    if (!psy) return { ok: false, message: 'Кабинет не найден' };
    if (psy.keyVerifier) return { ok: false, message: 'Пароль сейфа уже задан' };
    if (String(password || '').length < 6) return { ok: false, message: 'Пароль не менее 6 символов' };
    const salt = await cryptoService.randomSalt();
    psy.keyVerifier = await cryptoService.createVerifier(password, salt);
    db.saveChanges();
    const unlocked = await cryptoService.unlock(psychologistId, password, psy.keyVerifier);
    return unlocked
      ? { ok: true, message: 'Сейф создан и открыт' }
      : { ok: false, message: 'Не удалось открыть сейф' };
  }

  /** Открыть сейф существующим паролем */
  async unlockVault(psychologistId, password) {
    const psy = db.psychologists.find(x => x.id === psychologistId);
    if (!psy?.keyVerifier) return { ok: false, message: 'Пароль сейфа не задан' };
    const unlocked = await cryptoService.unlock(psychologistId, password, psy.keyVerifier);
    return unlocked
      ? { ok: true, message: 'Сейф открыт' }
      : { ok: false, message: 'Неверный пароль сейфа' };
  }

  logout() {
    const id = db.currentPsychologistId;
    cryptoService.lock(id);
    cryptoService.lockAll();
    db.clearCurrentPsychologist();
    this.session = null;
    setAuthToken(null);
  }

  get current() {
    return db.currentPsychologist;
  }

  isAuthenticated() {
    return !!db.currentPsychologist;
  }

  isVaultUnlocked() {
    const id = db.currentPsychologistId;
    return id ? cryptoService.isUnlocked(id) : false;
  }

  listPublicPsychologists() {
    return db.psychologists
      .filter(p => p.isActive)
      .map(p => cryptoService.constructor.publicPsychologistView(p));
  }
}

function friendlyAuthError(ex) {
  const m = String(ex?.message || ex);
  if (/over_email_send_rate_limit|rate/i.test(m)) return 'Слишком часто. Подождите минуту и запросите код снова.';
  if (/invalid|token|expired|bad/i.test(m)) return 'Код неверный или истёк. Запросите новый.';
  if (/signup|not allowed|disabled/i.test(m)) return 'Вход по коду отключён в настройках Supabase Auth.';
  return 'Сервер не принял код: ' + m;
}

export const authService = new AuthService();
