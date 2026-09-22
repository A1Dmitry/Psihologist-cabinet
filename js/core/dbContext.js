/**
 * Code First DbContext — единая точка доступа к данным
 * Аналог EF Core DbContext + InMemory/LocalStorage provider
 */
import {
  Psychologist, EmailCode, Service, Client, Session, WaitingItem, SessionSettings,
  Payment, BookingAttempt, ClientRisk, PaymentPolicy, SessionReminder
} from '../models/entities.js';

const STORAGE_KEY = 'psy_portal_cf_v5';

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Безопасное хранилище (sandbox-safe) */
class StorageProvider {
  constructor() {
    this.memory = Object.create(null);
    this._ls = null;
  }

  getLS() {
    if (this._ls !== null) return this._ls || null;
    try {
      const ls = window.localStorage;
      ls.setItem('__t', '1');
      ls.removeItem('__t');
      this._ls = ls;
      return ls;
    } catch {
      this._ls = false;
      return null;
    }
  }

  get(key) {
    const ls = this.getLS();
    if (ls) {
      try { return ls.getItem(key); } catch { /* */ }
    }
    return this.memory[key] ?? null;
  }

  set(key, value) {
    const ls = this.getLS();
    if (ls) {
      try { ls.setItem(key, value); return; } catch { /* */ }
    }
    this.memory[key] = value;
  }

  remove(key) {
    const ls = this.getLS();
    if (ls) {
      try { ls.removeItem(key); } catch { /* */ }
    }
    delete this.memory[key];
  }
}

export class DbContext {
  constructor() {
    this.storage = new StorageProvider();
    this.psychologists = [];
    this.emailCodes = [];
    this.services = [];
    this.clients = [];
    this.sessions = [];
    this.payments = [];
    this.waitingItems = [];
    this.settings = [];
    this.bookingAttempts = [];
    this.clientRisks = [];
    this.reminders = [];
    this.currentPsychologistId = null;
    this._load();
  }

  // ——— Persistence ———
  _snapshot() {
    return {
      psychologists: this.psychologists,
      emailCodes: this.emailCodes,
      services: this.services,
      clients: this.clients,
      sessions: this.sessions,
      payments: this.payments,
      waitingItems: this.waitingItems,
      settings: this.settings,
      bookingAttempts: this.bookingAttempts,
      clientRisks: this.clientRisks,
      reminders: this.reminders,
      currentPsychologistId: this.currentPsychologistId
    };
  }

  saveChanges() {
    this.storage.set(STORAGE_KEY, JSON.stringify(this._snapshot()));
  }

  _load() {
    try {
      const raw = this.storage.get(STORAGE_KEY);
      if (!raw) {
        this._seed();
        return;
      }
      const data = JSON.parse(raw);
      this.psychologists = (data.psychologists || []).map(x => new Psychologist(x));
      this.emailCodes = (data.emailCodes || []).map(x => new EmailCode(x));
      this.services = (data.services || []).map(x => new Service(x));
      this.clients = (data.clients || []).map(x => new Client(x));
      this.sessions = (data.sessions || []).map(x => new Session(x));
      this.payments = (data.payments || []).map(x => new Payment(x));
      this.waitingItems = (data.waitingItems || []).map(x => new WaitingItem(x));
      this.settings = (data.settings || []).map(x => new SessionSettings(x));
      this.bookingAttempts = (data.bookingAttempts || []).map(x => new BookingAttempt(x));
      this.clientRisks = (data.clientRisks || []).map(x => new ClientRisk(x));
      this.reminders = (data.reminders || []).map(x => new SessionReminder(x));
      this.currentPsychologistId = data.currentPsychologistId || null;
      if (!this.psychologists.length) this._seed();
    } catch {
      this._seed();
    }
  }

  /** Демо-данные портала (несколько психологов) */
  _seed() {
    const n1 = new Psychologist({
      id: uid('psy'),
      email: 'natalia@example.com',
      fullName: 'Наталия Михайловская',
      phone: '+375 29 780-45-45',
      specialization: 'Гештальт-терапевт, кризисный и семейный психолог',
      city: 'Гродно',
      about: 'Использую методы из различных направлений психотерапии, подбирая их под особенности клиента.',
      slug: 'natalia-mikhailovskaya'
    });
    const n2 = new Psychologist({
      id: uid('psy'),
      email: 'ivan@example.com',
      fullName: 'Иван Петров',
      phone: '+375 29 100-20-30',
      specialization: 'Когнитивно-поведенческий психолог',
      city: 'Минск',
      about: 'Работа с тревогой, депрессией и навыками саморегуляции.',
      slug: 'ivan-petrov'
    });

    this.psychologists = [n1, n2];
    this.services = [
      new Service({ id: uid('svc'), psychologistId: n1.id, name: 'Очная консультация', price: 80, currency: 'BYN', duration: 60, format: 'offline' }),
      new Service({ id: uid('svc'), psychologistId: n1.id, name: 'Семейная консультация', price: 110, currency: 'BYN', duration: 90, format: 'offline' }),
      new Service({ id: uid('svc'), psychologistId: n1.id, name: 'Онлайн-консультация', price: 3000, currency: 'RUB', duration: 60, format: 'online' }),
      new Service({ id: uid('svc'), psychologistId: n2.id, name: 'Индивидуальная КПТ', price: 90, currency: 'BYN', duration: 50, format: 'offline' }),
      new Service({ id: uid('svc'), psychologistId: n2.id, name: 'Онлайн КПТ', price: 70, currency: 'BYN', duration: 50, format: 'online' })
    ];
    this.settings = [
      new SessionSettings({
        psychologistId: n1.id,
        defaultVideoPlatform: 'google_meet',
        paymentPolicy: PaymentPolicy.DEPOSIT,
        depositPercent: 30,
        holdMinutes: 60
      }),
      new SessionSettings({
        psychologistId: n2.id,
        defaultVideoPlatform: 'google_meet',
        workHours: 'Пн–Сб 9:00–18:00',
        paymentPolicy: PaymentPolicy.FULL,
        holdMinutes: 45
      })
    ];
    this.clients = [];
    this.sessions = [];
    this.payments = [];
    this.waitingItems = [];
    this.bookingAttempts = [];
    this.clientRisks = [];
    this.reminders = [];
    this.emailCodes = [];
    this.currentPsychologistId = null;
    this.saveChanges();
  }

