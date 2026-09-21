import { BaseViewModel } from './BaseViewModel.js';
import { db } from '../core/dbContext.js';
import { authService } from '../services/authService.js';
import { CryptoService } from '../services/cryptoService.js';

/**
 * ViewModel публичного портала — каталог психологов
 */
export class PortalViewModel extends BaseViewModel {
  constructor() {
    super();
    this.query = '';
    this.cityFilter = '';
  }

  get psychologists() {
    let list = authService.listPublicPsychologists();
    const q = this.query.trim().toLowerCase();
    if (q) {
      list = list.filter(p =>
        (p.fullName || '').toLowerCase().includes(q) ||
        (p.specialization || '').toLowerCase().includes(q) ||
        (p.city || '').toLowerCase().includes(q)
      );
    }
    if (this.cityFilter) {
      list = list.filter(p => (p.city || '') === this.cityFilter);
    }
    return list;
  }

  get cities() {
    return [...new Set(authService.listPublicPsychologists().filter(p => p.city).map(p => p.city))].sort();
  }

  get isLoggedIn() {
    return authService.isAuthenticated();
  }

  get currentPsychologist() {
    return authService.current;
  }

  setQuery(q) {
    this.query = q;
    this.notify();
  }

  setCity(city) {
    this.cityFilter = city;
    this.notify();
  }

  servicesCount(psyId) {
    return db.servicesOf(psyId).length;
  }
}
