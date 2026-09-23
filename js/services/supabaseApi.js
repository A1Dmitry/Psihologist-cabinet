/**
 * Минимальный REST-клиент Supabase (без npm)
 * PostgREST: /rest/v1/<table>
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from './supabaseConfig.js';

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

  async listPsychologists() {
    return request('psychologists?is_active=eq.true&select=*');
  },

  async getPsychologistBySlug(slug) {
    const rows = await request(`psychologists?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`);
    return rows?.[0] || null;
  },

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

  async listSessions(psychologistId, fromDate, toDate) {
    let q = `sessions?psychologist_id=eq.${psychologistId}&select=*&order=session_date.asc,session_time.asc`;
    if (fromDate) q += `&session_date=gte.${fromDate}`;
    if (toDate) q += `&session_date=lte.${toDate}`;
    return request(q);
  },

  async listClients(psychologistId) {
    return request(`clients?psychologist_id=eq.${psychologistId}&select=*&order=created_at.desc`);
  },

  async createClient(row) {
    const rows = await request('clients', { method: 'POST', body: JSON.stringify(row) });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  async createSession(row) {
    const rows = await request('sessions', { method: 'POST', body: JSON.stringify(row) });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  async updateSession(id, patch) {
    const rows = await request(`sessions?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
    });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  async getSettings(psychologistId) {
    const rows = await request(`session_settings?psychologist_id=eq.${psychologistId}&select=*&limit=1`);
    return rows?.[0] || null;
  }
};
