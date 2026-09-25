#!/usr/bin/env node
/**
 * Claim-протокол исполнителей: идентификатор EXEC-XXXXXXXXXX, карточки и
 * «взял Issue — другой не берёт тот же».
 *
 *   node tests/executor-claims.mjs
 *
 * Что проверяется по существу, а не «что функция существует»:
 *   1. Идентификатор: 10 символов base64url, детерминирован от seed, различает
 *      исполнителей, попадает в трейлер коммита ровно один раз.
 *   2. Маркеры: CLAIM/RELEASE в комментариях Issue восстанавливают владельца;
 *      истёкший claim отличается от активного (STALE ≠ CLAIMED).
 *   3. Конфликт: второй исполнитель НЕ получает активный Issue; перехват
 *      истёкшего — только явно (force + причина), карточка фиксирует handover.
 *   4. CLI целиком (герметично): подменный `gh` + изолированный `--root`;
 *      проверяются коды выхода (0/2/3), содержимое карточки, факт публикации
 *      маркера и коммит с трейлером.
 *   5. Негативные контроли гейта: два активных CLAIM на один Issue —
 *      conflict; недоступный GitHub — UNKNOWN, а не «свободно» (FAIL-пины).
 *   6. Карточки, уже лежащие в ветке (.claims/*.json), валидны и не конфликтуют.
 *
 * Сеть не используется: удалённые маркеры эмулирует fake-gh из временного
 * каталога. Репозиторий не мутируется: карточки/коммиты — только в temp-root.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ID_LENGTH, deriveExecutorId, findExecutorIds, formatExecutorId, hasCommitTrailer, withCommitTrailer
} from '../tools/executor/identity.mjs';
import {
  CARD_DIR, DEFAULT_TTL_MINUTES, buildCard, buildClaimComment, buildReleaseComment,
  claimDecision, findCardConflicts, parseMarkerEvents, releaseCard, resolveIssueClaims,
  summarizeQueue, validateCard
} from '../tools/executor/claims.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};
const min = n => new Date(Date.now() + n * 60_000).toISOString();

/* ═══ 1. Идентификатор исполнителя ═══ */
const idA = deriveExecutorId('branch:arena/agent-a');
const idB = deriveExecutorId('branch:arena/agent-b');
check('ID: ровно 10 символов base64url', idA.length === ID_LENGTH && /^[A-Za-z0-9_-]{10}$/.test(idA), idA);
check('ID: детерминирован от seed', deriveExecutorId('branch:arena/agent-a') === idA);
check('ID: разные seed дают разные ID (различимость исполнителей)', idA !== idB, `${idA} / ${idB}`);
check('ID: формат EXEC-…', formatExecutorId(idA) === `EXEC-${idA}`);
check('ID: находится в тексте (поиск по комментарию/PR)', findExecutorIds(`беру Issue (${formatExecutorId(idA)})`)[0] === idA);
const msg1 = withCommitTrailer('feat: правка', idA);
const msg2 = withCommitTrailer(msg1, idA);
check('трейлер: добавлен один раз и распознаётся', hasCommitTrailer(msg1, idA) && msg1 === msg2, msg1.split('\n').pop());
check('трейлер: чужой ID не принимается за свой', !hasCommitTrailer(msg1, idB));

/* ═══ 2. Маркеры и состояние владения ═══ */
const claimComment = buildClaimComment({
  issue: 99, executorId: idA, branch: 'arena/agent-a', takenAt: min(-10), ttlMinutes: 90
});
const events = parseMarkerEvents([{ body: claimComment, created_at: min(-10), html_url: 'u1', user: { login: 'bot' } }]);
check('маркер CLAIM: разобран (issue/executor/expires)', events.length === 1 && events[0].kind === 'claim'
  && events[0].issue === 99 && events[0].executorId === idA && new Date(events[0].expiresAt).getTime() > Date.now());
check('состояние: активный claim найден', resolveIssueClaims(events, { issue: 99 }).holders.length === 1);
check('состояние: release закрывает владение',
  resolveIssueClaims(parseMarkerEvents([{ body: buildReleaseComment({ issue: 99, executorId: idA, at: min(-1) }), created_at: min(-1) }]), { issue: 99 }).holders.length === 0);
