#!/usr/bin/env node
/**
 * Сходимость supabase/schema.sql — применение к «грязному» проду.
 *
 *   node tests/schema-convergence.mjs
 *
 * Зачем отдельный набор (issue #46, TASK 1/5):
 *   владелец применяет схему НЕ к пустой БД, а к проду, где живёт более ранняя
 *   генерация объектов (см. docs/ISSUE-46-EVIDENCE.md §2). Опасный случай —
 *   RPC: `create or replace function` при другой арности не заменяет функцию,
 *   а создаёт ВТОРУЮ с тем же именем. Схема при этом применяется «без ошибок»,
 *   а PostgREST перестаёт резолвить вызов (PGRST203) или резолвит не ту версию:
 *   прод остаётся сломанным при зелёной миграции.
 *
 *   Набор поднимает настоящий PostgreSQL, создаёт заведомо чужие перегрузки и
 *   проверяет, что повторное применение схемы схлопывает их в одну каноническую
 *   сигнатуру, восстанавливает гранты и не дублирует RLS-политики.
 */
import { startTestDatabaseOrExit, finishSuite } from '../tools/dbtest/index.mjs';

let teardownNoise = false;
const isTeardownNoise = (e) => /terminating connection|57P01/.test(String(e?.message || e));
process.on('uncaughtException', (e) => {
  if (isTeardownNoise(e)) { teardownNoise = true; return; }
  console.error(e);
  process.exitCode = 1;
});
process.on('unhandledRejection', (e) => {
  if (isTeardownNoise(e)) { teardownNoise = true; return; }
  console.error(e);
  process.exitCode = 1;
});

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const db = await startTestDatabaseOrExit({ port: Number(process.env.DB_PORT || 55436) });

/** Все сигнатуры функции в public. */
const signatures = async (name) => (await db.query(
  `select pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1`, [name]
)).map(r => r.args);

const arity = (sig) => (sig.trim() === '' ? 0 : sig.split(',').length);

