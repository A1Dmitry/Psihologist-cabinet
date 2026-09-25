#!/usr/bin/env node
/**
 * Claim-протокол исполнителя: «взял Issue — зафиксировал карточку».
 *
 *   node tools/claim.mjs id                 # мой идентификатор EXEC-XXXXXXXXXX
 *   node tools/claim.mjs status             # кто что держит (из любой ветки)
 *   node tools/claim.mjs take 67            # взять Issue: карточка + CLAIM-комментарий
 *   node tools/claim.mjs release 67         # завершить работу, RELEASE + карточка released
 *   node tools/claim.mjs mine               # мои активные claim'ы и мои коммиты
 *   node tools/claim.mjs commit -m "msg"    # коммит с трейлером Executor: EXEC-…
 *   node tools/claim.mjs card 67            # показать карточку, ничего не меняя
 *
 * Владение Issue защищено от гонки: активный claim другого исполнителя даёт
 * конфликт (exit 2), а не «попробую параллельно». Истёкший claim берётся
 * только явно: `take --force --reason "…"`.
 *
 * Честность состояний (RULES §6.15): если GitHub недоступен, состояние не
 * объявляется свободным — печатается UNKNOWN. `take` в таком режиме без
 * `--offline-ok` отказывает (fail closed, exit 3), чтобы не появился второй
 * исполнитель на том же Issue без видимого маркера.
 *
 * Тестовые швы: `--gh-bin <path>` / env CLAIM_GH (подмена gh), `--repo <owner/name>`
 * / env CLAIM_REPO, `--branch`, `--seed`, `--no-commit`, `--push`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEED_FILE, deriveExecutorId, seedFromBranch, formatExecutorId, withCommitTrailer
} from './executor/identity.mjs';
import {
  CARD_DIR, DEFAULT_TTL_MINUTES, STATE_ACTIVE,
  buildCard, buildClaimComment, buildReleaseComment, cardPath, claimDecision,
  findCardConflicts, parseMarkerEvents, releaseCard, summarizeQueue, validateCard
} from './executor/claims.mjs';

const ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE_WINDOW_HOURS = 24;
const PAGE_SIZE = 100;
const EXIT = { OK: 0, USAGE: 1, CONFLICT: 2, REMOTE: 3, PUBLISH: 4 };

/* ——— аргументы ——— */
const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'id';
const flags = {};
const rest = [];
const VALUE_FLAGS = ['ttl', 'seed', 'repo', 'branch', 'gh-bin', 'reason', 'message', 'issue', 'root'];
for (let i = command === argv[0] ? 1 : 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
  if (a === '-m' || a === '--message') { flags.message = argv[i + 1] ?? ''; i += 1; continue; }
  if (a.startsWith('--')) {
    const [key, inline] = a.slice(2).split('=');
    if (inline !== undefined) { flags[key] = inline; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-') && VALUE_FLAGS.includes(key)) { flags[key] = next; i += 1; }
    else flags[key] = true;
  } else rest.push(a);
}
const jsonOut = flags.json === true || flags.json === 'true';
const print = (...a) => { if (!jsonOut) console.log(...a); };
const out = obj => { if (jsonOut) console.log(JSON.stringify(obj, null, 2)); };
const fail = (code, message) => { console.error(message); out({ ok: false, error: message }); process.exit(code); };

/** Корень работы: репозиторий либо изолированный каталог (--root, тесты). */
const ROOT = flags.root && flags.root !== true ? resolve(String(flags.root)) : ROOT_DEFAULT;

/* ——— git / gh ——— */
function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
const branch = flags.branch && flags.branch !== true ? String(flags.branch) : git(['branch', '--show-current'], { allowFail: true }).stdout;
const ghBin = (flags['gh-bin'] && flags['gh-bin'] !== true ? String(flags['gh-bin']) : null) || process.env.CLAIM_GH || 'gh';

function gh(args, { input = null, allowFail = true } = {}) {
  const r = spawnSync(ghBin, args, { cwd: ROOT, encoding: 'utf8', input });
  const res = { ok: r.status === 0, status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  if (!res.ok && !allowFail) throw new Error(`gh ${args.join(' ')}: ${res.stderr || res.status}`);
  return res;
}
function ghJson(args) {
  const r = gh(args);
  if (!r.ok) return { ok: false, error: r.stderr || `exit ${r.status}` };
  try { return { ok: true, data: JSON.parse(r.stdout || 'null') }; }
  catch (e) { return { ok: false, error: `не JSON: ${e.message}` }; }
}
function repoSlug() {
  if (flags.repo && flags.repo !== true) return String(flags.repo);
  if (process.env.CLAIM_REPO) return process.env.CLAIM_REPO;
  const url = git(['remote', 'get-url', 'origin'], { allowFail: true }).stdout;
  const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m ? m[1] : 'A1Dmitry/Psihologist-cabinet';
}

/* ——— идентичность ——— */
function resolveSeed() {
  if (flags.seed && flags.seed !== true) return { seed: String(flags.seed), kind: 'флаг --seed' };
  if (process.env.EXECUTOR_SEED) return { seed: process.env.EXECUTOR_SEED, kind: 'env EXECUTOR_SEED' };
  const file = join(ROOT, SEED_FILE);
  if (existsSync(file)) {
    const v = readFileSync(file, 'utf8').trim();
    if (v) return { seed: v, kind: `файл ${SEED_FILE}` };
  }
  const fromBranch = seedFromBranch(branch);
  if (fromBranch) return { seed: fromBranch, kind: `ветка ${branch}` };
  const host = `${process.env.USER || process.env.USERNAME || 'user'}@${process.env.HOSTNAME || 'host'}`;
  return { seed: host, kind: 'user@host' };
}
const seedInfo = resolveSeed();
const executorId = deriveExecutorId(seedInfo.seed);
const executor = formatExecutorId(executorId);

/* ——— карточки в ветке ——— */
function readCards() {
  const dir = join(ROOT, CARD_DIR);
  if (!existsSync(dir)) return [];
  const cards = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    try { cards.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); }
    catch { cards.push({ schema: 'broken', file: f }); }
  }
  return cards;
}
function writeCard(card) {
  const dir = join(ROOT, CARD_DIR);
  mkdirSync(dir, { recursive: true });
  const rel = cardPath(card);
  writeFileSync(join(ROOT, rel), JSON.stringify(card, null, 2) + '\n');
  return rel;
}
function commitCard(rel, issue) {
  if (flags['no-commit']) { print(`· карточка записана без коммита: ${rel} (--no-commit)`); return { committed: false }; }
  const msg = withCommitTrailer(`claim(issue-${issue}): карточка исполнителя ${executor}`, executorId);
  git(['add', rel]);
  const c = git(['commit', '-m', msg], { allowFail: true });
  if (!c.ok) {
    print(`· WARNING: карточка записана, но коммит не сделан: ${c.stderr.split('\n')[0] || 'нет причины'}`);
    return { committed: false, error: c.stderr };
  }
  print(`· карточка закоммичена: ${rel}`);
  if (flags.push) {
    const p = git(['push', 'origin', branch], { allowFail: true });
    print(p.ok ? `· запушено в origin/${branch}` : `· WARNING: push не удался: ${p.stderr.split('\n')[0]}`);
  }
  return { committed: true, sha: git(['rev-parse', '--short', 'HEAD'], { allowFail: true }).stdout };
}

