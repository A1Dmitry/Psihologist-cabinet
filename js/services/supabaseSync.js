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
import { Service, SessionSettings, ScheduleBlock, ScheduleOverride } from '../models/entities.js';
import { supabaseApi } from './supabaseApi.js';
import { isSupabaseConfigured } from './supabaseConfig.js';
import { mapPsy } from './psyMapper.js';
import { DEFAULT_DURATION_MIN, resolveDurationMinutes } from '../domain/duration.js';

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
  const duration = resolveDurationMinutes({ durationMin: row.duration_min ?? row.duration });
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
    isActive: row.is_active !== false,
    availability: row.availability ?? null
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

/**
 * Разобрать ошибку REST-клиента в машиночитаемый «диагноз слоя».
 *
 * `request()` бросает `Supabase <status>: <тело>`; тело PostgREST содержит
 * `code` (PGRST205 = объекта нет в schema cache, PGRST204 = нет колонки).
 * Без этого частичная схема выглядит как «данных просто нет»: 404 на
 * public_schedule_overrides неотличим от пустого списка, поэтому дрифт
 * прода видно только в DevTools.
 */
function describeRestError(e) {
  const msg = String(e?.message || e || '');
  const status = /Supabase (\d{3})/.exec(msg)?.[1] || null;
  const code = /"code"\s*:\s*"([^"]+)"/.exec(msg)?.[1] || null;
  return { status, code, message: msg.slice(0, 160) };
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

  /** Отправить ТОЛЬКО key_verifier на сервер (владелец, по своей сессии).
   *
   *  Отдельный метод не случайно: pushProfile сознательно вырезает
   *  key_verifier, чтобы публичный контекст не мог его ни записать, ни
   *  перезаписать. Единственный легитимный писатель — init сейфа у владельца.
   *  Без этой отправки verifier живёт только в localStorage: очистка хранилища
   *  или другое устройство видят «сейф не настроен», а повторный init с тем же
   *  паролем даёт НОВУЮ соль → новый ключ AES → прежние шифроблобы (в т.ч.
   *  серверная encrypted_pii, SR-102) становятся нерасшифровываемыми. */
  async pushKeyVerifier(psychologist) {
    if (!this.enabled()) return { ok: false, localOnly: true };
    if (!psychologist?.id || !psychologist.keyVerifier) return { ok: false, message: 'Verifier сейфа не задан' };
    try {
      await supabaseApi.updatePsychologist(psychologist.id, { key_verifier: psychologist.keyVerifier });
      return { ok: true };
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
    // Исключение — профиль текущего владельца: его id нужен для кабинета и
    // RLS-запросов, а в публичном каталоге свежезарегистрированный специалист
    // может появиться не сразу (кэш view). Потерять его здесь = потерять вход
    // после перезагрузки страницы.
    const prevSettings = new Map(db.settings.map(s => [s.psychologistId, s]));
    const owned = db.currentPsychologistId
      ? db.psychologists.find(p => p.id === db.currentPsychologistId)
      : null;
    db.psychologists = rows.map(mapPsy);
    if (owned && !db.psychologists.some(p => p.id === owned.id)) {
      db.psychologists.push(owned);
    }
    db.services = [];
    db.clients = [];
    db.sessions = [];
    db.settings = [];
    db.scheduleBlocks = [];
    // Overrides сбрасываются вместе со всеми серверными слоями: если слой
    // недоступен (например, view public_schedule_overrides ещё не применён в
    // проде — PostgREST 404), старый кэш из localStorage НЕ должен оставаться.
    // Иначе закрытый день, однажды прочитанный с сервера, закрывает дату
    // навсегда: pullAll молча падает в catch, а строка живёт в хранилище.
    db.scheduleOverrides = [];

    // Слои, которые не прочитались: relation → { status, code }.
    // Пусто = сервер отдал всё, что просили.
    const degraded = new Map();

    for (const r of rows) {
      const psyId = r.id;

      const services = await supabaseApi.listServices(psyId);
      db.services = db.services.filter(s => s.psychologistId !== psyId);
      (services || []).forEach(s => db.services.push(mapService(s)));

      // free/busy: блокировки занятости (без приватных заметок)
      try {
        const blocks = await supabaseApi.listBusyBlocks(psyId);
        (blocks || []).forEach(b => db.scheduleBlocks.push(mapBlock(b)));
      } catch (e) { degraded.set('public_schedule_blocks', describeRestError(e)); }

      // D1: переопределения расписания на дату (закрытые дни / особые окна)
      try {
        const overrides = await supabaseApi.listOverrides(psyId);
        (overrides || []).forEach(o => db.scheduleOverrides.push(new ScheduleOverride({
          id: o.id, psychologistId: o.psychologist_id, date: o.date,
          isClosed: !!o.is_closed, openFrom: o.open_from || '', openTo: o.open_to || '',
          title: o.title || '', createdAt: o.created_at
        })));
      } catch (e) { degraded.set('public_schedule_overrides', describeRestError(e)); }

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
            slotStepMin: st.slot_step_min || DEFAULT_DURATION_MIN,
            defaultVideoPlatform: st.default_video_platform || 'google_meet',
            // D1: политика доступности (public_settings; отсутствуют в старых схемах → дефолты)
            minNoticeMinutes: st.min_notice_minutes ?? 0,
            maxAdvanceDays: st.max_advance_days ?? null,
            bufferBeforeMin: st.buffer_before_min ?? 0,
            bufferAfterMin: st.buffer_after_min ?? 0,
            slotIncrementMin: st.slot_increment_min ?? null,
            maxBookingsPerDay: st.max_bookings_per_day ?? null,
            maxBookingsPerWeek: st.max_bookings_per_week ?? null,
            paymentPolicy: st.payment_policy || 'none',
            depositPercent: Number(st.deposit_percent) || 30,
            holdMinutes: st.hold_minutes || 30,
            // секретный iCal-адрес Google Calendar — локальная приватная настройка
            googleCalendarIcalUrl: prev?.googleCalendarIcalUrl || '',
            googleSyncBusy: prev ? prev.googleSyncBusy !== false : true
          }));
        }
      } catch (e) { degraded.set('public_settings', describeRestError(e)); }
    }

    db.saveChanges();

    const degradedLayers = [...degraded.entries()].map(([relation, d]) => ({ relation, ...d }));
    if (degradedLayers.length) {
      // Не «данных нет», а «слой не применён»: 404/PGRST205 на view означает,
      // что схема в этой базе старше репозитория. Молчаливый catch здесь
      // стоил бы владельцу часов поиска по DevTools.
      console.warn(
        '[Supabase] схема БД применена частично — слои недоступны: '
        + degradedLayers.map(d => `${d.relation} (HTTP ${d.status || '?'}${d.code ? `, ${d.code}` : ''})`).join(', ')
        + '. Эти слои считаются пустыми (политика доступности — по дефолтам).'
        + ' Лечение: переприменить supabase/schema.sql в SQL Editor (docs/INFRA.md, п.2).'
      );
    }
    return {
      ok: true,
      message: `Синхронизировано психологов: ${rows.length}`,
      degraded: degradedLayers
    };
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
      p_currency: session.currency || 'BYN',
      // T-03 / SR-001: канонический контракт пояса клиента —
      // IANA-пояс + снимок смещения (offset не используется вместо пояса)
      p_client_timezone: session.clientTimezone || '',
      p_client_utc_offset_min: session.clientUtcOffsetMin ?? null,
      // снимок длительности услуги на момент записи
      p_duration_min: session.durationMin ?? DEFAULT_DURATION_MIN,
      // T-25: факт согласия на обработку ПДн
      p_consent: !!client.consent,
      p_consent_at: client.consentAt || null
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
      if (created.duration_min) localSes.durationMin = Number(created.duration_min);
    }
    db.saveChanges();
    return {
      ok: true,
      clientId: created.client_id,
      sessionId: created.session_id,
      durationMin: created.duration_min ?? null
    };
  }
};