try {
  /* ========================================================================
   * 0. Исходное состояние: каноническая сигнатура одна
   * ====================================================================== */
  const cb0 = await signatures('create_booking');
  const cl0 = await signatures('claim_psychologist_profile');
  check('до: create_booking — ровно одна сигнатура', cb0.length === 1, JSON.stringify(cb0));
  check('до: create_booking — 22 аргумента', cb0.length === 1 && arity(cb0[0]) === 22, cb0[0] || '');
  check('до: claim_psychologist_profile — одна сигнатура (6 аргументов)',
    cl0.length === 1 && arity(cl0[0]) === 6, JSON.stringify(cl0));

  /* ========================================================================
   * 1. «Грязный прод»: чужие перегрузки, которых нет в истории репозитория
   * ====================================================================== */
  // DDL — от суперпользователя (pool), а не от PostgREST-роли: у service_role
  // в обвязке есть USAGE на схему public, но нет CREATE (как и в проде).
  await db.pool.query(`
    create function public.create_booking(
      p_psychologist_id text, p_service_id text, p_session_date text,
      p_session_time text, p_client_name text
    ) returns jsonb language sql as $$ select '{"ok":false,"error":"legacy"}'::jsonb $$;

    create function public.claim_psychologist_profile(
      p_email text, p_full_name text, p_phone text
    ) returns jsonb language sql as $$ select '{"ok":false,"error":"legacy"}'::jsonb $$;
  `);
  const cbDirty = await signatures('create_booking');
  const clDirty = await signatures('claim_psychologist_profile');
  check('грязный прод: перегрузка create_booking создана (2 сигнатуры)',
    cbDirty.length === 2, JSON.stringify(cbDirty));
  check('грязный прод: перегрузка claim_psychologist_profile создана (2 сигнатуры)',
    clDirty.length === 2, JSON.stringify(clDirty));

  /* ========================================================================
   * 2. Повторное применение схемы схлопывает перегрузки
   * ====================================================================== */
  await db.applySchema();
  check('схема применилась повторно без ошибок', true);

  const cb1 = await signatures('create_booking');
  const cl1 = await signatures('claim_psychologist_profile');
  check('после: create_booking — снова ОДНА сигнатура', cb1.length === 1, JSON.stringify(cb1));
  check('после: create_booking — канонические 22 аргумента',
    cb1.length === 1 && arity(cb1[0]) === 22, cb1[0] || '');
  check('после: claim_psychologist_profile — снова ОДНА сигнатура',
    cl1.length === 1 && arity(cl1[0]) === 6, JSON.stringify(cl1));
  const helper = await signatures('is_active_own_psychologist');
  check('после: is_active_own_psychologist — одна сигнатура',
    helper.length === 1 && arity(helper[0]) === 1, JSON.stringify(helper));

  /* ========================================================================
   * 3. Гранты после повторного применения (иначе RPC есть, но не вызвать)
   * ====================================================================== */
  // 6 именованных аргументов — как в db-contract и как шлёт клиент: при меньшем
  // числе node-pg отдаёт параметры без типа, и PostgreSQL не резолвит вызов
  // (это артефакт драйвера, а не схемы).
  const anonCall = await db.rpc('create_booking', {
    p_psychologist_id: '__probe__', p_service_id: null,
    p_session_date: '1900-01-01', p_session_time: '00:00',
    p_client_name: 'Probe', p_client_phone: '+375290000000'
  }, { role: 'anon', uid: null });
  check('после: anon может вызвать create_booking (грант восстановлен)',
    anonCall?.ok === false && /прошлое|не найден/i.test(anonCall?.error || ''),
    JSON.stringify(anonCall));

  // Гранты — по pg_proc.proacl: information_schema.routine_privileges их НЕ
  // показывает (фильтруется по текущему пользователю) и даёт ложную картину.
  const acl = (await db.query(`
    select p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_booking','claim_psychologist_profile')`))
    .reduce((acc, r) => ({ ...acc, [r.proname]: r }), {});
  check('после: create_booking — EXECUTE у anon и authenticated',
    acl.create_booking?.anon_exec === true && acl.create_booking?.auth_exec === true,
    JSON.stringify(acl.create_booking));
  check('после: claim_psychologist_profile — EXECUTE только у authenticated',
    acl.claim_psychologist_profile?.anon_exec === false
      && acl.claim_psychologist_profile?.auth_exec === true,
    JSON.stringify(acl.claim_psychologist_profile));

  let claimErr = null;
  try {
    await db.rpc('claim_psychologist_profile', {
      p_email: 'x@example.by', p_full_name: 'X', p_phone: '',
      p_specialization: '', p_city: '', p_about: ''
    }, { role: 'anon', uid: null });
  } catch (e) {
    claimErr = String(e.message || e);
  }
  check('после: вызов claim от anon отклонён на уровне гранта',
    /permission denied for function/.test(claimErr || ''), claimErr || 'вызов прошёл');

  /* ========================================================================
   * 4. RLS-политики не дублируются повторным применением
   * ====================================================================== */
  const policies = await db.query(`
    select c.relname, count(*) as n
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace nn on nn.oid = c.relnamespace
    where nn.nspname = 'public' and p.polname like 'owner\\_%'
    group by c.relname order by c.relname`);
  check('после: у каждой таблицы ровно по одному комплекту owner-политик',
    policies.length > 0 && policies.every(r => r.n <= 4),
    JSON.stringify(policies));
  const dupes = await db.query(`
    select c.relname, p.polname, count(*) as n
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace nn on nn.oid = c.relnamespace
    where nn.nspname = 'public'
    group by c.relname, p.polname having count(*) > 1`);
  check('после: дублей политик нет', dupes.length === 0, JSON.stringify(dupes));

  /* ========================================================================
   * 5. Идемпотентность: третье применение ничего не ломает
   * ====================================================================== */
  await db.applySchema();
  const cb2 = await signatures('create_booking');
  check('третье применение: create_booking по-прежнему один (идемпотентность)',
    cb2.length === 1 && arity(cb2[0]) === 22, JSON.stringify(cb2));

  /* ========================================================================
   * 6. Ровно то, что делает владелец в Блоке 2: схема ЦЕЛИКОМ + seed, повторно
   * ====================================================================== */
  await db.applySchema({ seed: true });
  await db.applySchema({ seed: true });
  const psyCount = await db.count('psychologists', `where id = 'psy_catalog_19'`);
  check('seed повторно: референс-профиль ровно один (on conflict)', psyCount === 1, String(psyCount));
  const svcDupes = await db.query(`
    select id, count(*) n from services group by id having count(*) > 1`);
  check('seed повторно: дублей услуг нет', svcDupes.length === 0, JSON.stringify(svcDupes));
  const cbAfterSeed = await signatures('create_booking');
  check('seed повторно: create_booking по-прежнему один',
    cbAfterSeed.length === 1 && arity(cbAfterSeed[0]) === 22, JSON.stringify(cbAfterSeed));

  // и функционально: полный путь записи после всех пере применений
  const uid = await db.createAuthUser('conv@example.by');
  const claim = await db.rpc('claim_psychologist_profile', {
    p_email: 'conv@example.by', p_full_name: 'Convergence Test'
  }, { uid });
  check('после миграции: claim работает и возвращает owner_id = auth.uid()',
    claim?.ok === true && claim.owner_id === uid, JSON.stringify(claim));
} catch (e) {
  results.push(['FATAL: suite crashed: ' + (e?.message || e), false]);
  console.error('FATAL:', e);
} finally {
  await db.stop();
}

const failed = results.filter(r => !r[1]).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
if (teardownNoise) console.log('(шум остановки PostgreSQL проигнорирован: 57P01 на закрытии соединения)');
await finishSuite(failed);