/* ——— удалённое состояние ——— */
function issueComments(issue) {
  const r = ghJson(['api', `repos/${repoSlug()}/issues/${Number(issue)}/comments?per_page=${PAGE_SIZE}&sort=created&direction=asc`]);
  return r.ok ? { ok: true, comments: r.data || [] } : { ok: false, error: r.error };
}
function postComment(issue, body) {
  const r = gh(['issue', 'comment', String(Number(issue)), '--repo', repoSlug(), '--body-file', '-'], { input: body });
  return r.ok ? { ok: true, url: r.stdout } : { ok: false, error: r.stderr };
}
function remoteState(issue) {
  const c = issueComments(issue);
  if (!c.ok) return { ok: false, error: c.error };
  return { ok: true, events: parseMarkerEvents(c.comments) };
}
function openIssues() {
  const r = ghJson(['issue', 'list', '--repo', repoSlug(), '--state', 'open', '--limit', '100', '--json', 'number,title']);
  return r.ok ? { ok: true, issues: r.data || [] } : { ok: false, error: r.error };
}
function recentCommentEvents() {
  const since = new Date(Date.now() - REMOTE_WINDOW_HOURS * 3600_000).toISOString();
  const r = ghJson(['api', `repos/${repoSlug()}/issues/comments?per_page=${PAGE_SIZE}&sort=created&direction=desc&since=${since}`]);
  if (!r.ok) return { ok: false, error: r.error };
  const comments = r.data || [];
  return { ok: true, events: parseMarkerEvents(comments), truncated: comments.length >= PAGE_SIZE, windowHours: REMOTE_WINDOW_HOURS };
}

