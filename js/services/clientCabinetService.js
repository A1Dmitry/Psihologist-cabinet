/**
 * ClientCabinetService — личный мини-кабинет клиента по секретной ссылке (T-12),
 * материалы/домашние задания (T-13), документы (T-14) и запросы клиента
 * (предложить другое время, «хочу постоянное время», встать в очередь на день — T-08/T-24).
 *
 * Принципы:
 *  - у клиента нет аккаунта: доступ даёт токен в ссылке (как reply-механизм напоминаний);
 *  - кабинет психолога — источник данных; клиенту отдаётся только его собственный срез
 *    (свои встречи, свои материалы) — без чужих клиентов и без PII кабинета;
 *  - если серверная часть (таблицы/RPC из заявок SR-103…SR-107) ещё не применена,
 *    сервис честно работает локально (предпросмотр в этом браузере) и говорит об этом
 *    в UI, а не молча теряет данные.
 */
import { db } from '../core/dbContext.js';
import { safeStorage } from '../core/safeStorage.js';
import { resolveDurationMinutes, DEFAULT_DURATION_MIN } from '../domain/duration.js';
import { supabaseApi } from './supabaseApi.js';
import { cabinetApi } from './cabinetApi.js';
import {
  addDaysStr, todayStr, isValidZone, DEFAULT_TIMEZONE, zoneCity, zoneLabel,
  convertWallClock, sessionZoneHint, weekdayOf
} from './timezoneService.js';

const KEYS = {
  tokens: 'psy_client_tokens_v1',
  materials: 'psy_client_materials_v1',
  requests: 'psy_client_requests_v1',
  documents: 'psy_client_documents_v1',
  zones: 'psy_client_zones_v1',
  waitPrefs: 'psy_waiting_prefs_v1'
};

