/**
 * Code First — модели данных портала психологов
 * Оплата: предоплата / аванс / 100% по чеку
 * Защита: антиспам, риск-скоринг клиента
 */

export const EntityNames = {
  Psychologist: 'Psychologists',
  EmailCode: 'EmailCodes',
  Service: 'Services',
  Client: 'Clients',
  Session: 'Sessions',
  Payment: 'Payments',
  WaitingItem: 'WaitingItems',
  SessionSettings: 'SessionSettings',
  BookingAttempt: 'BookingAttempts',
  ClientRisk: 'ClientRisks',
  SessionReminder: 'SessionReminders',
  ScheduleBlock: 'ScheduleBlocks',
  Task: 'Tasks',
  PsyNote: 'PsyNotes',
  ClientEntry: 'ClientEntries'
};

/**
 * Профессии специалистов (портал — не только психологи).
 * discriminator для мультипрофильности: UI-каталог, SEO (schema.org), таксономия запросов.
 */
export const Professions = {
  psychologist: { label: 'Психолог', schemaType: 'ProfessionalService' },
  psychotherapist: { label: 'Психотерапевт', schemaType: 'MedicalBusiness' },
  coach: { label: 'Коуч', schemaType: 'ProfessionalService' },
  lawyer: { label: 'Юрист', schemaType: 'LegalService' },
  accountant: { label: 'Бухгалтер', schemaType: 'AccountingService' }
};

/** Типы блокировок занятости (выходной, занят и т.д.) */
export const ScheduleBlockKind = {
  DAY_OFF: 'day_off',       // выходной
  BUSY: 'busy',             // занят
  VACATION: 'vacation',     // отпуск
  HOLIDAY: 'holiday',       // праздник
  OTHER: 'other'
};

/** Политика оплаты услуги/кабинета */
export const PaymentPolicy = {
  NONE: 'none',                 // без предоплаты, мягкое подтверждение
  DEPOSIT: 'deposit',           // аванс (часть суммы)
  FULL: 'full',                 // 100% предоплата = подтверждённая запись
  HOLD_UNTIL_PAID: 'hold'       // слот удерживается до оплаты / истечения
};

export const PaymentStatus = {
  UNPAID: 'unpaid',
  DEPOSIT_PAID: 'deposit_paid',
  FULLY_PAID: 'fully_paid',
  REFUNDED: 'refunded',
  EXPIRED: 'expired',
  FAILED: 'failed'
};

/** Психолог — владелец кабинета.
 *  Модель расширена по публичному профилю с сайта (см. docs/DATA-MODEL.md):
 *  «Обо мне», направления работы, образование, опыт, контакты/соцсети, оплата.
 */
