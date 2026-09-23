import { BaseViewModel } from './BaseViewModel.js';
import { authService } from '../services/authService.js';

/**
 * ViewModel: вход/регистрация по коду из письма (Supabase Auth OTP).
 * «Получить код» → окно ожидания ввода 2 минуты (таймер повторной отправки) →
 * код совпал → email подтверждён → кабинет открыт.
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
      const res = await authService.requestCode(this.email);
      if (!res.ok) {
        this.error = res.message;
        return false;
      }
      this.step = 'code';
      this._startWindow();
      this.showToast(res.message);
      return true;
    } catch (ex) {
      this.error = /rate|часто/i.test(String(ex?.message))
        ? 'Слишком часто. Подождите минуту и попробуйте снова.'
        : `Не удалось отправить код: ${ex?.message || ex}`;
      return false;
    } finally {
      this.busy = false;
    }
  }

  async confirmCode() {
    this.error = '';
    this.busy = true;
    try {
      const res = await authService.verifyCode(this.email, this.code, {
        fullName: this.fullName,
        phone: this.phone,
        specialization: this.specialization,
        city: this.city,
        about: this.about,
        password: this.password
      });
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

  logout() {
    authService.logout();
    this.step = 'email';
    this.code = '';
    this.notify();
  }
}
