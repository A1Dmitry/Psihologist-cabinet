/**
 * Синхронизация локального DbContext ↔ Supabase
 *
 * Публичный контракт (то, что и так публично в сети):
 *   каталог профилей, услуги, часы/слоты/условия, free/busy занятость.
 * Клиенты/сессии/PII анонимам не читаются и не пишутся напрямую:
 * запись клиента идёт только через RPC create_booking (security definer).
 * Кабинет психолога — локально (PII в шифрованном сейфе); серверный доступ
 * к клиентам включается после подключения Supabase Auth (owner_id = auth.uid()).
 */
import { db } from '../core/dbContext.js';
import { Psychologist, Service, SessionSettings, ScheduleBlock } from '../models/entities.js';
import { supabaseApi } from './supabaseApi.js';
import { isSupabaseConfigured } from './supabaseConfig.js';

function mapPsy(row) {
  return new Psychologist({
    id: row.id,
    email: row.email || '',
    fullName: row.full_name,
    phone: row.phone || '',
    specialization: row.specialization || 'Психолог',
    city: row.city || '',
    about: row.about || '',
    website: row.website || '',
    sourceUrl: row.source_url || row.website || '',
    address: row.address || '',
    experience: row.experience || '',
    slug: row.slug || '',
    profession: row.profession || 'psychologist',
    // —— расширенный публичный профиль ——
    greeting: row.greeting || '',
    approach: row.approach || '',
    photoUrl: row.photo_url || '',
    publicEmail: row.public_email || '',
    directions: row.directions || [],
    education: row.education || null,
    experienceItems: row.experience_items || [],
    socials: row.socials || [],
    paymentLinks: row.payment_links || [],
    paymentRequisites: row.payment_requisites || null,
    isActive: row.is_active !== false,
    keyVerifier: row.key_verifier || null,
    createdAt: row.created_at
  });
}

/** Обратное преобразование: Psychologist → строка таблицы psychologists (без потерь) */
function toPsyRow(psy) {
  return {
    email: psy.email,
    full_name: psy.fullName,
    phone: psy.phone || '',
    specialization: psy.specialization || 'Психолог',
    city: psy.city || '',
    about: psy.about || '',
    website: psy.website || '',
    source_url: psy.sourceUrl || '',
    address: psy.address || '',
    experience: psy.experience || '',
    slug: psy.slug,
    greeting: psy.greeting || '',
    approach: psy.approach || '',
    photo_url: psy.photoUrl || '',
    public_email: psy.publicEmail || '',
    directions: psy.directions || [],
    education: psy.education || { basic: [], additional: [] },
    experience_items: psy.experienceItems || [],
    socials: psy.socials || [],
    payment_links: psy.paymentLinks || [],
    payment_requisites: psy.paymentRequisites || {},
    profession: psy.profession || 'psychologist',
    is_active: psy.isActive !== false,
    key_verifier: psy.keyVerifier || null
  };
}

function mapService(row) {
  const title = row.title ?? row.name ?? '';
  const duration = row.duration_min ?? row.duration ?? 60;
  return new Service({
    id: row.id,
    psychologistId: row.psychologist_id,
    name: title,
    title,
    description: row.description || '',
    duration,
    durationMin: duration,
    price: Number(row.price) || 0,
    currency: row.currency || 'BYN',
    format: row.format || 'offline',
    platforms: row.platforms || [],
    payUrl: row.pay_url || '',
    sortOrder: row.sort_order || 0,
    isActive: row.is_active !== false
  });
}

function mapBlock(row) {
  return new ScheduleBlock({
    id: row.id,
    psychologistId: row.psychologist_id,
    dateFrom: row.date_from,
    dateTo: row.date_to || row.date_from,
    timeFrom: row.time_from || '',
    timeTo: row.time_to || '',
    kind: row.kind || 'busy',
    title: row.title || '',
    note: row.note || '',
    source: row.source || 'manual',
    googleEventId: row.google_event_id || '',
    createdAt: row.created_at
  });
}