export class Psychologist {
  constructor({
    id = null,
    email = '',
    fullName = '',
    phone = '',
      specialization = 'Психолог',
      city = '',
      about = '',
      website = '',
      sourceUrl = '',
      address = '',
      experience = '',
      slug = '',
    // —— «Обо мне» (публичный профиль) ——
    greeting = '',
    approach = '',
    photoUrl = '',
    publicEmail = '',
    // —— Направления работы / запросы клиента («С чем могу помочь») ——
    // [{ title, details }] — details в скобках после title (как на сайте)
    directions = [],
    // —— Образование: { basic: [{title, institution, details}], additional: [...] } ——
    education = null,
    // —— Опыт работы: [{ organisation, details, years, isCurrent }] ——
    experienceItems = [],
    // —— Контакты/соцсети: [{ kind: telegram|instagram|skype|..., url, title }] ——
    socials = [],
    // —— Платёжные ссылки (bePaid и пр.): [{ label, url, kind: service|donation|other }] ——
    paymentLinks = [],
    // —— Банковские реквизиты для платежа по реквизитам ——
    paymentRequisites = null,
    /** discriminator профессии (см. Professions) — портал расширяется не только на психологов */
    profession = 'psychologist',
    isActive = true,
    /** { salt, iv, data } — verifier ключа из пароля; пароль не хранится */
    keyVerifier = null,
    createdAt = null
  } = {}) {
    this.id = id;
    this.email = String(email).toLowerCase().trim();
    this.fullName = fullName;
    this.phone = phone;
    this.specialization = specialization;
    this.city = city;
    this.about = about;
    this.website = website;
    this.sourceUrl = sourceUrl;
    this.address = address;
    this.experience = experience;
    this.slug = slug || Psychologist.makeSlug(fullName || email);

    this.greeting = greeting || '';
    this.approach = approach || '';
    this.photoUrl = photoUrl || '';
    this.publicEmail = String(publicEmail || '').toLowerCase().trim();
    this.directions = normList(directions, d => ({
      title: str(d?.title),
      details: str(d?.details)
    }));
    this.education = {
      basic: normList(education?.basic, educationItem),
      additional: normList(education?.additional, educationItem)
    };
    this.experienceItems = normList(experienceItems, x => ({
      organisation: str(x?.organisation),
      details: str(x?.details),
      years: x?.years != null && x.years !== '' ? Number(x.years) : null,
      isCurrent: !!x?.isCurrent
    }));
    this.socials = normList(socials, s => ({
      kind: str(s?.kind) || 'other',
      url: str(s?.url),
      title: str(s?.title)
    }));
    this.paymentLinks = normList(paymentLinks, l => ({
      label: str(l?.label),
      url: str(l?.url),
      kind: str(l?.kind) || 'other'
    }));
    this.paymentRequisites = {
      recipient: str(paymentRequisites?.recipient),
      legalAddress: str(paymentRequisites?.legalAddress),
      unp: str(paymentRequisites?.unp),
      account: str(paymentRequisites?.account),
      bankName: str(paymentRequisites?.bankName),
      bik: str(paymentRequisites?.bik),
      purpose: str(paymentRequisites?.purpose),
      donationUrl: str(paymentRequisites?.donationUrl)
    };
    this.profession = Professions[profession] ? profession : 'psychologist';

    this.isActive = isActive;
    this.keyVerifier = keyVerifier;
    this.createdAt = createdAt || new Date().toISOString();
  }

  static makeSlug(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'psy';
  }
}

function str(v) {
  return v == null ? '' : String(v);
}

function normList(value, mapItem) {
  return Array.isArray(value) ? value.filter(Boolean).map(mapItem) : [];
}

function educationItem(x) {
  return {
    title: str(x?.title),
    institution: str(x?.institution),
    details: str(x?.details)
  };
}

/** Код подтверждения email (регистрация / вход / верификация клиента) */
export class EmailCode {
  constructor({
    id = null,
    email = '',
    code = '',
    purpose = 'register', // register | login | client_verify
    expiresAt = null,
    used = false,
    createdAt = null
  } = {}) {
    this.id = id;
    this.email = String(email).toLowerCase().trim();
    this.code = code;
    this.purpose = purpose;
    this.expiresAt = expiresAt;
    this.used = used;
    this.createdAt = createdAt || new Date().toISOString();
  }

  get isValid() {
    return !this.used && this.expiresAt && new Date(this.expiresAt) > new Date();
  }
}

