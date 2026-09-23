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

  _startWindow() {
    clearInterval(this._win);
    this.resendIn = 120; // 2 минуты на ввод кода
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
      const res = await authService.verifyCode(this.email, this.code, this.profile);
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
