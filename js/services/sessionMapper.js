/**
 * SessionMapper — ЕДИНСТВЕННЫЙ маппер «строка БД ↔ доменная модель Session».
 *
 * До консолидации (аудит AUDIT-REG-DRY-001) преобразование строки `sessions`
 * в `Session` было написано в `cabinetApi`, а в `clientCabinetService` рядом
 * жил второй маппер, который независимо вычислял длительность и валюту.
 * Теперь persistence ↔ domain преобразует только этот модуль; всё, что
 * отличается по смыслу (UI-проекция карточки клиента), строится поверх
 * доменной модели, а не параллельно с ней.
 *
 * Правило слоя: маппер не содержит бизнес-правил — только соответствие полей
 * и канонический резолвер длительности (js/domain/duration.js).
 */
import { Session } from '../models/entities.js';
import { resolveDurationMinutes, DEFAULT_DURATION_MIN } from '../domain/duration.js';

/** Строка таблицы `sessions` (или view) → доменная Session. */
export function sessionFromRow(row, { service = null, slotStepMin = null } = {}) {
  if (!row) return null;
  return new Session({
    id: row.id,
    psychologistId: row.psychologist_id,
    clientId: row.client_id,
    serviceId: row.service_id,
    date: row.session_date,
    time: row.session_time,
    status: row.status || 'pending',
    note: row.note || '',
    videoPlatform: row.video_platform || '',
    meetLink: row.meet_link || '',
    paymentPolicy: row.payment_policy || 'none',
    paymentStatus: row.payment_status || 'unpaid',
    amountDue: Number(row.amount_due) || 0,
    amountPaid: Number(row.amount_paid) || 0,
    currency: row.currency || 'BYN',
    holdExpiresAt: row.hold_expires_at,
    requiresPayment: !!row.requires_payment,
    clientResponse: row.client_response,
    clientRespondedAt: row.client_responded_at,
    googleEventId: row.google_event_id || '',
    pendingChange: row.pending_change || null,
    previousSlot: row.previous_slot || null,
    changeConsentStatus: row.change_consent_status || null,
    // канонический контракт пояса клиента (SR-001/SR-108)
    clientTimezone: row.client_timezone || '',
    clientUtcOffsetMin: row.client_utc_offset_min ?? null,
    // снимок длительности: из строки → из услуги → из шага сетки → дефолт
    durationMin: resolveDurationMinutes({
      durationMin: row.duration_min,
      service,
      slotStepMin
    }),
    createdAt: row.created_at
  });
}

/** Доменная Session → строка таблицы `sessions` (для POST/PATCH). */
export function sessionToRow(session) {
  return {
    session_date: session.date,
    session_time: session.time,
    status: session.status,
    note: session.note || '',
    video_platform: session.videoPlatform || '',
    meet_link: session.meetLink || '',
    payment_policy: session.paymentPolicy || 'none',
    payment_status: session.paymentStatus || 'unpaid',
    amount_due: session.amountDue || 0,
    amount_paid: session.amountPaid || 0,
    currency: session.currency || 'BYN',
    hold_expires_at: session.holdExpiresAt ?? null,
    requires_payment: !!session.requiresPayment,
    client_response: session.clientResponse ?? null,
    client_responded_at: session.clientRespondedAt ?? null,
    pending_change: session.pendingChange ?? null,
    previous_slot: session.previousSlot ?? null,
    change_consent_status: session.changeConsentStatus ?? null,
    google_event_id: session.googleEventId || '',
    client_timezone: session.clientTimezone || '',
    client_utc_offset_min: session.clientUtcOffsetMin ?? null,
    duration_min: session.durationMin ?? DEFAULT_DURATION_MIN
  };
}

export const sessionMapper = { sessionFromRow, sessionToRow };
