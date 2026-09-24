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
import { safeStorage } from '../core/safeStorage.js';

const PUBLIC_PROFILE_COLUMNS = 'id,full_name,phone,specialization,city,about,website,source_url,address,experience,slug,greeting,approach,photo_url,public_email,directions,education,experience_items,socials,payment_links,payment_requisites,profession,is_active,created_at';
// пилотная схема (без расширенных колонок) — на случай, если миграция ещё не применена
const PUBLIC_PROFILE_COLUMNS_LEGACY = 'id,full_name,phone,specialization,city,about,website,source_url,address,experience,slug,is_active,created_at';

/**
 * Bearer-токен пользователя Supabase Auth (после входа по коду).
 *
 * Сессия ОБЯЗАНА переживать перезагрузку страницы: до аудита AUDIT-REG-DRY-001
 * токен жил только в модульной переменной, поэтому после reload кабинет
 * открывался (роут-гард смотрел в localStorage), но `hasSession()` был false —
 * все write-through записи молча не уходили на сервер.
 */
const SESSION_KEY = 'psy_auth_session_v1';
let userToken = null;

export function setAuthToken(token) {
  userToken = token || null;
}

/** Сохранить сессию GoTrue (access/refresh/expires) и выставить токен. */
export function persistSession(session) {
  if (!session?.access_token) return null;
  const stored = {
    access_token: session.access_token,
    refresh_token: session.refresh_token || '',
    expires_at: session.expires_at ?? null,
    token_type: session.token_type || 'bearer'
  };
  safeStorage.setJSON(SESSION_KEY, stored);
  setAuthToken(stored.access_token);
  return stored;
}

export function readPersistedSession() {
  const s = safeStorage.getJSON(SESSION_KEY, null);
  return s?.access_token ? s : null;
}

export function clearPersistedSession() {
  safeStorage.remove(SESSION_KEY);
  setAuthToken(null);
}

/**
 * `sub` из JWT — это auth.uid() на сервере. Декодируем payload без проверки
 * подписи: подпись проверяет сам Supabase при запросе, нам нужен только
 * идентификатор владельца для поиска своего профиля.
 */
export function userIdFromToken(token) {
  try {
    const payload = String(token || '').split('.')[1] || '';
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return json?.sub || null;
  } catch {
    return null;
  }
}

