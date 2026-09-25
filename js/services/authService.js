/**
 * AuthService — тонкая обёртка над каноническим use case регистрации
 * (`js/domain/registration.js`) плюс сейф клиентов.
 *
 * Исторически правила входа/регистрации (канал доставки кода, проверка кода,
 * привязка профиля, инициализация состояния) были написаны прямо здесь, а
 * часть логики дублировалась в AuthViewModel. После аудита AUDIT-REG-DRY-001
 * доменная и аутентификационная логика живёт только в `registration`;
 * этот файл НЕ реализует её повторно, а делегирует.
 *
 * Сейф клиентов (AES-ключ, верификатор пароля) — отдельная ответственность,
 * она остаётся здесь: к регистрации отношения не имеет.
 */
import { db } from '../core/dbContext.js';
import { cryptoService, vaultPasswordError } from './cryptoService.js';
import { registration } from '../domain/registration.js';
import { supabaseSync } from './supabaseSync.js';

export class AuthService {
  /** Шаг 1: отправить код на email (сервер). */
  requestCode(email) {
    return registration.requestVerification(email);
  }

  /**
   * Шаг 2: проверить код → сессия → привязка/создание кабинета → локальное
   * состояние → (опция) открыть сейф клиентов паролем с формы регистрации.
   *
   * @param {string} vaultPassword пароль сейфа с формы регистрации (опция,
   *        не для входа: '' — сейф задаётся позже во вкладке «Клиенты»).
   */
  async verifyCode(email, code, profile = {}, vaultPassword = '') {
    // Пароль сейфа проверяем ДО обращения к серверу: код одноразовый,
    // и тратить его на заведомо отклонённый ввод нельзя.
    const pwError = vaultPasswordError(vaultPassword);
    if (pwError) return { ok: false, message: pwError };

    const res = await registration.completeVerification(email, code, profile, {
      // при регистрации обязательные поля должны дойти до сервера;
      // при обычном входе профиль уже существует и дозаполнять его не требуется
      requireProfileFields: false
    });
    if (!res.ok) return res;

    // Пароль сейфа с формы регистрации применяется сразу (issue #14, п.7 —
    // challenger-находка: поле собиралось, но нигде не использовалось, и сейф
    // оставался незадатым, хотя форма помечала пароль обязательным «*»).
    const pw = String(vaultPassword || '');
    if (pw) {
      const psyId = res.psychologist.id;
      const hasVerifier = !!db.psychologists.find(x => x.id === psyId)?.keyVerifier;
      // у уже существующего кабинета verifier свой: пароль с формы может лишь
      // открыть сейф, но не подменить его
      const vault = hasVerifier
        ? await this.unlockVault(psyId, pw)
        : await this.initVaultPassword(psyId, pw);
      if (!vault.ok) return { ...res, message: `${res.message} Сейф: ${vault.message}` };
      return {
        ...res,
        message: hasVerifier
          ? 'Email подтверждён, вход выполнен. Сейф клиентов открыт.'
          : 'Email подтверждён, вход выполнен. Сейф клиентов создан и открыт.'
      };
    }
    return res;
  }

  /** Восстановить вход после перезагрузки страницы (см. registration). */
  restoreAuthenticatedState() {
    return registration.restoreAuthenticatedState();
  }

  logout() {
    cryptoService.lock(db.currentPsychologistId);
    cryptoService.lockAll();
    registration.signOut();
  }

  get session() {
    return registration.currentSession();
  }

  /** Сохранённый канал: 'fn' (current) | 'otp' (legacy pending only) | null. */
  get channel() {
    return registration.currentChannel();
  }

  get current() {
    return db.currentPsychologist;
  }

  get currentPsychologist() {
    return db.currentPsychologist;
  }

  isAuthenticated() {
    return !!db.currentPsychologist;
  }

  // ——— Сейф клиентов (пароль — только для шифрования, не для входа) ———
  /** Задать пароль сейфа (если ещё не задан).
   *  Verifier сразу отправляется на сервер (pushKeyVerifier): если он останется
   *  только в localStorage, то очистка хранилища или другое устройство увидят
   *  «сейф не настроен», а повторный init с тем же паролем создаст НОВУЮ соль
   *  и несовместимый ключ — прежние шифроблобы станут нечитаемыми. */
  async initVaultPassword(psychologistId, password) {
    const psy = db.psychologists.find(x => x.id === psychologistId);
    if (!psy) return { ok: false, message: 'Кабинет не найден' };
    if (psy.keyVerifier) return { ok: false, message: 'Пароль сейфа уже задан' };
    const pwError = vaultPasswordError(password, { required: true });
    if (pwError) return { ok: false, message: pwError };
    const salt = await cryptoService.randomSalt();
    psy.keyVerifier = await cryptoService.createVerifier(password, salt);
    db.saveChanges();
    const unlocked = await cryptoService.unlock(psychologistId, password, psy.keyVerifier);
    if (!unlocked) return { ok: false, message: 'Не удалось открыть сейф' };
    const pushed = await supabaseSync.pushKeyVerifier(psy);
    return pushed.ok
      ? { ok: true, serverSynced: true, message: 'Сейф создан и открыт' }
      : { ok: true, serverSynced: false, message: 'Сейф создан и открыт (сервер недоступен: пароль действует только на этом устройстве)' };
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

export const authService = new AuthService();
