/**
 * Claim-протокол: «взял Issue — зафиксировал карточку».
 *
 * Два носителя состояния, намеренно разных по назначению:
 *
 *   1. Комментарий-маркер в Issue (GitHub) — единственный КРОСС-ВЕТОЧНЫЙ
 *      источник истины: его видит любой исполнитель из любой ветки и клона.
 *      Формат (первая строка — невидимый маркер для парсинга):
 *
 *        <!-- executor-claim v1 -->
 *        CLAIM EXEC-xxxxxxxxxx issue=67 branch=... taken=... ttl=90 expires=...
 *
 *   2. Карточка `.claims/issue-<n>.<EXEC>.json` в ветке — видимая история
 *      «кто брал» рядом с изменениями, и материал для проверки в Quality Gate
 *      (два активных claim на один Issue = красный гейт).
 *
 * Инварианты (проверяются tests/executor-claims.mjs):
 *   - ID = 10 символов base64url (единственная реализация — identity.mjs);
 *   - второй исполнитель НЕ получает активный Issue: решение conflict;
 *   - истёкший claim (STALE) перехватывается только явно (--force + причина);
 *   - «не прочитали удалённые маркеры» ≠ «свободно»: состояние UNKNOWN.
 *
 * Модуль чистый: время и данные передаются аргументами, сеть/файлы — в CLI.
 */

export const CLAIM_MARKER = '<!-- executor-claim v1 -->';
export const DEFAULT_TTL_MINUTES = 90;
export const CARD_DIR = '.claims';
export const STATE_ACTIVE = 'active';
export const STATE_RELEASED = 'released';

const iso = (value) => new Date(value).toISOString();

/** Комментарий CLAIM (публикуется в Issue). */
export function buildClaimComment({ issue, executorId, branch, takenAt, ttlMinutes = DEFAULT_TTL_MINUTES, comment = '' }) {
  const taken = iso(takenAt);
  const expires = iso(new Date(new Date(taken).getTime() + ttlMinutes * 60_000));
  const lines = [
    CLAIM_MARKER,
    `CLAIM EXEC-${executorId} issue=${issue} branch=${branch} taken=${taken} ttl=${ttlMinutes} expires=${expires}`
  ];
  if (comment) lines.push('', comment);
  return lines.join('\n');
}

/** Комментарий RELEASE (закрывает владение). */
export function buildReleaseComment({ issue, executorId, at, reason = '' }) {
  const lines = [CLAIM_MARKER, `RELEASE EXEC-${executorId} issue=${issue} at=${iso(at)}`];
  if (reason) lines.push('', reason);
  return lines.join('\n');
}

/**
 * Разобрать комментарии Issue в события протокола.
 * @param {Array<{body?:string, created_at?:string, html_url?:string, user?:{login?:string}}>} comments
 */
