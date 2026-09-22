/**
 * NicknameService — уникальный никнейм клиента в кабинете психолога
 * - минимум 4 буквы (латиница/кириллица)
 * - внутренняя уникальность в рамках psychologistId
 * - автопредложение свободных вариантов
 */
import { db } from '../core/dbContext.js';

const LETTER_RE = /[a-zA-Zа-яА-ЯёЁ]/g;

export function countLetters(str) {
  const m = String(str || '').match(LETTER_RE);
  return m ? m.length : 0;
}

export function normalizeNickname(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\-]/g, '')
    .slice(0, 32);
}

export class NicknameService {
  validate(nickname, psychologistId, excludeClientId = null) {
    const nick = normalizeNickname(nickname);
    if (!nick) {
      return { ok: false, message: 'Укажите никнейм' };
    }
    if (countLetters(nick) < 4) {
      return { ok: false, message: 'Никнейм: не менее 4 букв (цифры и _ допустимы, но букв ≥ 4)' };
    }
    if (nick.length < 4) {
      return { ok: false, message: 'Никнейм слишком короткий' };
    }
    const taken = db.clientsOf(psychologistId).some(c => {
      if (c.id === excludeClientId) return false;
      if (c.nickname || c.name) {
        return normalizeNickname(c.nickname || c.name).toLowerCase() === nick.toLowerCase();
      }
      return false; // encrypted-only: hash checked async in vault
    });
    if (taken) {
      return { ok: false, message: 'Этот никнейм уже занят у данного психолога', taken: true };
    }
    return { ok: true, nickname: nick };
  }

  isAvailable(nickname, psychologistId, excludeClientId = null) {
    return this.validate(nickname, psychologistId, excludeClientId).ok;
  }

  /** Автопредложения на основе ввода / имени */
  suggest(base, psychologistId, limit = 5) {
    let root = normalizeNickname(base);
    if (countLetters(root) < 4) {
      // добить до 4 букв осмысленным суффиксом
      const pad = 'user';
      root = normalizeNickname((root || 'cli') + pad);
    }
    if (countLetters(root) < 4) root = 'client';

    const suggestions = [];
    const tryAdd = (cand) => {
      const n = normalizeNickname(cand);
      if (!n || suggestions.includes(n)) return;
      if (this.isAvailable(n, psychologistId)) suggestions.push(n);
    };

    tryAdd(root);
    const year = new Date().getFullYear().toString().slice(-2);
    for (let i = 1; suggestions.length < limit && i < 40; i++) {
      tryAdd(`${root}${i}`);
      tryAdd(`${root}_${i}`);
      if (i <= 5) tryAdd(`${root}${year}`);
    }
    // варианты с мягкими окончаниями
    ['_psy', '_ok', '_new'].forEach(s => {
      if (suggestions.length < limit) tryAdd(root + s);
    });

    return suggestions.slice(0, limit);
  }

  findByNickname(psychologistId, nickname) {
    const n = normalizeNickname(nickname).toLowerCase();
    return db.clientsOf(psychologistId).find(
      c => normalizeNickname(c.nickname || c.name).toLowerCase() === n
    ) || null;
  }
}

export const nicknameService = new NicknameService();
