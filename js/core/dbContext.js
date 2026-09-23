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

  /** Публичный каталог психологов Минска и Гродно.
   * Данные собраны из открытых профилей; реальные email/пароли не создаются.
   * example.invalid используется только как технический маркер записи для синхронизации.
   */
  _seed() {
    const catalog = [
      { fullName: 'Анастасия Мартынова', city: 'Минск', specialization: 'Семейный психолог; тревожность, эмоции, отношения, созависимость', about: 'Публичная анкета: семейное консультирование, работа с тревожностью и эмоциями, отношениями и созависимостью. Очный и онлайн-форматы.', website: 'https://www.b17.ru/max367/', sourceUrl: 'https://www.b17.ru/max367/', experience: '3 года на B17' },
      { fullName: 'Екатерина Шалахман', city: 'Минск', specialization: 'Психолог, экзистенциальный терапевт; индивидуальная и парная работа', about: 'Публичная анкета: выгорание, тревога, синдром самозванца, кризисы в отношениях, сепарация, прокрастинация и страх ошибки.', website: 'https://www.b17.ru/kaosipova/', sourceUrl: 'https://www.b17.ru/kaosipova/', experience: 'Более 8 лет практики по описанию профиля' },
      { fullName: 'Егор Ильин', city: 'Минск', specialization: 'Психолог, магистр психологии; отношения и самооценка', about: 'Публичная анкета: расставания, ревность, обида, любовная зависимость, вина, стыд, отношения, семейные конфликты, одиночество и стресс.', website: 'https://www.b17.ru/egor_iluo__/', sourceUrl: 'https://www.b17.ru/egor_iluo__/', experience: 'Магистр психологии; 2 года на B17' },
      { fullName: 'Абрамович Инна', city: 'Минск', specialization: 'Практический психолог; анализ поведения и эффективная коммуникация', about: 'Публичная анкета: помощь в адаптации к сложным обстоятельствам, конфликтам с близкими и трудным рабочим ситуациям.', website: 'https://www.b17.ru/abramovich_inna/', sourceUrl: 'https://www.b17.ru/abramovich_inna/', experience: 'Более 15 лет опыта по описанию профиля' },
      { fullName: 'Белко Лариса Станиславовна', city: 'Минск', specialization: 'Психолог, EMDR-терапевт, травма-терапевт, бизнес-психолог', about: 'Публичная анкета: работа с травмой, жизненными сценариями и бизнес-запросами; указаны EMDR, кинезиология и символдрама.', website: 'https://www.b17.ru/larisabelko/', sourceUrl: 'https://www.b17.ru/larisabelko/', experience: '5 лет на B17' },
      { fullName: 'Гурко Михаил Владимирович', city: 'Минск', specialization: 'Психолог, системный семейный терапевт, гештальт-подход', about: 'Публичная анкета: индивидуальная и парная работа, зависимость, тревога, панические атаки, депрессия, выгорание, развод и кризисы.', website: 'https://www.b17.ru/id1033842/', sourceUrl: 'https://www.b17.ru/id1033842/', experience: '41 год; 2 года на B17' },
      { fullName: 'Семён Красильников', city: 'Минск', specialization: 'Психоаналитик, сексолог, секс-терапевт', about: 'Публичная анкета: работа на пересечении психологических трудностей и вопросов сексуальности.', website: 'https://www.b17.ru/id942230/', sourceUrl: 'https://www.b17.ru/id942230/', experience: '3 года на B17' },
      { fullName: 'Наталья Денисьева', city: 'Минск', specialization: 'Кризисный и провокативный психолог; интегративный подход', about: 'Сайт центра: индивидуальная и семейная терапия, кризисные состояния, телесно-ориентированная терапия, арт-терапия, ДПДГ и КПТ.', website: 'https://psy-provocator.com/', sourceUrl: 'https://psyprosto-help.by/', experience: '17 лет практического опыта по данным сайта центра' },
      { fullName: 'Снежана Сковинская', city: 'Минск', specialization: 'Кризисный психолог', about: 'Специалист центра кризисной психологии «Просто жить!»; запись и актуальные условия опубликованы на сайте центра.', website: 'https://psyprosto-help.by/uslugi', sourceUrl: 'https://psyprosto-help.by/', experience: 'Публичный профиль центра' },
      { fullName: 'Наталия Корнукова', city: 'Минск', specialization: 'Кризисный психолог, специалист по психодиагностике', about: 'Специалист центра кризисной психологии «Просто жить!»; также указаны игропрактика и обучающие программы.', website: 'https://psyprosto-help.by/uslugi', sourceUrl: 'https://psyprosto-help.by/', experience: 'Публичный профиль центра' },
      { fullName: 'Елена Костюченко', city: 'Гродно', phone: '+375 (29) 778-44-38', specialization: 'Кандидат психологических наук, доцент; КПТ, схема-терапия, семейная и детская психология', about: 'Индивидуальные и групповые консультации, работа с семьями, супругами и детьми. Также указаны майндфулнесс, CFT, экзистенциальное консультирование, травматерапия, ДПДТ и ACT.', website: 'https://psihologgrodno.by/', sourceUrl: 'https://psihologgrodno.by/', address: 'г. Гродно, ул. Врублевского, 3', experience: 'Много лет практической психологии; кандидат психологических наук, доцент' },
      { fullName: 'Валерия Соловьёва', city: 'Гродно', phone: '+375 (29) 207-57-15', specialization: 'Практический психолог, магистр психологии; КПТ, детская и семейная практика', about: 'Работа со взрослыми, детьми и родителями; темы расставаний, тревоги, депрессивных состояний, самооценки и воспитания.', website: 'https://solovushka.by/', sourceUrl: 'https://solovushka.by/obo-mne/', address: 'г. Гродно, ул. Горького 91, каб. 306', experience: 'Практика с 2018 года; магистр психологии с 2020 года' },
      { fullName: 'Алла Карчик', city: 'Гродно', specialization: 'Психолог; самооценка и тревожные мысли', about: 'Публичная анкета: повышение самооценки, работа с тревожными мыслями, самостоятельные навыки преодоления трудностей.', website: 'https://www.b17.ru/karchik/', sourceUrl: 'https://www.b17.ru/karchik/', experience: '4 года на B17' },
      { fullName: 'Владислав Селицкий', city: 'Гродно', specialization: 'Врач-психотерапевт, онлайн-консультант', about: 'Публичная анкета: депрессия, панические атаки, тревога, фобии, стресс, психосоматика и зависимости.', website: 'https://www.b17.ru/selitskij/', sourceUrl: 'https://www.b17.ru/selitskij/', experience: '9 лет на B17' },
      { fullName: 'Лариса Волкова', city: 'Гродно', specialization: 'Психолог высшей квалификационной категории; КПТ, семейная терапия', about: 'Публичная анкета: кризисы, депрессии, психосоматические расстройства, семейные проблемы, страхи и тревога.', website: 'https://www.b17.ru/id423802/', sourceUrl: 'https://www.b17.ru/id423802/', experience: 'Более 20 лет стажа по описанию профиля' },
      { fullName: 'Мария Вакер', city: 'Гродно', specialization: 'Психолог; экзистенциальный подход', about: 'Публичная анкета: практикующий психолог, индивидуальное и парное консультирование, очный и онлайн-форматы.', website: 'https://www.b17.ru/vaker_mariya/', sourceUrl: 'https://www.b17.ru/vaker_mariya/', experience: 'Практика с 2012 года по описанию профиля' },
      { fullName: 'Павел Гаврилик', city: 'Гродно', specialization: 'Психолог для пар и индивидуальных клиентов', about: 'Публичная анкета: диалог в отношениях, тревога и самооценка; очный и онлайн-форматы.', website: 'https://www.b17.ru/haurylik_pavel/', sourceUrl: 'https://www.b17.ru/haurylik_pavel/', experience: '2000+ часов практики по описанию профиля' },
      { fullName: 'Александр Кох', city: 'Гродно', specialization: 'Психолог, системный семейный психолог', about: 'Публичная анкета: системная семейная психотерапия; автор книги «Разговор со Страхом».', website: 'https://www.b17.ru/koh/', sourceUrl: 'https://www.b17.ru/koh/', experience: '7 лет на B17' },
      { fullName: 'Наталия Михайловская', city: 'Гродно', phone: '+375 (29) 780-45-45',
        publicEmail: 'mikhailouskayanataliya@gmail.com',
        specialization: 'Гештальт-терапевт, кризисный и семейный психолог',
        greeting: 'Добро пожаловать. Меня зовут Наталия Михайловская.',
        about: 'Работа с отношениями, кризисами, тревогой, самооценкой, личными границами, эмоциональным выгоранием и семейными запросами. Использует гештальт-подход, системную семейную терапию, НЛП/ИНП и МАК.',
        approach: 'В своей работе я использую методы и концепции из различных направлений психотерапии, подбирая их под психические особенности клиента.',
        photoUrl: 'https://optim.tildacdn.biz/tild3136-3339-4362-b337-613561643332/-/format/webp/IMG_6796.JPG.webp',
        website: 'https://nataliamikhailouskaya.by/', sourceUrl: 'https://nataliamikhailouskaya.by/',
        address: 'г. Гродно, ул. Свердлова, 16', experience: '10 лет работы в областном клиническом центре и 10 лет частной практики по данным официального сайта',
        // «Направления моей работы» / «С чем могу помочь»
        directions: [
          { title: 'Взаимоотношения', details: 'созависимые, кризисы, сложности в построении отношений: супружеских, партнёрских, детско-родительских; переживания измены, болезненные расставания и разводы' },
          { title: 'Страхи, повышенная тревожность', details: '' },
          { title: 'Неуверенность в себе, низкая самооценка, поиск себя', details: '' },
          { title: 'Переживания злости, обиды, стыда, чувство вины', details: '' },
          { title: 'Личные границы', details: '' },
          { title: 'Стресс, упадок сил, эмоциональное выгорание', details: '' }
        ],
        education: {
          basic: [
            { title: 'Гродненский государственный университет им. Я. Купалы, факультет психологии (5-ти летнее обучение)', institution: 'Гродненский государственный университет им. Я. Купалы', details: 'факультет психологии; 5-ти летнее обучение' },
            { title: 'Московский Гештальт Институт (МГИ)', institution: 'Московский Гештальт Институт (МГИ)', details: '' }
          ],
          additional: [
            { title: 'Специалист в области кризисов и травм', institution: '', details: '' },
            { title: 'Специалист в области семейной системной психотерапии', institution: '', details: '' },
            { title: 'Психотерапия секса и сексуальных отношений', institution: '', details: '' },
            { title: 'Сертифицированный НЛП-практик', institution: '', details: '' },
            { title: 'Специалист по использованию метафорических ассоциативных карт', institution: '', details: '' }
          ]
        },
        experienceItems: [
          { organisation: 'Областной клинический центр «Психиатрия-наркология»', details: 'В данный момент работаю в областном клиническом центре «Психиатрия-наркология» 10 лет', years: 10, isCurrent: true },
          { organisation: 'Частная практика', details: 'Также консультирую на протяжении 10 лет в рамках частной практики', years: 10, isCurrent: true }
        ],
        socials: [
          { kind: 'telegram', url: 'https://t.me/psyholog_natali', title: 'telegram' },
          { kind: 'instagram', url: 'https://www.instagram.com/psyholog__natali', title: 'instagram' }
        ],
        paymentLinks: [
          { label: 'Очная/онлайн консультации', url: 'https://api.bepaid.by/products/prd_4b68b00019808a21/pay', kind: 'service' },
          { label: 'Семейная консультация', url: 'https://api.bepaid.by/products/prd_eec3c942ea52cfed/pay', kind: 'service' },
          { label: 'Свободный платёж', url: 'https://nataliamikhailouskaya.by/donation', kind: 'donation' }
        ],
        paymentRequisites: {
          recipient: 'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ МИХАЙЛОВСКАЯ НАТАЛИЯ МИХАЙЛОВНА',
          legalAddress: 'РБ, Г. ГРОДНО, УЛ. ПРОЛЕТАРСКАЯ, Д. 54 ОФ. 65',
          unp: '591945736',
          account: 'BY67ALFA30132A03540010270000',
          bankName: 'ЗАО «Альфа-Банк»',
          bik: 'ALFABY2X',
          purpose: 'оплата за консультацию по охране здоровья или консультация',
          donationUrl: 'https://nataliamikhailouskaya.by/donation'
        },
        services: [
          { name: 'Очная консультация', price: 80, currency: 'BYN', duration: 60, format: 'offline', description: 'в г. Гродно (Беларусь)', payUrl: 'https://api.bepaid.by/products/prd_4b68b00019808a21/pay', sortOrder: 1 },
          { name: 'Супружеское (семейное) консультирование', price: 110, currency: 'BYN', duration: 90, format: 'offline', description: 'личный приём в г. Гродно', payUrl: 'https://api.bepaid.by/products/prd_eec3c942ea52cfed/pay', sortOrder: 2 },
          { name: 'Онлайн-консультация', price: 3000, currency: 'RUB', duration: 60, format: 'online', description: 'в Skype, WhatsApp, Viber, Telegram, Zoom', platforms: ['skype', 'whatsapp', 'viber', 'telegram', 'zoom'], payUrl: 'https://api.bepaid.by/products/prd_4b68b00019808a21/pay', sortOrder: 3 }
        ]
      }
    ];

    this.psychologists = catalog.map((p, index) => new Psychologist({
      ...p,
      id: `psy_catalog_${String(index + 1).padStart(2, '0')}`,
      email: `catalog+${Psychologist.makeSlug(p.fullName)}-${index + 1}@example.invalid`,
      slug: Psychologist.makeSlug(p.fullName) + '-' + (index + 1)
    }));

    this.services = catalog.flatMap((p, index) => (p.services || [
      { name: 'Очная консультация', price: 0, currency: 'BYN', duration: 60, format: 'offline' },
      { name: 'Онлайн-консультация', price: 0, currency: 'BYN', duration: 60, format: 'online' }
    ]).map(s => new Service({
      ...s,
      id: s.id || uid('svc'),
      psychologistId: this.psychologists[index].id
    })));
    this.settings = this.psychologists.map(p => new SessionSettings({ psychologistId: p.id }));
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