function headers(extra = {}) {
  const h = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${userToken || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra
  };
  return h;
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
  request, // для cabinetApi (RLS-запросы владельца)

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
    // duration_min чужой записи — SR-003: без него клиент недооценивает занятость
    let q = `public_booked_slots?psychologist_id=eq.${psychologistId}&select=session_date,session_time,duration_min&order=session_date.asc,session_time.asc`;
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

  // ——— Supabase Auth: вход по коду из письма (OTP) ———
  /** Отправить 6-значный код на email (Supabase Auth → письмо). */
  async requestEmailOtp(email) {
    if (!isSupabaseConfigured()) throw new Error('Supabase не настроен');
    const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      // create_user: true — email может быть в таблице psychologists, но не в auth.users
      body: JSON.stringify({ email: String(email).toLowerCase().trim(), create_user: true })
    });
    if (!res.ok) {
      const body = await res.text();
      let msg = body;
      try { msg = JSON.parse(body).msg || JSON.parse(body).message || body; } catch (_) {}
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return true;
  },

  /** Проверить код из письма → сессия (access_token).
   *  GoTrue шлёт разный type: magiclink (существующий), signup (созданный) —
   *  пробуем по очереди, пока сервер не примет. */
  async verifyEmailOtp(email, token) {
    const e = String(email).toLowerCase().trim();
    const types = ['magiclink', 'signup', 'recovery'];
    let lastMsg = '';
    for (const type of types) {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: e, token: String(token).trim(), type })
      });
      if (res.ok) return res.json();
      const body = await res.text();
      let msg = body;
      try { msg = JSON.parse(body).msg || JSON.parse(body).error_description || body; } catch (_) {}
      lastMsg = msg || `HTTP ${res.status}`;
      if (/rate|часто/i.test(lastMsg)) break; // при rate-limit перебор бессмыслен
    }
    throw new Error(lastMsg);
  },

  // ——— Собственный код входа (Edge Function auth-code; письмо через Resend,
  //     шаблоны Supabase Auth не участвуют; код живёт в таблице auth_login_codes) ———
  async _authCodeFn(action, payload) {
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/functions/v1/auth-code`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload })
      });
    } catch (e) {
      // Ответа нет вообще (сеть/CORS). В браузере «функция не задеплоена»
      // выглядит именно так: preflight OPTIONS получает 404 без CORS-заголовков,
      // fetch бросает TypeError и статус прочитать нельзя. Помечаем status=0,
      // чтобы use case мог отличить «канал недоступен» (→ запасной OTP)
      // от честного HTTP-отказа задеплоенной функции (429/500/502).
      const err = new Error('Функция auth-code недоступна (нет ответа: сеть или CORS)');
      err.status = 0;
      throw err;
    }
    if (res.status === 404) {
      const e = new Error('Функция auth-code не задеплоена');
      e.status = 404;
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const e = new Error(data.error || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return data;
  },

  /** Запросить код входа (письмо с 6–8-символьным кодом, окно 2 минуты). */
  async requestLoginCode(email) {
    if (!isSupabaseConfigured()) throw new Error('Supabase не настроен');
    await this._authCodeFn('request', { email: String(email).toLowerCase().trim() });
    return true;
  },

  /** Обмен hashed_token (из auth-code) на сессию браузера в GoTrue. */
  async _sessionFromHashedToken(hashedToken) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken })
    });
    if (!res.ok) {
      const body = await res.text();
      let msg = body;
      try { msg = JSON.parse(body).msg || JSON.parse(body).error_description || body; } catch (_) {}
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /**
   * Перевыпустить сессию по уже подтверждённому коду (action=recover).
   *
   * Зачем: код погашен на сервере, но ответ с hashed_token мог не дойти до
   * браузера (обрыв сети, перезагрузка между шагами) либо GoTrue отказал
   * в момент обмена. Без восстановления пользователь терял регистрацию —
   * код-то уже одноразовый. capability здесь — code_id (uuid, выдаётся только
   * тому, кто код подтвердил), плюс окно TTL и лимит перевыпусков на сервере.
   */
  async reissueLoginSession(email, codeId) {
    const { hashed_token } = await this._authCodeFn('recover', {
      email: String(email).toLowerCase().trim(),
      code_id: codeId
    });
    const session = await this._sessionFromHashedToken(hashed_token);
    return { session, hashedToken: hashed_token };
  },

  /**
   * Сообщить серверу, что браузер получил сессию (action=redeem).
   * После этого сервер закрывает перевыпуск токена: один код = одна сессия.
   * Отказ не критичен (сессия уже есть), поэтому вызывающий гасит ошибку сам.
   */
  async redeemLoginCode(email, codeId, hashedToken) {
    return this._authCodeFn('redeem', {
      email: String(email).toLowerCase().trim(),
      code_id: codeId,
      hashed_token: hashedToken
    });
  },

  /**
   * Проверить код → hashed_token → сессия (access_token) для браузера.
   * Возвращает { session, codeId }: codeId нужен для восстановления, если
   * обмен hashed_token на сессию не удался (см. reissueLoginSession).
   */
  async verifyLoginCode(email, code) {
    const e = String(email).toLowerCase().trim();
    const verified = await this._authCodeFn('verify', { email: e, code: String(code).trim().toUpperCase() });
    const codeId = verified.code_id || null;

    /** Сессия получена — закрываем возможность перевыпуска токена на сервере. */
    const redeem = async (hashedToken) => {
      if (codeId && hashedToken) await this.redeemLoginCode(e, codeId, hashedToken).catch(() => {});
    };

    try {
      const session = await this._sessionFromHashedToken(verified.hashed_token);
      await redeem(verified.hashed_token);
      return { session, codeId };
    } catch (ex) {
      if (!codeId) throw ex; // старая схема без code_id: восстанавливать нечем
      const reissued = await this.reissueLoginSession(e, codeId).catch(() => null);
      if (reissued?.session?.access_token) {
        await redeem(reissued.hashedToken);
        return { session: reissued.session, codeId };
      }
      throw ex;
    }
  },

  /**
   * Обновить access_token по refresh_token (GoTrue).
   * Используется при восстановлении сессии после перезагрузки страницы.
   */
  async refreshSession(refreshToken) {
    if (!refreshToken) throw new Error('Нет refresh_token');
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(body || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /**
   * Привязать/создать профиль психолога (security definer, только authenticated).
   * Владение определяется на сервере по auth.uid(); email — лишь способ найти
   * существующий профиль. Возвращает { ok, id, owner_id, created }.
   */
  async claimPsychologist({ email, fullName = '', phone = '', specialization = '', city = '', about = '' }) {
    const rows = await request('rpc/claim_psychologist_profile', {
      method: 'POST',
      body: JSON.stringify({
        p_email: String(email).toLowerCase().trim(),
        p_full_name: fullName || '',
        p_phone: phone || '',
        p_specialization: specialization || '',
        p_city: city || '',
        p_about: about || ''
      })
    });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  /**
   * Свой профиль по ВЛАДЕЛЬЦУ (owner_id = auth.uid()), а не по email.
   * Это единственный допустимый способ определить «мой кабинет».
   */
  async fetchOwnedPsychologist(ownerId) {
    if (!ownerId) return null;
    const rows = await request(
      `psychologists?owner_id=eq.${encodeURIComponent(ownerId)}&select=*&order=created_at.asc&limit=1`
    );
    return rows?.[0] || null;
  },

  /** Есть ли пользовательская сессия (после OTP-входа) — для записи в кабинет. */
  hasSession() {
    return !!userToken;
  },

  /** Upsert своих настроек кабинета (RLS owner_all). */
  async upsertSettings(psychologistId, patch) {
    const rows = await request(`session_settings?on_conflict=psychologist_id`, {
      method: 'POST',
      headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify({ psychologist_id: psychologistId, ...patch })
    });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  /** Свой профиль по id (RLS: только владелец). */
  async fetchOwnPsychologist(id) {
    const rows = await request(`psychologists?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    return rows?.[0] || null;
  },

  async getSettings(psychologistId) {
    const rows = await request(`public_settings?psychologist_id=eq.${psychologistId}&select=*&limit=1`);
    return rows?.[0] || null;
  },

  /**
   * Диагностика БД: что применено, а что нет (для панели «Проверить сервер»).
   * Не отправляет писем и не меняет данные.
   */
  async serverDiagnostics() {
    const out = [];
    const check = async (name, hint, fn) => {
      try {
        const detail = await fn();
        out.push({ name, ok: true, detail: detail || 'OK' });
      } catch (e) {
        out.push({ name, ok: false, detail: String(e.message || e).slice(0, 200), hint });
      }
    };
    await check('REST доступен', 'Проверьте SUPABASE_URL и anon key', async () => {
      await request('public_profiles?select=id&limit=1');
      return null;
    });
    await check('View public_profiles (schema.sql применён)', 'Выполните supabase/schema.sql', async () => {
      const r = await request('public_profiles?select=id,slug&limit=1');
      return `записей: ${(r || []).length}`;
    });
    await check('Новые колонки профиля (greeting…)', 'Выполните supabase/schema.sql (alter table …)', async () => {
      await request('psychologists?select=greeting,profession&limit=1');
      return null;
    });
    await check('RPC create_booking (запись клиентов)', 'Выполните supabase/schema.sql (функция create_booking)', async () => {
      // Проба с несуществующим id: исправная функция отвечает 200
      // {"ok":false,"error":"Специалист не найден…"}; 404 = функции/схемы нет.
      // Пустой {} здесь нельзя: у функции обязательные аргументы, PostgREST
      // ответил бы 404 и на исправной схеме (ложный ⛔).
      const r = await request('rpc/create_booking', { method: 'POST', body: JSON.stringify({
        p_psychologist_id: 'diag-probe', p_service_id: 'diag-probe',
        p_session_date: '2000-01-01', p_session_time: '00:00'
      }) });
      if (r?.ok === false && /не найден/i.test(String(r.error || ''))) return null;
      return r?.ok === false ? `неожиданный ответ: ${String(r.error).slice(0, 120)}` : null;
    });
    await check('RPC claim_psychologist_profile (вход по коду)', 'Выполните supabase/schema.sql (функция claim_psychologist_profile)', async () => {
      // Проба без сессии (anon): исправная функция отвечает 200
      // {"ok":false,"error":"Email не подтверждён"}; 404 = функции нет.
      const r = await request('rpc/claim_psychologist_profile', { method: 'POST', body: JSON.stringify({ p_email: 'diag-probe@example.invalid' }) });
      if (r?.ok === false) return null;
      return r?.ok === true ? 'анонимный claim неожиданно успешен — проверьте security-контур' : null;
    });
    await check('Edge Function auth-code (письма с кодом входа)', 'Задеплойте функцию: supabase functions deploy auth-code --project-ref phiavtroybgwyjdhqqkh --no-verify-jwt (см. docs/INFRA.md). Не задеплоенная функция в браузере выглядит как CORS-ошибка', async () => {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/auth-code`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (r.status === 404) throw new Error('не задеплоена (HTTP 404)');
      // задеплоенная функция на пустой body отвечает 400 «Неизвестное действие» — это норма
      return `отвечает (HTTP ${r.status})`;
    });
    // SR-004: без этих колонок функция не может атомарно гасить код и не умеет
    // восстанавливать сессию. Проверяется «холостым» recover: письмо не шлётся,
    // данные не меняются, а ответ функции прямо говорит, чего не хватает.
    await check('Схема auth_login_codes (SR-004: атомарность кода входа)', 'Перепримените supabase/schema.sql в SQL Editor (п.2 docs/INFRA.md)', async () => {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/auth-code`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recover', email: 'schema-probe@example.invalid', code_id: 'schema-probe' })
      });
      if (r.status === 404) throw new Error('функция auth-code не задеплоена (HTTP 404)');
      const data = await r.json().catch(() => ({}));
      if (data?.ok === false && /issued_token_hash|schema\.sql/i.test(String(data.error || ''))) {
        throw new Error(String(data.error).slice(0, 200));
      }
      // 400 «Подтверждение не найдено» — норма: схема на месте, кода такого нет
      return `колонки SR-004 на месте (HTTP ${r.status})`;
    });
    return out;
  }
};