const staleComment = buildClaimComment({ issue: 99, executorId: idB, branch: 'arena/agent-b', takenAt: min(-200), ttlMinutes: 90 });
const staleEvents = parseMarkerEvents([{ body: staleComment, created_at: min(-200) }]);
const staleState = resolveIssueClaims(staleEvents, { issue: 99 });
check('состояние: истёкший claim — STALE, а не CLAIMED', staleState.holders.length === 0 && staleState.stale.length === 1);
check('состояние: TTL по умолчанию — 90 минут', DEFAULT_TTL_MINUTES === 90);

/* Решения по взятию: свободно / своё / чужое / истёкшее */
check('решение: свободный Issue — acquire', claimDecision({ events: [], issue: 99, executorId: idA }).action === 'acquire');
check('решение: свой активный claim — refresh',
  claimDecision({ events, issue: 99, executorId: idA }).action === 'refresh');
const conflict = claimDecision({ events, issue: 99, executorId: idB });
check('решение: чужой активный claim — conflict с указанием владельца',
  conflict.action === 'conflict' && conflict.holder.executorId === idA, conflict.action);
check('решение: истёкший claim — takeover-stale (не молчаливый захват)',
  claimDecision({ events: staleEvents, issue: 99, executorId: idA }).action === 'takeover-stale');
check('очередь: статусы CLAIMED / STALE / FREE различаются', (() => {
  const rows = summarizeQueue([{ number: 1 }, { number: 2 }, { number: 3 }], [
    ...events.map(e => ({ ...e, issue: 1 })),
    ...staleEvents.map(e => ({ ...e, issue: 2 }))
  ]);
  return rows[0].state === 'CLAIMED' && rows[1].state === 'STALE' && rows[2].state === 'FREE';
})());

/* ═══ 3. Карточки ═══ */
const card = buildCard({ issue: 99, executorId: idA, branch: 'arena/agent-a', ttlMinutes: 90 });
check('карточка: схема валидна', validateCard(card).length === 0, validateCard(card).join('; '));
check('карточка: release сохраняет историю (state=released)',
  validateCard(releaseCard(card, { at: Date.now(), reason: 'готово' })).length === 0
  && releaseCard(card).state === 'released');
check('карточка (негатив): чужая схема/битые даты отклоняются', (() => {
  const bad = [
    { ...card, schema: 'other/v9' },
    { ...card, executor: 'EXEC-коротко' },
    { ...card, expires_at: 'не-дата' },
    { ...card, state: 'active', released_at: undefined, taken_at: card.expires_at, expires_at: card.taken_at }
  ];
  return bad.every(b => validateCard(b).length > 0);
})());
const conflictCard = buildCard({ issue: 99, executorId: idB, branch: 'arena/agent-b' });
check('карточки (негатив): два активных владельца одного Issue — конфликт',
  findCardConflicts([card, conflictCard]).length === 1 && findCardConflicts([card, conflictCard])[0].issue === 99);
check('карточки: released и истёкшие не считаются конфликтом',
  findCardConflicts([releaseCard(card), conflictCard]).length === 0
  && findCardConflicts([{ ...card, expires_at: min(-5) }, conflictCard]).length === 0);

