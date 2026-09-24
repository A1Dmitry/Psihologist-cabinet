import { BaseViewModel } from './BaseViewModel.js';
import { authService } from '../services/authService.js';
import { registration } from '../domain/registration.js';

/**
 * ViewModel входа/регистрации: ТОЛЬКО UI-состояние, оркестрация и представление.
 *
 * Ни валидации, ни правил каналов, ни привязки профиля здесь нет — всё это
 * живёт в каноническом use case `js/domain/registration.js` (требование
 * AUDIT-REG-DRY-001). ViewModel умеет: хранить поля формы, крутить таймер
 * повторной отправки, вызывать use case и показывать его результат/ошибку.
 */
export class AuthViewModel extends BaseViewModel {
  constructor() {
    super();
    this.mode = 'login'; // login | register
    this.step = 'email'; // email | code
    this.email = '';
    this.code = '';
    this.fullName = '';
    this.phone = '';
    this.specialization = 'Психолог';
    this.city = '';
    this.about = '';
    this.password = ''; // пароль сейфа клиентов (опция, не для входа)
    this.resendIn = 0;  // сек до повторной отправки (окно ожидания)
  }

  get resendLabel() {
    if (this.resendIn <= 0) return 'Отправить код снова';
    const m = Math.floor(this.resendIn / 60);
    const s = String(this.resendIn % 60).padStart(2, '0');
    return `Повторная отправка через ${m}:${s}`;
  }

  /** Поля профиля, которые уходят в use case. */
  get profile() {
    return {
      fullName: this.fullName,
      phone: this.phone,
      specialization: this.specialization,
      city: this.city,
      about: this.about
    };
  }

  /**
   * Восстановить шаг ввода кода после перезагрузки страницы (issue #14, п.3).
   *
   * Канал доставки сохраняется вместе с ожиданием, поэтому после reload код
   * проверяется тем же транспортом, которым он был выслан; при истёкшем окне
   * пользователь явно видит, что нужен новый код (тихого переключения канала
   * больше нет). Вызывается из renderAuth() ровно один раз на загрузку.
   */
  resumePendingVerification() {
    if (this._resumed) return false;
    this._resumed = true;

    const record = registration.peekPendingVerification();
    if (!record) return false;

    const remainingMs = record.expiresAt - Date.now();
    if (remainingMs > 0) {
      this.email = record.email;
      this.step = 'code';
      this._startWindow(Math.ceil(remainingMs / 1000));
      return true;
    }

    // Ожидание есть, но окно ввода истекло: пользователь должен это увидеть,
    // а не молча оказаться на пустой форме (код на сервере уже не примут).
    this.email = record.email;
    this.step = 'email';
    this.error = 'Окно ввода кода истекло. Запросите новый код.';
    registration.clearPendingVerification();
    return true;
  }

  /** Подсказка о незаполненных обязательных полях (валидация — из use case). */
  get profileError() {
    return registration.validateProfile(this.profile, { required: this.mode === 'register' });
  }

  setMode(mode) {
    this.mode = mode === 'register' ? 'register' : 'login';
    this.step = 'email';
    this.code = '';
    this.error = '';
    this.notify();
  }

  _startWindow(seconds = 120) {
    clearInterval(this._win);
    this.resendIn = Math.max(0, seconds); // 2 минуты на ввод кода
    this._win = setInterval(() => {
      this.resendIn = Math.max(0, this.resendIn - 1);
      if (this.resendIn === 0) clearInterval(this._win);
      this.notify();
    }, 1000);
  }

  async requestCode() {
    this.error = '';
    this.busy = true;
    try {
      const res = await registration.requestVerification(this.email);
      if (!res.ok) {
        this.error = res.message;
        return false;
      }
      this.step = 'code';
      this._startWindow();
      this.showToast(res.message);
      return true;
    } catch (ex) {
      this.error = registration.friendlyAuthError(ex);
      return false;
    } finally {
      this.busy = false;
    }
  }

  async confirmCode() {
    this.error = '';
    this.busy = true;
    try {
      // пароль сейфа (this.password) — опция формы регистрации, не для входа;
      // use case применит его к сейфу сразу после успешного входа
      const res = await authService.verifyCode(this.email, this.code, this.profile, this.password);
      if (!res.ok) {
        this.error = res.message;
        return null;
      }
      clearInterval(this._win);
      this.resendIn = 0;
      this.showToast(res.message);
      return res.psychologist;
    } finally {
      this.busy = false;
    }
  }

  /** Восстановить вход после перезагрузки страницы (вызывается из boot). */
  async restore() {
    return registration.restoreAuthenticatedState();
  }

  logout() {
    authService.logout();
    this.step = 'email';
    this.code = '';
    this.notify();
  }
}
