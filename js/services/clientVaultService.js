/**
 * ClientVault — изоляция + шифрование PII клиентов ключом психолога
 * Другие психологи не получают расшифрованные и даже «сырые» чужие записи через API.
 *
 * Дополнено (Агент 3, карточка клиента):
 *  - индивидуальные условия клиента (T-09/T-10): цена, валюта, способ оплаты,
 *    постоянная ссылка на встречу, ссылка на оплату;
 *  - условия лежат в том же зашифрованном блобе, что и PII, — это приватные
 *    коммерческие договорённости кабинета, на сервер в открытом виде не уходят
 *    (серверные колонки clients.price_override/currency/payment_method/meet_link/
 *    payment_url заказаны заявкой SR-102 для паритета схемы).
 */
import { db } from '../core/dbContext.js';
import { cryptoService } from './cryptoService.js';
import { Client } from '../models/entities.js';

const SENSITIVE = ['name', 'nickname', 'phone', 'contact', 'note'];

/** Поля индивидуальных условий клиента (все необязательные) */
const CONDITION_KEYS = ['priceOverride', 'currency', 'paymentMethod', 'meetLink', 'paymentUrl', 'videoPlatform', 'clientTimezone'];

function stripSensitive(c) {
  const o = { ...c };
  SENSITIVE.forEach(k => { o[k] = ''; });
  return o;
}

/** Нормализация условий: пустые значения не храним */
export function normalizeConditions(input = {}) {
  const out = {};
  for (const key of CONDITION_KEYS) {
    let v = input?.[key];
    if (v == null || v === '') continue;
    if (key === 'priceOverride') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      out[key] = n;
      continue;
    }
    out[key] = String(v).trim();
  }
  return out;
}

export class ClientVaultService {
  /**
   * Только клиенты текущего психолога; без ключа — без PII
   */
  async listDecrypted(psychologistId) {
    if (!psychologistId) return [];
    const rows = db.clients.filter(c => c.psychologistId === psychologistId);
    if (!cryptoService.isUnlocked(psychologistId)) {
      return rows.map(c => ({
        id: c.id,
        psychologistId: c.psychologistId,
        name: '•••',
        nickname: '•••',
        phone: '',
        contact: '',
        note: '',
        trustLevel: c.trustLevel,
        locked: true,
        createdAt: c.createdAt,
        _conditions: {}
      }));
    }
    const out = [];
    for (const c of rows) {
      out.push(await this.materialize(c));
    }
    return out;
  }

  async materialize(clientRow) {
    if (!clientRow) return null;
    if (clientRow.psychologistId && clientRow.encryptedPii && cryptoService.isUnlocked(clientRow.psychologistId)) {
      const plain = await cryptoService.decryptJson(clientRow.psychologistId, clientRow.encryptedPii);
      if (plain) {
        const client = new Client({
          ...clientRow,
          name: plain.name || '',
          nickname: plain.nickname || plain.name || '',
          phone: plain.phone || '',
          contact: plain.contact || '',
          note: plain.note || '',
          locked: false
        });
        // условия: зашифрованный сейф имеет приоритет, серверные колонки (SR-102) — fallback
        client._conditions = {
          ...normalizeConditions(clientRow._conditionsServer || {}),
          ...normalizeConditions(plain.conditions || {})
        };
        return client;
      }
    }
    // legacy plaintext (до миграции) — только владельцу с открытым сейфом
    if (cryptoService.isUnlocked(clientRow.psychologistId)) {
      const client = new Client({ ...clientRow, locked: false });
      client._conditions = {
        ...normalizeConditions(clientRow._conditionsServer || {}),
        ...normalizeConditions(clientRow._conditions || {})
      };
      return client;
    }
    return new Client({
      id: clientRow.id,
      psychologistId: clientRow.psychologistId,
      name: '•••',
      nickname: '•••',
      locked: true,
      trustLevel: clientRow.trustLevel,
      createdAt: clientRow.createdAt
    });
  }

  async getForOwner(psychologistId, clientId) {
    const row = db.clients.find(c => c.id === clientId && c.psychologistId === psychologistId);
    if (!row) return null;
    return this.materialize(row);
  }

  /** Чужой психолог → всегда null */
  assertOwner(psychologistId, clientId) {
    const row = db.clients.find(c => c.id === clientId);
    if (!row || row.psychologistId !== psychologistId) return null;
    return row;
  }

