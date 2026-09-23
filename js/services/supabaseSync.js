/**
 * Синхронизация локального DbContext ↔ Supabase
 * Общие данные: психологи, услуги, клиенты, сессии
 */
import { db } from '../core/dbContext.js';
import { Psychologist, Service, Client, Session, SessionSettings } from '../models/entities.js';
import { supabaseApi } from './supabaseApi.js';
import { isSupabaseConfigured } from './supabaseConfig.js';

function mapPsy(row) {
  return new Psychologist({
    id: row.id,
    email: row.email,
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
    isActive: row.is_active !== false,
    keyVerifier: row.key_verifier || null,
    createdAt: row.created_at
  });
}

function mapService(row) {
  return new Service({
    id: row.id,
    psychologistId: row.psychologist_id,
    name: row.title,
    title: row.title,
    description: row.description || '',
    duration: row.duration_min || 60,
    durationMin: row.duration_min || 60,
    price: Number(row.price) || 0,
    currency: row.currency || 'BYN',
    format: row.format || 'offline',
    isActive: row.is_active !== false
  });
}

function mapClient(row) {
  return new Client({
    id: row.id,
    psychologistId: row.psychologist_id,
    name: row.name || row.nickname || '',
    nickname: row.nickname || row.name || '',
    phone: row.phone || '',
    contact: row.contact || '',
    note: row.note || '',
    trustLevel: row.trust_level || 'new',
    noShowCount: row.no_show_count || 0,
    cancelCount: row.cancel_count || 0,
    createdAt: row.created_at
  });
}

function mapSession(row) {
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
    clientResponse: row.client_response || '',
    pendingChange: row.pending_change || null,
    createdAt: row.created_at
  });
}

export const supabaseSync = {
  enabled() {
    return isSupabaseConfigured();
  },

  /**
   * Загрузить каталог + данные всех психологов в локальный db
   * (для пилота с 1 психологом — достаточно)
   */
  async pullAll() {
    if (!this.enabled()) return { ok: false, message: 'Supabase не настроен (anon key)' };

    const rows = await supabaseApi.listPsychologists();
    if (!rows?.length) {
      return { ok: false, message: 'В Supabase нет психологов — выполните seed.sql' };
    }

    // Серверный каталог полностью заменяет локальный seed-каталог.
    // Это не merge: локальные демо-записи не должны попадать в публичный список.
    db.psychologists = rows.map(mapPsy);
    db.services = [];
    db.clients = [];
    db.sessions = [];
    db.settings = [];

    // услуги, клиенты, сессии, настройки по каждому
    for (const r of rows) {
      const psyId = r.id;

      const services = await supabaseApi.listServices(psyId);
      db.services = db.services.filter(s => s.psychologistId !== psyId);
      (services || []).forEach(s => db.services.push(mapService(s)));

      const clients = await supabaseApi.listClients(psyId);
      db.clients = db.clients.filter(c => c.psychologistId !== psyId);
      (clients || []).forEach(c => db.clients.push(mapClient(c)));

      const sessions = await supabaseApi.listSessions(psyId);
      db.sessions = db.sessions.filter(s => s.psychologistId !== psyId);
      (sessions || []).forEach(s => db.sessions.push(mapSession(s)));

      try {
        const st = await supabaseApi.getSettings(psyId);
        if (st) {
          db.settings = db.settings.filter(x => x.psychologistId !== psyId);
          db.settings.push(new SessionSettings({
            psychologistId: psyId,
            workDays: st.work_days || [1, 2, 3, 4, 5],
            slotStart: st.slot_start || '10:00',
            slotEnd: st.slot_end || '18:00',
            slotStepMin: st.slot_step_min || 60,
            defaultVideoPlatform: st.default_video_platform || 'google_meet',
            paymentPolicy: st.payment_policy || 'none',
            depositPercent: Number(st.deposit_percent) || 30,
            holdMinutes: st.hold_minutes || 30
          }));
        }
      } catch (_) { /* settings optional */ }
    }

    db.saveChanges();
    return { ok: true, message: `Синхронизировано психологов: ${rows.length}` };
  },

  /** Создать клиента + сессию на сервере (запись с сайта) */
  async pushBooking({ psychologistId, client, session }) {
    if (!this.enabled()) return { ok: false, localOnly: true };

    let clientId = client.id;
    // если id локальный (не uuid) — создаём на сервере
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(clientId || ''));

    if (!isUuid) {
      const created = await supabaseApi.createClient({
        psychologist_id: psychologistId,
        name: client.name || client.nickname || '',
        nickname: client.nickname || client.name || '',
        phone: client.phone || '',
        contact: client.contact || '',
        note: client.note || '',
        trust_level: client.trustLevel || 'new'
      });
      clientId = created.id;
      // обновить локально
      const local = db.clients.find(c => c.id === client.id);
      if (local) {
        local.id = clientId;
        local.psychologistId = psychologistId;
      }
    }

    const createdSes = await supabaseApi.createSession({
      psychologist_id: psychologistId,
      client_id: clientId,
      service_id: session.serviceId || null,
      session_date: session.date,
      session_time: session.time,
      status: session.status || 'pending',
      note: session.note || '',
      video_platform: session.videoPlatform || '',
      meet_link: session.meetLink || '',
      payment_policy: session.paymentPolicy || 'none',
      payment_status: session.paymentStatus || 'unpaid',
      amount_due: session.amountDue || 0,
      amount_paid: session.amountPaid || 0,
      currency: session.currency || 'BYN'
    });

    const localSes = db.sessions.find(s => s.id === session.id);
    if (localSes && createdSes?.id) {
      localSes.id = createdSes.id;
      localSes.clientId = clientId;
    }
    db.saveChanges();
    return { ok: true, clientId, sessionId: createdSes?.id };
  }
};