export function parseMarkerEvents(comments = []) {
  const events = [];
  for (const c of comments) {
    const body = String(c?.body ?? '');
    if (!body.includes(CLAIM_MARKER)) continue;
    const createdAt = c?.created_at ? iso(c.created_at) : null;
    const url = c?.html_url || '';
    const login = c?.user?.login || '';
    for (const line of body.split('\n')) {
      const claim = line.match(/^CLAIM EXEC-([A-Za-z0-9_-]{10}) issue=(\d+) branch=(\S+) taken=(\S+) ttl=(\d+) expires=(\S+)/);
      if (claim) {
        events.push({
          kind: 'claim', issue: Number(claim[2]), executorId: claim[1], branch: claim[3],
          takenAt: claim[4], ttlMinutes: Number(claim[5]), expiresAt: claim[6],
          createdAt: createdAt || claim[4], url, login
        });
        continue;
      }
      const release = line.match(/^RELEASE EXEC-([A-Za-z0-9_-]{10}) issue=(\d+) at=(\S+)/);
      if (release) {
        events.push({
          kind: 'release', issue: Number(release[2]), executorId: release[1],
          releasedAt: release[3], createdAt: createdAt || release[3], url, login
        });
      }
    }
  }
  return events.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Активные владельцы Issue: последнее событие исполнителя решает, плюс TTL.
 * @returns {{holders: Array, stale: Array}} holders — активные, stale — истёкшие.
 */
export function resolveIssueClaims(events, { issue, now = Date.now() } = {}) {
  const last = new Map();
  for (const e of events) {
    if (issue != null && e.issue !== Number(issue)) continue;
    last.set(e.executorId, e);
  }
  const holders = [];
  const stale = [];
  for (const [executorId, e] of last) {
    if (e.kind === 'release') continue;
    const entry = {
      executorId, branch: e.branch || '', takenAt: e.takenAt, expiresAt: e.expiresAt,
      ttlMinutes: e.ttlMinutes, url: e.url || ''
    };
    if (new Date(e.expiresAt).getTime() > now) holders.push(entry);
    else stale.push(entry);
  }
  holders.sort((a, b) => a.executorId.localeCompare(b.executorId));
  stale.sort((a, b) => a.executorId.localeCompare(b.executorId));
  return { holders, stale };
}

/**
 * Решение по взятию Issue.
 * @returns {{action:'acquire'|'refresh'|'conflict'|'takeover-stale', holder?:object, holders?:Array}}
 *   acquire        — свободно;
 *   refresh        — мой же активный claim (продление);
 *   conflict       — держит другой исполнитель;
 *   takeover-stale — держит другой, но claim истёк (только с --force).
 */
export function claimDecision({ events = [], issue, executorId, now = Date.now() } = {}) {
  const { holders, stale } = resolveIssueClaims(events, { issue, now });
  const mine = holders.find(h => h.executorId === executorId);
  if (mine) return { action: 'refresh', holder: mine };
  if (holders.length) return { action: 'conflict', holder: holders[0], holders };
  const staleOther = stale.find(s => s.executorId !== executorId);
  if (staleOther) return { action: 'takeover-stale', holder: staleOther };
  return { action: 'acquire' };
}

/** Карточка исполнителя (файл в .claims/, коммитится в ветку). */
export function buildCard({ issue, executorId, branch, takenAt = Date.now(), ttlMinutes = DEFAULT_TTL_MINUTES, handoverFrom = null }) {
  const taken = iso(takenAt);
  return {
    schema: 'executor-claim/v1',
    issue: Number(issue),
    executor: `EXEC-${executorId}`,
    branch: String(branch || ''),
    state: STATE_ACTIVE,
    taken_at: taken,
    expires_at: iso(new Date(new Date(taken).getTime() + ttlMinutes * 60_000)),
    ttl_minutes: ttlMinutes,
    ...(handoverFrom ? { handover_from: `EXEC-${handoverFrom}` } : {})
  };
}

/** Карточка, закрытая release (история сохраняется в ветке). */
export function releaseCard(card, { at = Date.now(), reason = '' } = {}) {
  return { ...card, state: STATE_RELEASED, released_at: iso(at), ...(reason ? { release_reason: reason } : {}) };
}

export function cardPath(card) {
  return `${CARD_DIR}/issue-${card.issue}.${card.executor}.json`;
}

/** Валидация карточки (гейт обязан красить невалидную схему). */
export function validateCard(card) {
  const errors = [];
  if (!card || typeof card !== 'object') return ['карточка не объект'];
  if (card.schema !== 'executor-claim/v1') errors.push(`schema: ожидалось executor-claim/v1, получено ${card.schema}`);
  if (!Number.isInteger(card.issue) || card.issue <= 0) errors.push(`issue: ${card.issue}`);
  if (!/^EXEC-[A-Za-z0-9_-]{10}$/.test(String(card.executor || ''))) errors.push(`executor: ${card.executor}`);
  if (![STATE_ACTIVE, STATE_RELEASED].includes(card.state)) errors.push(`state: ${card.state}`);
  for (const key of ['taken_at', 'expires_at']) {
    if (Number.isNaN(new Date(card[key]).getTime())) errors.push(`${key}: ${card[key]}`);
  }
  if (card.state === STATE_ACTIVE && new Date(card.expires_at).getTime() <= new Date(card.taken_at).getTime()) {
    errors.push('expires_at не позже taken_at');
  }
  if (card.state === STATE_RELEASED && Number.isNaN(new Date(card.released_at).getTime())) {
    errors.push(`released_at: ${card.released_at}`);
  }
  return errors;
}

/**
 * Конфликты внутри ветки: один Issue, два РАЗНЫХ исполнителя с активным
 * (не истёкшим) claim. Истёкшие и released — не конфликт (история допустима).
 */
export function findCardConflicts(cards = [], { now = Date.now() } = {}) {
  const byIssue = new Map();
  for (const card of cards) {
    if (card?.state !== STATE_ACTIVE) continue;
    if (new Date(card.expires_at).getTime() <= now) continue;
    if (!byIssue.has(card.issue)) byIssue.set(card.issue, new Set());
    byIssue.get(card.issue).add(card.executor);
  }
  return [...byIssue.entries()]
    .filter(([, executors]) => executors.size > 1)
    .map(([issue, executors]) => ({ issue, executors: [...executors].sort() }));
}

/**
 * Сводка состояния очереди: для каждого Issue — кто держит.
 * @param {Array<{number:number,title?:string}>} issues открытые Issue
 * @param {Array} events события протокола из комментариев
 * @returns {Array<{issue:number,title:string,state:'CLAIMED'|'STALE'|'FREE',holders:Array,stale:Array}>}
 */
export function summarizeQueue(issues = [], events = [], { now = Date.now() } = {}) {
  return issues.map(issue => {
    const { holders, stale } = resolveIssueClaims(events, { issue: issue.number, now });
    const state = holders.length ? 'CLAIMED' : (stale.length ? 'STALE' : 'FREE');
    return { issue: issue.number, title: issue.title || '', state, holders, stale };
  });
}