  async saveClient(psychologistId, data) {
    if (!psychologistId) throw new Error('Нет владельца');
    if (!cryptoService.isUnlocked(psychologistId)) {
      throw new Error('Сейф заблокирован. Войдите с паролем, чтобы сохранять клиентов.');
    }
    const existing = data.id ? this.assertOwner(psychologistId, data.id) : null;
    if (data.id && !existing) throw new Error('Клиент не найден или чужой кабинет');

    // условия: новые значения поверх сохранённых (пустая строка = «не менять»)
    let prevConditions = {};
    if (existing) {
      const prevPlain = existing.encryptedPii
        ? await cryptoService.decryptJson(psychologistId, existing.encryptedPii)
        : existing;
      prevConditions = normalizeConditions(prevPlain?.conditions || existing?._conditions || {});
    }
    const incoming = normalizeConditions(data.conditions || {});
    const conditions = { ...prevConditions, ...incoming };
    // явное очищение поля (UI передаёт null) — убираем из условий
    for (const key of CONDITION_KEYS) {
      if (data.conditions && Object.prototype.hasOwnProperty.call(data.conditions, key) && (data.conditions[key] === null || data.conditions[key] === '')) {
        delete conditions[key];
      }
    }

    const pii = {
      name: data.name || '',
      nickname: data.nickname || data.name || '',
      phone: data.phone || '',
      contact: data.contact || '',
      note: data.note || '',
      conditions
    };
    const encryptedPii = await cryptoService.encryptJson(psychologistId, pii);

    if (existing) {
      Object.assign(existing, {
        encryptedPii,
        name: '', // не храним plaintext
        nickname: '',
        phone: '',
        contact: '',
        note: '',
        trustLevel: data.trustLevel || existing.trustLevel,
        noShowCount: data.noShowCount ?? existing.noShowCount,
        cancelCount: data.cancelCount ?? existing.cancelCount,
        verifiedContact: data.verifiedContact ?? existing.verifiedContact
      });
      // searchable hash of nickname for uniqueness without plaintext
      existing.nicknameHash = await this.hashNick(psychologistId, pii.nickname);
      db.saveChanges();
      return this.materialize(existing);
    }

    const row = db.addClient({
      psychologistId,
      name: '',
      nickname: '',
      phone: '',
      contact: '',
      note: '',
      encryptedPii,
      nicknameHash: await this.hashNick(psychologistId, pii.nickname),
      trustLevel: data.trustLevel || 'new'
    });
    // addClient may not pass encryptedPii - fix
    row.encryptedPii = encryptedPii;
    row.nicknameHash = await this.hashNick(psychologistId, pii.nickname);
    db.saveChanges();
    return this.materialize(row);
  }

  /**
   * Обновить только индивидуальные условия клиента (T-09/T-10).
   * @returns {Promise<object|null>} расшифрованный клиент с новыми условиями
   */
  async updateConditions(psychologistId, clientId, patch = {}) {
    const current = await this.getForOwner(psychologistId, clientId);
    if (!current) return null;
    return this.saveClient(psychologistId, {
      id: clientId,
      name: current.name,
      nickname: current.nickname,
      phone: current.phone,
      contact: current.contact,
      note: current.note,
      conditions: patch
    });
  }

  /** Условия клиента (или пусто) — безопасно для любого клиента, включая «закрытый сейф» */
  conditionsOf(client) {
    return normalizeConditions(client?._conditions || {});
  }

  async hashNick(psychologistId, nick) {
    const enc = new TextEncoder();
    // привязка к id психолога, чтобы одинаковые ники у разных пси не совпадали в хеше между кабинетами
    const buf = await crypto.subtle.digest(
      'SHA-256',
      enc.encode(`${psychologistId}::${String(nick || '').toLowerCase()}`)
    );
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async isNicknameTaken(psychologistId, nickname, excludeClientId = null) {
    const h = await this.hashNick(psychologistId, nickname);
    return db.clients.some(c =>
      c.psychologistId === psychologistId &&
      c.id !== excludeClientId &&
      c.nicknameHash === h
    );
  }

  /**
   * Публичная запись: клиент создаётся с шифрованием только если кабинет разблокирован
   * (обычно нет). Иначе — временное plaintext + флаг needsEncryption, шифруется при входе владельца.
   */
  async saveClientFromPublicBooking(psychologistId, data) {
    if (cryptoService.isUnlocked(psychologistId)) {
      return this.saveClient(psychologistId, data);
    }
    // очередь на шифрование: данные только в записи с psychologistId (изоляция по id)
    const row = db.addClient({
      psychologistId,
      name: data.name || '',
      nickname: data.nickname || data.name || '',
      phone: data.phone || '',
      contact: data.contact || '',
      note: data.note || '',
      needsEncryption: true,
      trustLevel: data.trustLevel || 'new'
    });
    row.nicknameHash = await this.hashNick(psychologistId, row.nickname);
    db.saveChanges();
    return row;
  }

  /** После входа владельца — зашифровать plaintext клиентов кабинета */
  async migratePlaintextToEncrypted(psychologistId) {
    if (!cryptoService.isUnlocked(psychologistId)) return 0;
    let n = 0;
    for (const c of db.clients.filter(x => x.psychologistId === psychologistId)) {
      if (c.encryptedPii && !c.needsEncryption && !c.name && !c.phone) continue;
      if (c.name || c.phone || c.contact || c.note || c.nickname || c.needsEncryption) {
        const plain = c.encryptedPii
          ? (await cryptoService.decryptJson(psychologistId, c.encryptedPii)) || {}
          : {};
        const pii = {
          name: c.name || plain.name || '',
          nickname: c.nickname || plain.nickname || c.name || '',
          phone: c.phone || plain.phone || '',
          contact: c.contact || plain.contact || '',
          note: c.note || plain.note || '',
          conditions: normalizeConditions({ ...(plain.conditions || {}), ...(c._conditions || {}) })
        };
        c.encryptedPii = await cryptoService.encryptJson(psychologistId, pii);
        c.name = '';
        c.nickname = '';
        c.phone = '';
        c.contact = '';
        c.note = '';
        c.needsEncryption = false;
        c.nicknameHash = await this.hashNick(psychologistId, pii.nickname);
        n++;
      }
    }
    if (n) db.saveChanges();
    return n;
  }

  /** Сессии другого психолога недоступны */
  sessionsOf(psychologistId) {
    return db.sessions.filter(s => s.psychologistId === psychologistId);
  }

  clientsRawOwned(psychologistId) {
    return db.clients.filter(c => c.psychologistId === psychologistId);
  }
}

export const clientVaultService = new ClientVaultService();
export { CONDITION_KEYS, stripSensitive };
