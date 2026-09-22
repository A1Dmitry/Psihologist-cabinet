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
  SessionReminder: 'SessionReminders'
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

/** Психолог — владелец кабинета */
export class Psychologist {
  constructor({
    id = null,
    email = '',
    fullName = '',
    phone = '',
    specialization = 'Психолог',
    city = '',
    about = '',
    slug = '',
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
    this.slug = slug || Psychologist.makeSlug(fullName || email);
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

/** Услуга психолога */
export class Service {
  constructor({
    id = null,
    psychologistId = null,
    name = '',
    price = 0,
    currency = 'BYN',
    duration = 60,
    format = 'offline',
    isActive = true,
    /** переопределение политики оплаты для услуги (null = из настроек кабинета) */
    paymentPolicy = null,
    depositPercent = null,
    depositAmount = null
  } = {}) {
    this.id = id;
    this.psychologistId = psychologistId;
    this.name = name;
    this.price = Number(price) || 0;
    this.currency = currency;
    this.duration = Number(duration) || 60;
    this.format = format;
    this.isActive = isActive;
    this.paymentPolicy = paymentPolicy;
    this.depositPercent = depositPercent;
    this.depositAmount = depositAmount;
  }

  priceLabel() {
    return this.currency === 'RUB' ? `${this.price} ₽` : `${this.price} бел. руб.`;
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
    timezone = 'Europe/Minsk',
    defaultVideoPlatform = 'google_meet',
    slotTimes = null,
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
    reminderChannel = 'telegram_sms' // demo channel label
  } = {}) {
    this.psychologistId = psychologistId;
    this.workHours = workHours;
    this.timezone = timezone;
    this.defaultVideoPlatform = defaultVideoPlatform;
    this.slotTimes = slotTimes || ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
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
