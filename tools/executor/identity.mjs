/**
 * Идентичность исполнителя (EXEC-XXXXXXXXXX).
 *
 * Зачем: в проекте параллельно работают несколько агентов/людей; нужно без
 * дополнительной инфраструктуры понимать, кто владеет Issue и чьи это коммиты.
 *
 * Контракт идентификатора:
 *   ID = base64url(SHA-256(seed)).slice(0, 10)   → 10 символов [A-Za-z0-9_-]
 *   Отображение: EXEC-XXXXXXXXXX
 *
 * Seed (в порядке приоритета, см. resolveSeed):
 *   1. --seed / EXECUTOR_SEED           — явный (ручной запуск, тесты);
 *   2. .executor-seed                   — локальный файл исполнителя (gitignored);
 *   3. имя ветки arena/...              — у каждой агентской сессии своя ветка,
 *                                         значит свой стабильный seed;
 *   4. user@host                        — последний рубеж для человека локально.
 *
 * Про seed: он не секрет и не удостоверяет личность (им можно притвориться);
 * это способ различить исполнителей и не дать двум агентам взять один Issue.
 * Не публиковать в seed PII/токены: файл может попасть в отчёты/диалог.
 */
import { createHash } from 'node:crypto';

export const ID_LENGTH = 10;
export const ID_PREFIX = 'EXEC-';
export const ID_RE = /EXEC-([A-Za-z0-9_-]{10})\b/g;
export const SEED_FILE = '.executor-seed';

/** Производный идентификатор: 10 символов base64url от SHA-256(seed). */
export function deriveExecutorId(seed) {
  const value = String(seed ?? '').trim();
  if (!value) throw new Error('deriveExecutorId: пустой seed');
  return createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, ID_LENGTH);
}

/** EXEC-XXXXXXXXXX (идентификатор для карточек, комментариев, трейлеров). */
export function formatExecutorId(id) {
  if (!isExecutorId(id)) throw new Error(`formatExecutorId: неверный идентификатор «${id}»`);
  return ID_PREFIX + id;
}

/** Голый 10-символьный id без префикса; принимает и «EXEC-…», и голый. */
export function normalizeExecutorId(value) {
  const raw = String(value ?? '').trim();
  const m = raw.match(/^(?:EXEC-)?([A-Za-z0-9_-]{10})$/);
  return m ? m[1] : null;
}

export function isExecutorId(value) {
  return normalizeExecutorId(value) !== null;
}

/** Найти все EXEC-идентификаторы в произвольном тексте (комментарий, PR, лог). */
export function findExecutorIds(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(ID_RE)) out.push(m[1]);
  return out;
}

/**
 * Seed из имени ветки: агентская ветка `arena/<session-id>-slug` уникальна для
 * сессии, поэтому даёт стабильный ID и не требует ни файла, ни env.
 */
export function seedFromBranch(branch) {
  const b = String(branch ?? '').trim();
  return /^arena\/.+/.test(b) ? `branch:${b}` : null;
}

/** Трейлер коммита: единственная строка, по которой `git log` показывает автора. */
export function commitTrailer(executorId) {
  return `Executor: ${formatExecutorId(executorId)}`;
}

/**
 * Есть ли в сообщении коммита ИМЕННО трейлер нужного исполнителя.
 * Проверяется строка `Executor: EXEC-…`, а не любое упоминание ID в тексте:
 * иначе сообщение вида «claim(issue-1): карточка исполнителя EXEC-…» считалось
 * бы уже помеченным и трейлер не добавлялся (найдено набором при разработке).
 */
export function hasCommitTrailer(message, executorId) {
  const id = normalizeExecutorId(executorId);
  if (!id) return false;
  return new RegExp(`^Executor:\\s*EXEC-${id}\\s*$`, 'm').test(String(message ?? ''));
}

/** Готовое сообщение с добавленным трейлером (не дублирует существующий). */
export function withCommitTrailer(message, executorId) {
  const text = String(message ?? '').trimEnd();
  if (hasCommitTrailer(text, executorId)) return text;
  return `${text}\n\n${commitTrailer(executorId)}`;
}