/** Услуга психолога (блок «Услуги» публичного профиля) */
export class Service {
  constructor({
    id = null,
    psychologistId = null,
    name = '',
    title = '', // алиас name (Supabase-колонка title)
    price = 0,
    currency = 'BYN',
    duration = 60,
    durationMin = null, // алиас duration (Supabase-колонка duration_min)
    format = 'offline',
    description = '',
    /** каналы для онлайн-консультации: ['skype','whatsapp','viber','telegram','zoom'] */
    platforms = null,
    /** внешняя платёжная ссылка (bePaid product URL и т.п.) */
    payUrl = '',
    sortOrder = 0,
    isActive = true,
    /** переопределение политики оплаты для услуги (null = из настроек кабинета) */
    paymentPolicy = null,
    depositPercent = null,
    depositAmount = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.name = name || title;
    this.price = Number(price) || 0;
    this.currency = currency;
    this.duration = Number(durationMin ?? duration) || 60;
    this.format = format;
    this.description = description || '';
    this.platforms = Array.isArray(platforms) ? platforms.map(String) : [];
    this.payUrl = payUrl || '';
    this.sortOrder = Number(sortOrder) || 0;
    this.isActive = isActive;
    this.paymentPolicy = paymentPolicy;
    this.depositPercent = depositPercent;
    this.depositAmount = depositAmount;
  }

  priceLabel() {
    return this.currency === 'RUB' ? `${this.price} рос. руб.` : `${this.price} бел. руб.`;
  }
}

/** Клиент */
export class Client {
  constructor({
    id = null,
    psychologistId = null,
    name = '',
    nickname = '',
    phone = '',
    contact = '',
    note = '',
    trustLevel = 'new', // new | trusted | caution | blocked
    noShowCount = 0,
    cancelCount = 0,
    verifiedContact = false,
    encryptedPii = null,
    nicknameHash = '',
    needsEncryption = false,
    createdAt = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.name = name;
    this.nickname = nickname || name;
    this.phone = phone;
    this.contact = contact;
    this.note = note;
    this.trustLevel = trustLevel;
    this.noShowCount = Number(noShowCount) || 0;
    this.cancelCount = Number(cancelCount) || 0;
    this.verifiedContact = !!verifiedContact;
    this.encryptedPii = encryptedPii;
    this.nicknameHash = nicknameHash || '';
    this.needsEncryption = !!needsEncryption;
    this.createdAt = createdAt || new Date().toISOString();
  }
}

/** Сессия / запись */
export class Session {
  constructor({
    id = null,
    psychologistId = null,
    clientId = null,
    serviceId = null,
    date = '',
    time = '',
    status = 'pending', // pending | held | confirmed | paid | done | cancelled | no_show | expired
    note = '',
    videoPlatform = '',
    meetLink = '',
    paymentPolicy = PaymentPolicy.NONE,
    paymentStatus = PaymentStatus.UNPAID,
    amountDue = 0,
    amountPaid = 0,
    currency = 'BYN',
    holdExpiresAt = null,
    requiresPayment = false,
    clientResponse = null, // null | confirmed | declined | change_confirmed | change_declined
    clientRespondedAt = null,
    /** Google Calendar: идентификатор события для синхронизации */
    googleEventId = '',
    /** предложенный перенос владельцем кабинета */
    pendingChange = null, // { date, time, reason, proposedAt } | null
    previousSlot = null, // { date, time } до переноса
    changeConsentStatus = null, // pending | confirmed | declined
    createdAt = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.clientId = clientId;
    this.serviceId = serviceId;
    this.date = date;
    this.time = time;
    this.status = status;
    this.note = note;
    this.videoPlatform = videoPlatform;
    this.meetLink = meetLink;
    this.paymentPolicy = paymentPolicy;
    this.paymentStatus = paymentStatus;
    this.amountDue = Number(amountDue) || 0;
    this.amountPaid = Number(amountPaid) || 0;
    this.currency = currency;
    this.holdExpiresAt = holdExpiresAt;
    this.requiresPayment = !!requiresPayment;
    this.clientResponse = clientResponse;
    this.clientRespondedAt = clientRespondedAt;
    this.googleEventId = googleEventId || '';
    this.pendingChange = pendingChange;
    this.previousSlot = previousSlot;
    this.changeConsentStatus = changeConsentStatus;
    this.createdAt = createdAt || new Date().toISOString();
  }

  get isSlotBlocking() {
    if (['cancelled', 'expired', 'no_show'].includes(this.status)) return false;
    if (this.status === 'held' && this.holdExpiresAt && new Date(this.holdExpiresAt) < new Date()) return false;
    return true;
  }
}

/** Платёж / чек */
export class Payment {
  constructor({
    id = null,
    sessionId = null,
    psychologistId = null,
    clientId = null,
    amount = 0,
    currency = 'BYN',
    kind = 'full', // deposit | full | balance
    method = 'manual', // manual | card_demo | transfer | receipt
    status = PaymentStatus.UNPAID,
    receiptCode = '',
    externalRef = '',
    paidAt = null,
    createdAt = null,
    note = ''
  } = {}) {
    this.id = id;
    this.sessionId = sessionId;
    this.psychologistId = psychologistId;
    this.clientId = clientId;
    this.amount = Number(amount) || 0;
    this.currency = currency;
    this.kind = kind;
    this.method = method;
    this.status = status;
    this.receiptCode = receiptCode;
    this.externalRef = externalRef;
    this.paidAt = paidAt;
    this.createdAt = createdAt || new Date().toISOString();
    this.note = note;
  }
}

/** Лист ожидания */
export class WaitingItem {
  constructor({
    id = null,
    psychologistId = null,
    clientId = null,
    type = 'wait',
    name = '',
    phone = '',
    note = '',
    createdAt = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.clientId = clientId;
    this.type = type;
    this.name = name;
    this.phone = phone;
    this.note = note;
    this.createdAt = createdAt || new Date().toISOString();
  }
}

/** Настройки кабинета + оплата + антиспам */
export class SessionSettings {
  constructor({
    psychologistId = null,
    workHours = 'Пн–Пт 10:00–19:00',
    workDays = null, // [1..7] — рабочие дни недели
    timezone = 'Europe/Minsk',
    defaultVideoPlatform = 'google_meet',
    slotTimes = null,
    slotStart = '10:00',
    slotEnd = '18:00',
    slotStepMin = 60,
    // —— оплата ——
    paymentPolicy = PaymentPolicy.DEPOSIT,
    depositPercent = 30,
    depositAmount = null,
    holdMinutes = 60,
    // —— защита записи ——
    maxActiveUnpaidPerPhone = 1,
    maxBookingsPerDayPerPhone = 2,
    minSecondsOnForm = 4,
    cooldownMinutesAfterCancel = 120,
    blockAfterNoShows = 2,
    requireVerifiedContactIfRisk = true,
    allowNewClientWithoutDeposit = false,
    // напоминания
    reminderEnabled = true,
    reminderHoursBefore = 24, // оптимум: 24; альтернатива 12 / 48
    reminderSecondHoursBefore = 12, // повтор, если нет ответа (0 = выкл)
    reminderChannel = 'telegram_sms', // demo channel label
    // —— Google Calendar (занятость) ——
    /** secret iCal-адрес календаря (basic.ics) — хранится приватно, импорт в блокировки */
    googleCalendarIcalUrl = '',
    googleSyncBusy = true
  } = {}) {
    this.psychologistId = psychologistId;
    this.workHours = workHours;
    this.workDays = Array.isArray(workDays) ? workDays.map(Number) : [1, 2, 3, 4, 5];
    this.timezone = timezone;
    this.defaultVideoPlatform = defaultVideoPlatform;
    this.slotTimes = slotTimes || ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    this.slotStart = slotStart || '10:00';
    this.slotEnd = slotEnd || '18:00';
    this.slotStepMin = Number(slotStepMin) || 60;
    this.paymentPolicy = paymentPolicy;
    this.depositPercent = Number(depositPercent) || 30;
    this.depositAmount = depositAmount != null ? Number(depositAmount) : null;
    this.holdMinutes = Number(holdMinutes) || 60;
    this.maxActiveUnpaidPerPhone = Number(maxActiveUnpaidPerPhone) || 1;
    this.maxBookingsPerDayPerPhone = Number(maxBookingsPerDayPerPhone) || 2;
    this.minSecondsOnForm = Number(minSecondsOnForm) || 4;
    this.cooldownMinutesAfterCancel = Number(cooldownMinutesAfterCancel) || 120;
    this.blockAfterNoShows = Number(blockAfterNoShows) || 2;
    this.requireVerifiedContactIfRisk = requireVerifiedContactIfRisk !== false;
    this.allowNewClientWithoutDeposit = !!allowNewClientWithoutDeposit;
    this.reminderEnabled = reminderEnabled !== false;
    this.reminderHoursBefore = Number(reminderHoursBefore) || 24;
    this.reminderSecondHoursBefore = reminderSecondHoursBefore == null ? 12 : Number(reminderSecondHoursBefore);
    this.reminderChannel = reminderChannel || 'telegram_sms';
    this.googleCalendarIcalUrl = googleCalendarIcalUrl || '';
    this.googleSyncBusy = googleSyncBusy !== false;
  }
}

/**
 * Блокировка занятости специалиста (выходной, занят, отпуск…).
 * Публично отдаётся только free/busy (см. public_schedule_blocks) — без заметок.
 */
export class ScheduleBlock {
  constructor({
    id = null,
    psychologistId = null,
    dateFrom = '',            // YYYY-MM-DD (включительно)
    dateTo = '',              // YYYY-MM-DD (включительно); пусто = один день
    timeFrom = '',            // HH:MM, пусто = весь день
    timeTo = '',              // HH:MM
    kind = ScheduleBlockKind.BUSY,
    title = '',               // «Выходной», «Отпуск» — видно на публичной странице
    note = '',                // приватная заметка — НЕ видна анонимам
    source = 'manual',        // manual | google
    googleEventId = '',
    createdAt = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.dateFrom = dateFrom;
    this.dateTo = dateTo || dateFrom;
    this.timeFrom = timeFrom || '';
    this.timeTo = timeTo || '';
    this.kind = Object.values(ScheduleBlockKind).includes(kind) ? kind : ScheduleBlockKind.OTHER;
    this.title = title || '';
    this.note = note || '';
    this.source = source || 'manual';
    this.googleEventId = googleEventId || '';
    this.createdAt = createdAt || new Date().toISOString();
  }

  /** Покрывает ли блокировка дату (и время, если указано) */
  covers(date, time = '') {
    if (!this.dateFrom || date < this.dateFrom || date > (this.dateTo || this.dateFrom)) return false;
    if (!this.timeFrom && !this.timeTo) return true; // весь день
    if (!time) return true;
    const from = this.timeFrom || '00:00';
    const to = this.timeTo || '23:59';
    return time >= from && time < to;
  }
}

/** Напоминание клиенту о сессии */
export class SessionReminder {
  constructor({
    id = null,
    sessionId = null,
    psychologistId = null,
    clientId = null,
    kind = 'confirm_request', // confirm_request | day_of_nudge
    scheduledFor = null,
    sentAt = null,
    status = 'scheduled', // scheduled | sent | confirmed | declined | skipped | failed
    channel = 'telegram_sms',
    messageBody = '',
    responseToken = '',
    respondedAt = null,
    createdAt = null
  } = {}) {
    this.id = id;
    this.sessionId = sessionId;
    this.psychologistId = psychologistId;
    this.clientId = clientId;
    this.kind = kind;
    this.scheduledFor = scheduledFor;
    this.sentAt = sentAt;
    this.status = status;
    this.channel = channel;
    this.messageBody = messageBody;
    this.responseToken = responseToken;
    this.respondedAt = respondedAt;
    this.createdAt = createdAt || new Date().toISOString();
  }
}


/** Попытка записи (антиспам-журнал) */
export class BookingAttempt {
  constructor({
    id = null,
    psychologistId = null,
    phoneKey = '',
    fingerprint = '',
    success = false,
    reason = '',
    createdAt = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.phoneKey = phoneKey;
    this.fingerprint = fingerprint;
    this.success = !!success;
    this.reason = reason;
    this.createdAt = createdAt || new Date().toISOString();
  }
}

/** Глобальный риск по телефону (кросс-психолог, в рамках портала) */
export class ClientRisk {
  constructor({
    id = null,
    phoneKey = '',
    noShowTotal = 0,
    cancelTotal = 0,
    fraudFlags = 0,
    blocked = false,
    blockReason = '',
    updatedAt = null
  } = {}) {
    this.id = id;
    this.phoneKey = phoneKey;
    this.noShowTotal = Number(noShowTotal) || 0;
    this.cancelTotal = Number(cancelTotal) || 0;
    this.fraudFlags = Number(fraudFlags) || 0;
    this.blocked = !!blocked;
    this.blockReason = blockReason;
    this.updatedAt = updatedAt || new Date().toISOString();
  }
}


/** Задача психолога (список дел кабинета; опционально связана с клиентом) */
export class Task {
  constructor({
    id = null,
    psychologistId = null,
    title = '',
    details = '',
    dueDate = '',            // YYYY-MM-DD (необязательно)
    clientId = null,
    done = false,
    createdAt = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.title = String(title || '');
    this.details = String(details || '');
    this.dueDate = dueDate || '';
    this.clientId = clientId || null;
    this.done = !!done;
    this.createdAt = createdAt || new Date().toISOString();
  }
}

/** Заметка «блокнота» (планировщик: свободные записи, планы) */
export class PsyNote {
  constructor({
    id = null,
    psychologistId = null,
    title = '',
    body = '',
    date = '',               // YYYY-MM-DD (планирование на дату, необязательно)
    pinned = false,
    createdAt = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.title = String(title || '');
    this.body = String(body || '');
    this.date = date || '';
    this.pinned = !!pinned;
    this.createdAt = createdAt || new Date().toISOString();
  }
}

/** Запись о клиенте (журнал работы: наблюдения, договорённости; PII — только в кабинете) */
export class ClientEntry {
  constructor({
    id = null,
    psychologistId = null,
    clientId = null,
    sessionId = null,
    date = '',               // YYYY-MM-DD
    text = '',
    createdAt = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.clientId = clientId;
    this.sessionId = sessionId || null;
    this.date = date || new Date().toISOString().slice(0, 10);
    this.text = String(text || '');
    this.createdAt = createdAt || new Date().toISOString();
  }
}