/* ——— команды ——— */
function cmdId() {
  out({ executor, id: executorId, seed_kind: seedInfo.kind, branch });
  print(`${executor}`);
  if (flags['show-seed']) print(`seed: ${seedInfo.seed} (${seedInfo.kind})`);
  return EXIT.OK;
}

function cmdStatus() {
  const issues = openIssues();
  const comments = recentCommentEvents();
  const local = readCards();
  const errors = validateCardSet(local);
  const conflicts = findCardConflicts(local);
  if (!issues.ok || !comments.ok) {
    out({ ok: true, executor, branch, remote: 'UNKNOWN', reason: issues.error || comments.error, local_cards: local.length, invalid_cards: errors, conflicts });
    print('Состояние удалённых claim-маркеров: UNKNOWN (GitHub недоступен или нет прав).');
    print('UNKNOWN ≠ FREE: считать Issue свободным по этому выводу нельзя.');
    if (issues.error) print(`  причина: ${issues.error.split('\n')[0]}`);
    return EXIT.OK;
  }
  const rows = summarizeQueue(issues.issues, comments.events);
  // Дубли среди УДАЛЁННЫХ маркеров — аварийный сигнал: два исполнителя взяли
  // один Issue (например, из-за потери канала в момент CLAIM). Это конфликт,
  // а не «просто шум»: гейт и человек обязаны это увидеть.
  const remoteConflicts = rows.filter(r => r.holders.length > 1)
    .map(r => ({ issue: r.issue, executors: r.holders.map(h => formatExecutorId(h.executorId)) }));
  // Активная карточка в ветке, которой нет в удалённых маркерах: claim не виден
  // другим исполнителям (права/офлайн). Это риск дубля, а не «всё хорошо».
  const publishedKeys = new Set(rows.flatMap(r => r.holders.map(h => `${r.issue}|EXEC-${h.executorId}`)));
  const unpublished = local
    .filter(c => c.state === STATE_ACTIVE && new Date(c.expires_at).getTime() > Date.now())
    .filter(c => !publishedKeys.has(`${c.issue}|${c.executor}`))
    .map(c => ({ issue: c.issue, executor: c.executor, expires_at: c.expires_at }));
  out({ ok: true, executor, branch, remote: comments.truncated ? 'PARTIAL' : 'OK', rows, conflicts, remote_conflicts: remoteConflicts, unpublished, invalid_cards: errors });
  print(`Исполнитель: ${executor}   ветка: ${branch}`);
  print('ISSUE  КТО ДЕРЖИТ                          СОСТОЯНИЕ  ОСТАЛОСЬ  ЗАГОЛОВОК');
  for (const row of rows.sort((a, b) => a.issue - b.issue)) {
    const who = row.holders.length
      ? row.holders.map(h => `${formatExecutorId(h.executorId)}${h.executorId === executorId ? ' (я)' : ''}`).join(', ')
      : (row.stale[0] ? `${formatExecutorId(row.stale[0].executorId)} (истёк)` : '—');
    const left = row.holders.length
      ? `${Math.max(0, Math.round((new Date(row.holders[0].expiresAt) - Date.now()) / 60000))}м` : '—';
    print(`#${String(row.issue).padEnd(4)} ${who.padEnd(39)} ${row.state.padEnd(10)} ${left.padEnd(8)} ${String(row.title).slice(0, 60)}`);
  }
  if (comments.truncated) print('· PARTIAL: прочитаны не все комментарии окна — состояние может быть неполным.');
  for (const c of remoteConflicts) print(`· CONFLICT (удалённо): Issue #${c.issue} одновременно держат ${c.executors.join(', ')} — нужен release одного из них.`);
  for (const c of conflicts) print(`· CONFLICT (карточки ветки): Issue #${c.issue} держат ${c.executors.join(', ')} — merge запрещён до release.`);
  for (const u of unpublished) print(`· НЕ ОПУБЛИКОВАН: карточка #${u.issue} ${u.executor} есть в ветке, но удалённого маркера нет — другие исполнители владение не видят.`);
  for (const e of errors) print(`· НЕВАЛИДНАЯ КАРТОЧКА: ${e}`);
  return (conflicts.length || remoteConflicts.length) ? EXIT.CONFLICT : EXIT.OK;
}