/* ═══ 4. CLI целиком (fake gh + изолированный root) ═══ */
const tmp = mkdtempSync(join(tmpdir(), 'exec-claims-'));
const fakeGh = join(tmp, 'fake-gh.mjs');
const stateFile = join(tmp, 'state.json');
const postsFile = join(tmp, 'posts.jsonl');
const rootDir = join(tmp, 'repo');
mkdirSync(rootDir, { recursive: true });
writeFileSync(stateFile, JSON.stringify({ comments: {}, recent: [], issues: [] }));
writeFileSync(postsFile, '');
writeFileSync(fakeGh, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const main = async () => {
  const args = process.argv.slice(2);
  const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
  const respond = v => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
  if (args[0] === 'api') {
    const url = args[1] || '';
    const m = url.match(/\\/issues\\/(\\d+)\\/comments/);
    if (m) respond(state.comments?.[m[1]] || []);
    if (/\\/issues\\/comments/.test(url)) respond(state.recent || []);
    respond([]);
  }
  if (args[0] === 'issue' && args[1] === 'list') respond(state.issues || []);
  if (args[0] === 'issue' && args[1] === 'comment') {
    if (process.env.FAKE_GH_FAIL_COMMENT === '1') {
      process.stderr.write('Resource not accessible by integration (HTTP 403)\\n');
      process.exit(1);
    }
    let body = '';
    for await (const chunk of process.stdin) body += chunk;
    appendFileSync(process.env.FAKE_GH_POSTS, JSON.stringify({ issue: Number(args[2]), body }) + '\\n');
    process.stdout.write('https://github.com/test/repo/issues/' + args[2] + '#issuecomment-1\\n');
    process.exit(0);
  }
  process.stderr.write('fake gh: не поддержано: ' + args.join(' ') + '\\n');
  process.exit(1);
};
main();
`);
chmodSync(fakeGh, 0o755);

const git = args => spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
git(['init', '-q']);
git(['config', 'user.email', 'exec@test.invalid']);
git(['config', 'user.name', 'Exec Test']);

const setState = state => writeFileSync(stateFile, JSON.stringify(state));
const readPosts = () => readFileSync(postsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const readCard = (issue, id) => JSON.parse(readFileSync(join(rootDir, CARD_DIR, `issue-${issue}.EXEC-${id}.json`), 'utf8'));
const runClaim = (args, { seed = 'branch:arena/agent-a', gh = fakeGh } = {}) => {
  const r = spawnSync('node', [join(ROOT, 'tools', 'claim.mjs'), ...args, '--root', rootDir, '--branch', 'arena/agent-a'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, EXECUTOR_SEED: seed, CLAIM_GH: gh, CLAIM_REPO: 'test/repo', FAKE_GH_STATE: stateFile, FAKE_GH_POSTS: postsFile }
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

try {
  const idRun = runClaim(['id', '--json']);
  check('CLI id: печатает EXEC-… и JSON', idRun.code === 0 && idRun.out.includes(`EXEC-${idA}`), idRun.out.trim().split('\n')[0]);

  const statusFree = runClaim(['status', '--json']);
  const statusFreeJson = statusFree.code === 0 && statusFree.out.trim().startsWith('{') ? JSON.parse(statusFree.out) : null;
  check('CLI status (нет маркеров): FREE и exit 0',
    !!statusFreeJson && statusFreeJson.remote === 'OK' && (statusFreeJson.rows || []).every(r => r.state === 'FREE'),
    statusFreeJson ? `${statusFreeJson.remote}: ${String(statusFreeJson.reason || 'ок').slice(0, 100)}` : `exit=${statusFree.code} ${statusFree.err.trim().slice(0, 100)}`);

  const offline = runClaim(['status', '--json'], { gh: join(tmp, 'нет-такого-gh') });
  const offlineJson = offline.code === 0 && offline.out.trim().startsWith('{') ? JSON.parse(offline.out) : null;
  check('CLI status (GitHub недоступен): UNKNOWN и ни одного «FREE» (пин §6.15)',
    offlineJson?.remote === 'UNKNOWN' && offlineJson.rows === undefined,
    offlineJson ? `remote=${offlineJson.remote}, rows=${typeof offlineJson.rows}` : `exit=${offline.code}`);

  const takeOffline = runClaim(['take', '101'], { gh: join(tmp, 'нет-такого-gh') });
  check('CLI take (нет GitHub, без --offline-ok): отказ exit 3, карточка НЕ создана',
    takeOffline.code === 3 && !existsSync(join(rootDir, CARD_DIR, `issue-101.EXEC-${idA}.json`)));

  // Интеграция без права комментировать Issues (реальная ситуация этой сессии,
  // HTTP 403): claim без публичного маркера — блокер, а не «почти успех».
  const noComment = spawnSync('node', [join(ROOT, 'tools', 'claim.mjs'), 'take', '103', '--root', rootDir, '--branch', 'arena/agent-a'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, EXECUTOR_SEED: 'branch:arena/agent-a', CLAIM_GH: fakeGh, CLAIM_REPO: 'test/repo', FAKE_GH_STATE: stateFile, FAKE_GH_POSTS: postsFile, FAKE_GH_FAIL_COMMENT: '1' }
  });
  check('CLI take (нет права комментировать): блокер exit 4, а не тихий успех',
    noComment.status === 4 && /БЛОКЕР/.test(noComment.stdout || '') && /не опубликован/.test(noComment.stdout || ''),
    `exit=${noComment.status} out=${(noComment.stdout || '').trim().slice(0, 160)}`);
  const noCommentJsonRun = spawnSync('node', [join(ROOT, 'tools', 'claim.mjs'), 'take', '103', '--json', '--root', rootDir, '--branch', 'arena/agent-a'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, EXECUTOR_SEED: 'branch:arena/agent-a', CLAIM_GH: fakeGh, CLAIM_REPO: 'test/repo', FAKE_GH_STATE: stateFile, FAKE_GH_POSTS: postsFile, FAKE_GH_FAIL_COMMENT: '1' }
  });
  const noCommentJson = (noCommentJsonRun.stdout || '').trim().startsWith('{') ? JSON.parse(noCommentJsonRun.stdout) : null;
  check('CLI take (нет права комментировать): машинный код CLAIM_NOT_PUBLISHED',
    noCommentJsonRun.status === 4 && noCommentJson?.code === 'CLAIM_NOT_PUBLISHED',
    `exit=${noCommentJsonRun.status}, code=${noCommentJson?.code ?? 'нет JSON'}`);
  check('CLI take (нет права комментировать): карточка сохранена как локальная запись',
    existsSync(join(rootDir, CARD_DIR, `issue-103.EXEC-${idA}.json`)));

  const unpublishedStatus = runClaim(['status', '--json']);
  const unpublishedJson = unpublishedStatus.out.trim().startsWith('{') ? JSON.parse(unpublishedStatus.out) : null;
  check('CLI status: неопубликованный claim виден как риск дубля (unpublished)',
    (unpublishedJson?.unpublished || []).some(u => u.issue === 103 && u.executor === `EXEC-${idA}`),
    JSON.stringify(unpublishedJson?.unpublished ?? null));

  const take1 = runClaim(['take', '101']);
  const card1 = existsSync(join(rootDir, CARD_DIR, `issue-101.EXEC-${idA}.json`)) ? readCard(101, idA) : null;
  const posts1 = readPosts();
  check('CLI take: exit 0, карточка валидна и закоммичена с трейлером',
    take1.code === 0 && card1 && validateCard(card1).length === 0
    && git(['log', '-1', '--pretty=%B']).stdout.includes(`Executor: EXEC-${idA}`), card1 ? card1.state : 'нет карточки');
  check('CLI take: CLAIM опубликован в Issue с маркером и ID',
    posts1.length === 1 && posts1[0].issue === 101 && posts1[0].body.includes('executor-claim v1') && posts1[0].body.includes(`EXEC-${idA}`));

  setState({ comments: { 101: [{ body: posts1[0].body, created_at: new Date().toISOString() }] }, recent: [], issues: [{ number: 101, title: 'Занятый Issue' }] });
  const takeForeign = runClaim(['take', '101'], { seed: 'branch:arena/agent-b' });
  check('CLI take (чужой активный claim): conflict exit 2, второй карточки нет',
    takeForeign.code === 2 && /держит EXEC-/.test(takeForeign.out)
    && !existsSync(join(rootDir, CARD_DIR, `issue-101.EXEC-${idB}.json`)), takeForeign.out.trim().split('\n')[0]);

  const refresh = runClaim(['take', '101']);
  check('CLI take (свой claim): продление (exit 0), без второй карточки',
    refresh.code === 0 && readPosts().filter(p => p.issue === 101).length === 2
    && readdirSync(join(rootDir, CARD_DIR)).filter(f => f.startsWith('issue-101.')).length === 1);

  const staleBody = buildClaimComment({ issue: 102, executorId: idB, branch: 'arena/agent-b', takenAt: min(-200), ttlMinutes: 90 });
  setState({
    comments: { 102: [{ body: staleBody, created_at: min(-200) }] },
    recent: [{ body: staleBody, created_at: min(-200) }],
    issues: [{ number: 101, title: 'Занятый Issue' }, { number: 102, title: 'Заброшенный Issue' }]
  });
  const staleNoForce = runClaim(['take', '102']);
  check('CLI take (истёкший claim без --force): отказ exit 2 (нет молчаливого захвата)', staleNoForce.code === 2, staleNoForce.out.trim().split('\n')[0]);
  const staleForce = runClaim(['take', '102', '--force', '--reason', 'исполнитель не отвечает']);
  const card102 = existsSync(join(rootDir, CARD_DIR, `issue-102.EXEC-${idA}.json`)) ? readCard(102, idA) : null;
  check('CLI take (--force + причина): перехват с записью handover_from',
    staleForce.code === 0 && card102?.handover_from === `EXEC-${idB}`, card102?.handover_from || 'нет карточки');

  // Негативный контроль: два исполнителя одновременно держат один Issue
  // (например, CLAIM ушёл в момент потери канала). Status обязан быть красным.
  const dupA = buildClaimComment({ issue: 101, executorId: idA, branch: 'arena/agent-a', takenAt: min(-5), ttlMinutes: 90 });
  const dupB = buildClaimComment({ issue: 101, executorId: idB, branch: 'arena/agent-b', takenAt: min(-3), ttlMinutes: 90 });
  setState({
    comments: { 101: [{ body: dupA, created_at: min(-5) }, { body: dupB, created_at: min(-3) }] },
    recent: [{ body: dupA, created_at: min(-5) }, { body: dupB, created_at: min(-3) }],
    issues: [{ number: 101, title: 'Двойной захват' }]
  });
  const conflictStatus = runClaim(['status', '--json']);
  const conflictJson = conflictStatus.out.trim().startsWith('{') ? JSON.parse(conflictStatus.out) : null;
  check('CLI status (негатив): двойной захват Issue = CONFLICT и exit 2',
    conflictStatus.code === 2 && (conflictJson?.remote_conflicts || []).some(c => c.issue === 101 && c.executors.length === 2),
    `exit=${conflictStatus.code}, conflicts=${JSON.stringify(conflictJson?.remote_conflicts ?? null)}`);
  const conflictText = runClaim(['status']);
  check('CLI status (негатив): человекочитаемый вывод называет конфликт', conflictText.code === 2 && /CONFLICT \(удалённо\)/.test(conflictText.out));

  writeFileSync(join(rootDir, 'change.txt'), 'изменение\n');
  git(['add', 'change.txt']);
  const commitRun = runClaim(['commit', '-m', 'feat: проверка трейлера']);
  check('CLI commit: добавляет трейлер исполнителя',
    commitRun.code === 0 && git(['log', '-1', '--pretty=%B']).stdout.includes(`Executor: EXEC-${idA}`), commitRun.out.trim().split('\n')[0]);

  const releaseRun = runClaim(['release', '101']);
  const card1released = existsSync(join(rootDir, CARD_DIR, `issue-101.EXEC-${idA}.json`)) ? readCard(101, idA) : null;
  const postsNow = readPosts();
  check('CLI release: карточка released + RELEASE-маркер опубликован',
    releaseRun.code === 0 && card1released?.state === 'released' && validateCard(card1released).length === 0
    && postsNow.some(p => p.body.includes('RELEASE') && p.issue === 101));
  check('CLI release: после освобождения Issue снова свободен',
    claimDecision({ events: parseMarkerEvents(postsNow.map(p => ({ body: p.body, created_at: new Date().toISOString() }))), issue: 101, executorId: idB }).action === 'acquire');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/* ═══ 5. Карточки самой ветки (гейт: валидность и отсутствие конфликтов) ═══ */
const repoCardsDir = join(ROOT, CARD_DIR);
const repoCards = existsSync(repoCardsDir)
  ? readdirSync(repoCardsDir).filter(f => f.endsWith('.json')).map(f => {
    try { return JSON.parse(readFileSync(join(repoCardsDir, f), 'utf8')); }
    catch { return { schema: 'broken', file: f }; }
  })
  : [];
const repoCardErrors = repoCards.flatMap(c => validateCard(c).map(e => `${c.file || c.executor}: ${e}`));
const repoConflicts = findCardConflicts(repoCards);
check('ветка: все карточки .claims/*.json валидны', repoCardErrors.length === 0, repoCardErrors.join('; ') || `карточек: ${repoCards.length}`);
check('ветка: нет двух активных владельцев одного Issue', repoConflicts.length === 0,
  repoConflicts.map(c => `#${c.issue}: ${c.executors.join(', ')}`).join('; ') || `карточек: ${repoCards.length}`);
if (repoCards.length === 0) console.log('   · примечание: карточек в ветке пока нет — проверка станет содержательной после первого claim');

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : `\nALL PASS (${results.length})`);
process.exit(failed ? 1 : 0);
