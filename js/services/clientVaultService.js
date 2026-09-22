/**
 * ClientVault — изоляция + шифрование PII клиентов ключом психолога
 * Другие психологи не получают расшифрованные и даже «сырые» чужие записи через API.
 */
import { db } from '../core/dbContext.js';
import { cryptoService } from './cryptoService.js';
import { Client } from '../models/entities.js';

const SENSITIVE = ['name', 'nickname', 'phone', 'contact', 'note'];

function stripSensitive(c) {
  const o = { ...c };
  SENSITIVE.forEach(k => { o[k] = ''; });
  return o;
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
        createdAt: c.createdAt
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
        return new Client({
          ...clientRow,
          name: plain.name || '',
          nickname: plain.nickname || plain.name || '',
          phone: plain.phone || '',
          contact: plain.contact || '',
          note: plain.note || '',
          locked: false
        });
      }
    }
    // legacy plaintext (до миграции) — только владельцу с открытым сейфом
    if (cryptoService.isUnlocked(clientRow.psychologistId)) {
      return new Client({ ...clientRow, locked: false });
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
    const pii = {
      name: data.name || '',
      nickname: data.nickname || data.name || '',
      phone: data.phone || '',
      contact: data.contact || '',
      note: data.note || ''
    };
    const encryptedPii = await cryptoService.encryptJson(psychologistId, pii);

    if (data.id) {
      const row = this.assertOwner(psychologistId, data.id);
      if (!row) throw new Error('Клиент не найден или чужой кабинет');
      Object.assign(row, {
        encryptedPii,
        name: '', // не храним plaintext
        nickname: '',
        phone: '',
        contact: '',
        note: '',
        trustLevel: data.trustLevel || row.trustLevel,
        noShowCount: data.noShowCount ?? row.noShowCount,
        cancelCount: data.cancelCount ?? row.cancelCount,
        verifiedContact: data.verifiedContact ?? row.verifiedContact
      });
      // searchable hash of nickname for uniqueness without plaintext
      row.nicknameHash = await this.hashNick(psychologistId, pii.nickname);
      db.saveChanges();
      return this.materialize(row);
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
        const pii = {
          name: c.name || '',
          nickname: c.nickname || c.name || '',
          phone: c.phone || '',
          contact: c.contact || '',
          note: c.note || ''
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