function validateCardSet(cards) {
  const errors = [];
  for (const card of cards) {
    const errs = validateCard(card);
    if (errs.length) errors.push(`issue=${card?.issue ?? '?'} exec=${card?.executor ?? '?'}: ${errs.join('; ')}`);
  }
  return errors;
}

function takeIssue(issue, { force = false, reason = '', comment = '' } = {}) {
  if (!Number.isInteger(Number(issue)) || Number(issue) <= 0) fail(EXIT.USAGE, 'take: укажите номер Issue, например `claim take 67`');
  const ttl = Number(flags.ttl || DEFAULT_TTL_MINUTES);
  if (!Number.isFinite(ttl) || ttl <= 0) fail(EXIT.USAGE, `take: некорректный --ttl «${flags.ttl}»`);

  const remote = remoteState(issue);
  if (!remote.ok && !flags['offline-ok']) {
    out({ ok: false, code: 'REMOTE_UNKNOWN', issue: Number(issue), error: remote.error });
    print(`НЕ ВЗЯТО: удалённые claim-маркеры Issue #${issue} не прочитаны (${remote.error.split('\n')[0]}).`);
    print('Правило: UNKNOWN ≠ FREE. Повторите при доступе к GitHub либо, осознанно приняв риск,');
    print('запустите с --offline-ok — карточка будет локальной, а отсутствие публичного маркера станет блокером.');
    return EXIT.REMOTE;
  }
  const events = remote.ok ? remote.events : [];
  const decision = claimDecision({ events, issue, executorId });
  if (decision.action === 'conflict' || (decision.action === 'takeover-stale' && !force)) {
    const h = decision.holder;
    out({ ok: false, code: decision.action.toUpperCase(), issue: Number(issue), holder: h, hint: decision.action === 'takeover-stale' ? 'истёкший claim: нужен --force --reason' : 'выберите другое Issue' });
    print(`Issue #${issue} держит ${formatExecutorId(h.executorId)}${h.branch ? ` (ветка ${h.branch})` : ''}, до ${h.expiresAt}.`);
    print(decision.action === 'conflict'
      ? 'Возьмите другое Issue или дождитесь release/истечения TTL.'
      : 'Claim истёк: перехват только явно — `take ' + issue + ' --force --reason "почему"`.');
    return EXIT.CONFLICT;
  }
  const handoverFrom = decision.action === 'takeover-stale' ? decision.holder.executorId : null;
  if (handoverFrom && !reason) fail(EXIT.USAGE, 'take: перехват истёкшего claim требует --reason');

  const takenAt = Date.now();
  const card = buildCard({ issue, executorId, branch, takenAt, ttlMinutes: ttl, handoverFrom });
  const rel = writeCard(card);
  print(`· карточка: ${rel} (${card.state}, до ${card.expires_at})`);

  let commentPosted = false;
  let publishError = '';
  if (remote.ok && !flags['no-comment']) {
    const body = buildClaimComment({
      issue, executorId, branch, takenAt, ttlMinutes: ttl,
      comment: comment || (handoverFrom ? `Перехват истёкшего claim ${formatExecutorId(handoverFrom)}: ${reason}` : '')
    });
    const posted = postComment(issue, body);
    commentPosted = posted.ok;
    if (!posted.ok) publishError = posted.error.split('\n')[0];
    print(posted.ok ? `· CLAIM опубликован в Issue #${issue}` : `· CLAIM НЕ опубликован: ${publishError}`);
  } else if (!remote.ok) {
    publishError = 'нет канала GitHub';
    print('· WARNING: удалённый маркер не опубликован (offline-ok) — это блокер, зафиксируйте его в отчёте.');
  }
  const c = commitCard(rel, issue);

  // Публикация маркера — не удобство, а условие протокола: без него другой
  // исполнитель не увидит claim и возьмёт тот же Issue (rename-гонка).
  // Поэтому неудача публикации — явный блокер (exit 4), а не «почти успех».
  const publishBlocked = remote.ok && !flags['no-comment'] && !commentPosted;
  if (publishBlocked && !flags['offline-ok']) {
    out({ ok: false, code: 'CLAIM_NOT_PUBLISHED', action: decision.action, executor, issue: Number(issue), card: rel, committed: !!c.committed, error: publishError, hint: 'нужны права issues:write (комментарии) либо осознанный --offline-ok с фиксацией блокера' });
    print(`БЛОКЕР: карточка записана, но CLAIM-маркер в Issue #${issue} не опубликован.`);
    print('Другие исполнители не увидят владение и могут взять тот же Issue.');
    print('Действия: выдать исполнителю право комментировать Issues (issues:write) либо запустить с --offline-ok и зафиксировать блокер в отчёте.');
    return EXIT.PUBLISH;
  }
  out({ ok: true, action: decision.action, executor, issue: Number(issue), card: rel, expires_at: card.expires_at, comment_posted: commentPosted, publish_blocked: publishBlocked, committed: !!c.committed, commit: c.sha || null, branch });
  print(`Взято: Issue #${issue} → ${executor} (до ${card.expires_at}). Другой исполнитель получит conflict, пока claim активен.`);
  if (publishBlocked) print('· ВНИМАНИЕ: работаете без публичного маркера (--offline-ok) — это блокер, зафиксируйте его.');
  return EXIT.OK;
}

