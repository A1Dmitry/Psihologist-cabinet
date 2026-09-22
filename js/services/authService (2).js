/**
 * AuthService — email-код + пароль психолога
 * Пароль → PBKDF2 → AES-ключ сейфа клиентов (только в памяти)
 */
import { db } from '../core/dbContext.js';
import { cryptoService } from './cryptoService.js';
import { clientVaultService } from './clientVaultService.js';

const CODE_TTL_MS = 10 * 60 * 1000;

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export class AuthService {
  sendCode(email, purpose = 'login') {
    const e = String(email || '').toLowerCase().trim();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, message: 'Укажите корректный email' };
    }

    const existing = db.findPsychologistByEmail(e);

    if (purpose === 'register' && existing) {
      return { ok: false, message: 'Этот email уже зарегистрирован. Войдите.' };
    }
    if (purpose === 'login' && !existing) {
      return { ok: false, message: 'Аккаунт не найден. Зарегистрируйтесь.' };
    }

    db.emailCodes.forEach(c => {
      if (c.email === e && c.purpose === purpose && !c.used) c.used = true;
    });

    const code = generateCode();
    const entity = db.addEmailCode({
      email: e,
      code,
      purpose,
      expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      used: false
    });

    console.info(`[Auth] Код для ${e} (${purpose}): ${code}`);

    return {
      ok: true,
      message: `Код отправлен на ${e}`,
      demoCode: code,
      purpose,
      expiresAt: entity.expiresAt
    };
  }

  /**
   * Регистрация / вход: код email + пароль (пароль → ключ шифрования)
   */
  async verifyCode(email, code, purpose, profile = {}) {
    const e = String(email || '').toLowerCase().trim();
    const c = String(code || '').trim();
    const password = String(profile.password || '');

    if (password.length < 6) {
      return { ok: false, message: 'Пароль не менее 6 символов (из него строится ключ шифрования)' };
    }

    const record = [...db.emailCodes]
      .reverse()
      .find(x => x.email === e && x.purpose === purpose && x.code === c);

    if (!record) {
      return { ok: false, message: 'Неверный код' };
    }
    if (!record.isValid) {
      return { ok: false, message: 'Код истёк. Запросите новый.' };
    }

    record.used = true;
    db.saveChanges();

    if (purpose === 'register') {
      if (!profile.fullName || profile.fullName.trim().length < 2) {
        return { ok: false, message: 'Укажите ФИО для регистрации' };
      }
      const salt = await cryptoService.randomSalt();
      const keyVerifier = await cryptoService.createVerifier(password, salt);
      const psy = db.addPsychologist({
        email: e,
        fullName: profile.fullName.trim(),
        phone: profile.phone || '',
        specialization: profile.specialization || 'Психолог',
        city: profile.city || '',
        about: profile.about || '',
        keyVerifier
      });
      await cryptoService.unlock(psy.id, password, keyVerifier);
      db.setCurrentPsychologist(psy.id);
      return { ok: true, psychologist: psy, message: 'Регистрация завершена. Сейф клиентов открыт.' };
    }

    const psy = db.findPsychologistByEmail(e);
    if (!psy) {
      return { ok: false, message: 'Психолог не найден' };
    }

    // миграция старых аккаунтов без verifier
    if (!psy.keyVerifier) {
      const salt = await cryptoService.randomSalt();
      psy.keyVerifier = await cryptoService.createVerifier(password, salt);
      db.saveChanges();
    }

    const unlocked = await cryptoService.unlock(psy.id, password, psy.keyVerifier);
    if (!unlocked) {
      return { ok: false, message: 'Неверный пароль' };
    }

    db.setCurrentPsychologist(psy.id);
    const migrated = await clientVaultService.migratePlaintextToEncrypted(psy.id);
    const msg = migrated
      ? `Вход выполнен. Зашифровано карточек: ${migrated}`
      : 'Вход выполнен. Сейф клиентов открыт.';
    return { ok: true, psychologist: psy, message: msg };
  }

  logout() {
    const id = db.currentPsychologistId;
    cryptoService.lock(id);
    cryptoService.lockAll();
    db.clearCurrentPsychologist();
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

  /** Публичный каталог — без email и без данных клиентов */
  listPublicPsychologists() {
    return db.psychologists
      .filter(p => p.isActive)
      .map(p => cryptoService.constructor.publicPsychologistView(p));
  }
}

export const authService = new AuthService();