/* ——— sandbox-safe хранилище (единственная реализация — js/core/safeStorage.js) ——— */
function storeGet(key) {
  return safeStorage.get(key);
}
function storeSet(key, value) {
  safeStorage.set(key, value);
}
function readList(key) {
  try {
    const raw = storeGet(key);
    const data = raw ? JSON.parse(raw) : null;
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}
function writeList(key, items) {
  storeSet(key, JSON.stringify({ v: 1, items }));
}
function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function randomToken() {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return 'clt_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const MATERIAL_KINDS = {
  text: 'Текст / задание',
  link: 'Ссылка',
  file: 'Файл (ссылка на файл)'
};

export class ClientCabinetService {
  constructor() {
    /** какие серверные части уже доступны */
    this.serverState = { tokens: null, materials: null, requests: null, rpc: null };
    this._loadedFor = null;
  }

  // ==================== ТОКЕНЫ ДОСТУПА (T-12) ====================

  tokensOf(psychologistId) {
    return readList(KEYS.tokens).filter(t => t.psychologistId === psychologistId);
  }

  activeToken(psychologistId, clientId) {
    const now = Date.now();
    return this.tokensOf(psychologistId)
      .filter(t => t.clientId === clientId && !t.revoked && (!t.expiresAt || Date.parse(t.expiresAt) > now))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0] || null;
  }

  /**
   * Выдать (или вернуть существующий) секретный токен клиента.
   * @returns {{ok: boolean, token: string, url: string, expiresAt: string, localOnly: boolean}}
   */
  issueToken({ psychologistId, clientId, ttlDays = 180, rotate = false }) {
    if (!psychologistId || !clientId) return { ok: false, message: 'Нет клиента' };
    const items = readList(KEYS.tokens);
    let rec = items.find(t => t.psychologistId === psychologistId && t.clientId === clientId && !t.revoked);

    if (rec && rotate) {
      rec.revoked = true;
      rec = null;
    }
    if (!rec) {
      rec = {
        token: randomToken(),
        psychologistId,
        clientId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlDays * 86400000).toISOString(),
        revoked: false
      };
      items.push(rec);
      writeList(KEYS.tokens, items);
    }
    this._pushToken(rec);
    return { ok: true, token: rec.token, expiresAt: rec.expiresAt, localOnly: this.serverState.tokens === false };
  }

  revokeToken(token) {
    const items = readList(KEYS.tokens);
    const rec = items.find(t => t.token === token);
    if (rec) {
      rec.revoked = true;
      writeList(KEYS.tokens, items);
    }
    if (this.serverState.tokens !== false) {
      supabaseApi.request(`client_access_tokens?token=eq.${encodeURIComponent(token)}`, {
        method: 'PATCH', body: JSON.stringify({ revoked: true })
      }).catch(() => { this.serverState.tokens = false; });
    }
    return { ok: true };
  }

  /** Ссылка вида {origin}{base}reply?reply=<token> — та же точка входа, что у напоминаний */
  tokenUrl(token, basePath = '/') {
    const base = basePath.endsWith('/') ? basePath : basePath + '/';
    let origin = '';
    try { origin = location.origin; } catch { origin = ''; }
    return `${origin}${base}reply?reply=${encodeURIComponent(token)}`;
  }

  /**
   * Разрешение токена из ссылки: сначала серверный RPC (клиент с другого устройства),
   * затем локальное зеркало (предпросмотр в браузере психолога).
   * @returns {Promise<{ok: boolean, mode?: 'server'|'local', view?: object, message?: string}>}
   */
  async resolve(token, extra = {}) {
    if (!token) return { ok: false, message: 'Ссылка неполная' };
    if (supabaseApi.hasSession() || supabaseApi.configured()) {
      const server = await this._resolveOnServer(token).catch(() => null);
      if (server?.ok) return { ok: true, mode: 'server', view: server.view || server };
    }
    const local = this._resolveLocally(token, extra);
    if (local.ok) return { ok: true, mode: 'local', view: local.view };
    return local;
  }

  async _resolveOnServer(token) {
    if (!supabaseApi.configured()) return null;
    try {
      const res = await supabaseApi.request('rpc/client_cabinet', {
        method: 'POST',
        body: JSON.stringify({ p_token: token })
      });
      const row = Array.isArray(res) ? res[0] : res;
      if (!row) return null;
      if (row.ok === false) {
        this.serverState.rpc = true;
        return { ok: false, message: row.error || 'Ссылка недействительна' };
      }
      this.serverState.rpc = true;
      return { ok: true, view: row.view || row };
    } catch (e) {
      // RPC ещё не создан (SR-103) — падаем в локальный режим
      this.serverState.rpc = false;
      return null;
    }
  }

  /** Локальная проба токена без обращения к сети (для предпросмотра и подстановки условий) */
  localProbe(token, extra = {}) {
    return this._resolveLocally(token, extra);
  }

  _resolveLocally(token, extra = {}) {
    const rec = readList(KEYS.tokens).find(t => t.token === token);
    if (!rec) return { ok: false, message: 'Ссылка не найдена или уже заменена. Попросите специалиста прислать новую.' };
    if (rec.revoked) return { ok: false, message: 'Ссылка отозвана специалистом.' };
    if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) {
      return { ok: false, message: 'Срок действия ссылки истёк — попросите новую.' };
    }
    if (!db.psychologists.some(p => p.id === rec.psychologistId)) {
      return {
        ok: false,
        previewOnly: true,
        message: 'Эта ссылка создана в другом кабинете. Откройте её в браузере, где кабинет специалиста доступен, либо дождитесь серверной части (SR-103).'
      };
    }
    return { ok: true, view: this.buildView({ ...rec, token, localOnly: true, ...extra }) };
  }

  /**
   * Срез данных для страницы клиента: его встречи, материалы, документы.
   * Ничего лишнего: только записи этого клиента.
   */
  buildView({ psychologistId, clientId, token, localOnly = false, conditions: conditionsIn = null }) {
    const psy = db.psychologists.find(p => p.id === psychologistId);
    const client = db.clients.find(c => c.id === clientId);
    const settings = db.settingsOf(psychologistId);
    const psyZone = settings?.timezone || DEFAULT_TIMEZONE;
    // условия клиента: приоритет — расшифрованный сейф (передаёт кабинет), иначе строка клиента
    const conditions = { ...(client?._conditions || {}), ...(conditionsIn || {}) };
    const today = todayStr();
    const clientZone = conditions.clientTimezone && isValidZone(conditions.clientTimezone)
      ? conditions.clientTimezone
      : (this.clientTimezoneOf(clientId) || '');

    const sessions = db.sessions
      .filter(s => s.psychologistId === psychologistId && s.clientId === clientId && s.status !== 'cancelled')
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    const mapSession = s => {
      const svc = db.services.find(x => x.id === s.serviceId);
      const zone = clientZone || s.clientTimezone || '';
      const shown = zone ? convertWallClock(s.date, s.time, psyZone, zone) : null;
      const joinUrl = conditions.meetLink || s.meetLink || '';
      const isOnline = !!(s.videoPlatform || joinUrl || svc?.format === 'online');
      return {
        id: s.id,
        date: s.date,
        time: s.time,
        status: s.status,
        upcoming: s.date >= today,
        serviceName: svc?.name || '',
        // длительность — канонический резолвер (снимок записи → услуга → шаг → дефолт)
        durationMin: resolveDurationMinutes({ durationMin: s.durationMin, service: svc }),
        price: s.amountDue || svc?.price || 0,
        currency: s.currency || svc?.currency || 'BYN',
        joinUrl,
        joinPlatform: s.videoPlatform || (joinUrl ? 'video' : ''),
        isOnline,
        meetLinkReady: !!joinUrl,
        // время в поясе клиента (T-23): показываем оба, чтобы не путаться
        localTime: shown ? shown.time : s.time,
        localDate: shown ? shown.date : s.date,
        clientZone: zone,
        psyZone,
        zoneHint: zone ? `время в вашем поясе (${zoneCity(zone)})` : `время кабинета (${zoneCity(psyZone)})`,
        paymentUrl: conditions.paymentUrl || svc?.payUrl || '',
        pendingChange: s.pendingChange || null,
        canPropose: s.date >= today && !['done', 'no_show'].includes(s.status)
      };
    };

    const upcoming = sessions
      .filter(s => s.date >= today && !['done', 'no_show'].includes(s.status))
      .map(mapSession);
    const past = sessions
      .filter(s => s.date < today || ['done', 'no_show'].includes(s.status))
      .slice(-6).reverse().map(mapSession);

    return {
      ok: true,
      localOnly,
      now: new Date().toISOString(),
      token,
      psychologist: {
        id: psychologistId,
        fullName: psy?.fullName || 'Специалист',
        specialization: psy?.specialization || '',
        photoUrl: psy?.photoUrl || '',
        publicEmail: psy?.publicEmail || '',
        timezone: psyZone,
        timezoneLabel: zoneLabel(psyZone)
      },
      client: {
        id: clientId,
        displayName: client?.nickname || client?.name || 'Здравствуйте'
      },
      upcoming,
      past,
      materials: this.materialsOf(clientId).map(m => ({
        id: m.id, kind: m.kind, title: m.title, body: m.body, url: m.url,
        createdAt: m.createdAt, seenAt: m.seenAt || null
      })),
      documents: this.documentsOf(clientId).map(d => ({
        id: d.id, title: d.title, body: d.body, signedAt: d.signedAt || null
      })),
      pendingReply: this._pendingReplyFor(clientId)
    };
  }

  _pendingReplyFor(clientId) {
    const rem = db.reminders
      .filter(r => r.clientId === clientId && ['sent', 'scheduled'].includes(r.status) && r.kind !== 'day_of_nudge')
      .sort((a, b) => (b.sentAt || b.scheduledFor || '').localeCompare(a.sentAt || a.scheduledFor || ''))[0];
    if (!rem) return null;
    return { token: rem.responseToken, kind: rem.kind, message: rem.messageBody || '' };
  }

  // ==================== МАТЕРИАЛЫ (T-13) ====================

  materialsOf(clientId) {
    return readList(KEYS.materials)
      .filter(m => m.clientId === clientId)
      .sort((a, b) => (b.pinned - a.pinned) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  addMaterial({ psychologistId, clientId, kind = 'text', title = '', body = '', url = '' }) {
    if (!psychologistId || !clientId) return { ok: false, message: 'Нет клиента' };
    if (!title.trim() && !body.trim() && !url.trim()) return { ok: false, message: 'Заполните текст, ссылку или файл' };
    const item = {
      id: uid('mat'),
      psychologistId,
      clientId,
      kind: MATERIAL_KINDS[kind] ? kind : 'text',
      title: title.trim(),
      body: body.trim(),
      url: url.trim(),
      pinned: false,
      seenAt: null,
      createdAt: new Date().toISOString()
    };
    const items = readList(KEYS.materials);
    items.push(item);
    writeList(KEYS.materials, items);
    this._pushMaterial(psychologistId, item);
    return { ok: true, material: item };
  }

  removeMaterial(id) {
    const items = readList(KEYS.materials);
    writeList(KEYS.materials, items.filter(m => m.id !== id));
    if (this.serverState.materials !== false) {
      supabaseApi.request(`client_materials?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' })
        .catch(() => { this.serverState.materials = false; });
    }
    return { ok: true };
  }

  toggleMaterialPin(id) {
    const items = readList(KEYS.materials);
    const m = items.find(x => x.id === id);
    if (m) { m.pinned = !m.pinned; writeList(KEYS.materials, items); }
    return m;
  }

  /** Клиент открыл материал (отметка «прочитано» — видно психологу) */
  markMaterialSeen(token, materialId) {
    const items = readList(KEYS.materials);
    const m = items.find(x => x.id === materialId);
    if (m) {
      m.seenAt = new Date().toISOString();
      writeList(KEYS.materials, items);
      return { ok: true };
    }
    return { ok: false };
  }

  // ==================== ДОКУМЕНТЫ (T-14) ====================

  documentsOf(clientId) {
    return readList(KEYS.documents)
      .filter(d => d.clientId === clientId)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  addDocument({ psychologistId, clientId, title, body }) {
    if (!psychologistId || !clientId || !title?.trim()) return { ok: false, message: 'Нужен заголовок документа' };
    const item = {
      id: uid('doc'),
      psychologistId,
      clientId,
      title: title.trim(),
      body: (body || '').trim(),
      signedAt: null,
      signature: '',
      createdAt: new Date().toISOString()
    };
    const items = readList(KEYS.documents);
    items.push(item);
    writeList(KEYS.documents, items);
    return { ok: true, document: item };
  }

  /** «Подпись»: клиент открыл документ и подтвердил — фиксируем дату и токен */
  signDocument(token, documentId) {
    const items = readList(KEYS.documents);
    const d = items.find(x => x.id === documentId);
    if (!d) return { ok: false, message: 'Документ не найден' };
    if (d.signedAt) return { ok: true, document: d, already: true };
    d.signedAt = new Date().toISOString();
    d.signature = `clt:${String(token).slice(-6)}:${d.signedAt}`;
    writeList(KEYS.documents, items);
    if (this.serverState.tokens !== false) {
      supabaseApi.request('rpc/client_cabinet_action', {
        method: 'POST',
        body: JSON.stringify({ p_token: token, p_action: 'sign_document', p_payload: { document_id: documentId } })
      }).catch(() => { this.serverState.rpc = false; });
    }
    return { ok: true, document: d };
  }

  removeDocument(id) {
    writeList(KEYS.documents, readList(KEYS.documents).filter(d => d.id !== id));
    return { ok: true };
  }

  // ==================== ЗАПРОСЫ КЛИЕНТА (T-08 / T-12 / T-24) ====================

  requestsOf(psychologistId) {
    return readList(KEYS.requests)
      .filter(r => r.psychologistId === psychologistId)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  pendingRequestsOf(psychologistId) {
    return this.requestsOf(psychologistId).filter(r => r.status === 'pending');
  }

  /**
   * Клиент предлагает другое время / просит постоянное время / встаёт в очередь на день.
   * @returns {{ok: boolean, request?: object, message: string}}
   */
  addRequest({ psychologistId, clientId, kind = 'propose_time', sessionId = null, desiredDate = '', desiredTime = '', weekday = null, intervalWeeks = 1, comment = '', token = '' }) {
    if (!psychologistId || !clientId) return { ok: false, message: 'Не удалось определить клиента' };
    if (kind === 'propose_time' && (!desiredDate || !desiredTime)) {
      return { ok: false, message: 'Выберите день и время' };
    }
    const item = {
      id: uid('req'),
      psychologistId,
      clientId,
      kind,
      sessionId,
      desiredDate,
      desiredTime,
      weekday: weekday == null ? null : Number(weekday),
      intervalWeeks: Number(intervalWeeks) || 1,
      comment: (comment || '').trim(),
      status: 'pending',
      source: 'client_cabinet',
      createdAt: new Date().toISOString()
    };
    const items = readList(KEYS.requests);
    items.push(item);
    writeList(KEYS.requests, items);

    if (this.serverState.rpc !== false) {
      supabaseApi.request('rpc/client_cabinet_action', {
        method: 'POST',
        body: JSON.stringify({ p_token: token, p_action: 'create_request', p_payload: item })
      }).catch(() => { this.serverState.rpc = false; });
    }
    return { ok: true, request: item, message: 'Запрос отправлен специалисту' };
  }

  resolveRequest(id, status = 'accepted') {
    const items = readList(KEYS.requests);
    const r = items.find(x => x.id === id);
    if (!r) return null;
    r.status = status;
    r.resolvedAt = new Date().toISOString();
    writeList(KEYS.requests, items);
    return r;
  }

  removeRequest(id) {
    writeList(KEYS.requests, readList(KEYS.requests).filter(r => r.id !== id));
    return { ok: true };
  }

  // ==================== ЧАСОВЫЕ ПОЯСА КЛИЕНТОВ (T-23) ====================

  /** Запомнить пояс, из которого клиент открыл свой кабинет */
  rememberClientTimezone(clientId, timeZone) {
    if (!clientId || !isValidZone(timeZone)) return null;
    const map = this._zones();
    const prev = map[clientId];
    if (prev?.timeZone === timeZone) return prev;
    map[clientId] = { timeZone, at: new Date().toISOString() };
    storeSet(KEYS.zones, JSON.stringify({ v: 1, items: map }));
    if (this.serverState.rpc !== false) {
      supabaseApi.request('rpc/client_cabinet_action', {
        method: 'POST',
        body: JSON.stringify({ p_action: 'client_timezone', p_payload: { client_id: clientId, timezone: timeZone } })
      }).catch(() => { this.serverState.rpc = false; });
    }
    return map[clientId];
  }

  clientTimezoneOf(clientId) {
    return this._zones()[clientId]?.timeZone || '';
  }

  _zones() {
    try {
      const raw = storeGet(KEYS.zones);
      const data = raw ? JSON.parse(raw) : null;
      return data?.items && typeof data.items === 'object' ? data.items : {};
    } catch {
      return {};
    }
  }

  // ============ ПОЖЕЛАНИЯ ИЗ ЛИСТА ОЖИДАНИЯ (T-08 / T-24) ============
  // В таблице waiting_items пока нет колонок под день/время/«постоянное время»,
  // поэтому держим их рядом (заявка SR-106) и зеркалим на сервер, когда он готов.

  waitingPref(id) {
    return id ? (this._waitPrefs()[id] || null) : null;
  }

  setWaitingPref(id, patch = {}) {
    if (!id) return null;
    const all = this._waitPrefs();
    const next = { ...(all[id] || {}), ...patch, updatedAt: new Date().toISOString() };
    all[id] = next;
    storeSet(KEYS.waitPrefs, JSON.stringify({ v: 1, items: all }));
    cabinetApi.pushWaitingPatch?.(id, {
      desired_date: next.desiredDate || '',
      desired_time: next.desiredTime || '',
      recurring: !!next.recurring,
      weekday: Number.isFinite(next.weekday) && next.weekday ? next.weekday : null,
      interval_weeks: next.intervalWeeks ? Number(next.intervalWeeks) : null,
      session_id: next.sessionId || ''
    });
    return next;
  }

  clearWaitingPref(id) {
    if (!id) return;
    const all = this._waitPrefs();
    delete all[id];
    storeSet(KEYS.waitPrefs, JSON.stringify({ v: 1, items: all }));
  }

  _waitPrefs() {
    try {
      const raw = storeGet(KEYS.waitPrefs);
      const data = raw ? JSON.parse(raw) : null;
      return data?.items && typeof data.items === 'object' ? data.items : {};
    } catch {
      return {};
    }
  }

  /** Человекочитаемая подпись запроса для очереди в кабинете */
  requestLabel(r) {
    if (!r) return '';
    const name = db.clients.find(c => c.id === r.clientId)?.nickname || 'Клиент';
    switch (r.kind) {
      case 'propose_time':
        return `${name}: предлагает перенести встречу на ${r.desiredDate} ${r.desiredTime}`;
      case 'recurring':
        return `${name}: хочет постоянное время — ${r.weekday ? `день ${weekdayOfLabel(r.weekday)} ` : ''}${r.desiredTime || ''}`.trim();
      case 'waiting_day':
        return `${name}: хочет встать в очередь на ${r.desiredDate}`;
      default:
        return `${name}: запрос`;
    }
  }

  // ==================== СИНХРОНИЗАЦИЯ ====================

  async pull(psychologistId, { force = false } = {}) {
    if (!psychologistId) return { ok: false };
    if (this._loadedFor === psychologistId && !force) return { ok: true, cached: true };
    this._loadedFor = psychologistId;
    if (!supabaseApi.hasSession()) return { ok: true, localOnly: true };
    const pid = encodeURIComponent(psychologistId);
    const tasks = [
      ['tokens', `client_access_tokens?psychologist_id=eq.${pid}&select=*`],
      ['materials', `client_materials?psychologist_id=eq.${pid}&select=*&order=created_at.desc`],
      ['requests', `client_requests?psychologist_id=eq.${pid}&select=*&order=created_at.desc`]
    ];
    const results = await Promise.all(tasks.map(([, path]) =>
      supabaseApi.request(path).then(rows => ({ ok: true, rows })).catch(() => ({ ok: false, rows: [] }))
    ));
    const [tokens, materials, requests] = results;
    this.serverState.tokens = tokens.ok;
    this.serverState.materials = materials.ok;
    this.serverState.requests = requests.ok;

    if (tokens.ok) {
      const existing = readList(KEYS.tokens).filter(t => t.psychologistId !== psychologistId);
      writeList(KEYS.tokens, existing.concat(tokens.rows.map(r => ({
        token: r.token, psychologistId: r.psychologist_id, clientId: r.client_id,
        createdAt: r.created_at, expiresAt: r.expires_at, revoked: !!r.revoked
      }))));
    }
    if (materials.ok) {
      const existing = readList(KEYS.materials).filter(m => m.psychologistId !== psychologistId);
      writeList(KEYS.materials, existing.concat(materials.rows.map(r => ({
        id: r.id, psychologistId: r.psychologist_id, clientId: r.client_id,
        kind: r.kind || 'text', title: r.title || '', body: r.body || '', url: r.url || '',
        pinned: !!r.pinned, seenAt: r.seen_at, createdAt: r.created_at
      }))));
    }
    if (requests.ok) {
      const existing = readList(KEYS.requests).filter(r => r.psychologistId !== psychologistId);
      writeList(KEYS.requests, existing.concat(requests.rows.map(r => ({
        id: r.id, psychologistId: r.psychologist_id, clientId: r.client_id, kind: r.kind,
        sessionId: r.session_id || null, desiredDate: r.desired_date || '', desiredTime: r.desired_time || '',
        weekday: r.weekday ?? null, intervalWeeks: r.interval_weeks || 1, comment: r.comment || '',
        status: r.status || 'pending', createdAt: r.created_at
      }))));
    }
    return { ok: true, serverState: { ...this.serverState } };
  }

  /** Понятное объяснение для UI, если серверная часть ещё не применена */
  serverHint() {
    const s = this.serverState;
    if (s.tokens === false || s.materials === false || s.requests === false || s.rpc === false) {
      return 'Часть данных кабинета клиента хранится пока в этом браузере (предпросмотр). Ссылка начнёт работать на любом устройстве клиента после применения заявок SR-103…SR-106 на стороне сервера.';
    }
    return '';
  }

  _pushToken(rec) {
    if (!supabaseApi.hasSession() || this.serverState.tokens === false) return;
    supabaseApi.request('client_access_tokens?on_conflict=token', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        token: rec.token, psychologist_id: rec.psychologistId, client_id: rec.clientId,
        expires_at: rec.expiresAt, revoked: !!rec.revoked
      })
    }).then(() => { this.serverState.tokens = true; })
      .catch(() => { this.serverState.tokens = false; });
  }

  _pushMaterial(psychologistId, item) {
    if (!supabaseApi.hasSession() || this.serverState.materials === false) return;
    supabaseApi.request('client_materials', {
      method: 'POST',
      body: JSON.stringify({
        id: item.id, psychologist_id: psychologistId, client_id: item.clientId,
        kind: item.kind, title: item.title, body: item.body, url: item.url
      })
    }).then(() => { this.serverState.materials = true; })
      .catch(() => { this.serverState.materials = false; });
  }

  reset() {
    this._loadedFor = null;
    this.serverState = { tokens: null, materials: null, requests: null, rpc: null };
  }
}

/** «Пн» из номера дня недели (1…7) */
export function weekdayOfLabel(weekday) {
  return ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][Number(weekday)] || '';
}

/** Ближайшие свободные варианты для «предложить другое время» (клиентский выбор) */
export function suggestSlots({ psychologistId, days = 10, limit = 12 }) {
  const settings = db.settingsOf(psychologistId);
  const workDays = settings.workDays?.length ? settings.workDays : [1, 2, 3, 4, 5];
  const times = settings.slotTimes?.length ? settings.slotTimes : buildTimes(settings);
  const out = [];
  for (let i = 0; i < days && out.length < limit; i++) {
    const date = addDaysStr(todayStr(), i);
    if (!workDays.includes(weekdayOf(date))) continue;
    for (const time of times) {
      if (out.length >= limit) break;
      const busy = db.sessions.some(s =>
        s.psychologistId === psychologistId && s.date === date && s.time === time &&
        !['cancelled', 'expired', 'no_show'].includes(s.status)
      );
      if (busy) continue;
      if (db.isSlotBlocked(psychologistId, date, time)) continue;
      out.push({ date, time });
    }
  }
  return out;
}

function buildTimes(settings) {
  const toMin = t => {
    const [h, m] = String(t || '10:00').split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const start = toMin(settings.slotStart || '10:00');
  const end = toMin(settings.slotEnd || '18:00');
  const step = Number(settings.slotStepMin) || DEFAULT_DURATION_MIN;
  const out = [];
  for (let m = start; m <= end; m += step) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

export const clientCabinetService = new ClientCabinetService();
export { sessionZoneHint, convertWallClock };
