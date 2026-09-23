/**
 * CryptoService — ключ психолога из пароля (PBKDF2) + AES-GCM
 * Чувствительные поля клиентов шифруются; ключ только в памяти сессии.
 */
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 256;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s);
}

function b64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export class CryptoService {
  constructor() {
    /** @type {Map<string, CryptoKey>} psychologistId -> AES key */
    this._keys = new Map();
  }

  isUnlocked(psychologistId) {
    return this._keys.has(psychologistId);
  }

  lock(psychologistId) {
    if (psychologistId) this._keys.delete(psychologistId);
    else this._keys.clear();
  }

  lockAll() {
    this._keys.clear();
  }

  async randomSalt() {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return bufToB64(salt);
  }

  async deriveKey(password, saltB64) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: b64ToBuf(saltB64),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /** verifier: encrypt fixed phrase — для проверки пароля без хранения пароля */
  async createVerifier(password, saltB64) {
    const key = await this.deriveKey(password, saltB64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode('psy-portal-verifier-v1')
    );
    return {
      salt: saltB64,
      iv: bufToB64(iv),
      data: bufToB64(cipher)
    };
  }

  async verifyPassword(password, verifier) {
    if (!verifier?.salt || !verifier?.iv || !verifier?.data) return false;
    try {
      const key = await this.deriveKey(password, verifier.salt);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ToBuf(verifier.iv) },
        key,
        b64ToBuf(verifier.data)
      );
      const text = new TextDecoder().decode(plain);
      return text === 'psy-portal-verifier-v1';
    } catch {
      return false;
    }
  }

  async unlock(psychologistId, password, verifier) {
    const ok = await this.verifyPassword(password, verifier);
    if (!ok) return false;
    const key = await this.deriveKey(password, verifier.salt);
    this._keys.set(psychologistId, key);
    return true;
  }

  async encryptJson(psychologistId, obj) {
    const key = this._keys.get(psychologistId);
    if (!key) throw new Error('Сейф заблокирован: войдите с паролем');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(JSON.stringify(obj))
    );
    return {
      v: 1,
      iv: bufToB64(iv),
      data: bufToB64(cipher)
    };
  }

  async decryptJson(psychologistId, payload) {
    if (!payload || !payload.data) return null;
    const key = this._keys.get(psychologistId);
    if (!key) throw new Error('Сейф заблокирован');
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ToBuf(payload.iv) },
        key,
        b64ToBuf(payload.data)
      );
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return null;
    }
  }

  /** Публичные поля психолога для каталога — без контактов клиентов */
  static publicPsychologistView(p) {
    if (!p) return null;
    return {
      id: p.id,
      fullName: p.fullName,
      specialization: p.specialization,
      city: p.city,
      about: p.about,
      greeting: p.greeting || '',
      approach: p.approach || '',
      photoUrl: p.photoUrl || '',
      publicEmail: p.publicEmail || '',
      website: p.website || '',
      sourceUrl: p.sourceUrl || '',
      address: p.address || '',
      experience: p.experience || '',
      directions: Array.isArray(p.directions) ? p.directions : [],
      education: p.education || { basic: [], additional: [] },
      experienceItems: Array.isArray(p.experienceItems) ? p.experienceItems : [],
      socials: Array.isArray(p.socials) ? p.socials : [],
      paymentLinks: Array.isArray(p.paymentLinks) ? p.paymentLinks : [],
      paymentRequisites: p.paymentRequisites || null,
      slug: p.slug,
      isActive: p.isActive
    };
  }
}

export const cryptoService = new CryptoService();