  resetToSeed() {
    this.storage.remove(STORAGE_KEY);
    this.psychologists = [];
    this.emailCodes = [];
    this.services = [];
    this.clients = [];
    this.sessions = [];
    this.payments = [];
    this.waitingItems = [];
    this.settings = [];
    this.bookingAttempts = [];
    this.clientRisks = [];
    this.reminders = [];
    this.currentPsychologistId = null;
    this._seed();
  }

  // ——— Auth session ———
  setCurrentPsychologist(id) {
    this.currentPsychologistId = id;
    this.saveChanges();
  }

  clearCurrentPsychologist() {
    this.currentPsychologistId = null;
    this.saveChanges();
  }

  get currentPsychologist() {
    if (!this.currentPsychologistId) return null;
    return this.psychologists.find(p => p.id === this.currentPsychologistId) || null;
  }

  // ——— CRUD helpers ———
  addPsychologist(data) {
    const p = new Psychologist({ ...data, id: data.id || uid('psy') });
    this.psychologists.push(p);
    this.settings.push(new SessionSettings({ psychologistId: p.id }));
    // default services
    this.services.push(
      new Service({ id: uid('svc'), psychologistId: p.id, name: 'Очная консультация', price: 80, currency: 'BYN', duration: 60, format: 'offline' }),
      new Service({ id: uid('svc'), psychologistId: p.id, name: 'Онлайн-консультация (Google Meet)', price: 70, currency: 'BYN', duration: 60, format: 'online' })
    );
    this.saveChanges();
    return p;
  }

  findPsychologistByEmail(email) {
    const e = String(email).toLowerCase().trim();
    return this.psychologists.find(p => p.email === e) || null;
  }

  findPsychologistBySlug(slug) {
    return this.psychologists.find(p => p.slug === slug && p.isActive) || null;
  }

  addEmailCode(data) {
    const code = new EmailCode({ ...data, id: data.id || uid('code') });
    this.emailCodes.push(code);
    this.saveChanges();
    return code;
  }

  servicesOf(psychologistId) {
    return this.services.filter(s => s.psychologistId === psychologistId && s.isActive);
  }

  clientsOf(psychologistId) {
    return this.clients.filter(c => c.psychologistId === psychologistId);
  }

  sessionsOf(psychologistId) {
    return this.sessions.filter(s => s.psychologistId === psychologistId);
  }

  waitingOf(psychologistId) {
    return this.waitingItems.filter(w => w.psychologistId === psychologistId);
  }

  settingsOf(psychologistId) {
    return this.settings.find(s => s.psychologistId === psychologistId) || new SessionSettings({ psychologistId });
  }

  addClient(data) {
    const c = new Client({ ...data, id: data.id || uid('cli') });
    this.clients.push(c);
    this.saveChanges();
    return c;
  }

  updateClient(id, patch) {
    const c = this.clients.find(x => x.id === id);
    if (!c) return null;
    Object.assign(c, patch);
    this.saveChanges();
    return c;
  }

  removeClient(id) {
    this.clients = this.clients.filter(c => c.id !== id);
    this.sessions = this.sessions.filter(s => s.clientId !== id);
    this.saveChanges();
  }

  addSession(data) {
    const s = new Session({ ...data, id: data.id || uid('ses') });
    this.sessions.push(s);
    this.saveChanges();
    return s;
  }

  updateSession(id, patch) {
    const s = this.sessions.find(x => x.id === id);
    if (!s) return null;
    Object.assign(s, patch);
    this.saveChanges();
    return s;
  }

  removeSession(id) {
    this.sessions = this.sessions.filter(s => s.id !== id);
    this.saveChanges();
  }

  addService(data) {
    const s = new Service({ ...data, id: data.id || uid('svc') });
    this.services.push(s);
    this.saveChanges();
    return s;
  }

  removeService(id) {
    const svc = this.services.find(s => s.id === id);
    if (!svc) return;
    const others = this.services.filter(s => s.psychologistId === svc.psychologistId && s.id !== id);
    if (others.length === 0) return false;
    this.services = this.services.filter(s => s.id !== id);
    this.saveChanges();
    return true;
  }

  addWaiting(data) {
    const w = new WaitingItem({ ...data, id: data.id || uid('wait') });
    this.waitingItems.push(w);
    this.saveChanges();
    return w;
  }

  removeWaiting(id) {
    this.waitingItems = this.waitingItems.filter(w => w.id !== id);
    this.saveChanges();
  }
}

export const db = new DbContext();
