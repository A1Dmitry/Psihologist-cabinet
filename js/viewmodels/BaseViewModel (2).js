/**
 * Базовый ViewModel (MVVM)
 * Поддержка подписки на изменения для привязки к View
 */
export class BaseViewModel {
  constructor() {
    this._listeners = new Set();
    this._busy = false;
    this._error = '';
    this._toast = '';
  }

  get busy() { return this._busy; }
  set busy(v) {
    this._busy = !!v;
    this.notify();
  }

  get error() { return this._error; }
  set error(v) {
    this._error = v || '';
    this.notify();
  }

  get toast() { return this._toast; }
  set toast(v) {
    this._toast = v || '';
    this.notify();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  notify() {
    this._listeners.forEach(fn => {
      try { fn(this); } catch (e) { console.error(e); }
    });
  }

  showToast(msg, ms = 2800) {
    this.toast = msg;
    setTimeout(() => {
      if (this.toast === msg) {
        this.toast = '';
        this.notify();
      }
    }, ms);
  }
}