function releaseIssue(issue, { reason = '' } = {}) {
  if (!Number.isInteger(Number(issue)) || Number(issue) <= 0) fail(EXIT.USAGE, 'release: укажите номер Issue');
  const cards = readCards();
  const mineCard = cards.find(c => c.issue === Number(issue) && c.executor === executor && c.state === STATE_ACTIVE);
  let commentPosted = false;
  const remote = remoteState(issue);
  if (!remote.ok) {
    print(`· WARNING: удалённые маркеры не прочитаны (${remote.error.split('\n')[0]}) — RELEASE не опубликован.`);
  } else if (!flags['no-comment']) {
    const posted = postComment(issue, buildReleaseComment({ issue, executorId, at: Date.now(), reason }));
    commentPosted = posted.ok;
    print(posted.ok ? `· RELEASE опубликован в Issue #${issue}` : `· WARNING: RELEASE не опубликован: ${posted.error.split('\n')[0]}`);
  }
  let rel = null; let c = { committed: false };
  if (mineCard) {
    rel = writeCard(releaseCard(mineCard, { at: Date.now(), reason }));
    print(`· карточка закрыта: ${rel}`);
    if (!flags['no-commit']) {
      git(['add', rel]);
      c = git(['commit', '-m', withCommitTrailer(`claim(issue-${issue}): release ${executor}`, executorId)], { allowFail: true });
      if (!c.ok) print(`· WARNING: коммит не сделан: ${c.stderr.split('\n')[0] || 'нет причины'}`);
      else print(`· карточка закоммичена: ${rel}`);
      if (flags.push && c.ok) {
        const p = git(['push', 'origin', branch], { allowFail: true });
        print(p.ok ? `· запушено в origin/${branch}` : `· WARNING: push не удался: ${p.stderr.split('\n')[0]}`);
      }
    }
  } else {
    print(`· активной карточки ${executor} по Issue #${issue} в этой ветке нет — только удалённый RELEASE.`);
  }
  out({ ok: true, executor, issue: Number(issue), card: rel, comment_posted: commentPosted, committed: !!c.ok, branch });
  return EXIT.OK;
}

