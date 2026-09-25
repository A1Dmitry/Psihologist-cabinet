#!/usr/bin/env node
/**
 * Reload-паритет жизненного цикла локального снапшота кабинета — регрессия #67 TASK 1.
 *
 *   node tests/db-snapshot-parity.mjs
 *
 * Fail-before-fix. На main @ `b0313e8` (до PR #77) проверки 1–4 и 6 падали:
 *  - `_load()` не восстанавливал tasks/notes/clientEntries, а конструктор их не
 *    инициализировал → первая же перезагрузка с непустым хранилищем оставляла
 *    их `undefined` → `tasksOf()/notesOf()/entriesOf()` бросали
 *    `Cannot read properties of undefined (reading 'filter')` (красный баннер);
 *  - `JSON.stringify` отбрасывал `undefined`, и любое сохранение зтирало ключи
 *    коллекций из снапшота (потеря локального зеркала);
 *  - `cabinetApi.applyPull()` падал на `.filter()` до применения
 *    notes/entries/waiting/settings — серверное восстановление молча
 *    применялось частично.
 * Проверка 6 (static single-source) не давала бы reintroduce три вручную
 * синхронизируемых списка коллекций — корневую причину W5.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_KEY = 'psy_portal_cf_v5';

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

// ——— Детерминированный localStorage (память вместо браузера) ———
const backing = new Map();
globalThis.localStorage = {
  getItem: k => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: k => backing.delete(k)
};
const snap = () => JSON.parse(backing.get(STORAGE_KEY));
const COLL = ['psychologists','emailCodes','services','clients','sessions','payments','waitingItems',
  'settings','bookingAttempts','clientRisks','reminders','scheduleBlocks','scheduleOverrides',
  'tasks','notes','clientEntries'];

// ——— 1) boot(seed) → добавить задачи/заметки/журнал → save → reload → всё на месте ———
const m1 = await import(join(ROOT, 'js/core/dbContext.js') + '?boot=1');
const db1 = new m1.DbContext();
const psy = db1.psychologists[0];
db1.addTask({ psychologistId: psy.id, title: 'T-67', details: '', dueDate: '2026-09-30', clientId: null, done: false });
db1.addNote({ psychologistId: psy.id, title: 'N-67', body: 'note body', date: '2026-09-25', pinned: false });
db1.addClientEntry({ psychologistId: psy.id, clientId: db1.clients[0]?.id ?? null, sessionId: null, date: '2026-09-25', text: 'entry text' });
db1.saveChanges();
const s1 = snap();
check('1a. снапшот содержит ключи tasks/notes/clientEntries',
  ['tasks','notes','clientEntries'].every(k => Array.isArray(s1[k]) && s1[k].length === 1),
  JSON.stringify(Object.keys(s1)));
check('1b. снапшот содержит все 16 ключей коллекций',
  COLL.every(k => k in s1), Object.keys(s1).join(','));

// reload: новый модульный инстанс поверх того же хранилища
const m2 = await import(join(ROOT, 'js/core/dbContext.js') + '?boot=2');
const db2 = new m2.DbContext();
check('2a. после reload коллекции — массивы, не undefined',
  COLL.every(k => Array.isArray(db2[k])),
  COLL.filter(k => !Array.isArray(db2[k])).map(k => `${k}=${String(db2[k])}`).join(','));
const len = a => (Array.isArray(a) ? a.length : String(a));
check('2b. данные пользователя переживают reload (tasks/notes/clientEntries по 1)',
  len(db2.tasks) === 1 && len(db2.notes) === 1 && len(db2.clientEntries) === 1
    && db2.tasks?.[0]?.title === 'T-67',
  `lens=${len(db2.tasks)}/${len(db2.notes)}/${len(db2.clientEntries)} ` + JSON.stringify(db2.tasks?.[0] ?? null));
check('2c. восстановленные записи — экземпляры доменных классов, а не plain-объекты',
  db2.tasks?.[0]?.constructor.name === 'Task'
    && db2.notes?.[0]?.constructor.name === 'PsyNote'
    && db2.clientEntries?.[0]?.constructor.name === 'ClientEntry',
  [db2.tasks?.[0], db2.notes?.[0], db2.clientEntries?.[0]].map(x => x?.constructor?.name).join(','));
let threw = null;
try { db2.tasksOf(psy.id); db2.notesOf(psy.id); db2.entriesOf(psy.id); } catch (e) { threw = e.message; }
check('2d. tasksOf/notesOf/entriesOf не бросают после reload (баннер #67 не появится)',
  threw === null, String(threw));
db2.saveChanges();
const s2 = snap();
check('2e. повторный saveChanges НЕ затирает ключи коллекций из снапшота',
  ['tasks','notes','clientEntries'].every(k => Array.isArray(s2[k]) && s2[k].length === 1),
  JSON.stringify({ tasks: s2.tasks, notes: s2.notes, clientEntries: s2.clientEntries }));

// ——— 3) Legacy-снапшот без ключей (W3: непустое хранилище старого формата) ———
const legacy = { ...s1 };
delete legacy.tasks; delete legacy.notes; delete legacy.clientEntries;
backing.set(STORAGE_KEY, JSON.stringify(legacy));
const m3 = await import(join(ROOT, 'js/core/dbContext.js') + '?boot=3');
const db3 = new m3.DbContext();
check('3a. загрузка снапшота без tasks/notes/clientEntries: коллекции — массивы',
  Array.isArray(db3.tasks) && Array.isArray(db3.notes) && Array.isArray(db3.clientEntries),
  `tasks=${String(db3.tasks)} notes=${String(db3.notes)} entries=${String(db3.clientEntries)}`);
let threw3 = null;
try { db3.tasksOf(psy.id); } catch (e) { threw3 = e.message; }
check('3b. tasksOf на legacy-снапшоте возвращает [] без исключения', threw3 === null && db3.tasksOf(psy.id).length === 0, String(threw3));

// ——— 4) applyPull при повреждённом локальном зеркале (W4) ———
{
  const { db } = await import(join(ROOT, 'js/core/dbContext.js'));
  const { cabinetApi } = await import(join(ROOT, 'js/services/cabinetApi.js'));
  db.tasks = undefined; db.notes = undefined; db.clientEntries = undefined;
  db.waitingItems = undefined; db.settings = undefined;
  let threwPull = null;
  try {
    cabinetApi.applyPull(psy.id, {
      ok: true, clients: [], sessions: [], blocks: [], overrides: [],
      tasks: [{ id: 'srv_t1', psychologistId: psy.id, title: 'server task', dueDate: '', done: false, createdAt: null }],
      notes: [{ id: 'srv_n1', psychologistId: psy.id, title: 'sn', body: 'b', date: '2026-09-25', pinned: false, createdAt: null }],
      entries: [{ id: 'srv_e1', psychologistId: psy.id, clientId: null, sessionId: null, date: '2026-09-25', text: 'e', createdAt: null }],
      waiting: [], settings: null
    });
  } catch (e) { threwPull = `${e.constructor.name}: ${e.message}`; }
  check('4a. applyPull не падает при undefined-коллекциях и применяет серверные rows',
    threwPull === null && Array.isArray(db.tasks) && db.tasks.length === 1
      && Array.isArray(db.notes) && db.notes.length === 1
      && Array.isArray(db.clientEntries) && db.clientEntries.length === 1,
    String(threwPull) + ' ' + JSON.stringify({ t: db.tasks?.length, n: db.notes?.length, e: db.clientEntries?.length }));
  db.saveChanges();
  check('4b. snapshot после восстановительного pull содержит все 16 коллекций',
    COLL.every(k => Array.isArray(snap()[k])),
    COLL.filter(k => !Array.isArray(snap()[k])).join(','));
}

// ——— 5) Инвариант паритета: ключи _snapshot() == набор коллекций экземпляра ———
{
  const m5 = await import(join(ROOT, 'js/core/dbContext.js') + '?boot=5');
  const db5 = new m5.DbContext();
  const sKeys = Object.keys(db5._snapshot()).filter(k => k !== 'currentPsychologistId').sort();
  const iKeys = Object.keys(db5).filter(k => Array.isArray(db5[k])).sort();
  check('5. _snapshot() и экземпляр описывают один и тот же набор коллекций (паритет ключей)',
    sKeys.join('|') === iKeys.join('|'),
    `snapshot-only: ${sKeys.filter(k => !iKeys.includes(k))} | instance-only: ${iKeys.filter(k => !sKeys.includes(k))}`);
}

// ——— 6) Single-source (Poka-Yoke W5): список коллекций задан один раз ———
{
  const src = readFileSync(join(ROOT, 'js/core/dbContext.js'), 'utf8');
  const loadBody = /_load\(\)\s*\{([\s\S]*?)\n  \}/.exec(src)?.[1] ?? '';
  const snapBody = /_snapshot\(\)\s*\{([\s\S]*?)\n  \}/.exec(src)?.[1] ?? '';
  check('6a. _load()/ _snapshot() работают через манифест SNAPSHOT_COLLECTIONS, без per-collection-строк',
    /SNAPSHOT_COLLECTIONS/.test(loadBody) && /SNAPSHOT_COLLECTIONS/.test(snapBody)
      && !/data\.(tasks|notes|clientEntries|sessions)\b/.test(loadBody)
      && !/^\s*\w+:\s*this\.\w+,\s*$/m.test(snapBody),
    'обнаружены ручные списки коллекций — риск рассинхрона как в #67');
  const seedReset = /resetToSeed\(\)\s*\{([\s\S]*?)\n  \}/.exec(src)?.[1] ?? '';
  check('6b. resetToSeed сбрасывает коллекции тем же манифестом',
    /SNAPSHOT_COLLECTIONS/.test(seedReset) && !/this\.(tasks|notes)\s*=\s*\[\]/.test(seedReset));
  check('6c. STORAGE_KEY не менялся (совместимость с существующими данными пользователей)',
    /const STORAGE_KEY = 'psy_portal_cf_v5';/.test(src));
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'}: ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
