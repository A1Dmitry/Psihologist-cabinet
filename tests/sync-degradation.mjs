#!/usr/bin/env node
/**
 * Деградация публичной синхронизации при частично применённой схеме.
 *
 *   node tests/sync-degradation.mjs
 *
 * Повод — живой прод (issue #46, консоль владельца, 2026-09-25):
 *   GET /rest/v1/public_schedule_overrides?psychologist_id=eq.psy_catalog_19 → 404
 *   GET /rest/v1/public_schedule_overrides?psychologist_id=eq.psy_a1dmitry  → 404
 * Каталог при этом грузится нормально (2 профиля), поэтому UI считает, что
 * «всё работает», а слой D1 в базе отсутствует.
 *
 * Проверяется поведение боевого `supabaseSync.pullAll()` (подменён только
 * транспорт supabaseApi, сети нет):
 *  1. недоступный слой НЕ молчит: возвращается `degraded` с relation + HTTP
 *     статусом + кодом PostgREST и печатается один warn с лечением;
 *  2. устаревшие строки недоступного слоя не переживают перезагрузку
 *     (localStorage-кэш закрытого дня не закрывает дату навсегда);
 *  3. сбой по одному специалисту не вычищает данные другого;
 *  4. здоровый сервер → degraded пуст, warn не печатается.
 */
import { db } from '../js/core/dbContext.js';
import { supabaseApi } from '../js/services/supabaseApi.js';
import { supabaseSync } from '../js/services/supabaseSync.js';
import { ScheduleBlock, ScheduleOverride } from '../js/models/entities.js';

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const PSY_A = 'psy_catalog_19'; // как в проде
const PSY_B = 'psy_a1dmitry';

// --- транспортные стабы (PostgREST-форма; сети нет) ---
const orig = {
  listPsychologists: supabaseApi.listPsychologists,
  listServices: supabaseApi.listServices,
  listBusyBlocks: supabaseApi.listBusyBlocks,
  listOverrides: supabaseApi.listOverrides,
  getSettings: supabaseApi.getSettings
};
let overridesMode = 'ok';   // 'ok' | '404' | '404-for-A'
let blocksMode = 'ok';      // 'ok' | '404'
let settingsMode = 'ok';    // 'ok' | '404'

const notFound = (relation) => new Error(
  `Supabase 404: {"code":"PGRST205","details":null,"hint":null,`
  + `"message":"Could not find the table 'public.${relation}' in the schema cache"}`
);

supabaseApi.listPsychologists = async () => ([
  { id: PSY_A, full_name: 'A', slug: 'a', is_active: true },
  { id: PSY_B, full_name: 'B', slug: 'b', is_active: true }
]);
supabaseApi.listServices = async () => ([]);
supabaseApi.listBusyBlocks = async () => {
  if (blocksMode === '404') throw notFound('public_schedule_blocks');
  return [];
};
supabaseApi.listOverrides = async (psyId) => {
  if (overridesMode === '404') throw notFound('public_schedule_overrides');
  if (overridesMode === '404-for-A' && psyId === PSY_A) throw notFound('public_schedule_overrides');
  return [{ psychologist_id: psyId, date: '2026-12-25', is_closed: true, open_from: '', open_to: '', title: 'Серверный' }];
};
supabaseApi.getSettings = async () => {
  if (settingsMode === '404') throw notFound('public_settings');
  return null;
};

// warn перехватываем: он часть контракта «не молчать»
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); };

const resetDb = () => {
  db.currentPsychologistId = null;
  db.scheduleOverrides = [
    new ScheduleOverride({ id: 'stale-a', psychologistId: PSY_A, date: '2026-10-01', isClosed: true, title: 'Кэш из localStorage' }),
    new ScheduleOverride({ id: 'stale-b', psychologistId: PSY_B, date: '2026-10-02', isClosed: true, title: 'Кэш из localStorage' })
  ];
  db.scheduleBlocks = [new ScheduleBlock({ id: 'stale-block', psychologistId: PSY_A, dateFrom: '2026-10-03', dateTo: '2026-10-03' })];
};

try {
  console.log('=== sync-degradation: pullAll при частично применённой схеме ===');

  // ---------- 1. слой недоступен (прод сегодня) ----------
  resetDb();
  warnings.length = 0;
  overridesMode = '404';
  blocksMode = '404';
  settingsMode = '404';
  const r1 = await supabaseSync.pullAll();
  const rel = new Set((r1.degraded || []).map(d => d.relation));

  check('pullAll не падает при отсутствующих слоях', r1.ok === true, JSON.stringify(r1));
  check('degraded: public_schedule_overrides назван', rel.has('public_schedule_overrides'), [...rel].join(','));
  check('degraded: HTTP-статус разобран', r1.degraded.find(d => d.relation === 'public_schedule_overrides')?.status === '404');
  check('degraded: код PostgREST разобран (PGRST205)',
    r1.degraded.find(d => d.relation === 'public_schedule_overrides')?.code === 'PGRST205');
  check('degraded: блокировки и настройки тоже видны',
    rel.has('public_schedule_blocks') && rel.has('public_settings'), [...rel].join(','));
  check('устаревший override не переживает 404 (кэш не закрывает дату навсегда)',
    db.scheduleOverrides.length === 0, JSON.stringify(db.scheduleOverrides.map(o => o.id)));
  check('устаревший блок занятости тоже сброшен', db.scheduleBlocks.length === 0);
  check('warn напечатан один раз на pullAll', warnings.length === 1, String(warnings.length));
  check('warn называет relation', /public_schedule_overrides/.test(warnings[0] || ''));
  check('warn даёт лечение (schema.sql)', /schema\.sql/.test(warnings[0] || ''));

  // ---------- 2. сбой только по одному специалисту ----------
  resetDb();
  warnings.length = 0;
  overridesMode = '404-for-A';
  blocksMode = 'ok';
  settingsMode = 'ok';
  const r2 = await supabaseSync.pullAll();
  const ids = db.scheduleOverrides.map(o => o.id || `${o.psychologistId}:${o.date}`);
  check('сбой по A не вычищает серверные данные B',
    db.scheduleOverrides.length === 1 && db.scheduleOverrides[0].psychologistId === PSY_B, ids.join(','));
  check('устаревшая строка A удалена, хотя упал только A',
    !db.scheduleOverrides.some(o => o.psychologistId === PSY_A && o.title === 'Кэш из localStorage'));
  check('частичный сбой тоже попадает в degraded',
    (r2.degraded || []).some(d => d.relation === 'public_schedule_overrides'));

  // ---------- 3. здоровый сервер ----------
  resetDb();
  warnings.length = 0;
  overridesMode = 'ok';
  const r3 = await supabaseSync.pullAll();
  check('здоровый сервер: degraded пуст', Array.isArray(r3.degraded) && r3.degraded.length === 0,
    JSON.stringify(r3.degraded));
  check('здоровый сервер: warn не печатается', warnings.length === 0, warnings.join('|'));
  check('здоровый сервер: overrides загружены по обоим специалистам',
    db.scheduleOverrides.length === 2
    && db.scheduleOverrides.every(o => o.title === 'Серверный'), JSON.stringify(db.scheduleOverrides));
  const r4 = await supabaseSync.pullAll();
  check('здоровый сервер: повторный pull не дублирует строки',
    r4.ok === true && db.scheduleOverrides.length === 2, String(db.scheduleOverrides.length));
} finally {
  console.warn = realWarn;
  Object.assign(supabaseApi, orig);
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'}: ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
