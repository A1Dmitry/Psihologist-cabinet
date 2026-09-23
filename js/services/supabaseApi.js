/**
 * Минимальный REST-клиент Supabase (без npm)
 * PostgREST: /rest/v1/<table | view | rpc>
 *
 * Публичный контракт (RLS, anon) — только то, что публично в сети:
 *   public_profiles       — публичный профиль специалиста (без email-учётки и key_verifier)
 *   services              — услуги/цены
 *   public_settings       — часы работы/слоты/условия оплаты (без антиспам-настроек)
 *   public_schedule_blocks— free/busy блокировки (без приватных заметок)
 *   public_booked_slots   — занятые слоты (дата/время без данных клиента)
 *   rpc/create_booking    — запись клиента (security definer; единственный путь записи)
 *
 * Клиенты, сессии, платежи и PII анонимам НЕ доступны (см. supabase/schema.sql).
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from './supabaseConfig.js';

const PUBLIC_PROFILE_COLUMNS = 'id,full_name,phone,specialization,city,about,website,source_url,address,experience,slug,greeting,approach,photo_url,public_email,directions,education,experience_items,socials,payment_links,payment_requisites,profession,is_active,created_at';
// пилотная схема (без расширенных колонок) — на случай, если миграция ещё не применена
const PUBLIC_PROFILE_COLUMNS_LEGACY = 'id,full_name,phone,specialization,city,about,website,source_url,address,experience,slug,is_active,created_at';

function headers(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra
  };
}

async function request(path, options = {}) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase: укажите SUPABASE_ANON_KEY в js/services/supabaseConfig.js');
  }
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...headers(options.headers || {}), ...(options.headers || {}) }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

export const supabaseApi = {
  configured: isSupabaseConfigured,

  // ——— Публичный каталог / профиль ———
  /** Строго серверные данные. Слои: view новой схемы → таблица с расширенными
   *  колонками → пилотная таблица. select=* никогда не отдаём наружу как есть
   *  (вырезаем key_verifier/email-учётку в коде). */
  async listPsychologists() {
    const attempts = [
      () => request(`public_profiles?is_active=eq.true&select=${PUBLIC_PROFILE_COLUMNS}`),
      () => request(`psychologists?is_active=eq.true&select=${PUBLIC_PROFILE_COLUMNS}`),
      () => request(`psychologists?is_active=eq.true&select=${PUBLIC_PROFILE_COLUMNS_LEGACY}`),
      async () => {
        const rows = await request('psychologists?is_active=eq.true&select=*');
        return (rows || []).map(r => {
          const clean = { ...r };
          delete clean.key_verifier;
          delete clean.email;
          return clean;
        });
      }
    ];
    let lastErr = null;
    for (const attempt of attempts) {
      try {
        const rows = await attempt();
        if (Array.isArray(rows)) return rows;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Каталог недоступен');
  },

  async getPsychologistBySlug(slug) {
    const rows = await request(`public_profiles?slug=eq.${encodeURIComponent(slug)}&select=${PUBLIC_PROFILE_COLUMNS}&limit=1`);
    return rows?.[0] || null;
  },

  /** Обновление профиля (для auth-режима; anon RLS запрещает запись) */
  async updatePsychologist(id, patch) {
    const rows = await request(`psychologists?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
    });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  async listServices(psychologistId) {
    return request(
      `services?psychologist_id=eq.${psychologistId}&is_active=eq.true&select=*&order=sort_order.asc`
    );
  },

  // ——— Публичная доступность (free/busy) ———
  async listBookedSlots(psychologistId, fromDate, toDate) {
    let q = `public_booked_slots?psychologist_id=eq.${psychologistId}&select=session_date,session_time&order=session_date.asc,session_time.asc`;
    if (fromDate) q += `&session_date=gte.${fromDate}`;
    if (toDate) q += `&session_date=lte.${toDate}`;
    return request(q);
  },

  async listBusyBlocks(psychologistId, fromDate, toDate) {
    let q = `public_schedule_blocks?psychologist_id=eq.${psychologistId}&select=*&order=date_from.asc`;
    if (fromDate) q += `&date_to=gte.${fromDate}`;
    if (toDate) q += `&date_from=lte.${toDate}`;
    return request(q);
  },

  /** Запись клиента — только через RPC (анти-спам + проверка слота на сервере) */
  async createBooking(payload) {
    const rows = await request('rpc/create_booking', { method: 'POST', body: JSON.stringify(payload) });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  async getSettings(psychologistId) {
    const rows = await request(`public_settings?psychologist_id=eq.${psychologistId}&select=*&limit=1`);
    return rows?.[0] || null;
  }
};
