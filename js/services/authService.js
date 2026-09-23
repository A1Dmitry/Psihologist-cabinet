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
import { cryptoService } from './cryptoService.js';
import { registration } from '../domain/registration.js';

export class AuthService {
  /** Шаг 1: отправить код на email (сервер). */
  requestCode(email) {
    return registration.requestVerification(email);
  }

  /** Шаг 2: проверить код → сессия → привязка/создание кабинета → локальное состояние. */
  async verifyCode(email, code, profile = {}) {
    return registration.completeVerification(email, code, profile, {
      // при регистрации обязательные поля должны дойти до сервера;
      // при обычном входе профиль уже существует и дозаполнять его не требуется
      requireProfileFields: false
    });
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

  /** Канал доставки текущего кода: 'fn' | 'otp' | null. */
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