function cmdMine() {
  const trailer = `Executor: ${executor}`;
  const log = git(['log', `--grep=${trailer}`, '--oneline', '-20'], { allowFail: true }).stdout;
  const local = readCards().filter(c => c.executor === executor && c.state === STATE_ACTIVE);
  const remote = recentCommentEvents();
  let myRemote = [];
  if (remote.ok) {
    for (const row of summarizeQueue(openIssues().issues || [], remote.events)) {
      for (const h of row.holders) if (h.executorId === executorId) myRemote.push({ issue: row.issue, ...h });
    }
  }
  out({ ok: true, executor, branch, commits: log.split('\n').filter(Boolean), cards: local, remote_claims: myRemote, remote: remote.ok ? 'OK' : 'UNKNOWN' });
  print(`Исполнитель: ${executor}   ветка: ${branch}`);
  print(`\nМои коммиты в этой ветке (трейлер «${trailer}»):`);
  print(log || '  (пока нет)');
  print('\nМои активные claim\'ы (локальные карточки ветки):');
  print(local.length ? local.map(c => `  #${c.issue} до ${c.expires_at}`).join('\n') : '  (нет)');
  print(`\nВидимые удалённо: ${remote.ok ? (myRemote.length ? myRemote.map(r => `#${r.issue} до ${r.expiresAt}`).join(', ') : '(нет)') : 'UNKNOWN (GitHub недоступен)'}`);
  return EXIT.OK;
}

function cmdCommit() {
  const message = flags.message || flags.m || rest.join(' ');
  if (!message) fail(EXIT.USAGE, 'commit: нужен -m "сообщение"');
  const full = withCommitTrailer(message, executorId);
  const r = git(['commit', '-m', full], { allowFail: true });
  if (!r.ok) fail(EXIT.USAGE, `commit: git вернул ошибку: ${r.stderr.split('\n')[0] || 'нет причины'}`);
  out({ ok: true, executor, committed: true, sha: git(['rev-parse', '--short', 'HEAD'], { allowFail: true }).stdout });
  print(`${git(['rev-parse', '--short', 'HEAD'], { allowFail: true }).stdout}  ${full.split('\n')[0]}`);
  print(`Трейлер добавлен: Executor: ${executor}`);
  return EXIT.OK;
}

function cmdCard() {
  const issue = Number(flags.issue || rest[0]);
  if (!Number.isInteger(issue) || issue <= 0) fail(EXIT.USAGE, 'card: укажите номер Issue');
  const existing = readCards().find(c => c.issue === issue && c.executor === executor);
  const card = existing || buildCard({ issue, executorId, branch, takenAt: Date.now(), ttlMinutes: Number(flags.ttl || DEFAULT_TTL_MINUTES) });
  out({ ok: true, card, path: cardPath(card), errors: validateCard(card) });
  print(JSON.stringify(card, null, 2));
  print(`Путь: ${cardPath(card)}`);
  return EXIT.OK;
}

const COMMANDS = { id: cmdId, status: cmdStatus, take: takeIssue, release: releaseIssue, mine: cmdMine, commit: cmdCommit, card: cmdCard };
const fn = COMMANDS[command];
if (!fn) {
  fail(EXIT.USAGE, `claim: неизвестная команда «${command}». Доступно: ${Object.keys(COMMANDS).join(', ')}`);
}
process.exit(fn(command === 'take' || command === 'release' ? (flags.issue || rest[0]) : undefined, { reason: typeof flags.reason === 'string' ? flags.reason : '', force: flags.force === true, comment: '' }));
