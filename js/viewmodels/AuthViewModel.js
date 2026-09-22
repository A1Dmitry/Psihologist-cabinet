import { BaseViewModel } from './BaseViewModel.js';
import { authService } from '../services/authService.js';

/**
 * ViewModel: регистрация / вход по коду email
 */
export class AuthViewModel extends BaseViewModel {
  constructor() {
    super();
    this.mode = 'login'; // login | register
    this.step = 'email'; // email | code
    this.email = '';
    this.code = '';
    this.demoCode = ''; // только для демо-стенда
    this.fullName = '';
    this.phone = '';
    this.specialization = 'Психолог';
    this.city = '';
    this.about = '';
    this.password = '';
  }

  setMode(mode) {
    this.mode = mode === 'register' ? 'register' : 'login';
    this.step = 'email';
    this.code = '';
    this.demoCode = '';
    this.error = '';
    this.notify();
  }

  async requestCode() {
    this.error = '';
    this.busy = true;
    try {
      const purpose = this.mode === 'register' ? 'register' : 'login';
      const res = authService.sendCode(this.email, purpose);
      if (!res.ok) {
        this.error = res.message;
        return false;
      }
      this.step = 'code';
      this.demoCode = res.demoCode || '';
      this.showToast(res.message);
      return true;
    } finally {
      this.busy = false;
    }
  }

  async confirmCode() {
    this.error = '';
    this.busy = true;
    try {
      const purpose = this.mode === 'register' ? 'register' : 'login';
      const res = await authService.verifyCode(this.email, this.code, purpose, {
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
    this.demoCode = '';
    this.notify();
  }
}