export const supabaseSync = {
  enabled() {
    return isSupabaseConfigured();
  },

  /** Отправить профиль психолога (включая расширенные поля) на сервер.
   *  В пилоте anon RLS запрещает запись — остаёмся в localStorage с предупреждением. */
  async pushProfile(psychologist) {
    if (!this.enabled()) return { ok: false, localOnly: true };
    if (!psychologist?.id) return { ok: false, message: 'Профиль не выбран' };
    // key_verifier не перезаписываем из публичного контекста
    const row = { ...toPsyRow(psychologist) };
    delete row.key_verifier;
    try {
      await supabaseApi.updatePsychologist(psychologist.id, row);
      return { ok: true, message: 'Профиль синхронизирован с сервером' };
    } catch (e) {
      return { ok: false, message: String(e.message || e) };
    }
  },

  /**
   * Загрузить публичный каталог + услуги + free/busy в локальный db.
   * Клиенты и сессии НЕ загружаются — они приватны (только кабинет владельца).
   */
  async pullAll() {
    if (!this.enabled()) return { ok: false, message: 'Supabase не настроен (anon key)' };

    const rows = await supabaseApi.listPsychologists();
    if (!rows?.length) {
      return { ok: false, message: 'В Supabase нет психологов — выполните seed.sql' };
    }

    // Серверный каталог полностью заменяет локальный seed-каталог.
    // Это не merge: локальные демо-записи не должны попадать в публичный список.
    const prevSettings = new Map(db.settings.map(s => [s.psychologistId, s]));
    db.psychologists = rows.map(mapPsy);
    db.services = [];
    db.clients = [];
    db.sessions = [];
    db.settings = [];
    db.scheduleBlocks = [];

    for (const r of rows) {
      const psyId = r.id;

      const services = await supabaseApi.listServices(psyId);
      db.services = db.services.filter(s => s.psychologistId !== psyId);
      (services || []).forEach(s => db.services.push(mapService(s)));

      // free/busy: блокировки занятости (без приватных заметок)
      try {
        const blocks = await supabaseApi.listBusyBlocks(psyId);
        (blocks || []).forEach(b => db.scheduleBlocks.push(mapBlock(b)));
      } catch (_) { /* блокировки опциональны */ }

      try {
        const st = await supabaseApi.getSettings(psyId);
        if (st) {
          const prev = prevSettings.get(psyId);
          db.settings = db.settings.filter(x => x.psychologistId !== psyId);
          db.settings.push(new SessionSettings({
            psychologistId: psyId,
            workHours: st.work_hours || 'Пн–Пт 10:00–19:00',
            workDays: st.work_days || [1, 2, 3, 4, 5],
            timezone: st.timezone || 'Europe/Minsk',
            slotTimes: st.slot_times || null,
            slotStart: st.slot_start || '10:00',
            slotEnd: st.slot_end || '18:00',
            slotStepMin: st.slot_step_min || 60,
            defaultVideoPlatform: st.default_video_platform || 'google_meet',
            paymentPolicy: st.payment_policy || 'none',
            depositPercent: Number(st.deposit_percent) || 30,
            holdMinutes: st.hold_minutes || 30,
            // секретный iCal-адрес Google Calendar — локальная приватная настройка
            googleCalendarIcalUrl: prev?.googleCalendarIcalUrl || '',
            googleSyncBusy: prev ? prev.googleSyncBusy !== false : true
          }));
        }
      } catch (_) { /* settings optional */ }
    }

    db.saveChanges();
    return { ok: true, message: `Синхронизировано психологов: ${rows.length}` };
  },

  /**
   * Запись клиента на сервер — только через RPC create_booking:
   * сервер проверяет слот и анти-спам; PII не доступна через публичный REST.
   */
  async pushBooking({ psychologistId, client, session }) {
    if (!this.enabled()) return { ok: false, localOnly: true };

    const created = await supabaseApi.createBooking({
      p_psychologist_id: psychologistId,
      p_service_id: session.serviceId || null,
      p_session_date: session.date,
      p_session_time: session.time,
      p_client_name: client.name || client.nickname || '',
      p_client_nickname: client.nickname || client.name || '',
      p_client_phone: client.phone || '',
      p_client_contact: client.contact || '',
      p_client_note: client.note || '',
      p_session_note: session.note || '',
      p_status: session.status || 'pending',
      p_video_platform: session.videoPlatform || '',
      p_payment_policy: session.paymentPolicy || 'none',
      p_payment_status: session.paymentStatus || 'unpaid',
      p_amount_due: session.amountDue || 0,
      p_amount_paid: session.amountPaid || 0,
      p_currency: session.currency || 'BYN'
    });

    if (!created?.ok) {
      return { ok: false, message: created?.error || 'Сервер отклонил запись' };
    }

    // обновить локальные id на серверные
    const localClient = db.clients.find(c => c.id === client.id);
    if (localClient && created.client_id) localClient.id = created.client_id;
    const localSes = db.sessions.find(s => s.id === session.id);
    if (localSes && created.session_id) {
      localSes.id = created.session_id;
      localSes.clientId = created.client_id;
    }
    db.saveChanges();
    return { ok: true, clientId: created.client_id, sessionId: created.session_id };
  }
};
