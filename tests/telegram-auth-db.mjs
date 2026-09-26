#!/usr/bin/env node
/** Real PostgreSQL contract for Telegram account provisioning and onboarding. */
import { startTestDatabaseOrExit, finishSuite } from '../tools/dbtest/index.mjs';
process.on('uncaughtException', error => { console.error(error); process.exitCode = 1; });
process.on('unhandledRejection', error => { console.error(error); process.exitCode = 1; });

const results = [];
const check = (name, condition, extra = '') => {
  results.push([name, !!condition]);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !extra ? '' : ` → ${extra}`}`);
};
let failed = 0;
const db = await startTestDatabaseOrExit({ port: Number(process.env.DB_PORT || 55437) });
try {
  await db.applySqlFile('supabase/migrations/20260926_telegram_miniapp_auth.sql');
  check('migration installs Telegram owner and replay tables', true);

  const telegramId = '287654321';
  const userId = await db.createAuthUser(`telegram-${telegramId}@telegram.invalid`, {
    meta: { provider: 'telegram', telegram_user_id: telegramId, full_name: 'Telegram Test Specialist' }
  });
  await db.pool.query(
    'insert into public.psychologist_telegram_accounts(telegram_user_id, auth_user_id) values($1,$2)',
    [telegramId, userId]
  );

  const created = await db.rpc('link_or_create_psychologist_for_telegram', {}, { uid: userId, role: 'authenticated' });
  const profile = await db.query('select id, full_name, profile_completed from psychologists where owner_id=$1', [userId]);
  check('Telegram signup creates one incomplete cabinet', created?.ok === true && created?.created === true
    && profile.length === 1 && profile[0].profile_completed === false
    && profile[0].full_name === 'Telegram Test Specialist', JSON.stringify(created));

  const publishedBefore = await db.query('select id from public_profiles where id=$1', [profile[0]?.id]);
  check('incomplete Telegram profile is not public', publishedBefore.length === 0);

  const completed = await db.rpc('complete_telegram_psychologist_profile', {
    p_full_name: 'Telegram Test Specialist', p_phone: '+41790000000',
    p_specialization: 'Психолог', p_city: 'Zürich', p_about: 'Профиль из Mini App'
  }, { uid: userId, role: 'authenticated' });
  const publishedAfter = await db.query('select id from public_profiles where id=$1', [profile[0]?.id]);
  check('Telegram onboarding completes profile and publishes it', completed?.ok === true
    && publishedAfter.length === 1, JSON.stringify(completed));

  const mismatchedId = await db.createAuthUser('telegram-111111111@telegram.invalid', {
    meta: { provider: 'telegram', telegram_user_id: '999999999', full_name: 'Mismatch' }
  });
  await db.pool.query(
    'insert into public.psychologist_telegram_accounts(telegram_user_id, auth_user_id) values($1,$2)',
    ['111111111', mismatchedId]
  );
  const rejected = await db.rpc('link_or_create_psychologist_for_telegram', {}, { uid: mismatchedId, role: 'authenticated' });
  check('profile creation rejects metadata/Telegram ID mismatch', rejected?.ok === false && rejected?.code === 'identity_mismatch');

  let anonError = null;
  const tx = await db.transaction({ role: 'anon' });
  try { await tx.query('select * from psychologist_telegram_accounts'); }
  catch (error) { anonError = error; }
  finally { await tx.rollback(); }
  check('anon cannot read Telegram account mapping', !!anonError && /permission denied|row-level security/i.test(String(anonError.message)));
} catch (error) {
  console.error('FAIL Telegram auth DB contract:', error);
  failed++;
}
for (const [, pass] of results) if (!pass) failed++;
console.log(failed ? `\n${failed} FAILED (${results.length} checks)` : `\nALL PASS (${results.length})`);
await finishSuite(failed);
