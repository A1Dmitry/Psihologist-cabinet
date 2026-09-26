import { BaseViewModel } from './BaseViewModel.js';
import { db } from '../core/dbContext.js';
import { authService } from '../services/authService.js';
import { CryptoService } from '../services/cryptoService.js';

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ViewModel публичного портала — каталог психологов
 */
export class PortalViewModel extends BaseViewModel {
  constructor() {
    super();
    this.query = '';
    this.cityFilter = '';
    /** Источник каталога: 'loading' | 'server' | 'none' (строго серверный режим). */
    this.source = 'loading';
    this.serverError = '';
  }

  /**
   * Каталог загружен с сервера и по нему можно выносить окончательные
   * вердикты («специалист не найден», noindex). Единственный источник истины
   * для всех экранов (RULES §6.14): раньше предикат `source === 'server' ||
   * source === 'demo'` был скопирован в четыре места app.js, и состояние
   * 'demo' (issue #121, R14) приходилось помнить в каждом из них.
   */
  get catalogReady() {
    return this.source === 'server';
  }

  get psychologists() {
    let list = authService.listPublicPsychologists();
    const terms = normalizeSearchText(this.query).split(' ').filter(Boolean);
    if (terms.length) {
      list = list.filter(p => {
        const searchable = normalizeSearchText([
          p.fullName,
          p.specialization,
          p.about,
          p.city,
          p.experience,
          p.greeting,
          p.approach,
          // направления работы / запросы клиента
          ...(p.directions || []).flatMap(d => [d.title, d.details]),
          // образование и опыт
          ...(p.education?.basic || []).map(x => x.title),
          ...(p.education?.additional || []).map(x => x.title),
          ...(p.experienceItems || []).map(x => `${x.organisation} ${x.details}`)
        ].join(' '));
        return terms.every(term => searchable.includes(term));
      });
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
