#!/usr/bin/env node
/**
 * Открытая регистрация специалиста через Google — SQL-контракт на НАСТОЯЩЕМ
 * PostgreSQL (supabase/schema.sql + подготовленная миграция
 * supabase/migrations/20260925_google_specialist_signup.sql).
 *
 *   node tests/google-specialist-signup.mjs
 *
 * Проверяется именно то, что клиентский мок проверить не может:
 *   • миграция применяется и функции существуют;
 *   • создание нового кабинета со статусом «профиль не заполнен»;
 *   • идемпотентность повторного входа и гонка двух параллельных входов;
 *   • сравнение email без учёта регистра и окружающих пробелов;
 *   • привязка существующей записи БЕЗ перезаписи её данных;
 *   • дубли и занятые/отключённые записи не выбираются и не перезаписываются;
 *   • identity берётся из auth.users (email + email_confirmed_at +
 *     raw_user_meta_data): у RPC вообще нет аргументов, из браузера нельзя
 *     передать ни email, ни «чужой» owner_id;
 *   • колоночные права authenticated: прямой INSERT запрещён, email/is_active/
 *     owner_id/profile_completed обычным UPDATE не меняются;
 *   • недозаполненный кабинет не попадает в public_profiles.
 */
import { startTestDatabaseOrExit, finishSuite } from '../tools/dbtest/index.mjs';

/**
 * Гонка при остановке PostgreSQL: pg_ctl гасит сервер, а «спящий» клиент пула
 * успевает получить FATAL 57P01. pg.Pool пробрасывает его как unhandled
 * 'error' — процесс падал с кодом 1 ещё ДО печати итога (плавающий результат
 * `npm run verify`). Обработчики ставим ДО поднятия БД — ровно как в
 * tests/db-contract.mjs: событие прилетает во время db.stop().
 * На результат проверок это не влияет — они к тому моменту все выполнены,
 * а любая настоящая ошибка печатается и взводит ненулевой код выхода.
 */
const isTeardownNoise = (e) => /terminating connection|57P01/.test(String(e?.message || e));
process.on('uncaughtException', (e) => {
  if (isTeardownNoise(e)) return;
  console.error(e);
  process.exitCode = 1;
});
process.on('unhandledRejection', (e) => {
  if (isTeardownNoise(e)) return;
  console.error(e);
  process.exitCode = 1;
});

const MIGRATION = 'supabase/migrations/20260925_google_specialist_signup.sql';

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};
const failed = () => results.filter(([, ok]) => !ok);

const db = await startTestDatabaseOrExit({ port: Number(process.env.DB_PORT || 55436) });

/** Запрос от имени authenticated; true = выполнено без ошибки прав/RLS. */
async function allowed(sql, params, uid) {
  try {
    await db.query(sql, params, { role: 'authenticated', uid });
    return true;
  } catch {
    return false;
  }
}

try {
  /* ========================================================================
   * 0. Миграция применяется к schema.sql без ошибок
   * ====================================================================== */
  await db.applySqlFile(MIGRATION);
  check('миграция Google-регистрации применяется к schema.sql без ошибок', true);

  const fns = await db.query(
    `select proname from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('link_or_create_psychologist_for_google','complete_psychologist_profile')`
  );
  check('RPC link_or_create_psychologist_for_google создана',
    fns.some(f => f.proname === 'link_or_create_psychologist_for_google'));
  check('RPC complete_psychologist_profile создана',
    fns.some(f => f.proname === 'complete_psychologist_profile'));
  const colOk = await db.query(
    `select 1 from information_schema.columns
      where table_schema='public' and table_name='psychologists' and column_name='profile_completed'`
  );
  check('колонка psychologists.profile_completed создана', colOk.length === 1);
  check('у RPC нет аргументов — email/owner_id нельзя передать из браузера',
    (await db.query(
      `select pg_get_function_identity_arguments(oid) as args from pg_proc
        where pronamespace='public'::regnamespace and proname='link_or_create_psychologist_for_google'`
    ))[0]?.args === '');

  /* ========================================================================
   * 1. Новый Google-пользователь → кабинет создан, «профиль не заполнен»
   * ====================================================================== */
  const uidNew = await db.createAuthUser('New.Person@Example.COM ', {
    confirmed: true, meta: { full_name: 'Новый Специалист', picture: 'https://x/p.png' }
  });
  const r1 = await db.rpc('link_or_create_psychologist_for_google', {}, { uid: uidNew });
  check('новый аккаунт: ok=true, code=created', r1?.ok === true && r1?.code === 'created', JSON.stringify(r1));
  check('новый аккаунт: profile_completed=false («профиль не заполнен»)', r1?.profile_completed === false);
  check('новый аккаунт: is_active=true (кабинет рабочий, дальше онбординг)', r1?.is_active === true);

  const row1 = (await db.query(`select * from psychologists where id = $1`, [r1.id]))[0];
  check('email нормализован (lower+trim) и взят из auth.users, не из браузера',
    row1?.email === 'new.person@example.com', `got: ${row1?.email}`);
  check('owner_id = auth.uid() создателя', row1?.owner_id === uidNew);
  check('имя взято из данных провайдера (raw_user_meta_data.full_name)',
    row1?.full_name === 'Новый Специалист', `got: ${row1?.full_name}`);
  check('slug сгенерирован и не пуст', !!row1?.slug, `got: ${row1?.slug}`);
  check('стартовые session_settings созданы',
    (await db.count('session_settings', `where psychologist_id = $1`, [r1.id])) === 1);

  /* ========================================================================
   * 2. Повторный вход → тот же кабинет, без дубля
   * ====================================================================== */
  const r2 = await db.rpc('link_or_create_psychologist_for_google', {}, { uid: uidNew });
  check('повторный вход: code=already_linked, created=false',
    r2?.ok === true && r2?.code === 'already_linked' && r2?.created === false, JSON.stringify(r2));
  check('повторный вход: тот же id кабинета', r2?.id === r1.id);
  check('повторный вход: дубля не создано',
    (await db.count('psychologists', `where owner_id = $1`, [uidNew])) === 1);

  /* ========================================================================
   * 3. ГОНКА: два параллельных входа одного нового пользователя
   * ====================================================================== */
  const uidRace = await db.createAuthUser('race@example.com', { confirmed: true, meta: { full_name: 'Race' } });
  const [a, b] = await Promise.all([
    db.rpc('link_or_create_psychologist_for_google', {}, { uid: uidRace }),
    db.rpc('link_or_create_psychologist_for_google', {}, { uid: uidRace })
  ]);
  check('гонка: оба вызова успешны', a?.ok === true && b?.ok === true, `${a?.code} / ${b?.code}`);
  check('гонка: оба вызова вернули один id', a?.id === b?.id);
  check('гонка: ровно один кабинет на аккаунт',
    (await db.count('psychologists', `where owner_id = $1`, [uidRace])) === 1);

  /* ========================================================================
   * 4. Существующая запись с тем же email (другой регистр + пробелы),
   *    owner_id свободен → привязка БЕЗ перезаписи данных
   * ====================================================================== */
  await db.query(
    `insert into psychologists (email, full_name, phone, specialization, city, about, slug, owner_id, is_active)
     values ('  Existing.Specialist@Example.BY  ', 'Существующий Профиль', '+375 29 000-00-00',
             'Психотерапевт', 'Гродно', 'Опыт 12 лет', 'existing-specialist', null, true)`
  );
  const before = (await db.query(
    `select * from psychologists where lower(trim(email)) = 'existing.specialist@example.by'`))[0];
  check('поиск по email игнорирует регистр и пробелы: запись найдена', !!before);

  const uidLink = await db.createAuthUser('EXISTING.specialist@example.by', {
    confirmed: true, meta: { full_name: 'Другое Имя Из Google' }
  });
  const r3 = await db.rpc('link_or_create_psychologist_for_google', {}, { uid: uidLink });
  check('существующий email: code=linked, created=false',
    r3?.ok === true && r3?.code === 'linked' && r3?.created === false, JSON.stringify(r3));

  const after = (await db.query(`select * from psychologists where id = $1`, [before.id]))[0];
  check('привязка: owner_id выставлен на текущий auth.uid()', after.owner_id === uidLink);
  check('привязка: НЕ перезаписала full_name', after.full_name === 'Существующий Профиль', `got: ${after.full_name}`);
  check('привязка: НЕ перезаписала phone', after.phone === '+375 29 000-00-00');
  check('привязка: НЕ перезаписала specialization', after.specialization === 'Психотерапевт');
  check('привязка: НЕ перезаписала city', after.city === 'Гродно');
  check('привязка: НЕ перезаписала about', after.about === 'Опыт 12 лет');
  check('привязка: НЕ перезаписала slug', after.slug === 'existing-specialist');
  check('привязка: НЕ перезаписала email', after.email === before.email);
  check('привязка: заполненный профиль не отправляется на онбординг повторно',
    after.profile_completed === true);
  check('привязка: новой записи не появилось',
    (await db.count('psychologists', `where lower(trim(email)) = 'existing.specialist@example.by'`)) === 1);

  /* ========================================================================
   * 5. Запись уже привязана к ДРУГОМУ аккаунту → не отбираем
   * ====================================================================== */
  const ownerA = await db.createAuthUser('owner-a@example.by', { confirmed: true });
  await db.query(
    `insert into psychologists (email, full_name, phone, specialization, city, about, slug, owner_id, is_active)
     values ('taken@example.by', 'Занятый', '+375 29 999-99-99', 'Психолог', 'Минск', 'Обо мне', 'taken-profile', $1, true)`,
    [ownerA]);
  const ownerB = await db.createAuthUser('TAKEN@example.by', { confirmed: true });
  const r4 = await db.rpc('link_or_create_psychologist_for_google', {}, { uid: ownerB });
  check('занятая запись: ok=false, code=email_taken',
    r4?.ok === false && r4?.code === 'email_taken', JSON.stringify(r4));
  check('занятая запись: есть понятное resolution', /\S/.test(String(r4?.resolution || '')));
  const takenRow = (await db.query(`select owner_id, full_name from psychologists where email='taken@example.by'`))[0];
  check('занятая запись: владелец не изменён', takenRow.owner_id === ownerA);
  check('занятая запись: данные не затронуты', takenRow.full_name === 'Занятый');
  check('занятая запись: чужой кабинет НЕ привязан к новому аккаунту',
    (await db.count('psychologists', `where owner_id = $1`, [ownerB])) === 0);

  /* ========================================================================
   * 6. Дубли по email → не выбираем автоматически
   * ====================================================================== */
  await db.query(
    `insert into psychologists (email, full_name, slug, owner_id, is_active)
     values ('dup@example.by', 'Дубль 1', 'dup-1', null, true)`);
  await db.query(
    `insert into psychologists (email, full_name, slug, owner_id, is_active)
     values ('DUP@Example.BY', 'Дубль 2', 'dup-2', null, true)`);
  const uidDup = await db.createAuthUser('dup@example.by', { confirmed: true });
  const r5 = await db.rpc('link_or_create_psychologist_for_google', {}, { uid: uidDup });
  check('дубли email: ok=false, code=duplicate_email',
    r5?.ok === false && r5?.code === 'duplicate_email', JSON.stringify(r5));
  check('дубли email: matches = 2', Number(r5?.matches) === 2);
  check('дубли email: есть понятное resolution', /\S/.test(String(r5?.resolution || '')));
  check('дубли email: ни одна запись не привязана автоматически',
    (await db.count('psychologists',
      `where lower(trim(email)) = 'dup@example.by' and owner_id is not null`)) === 0);
  check('дубли email: нового кабинета не создано',
    (await db.count('psychologists', `where lower(trim(email)) = 'dup@example.by'`)) === 2);

  /* ========================================================================
   * 7. Отключённая запись входом не реактивируется
   * ====================================================================== */
  await db.query(
    `insert into psychologists (email, full_name, slug, owner_id, is_active)
     values ('inactive@example.by', 'Отключённый', 'inactive-profile', null, false)`);
  const uidIn = await db.createAuthUser('inactive@example.by', { confirmed: true });
  const r6 = await db.rpc('link_or_create_psychologist_for_google', {}, { uid: uidIn });
  check('отключённая запись: ok=false, code=profile_inactive',
    r6?.ok === false && r6?.code === 'profile_inactive', JSON.stringify(r6));
  const inRow = (await db.query(`select is_active, owner_id from psychologists where email='inactive@example.by'`))[0];
  check('отключённая запись: is_active остался false', inRow.is_active === false);
  check('отключённая запись: owner_id не выставлен', inRow.owner_id === null);

  /* ========================================================================
   * 8. Неподтверждённый email → отказ без создания кабинета
   * ====================================================================== */
  const uidUnc = await db.createAuthUser('unconfirmed@example.by', { confirmed: false });
  const r7 = await db.rpc('link_or_create_psychologist_for_google', {}, { uid: uidUnc });
  check('неподтверждённый email: ok=false, code=email_unconfirmed',
    r7?.ok === false && r7?.code === 'email_unconfirmed', JSON.stringify(r7));
  check('неподтверждённый email: кабинет не создан',
    (await db.count('psychologists', `where lower(trim(email)) = 'unconfirmed@example.by'`)) === 0);

  /* ========================================================================
   * 9. Доступ без сессии (anon) закрыт
   * ====================================================================== */
  let anonDenied = false;
  try { await db.rpc('link_or_create_psychologist_for_google', {}, { uid: null, role: 'anon' }); }
  catch { anonDenied = true; }
  check('anon не может вызвать link_or_create_psychologist_for_google', anonDenied);

  let anonDenied2 = false;
  try {
    await db.rpc('complete_psychologist_profile',
      { 'p_full_name': 'a', 'p_phone': 'b', 'p_specialization': 'c', 'p_city': 'd', 'p_about': 'e' },
      { uid: null, role: 'anon' });
  } catch { anonDenied2 = true; }
  check('anon не может вызвать complete_psychologist_profile', anonDenied2);

  /* ========================================================================
   * 10. Онбординг: complete_psychologist_profile
   * ====================================================================== */
  const bad = await db.rpc('complete_psychologist_profile',
    { 'p_full_name': ' ', 'p_phone': '', 'p_specialization': '', 'p_city': '', 'p_about': '' },
    { uid: uidNew });
  check('онбординг: пустые поля отклонены (code=validation)',
    bad?.ok === false && bad?.code === 'validation', JSON.stringify(bad));
  check('онбординг: profile_completed остался false при валидационной ошибке',
    (await db.query(`select profile_completed from psychologists where id=$1`, [r1.id]))[0].profile_completed === false);

  const done = await db.rpc('complete_psychologist_profile',
    {
      'p_full_name': 'Новый Специалист', 'p_phone': '+375 29 111-22-33',
      'p_specialization': 'Психолог', 'p_city': 'Минск', 'p_about': 'Работаю с тревогой'
    },
    { uid: uidNew });
  check('онбординг: ok=true, profile_completed=true',
    done?.ok === true && done?.profile_completed === true, JSON.stringify(done));

  const doneRow = (await db.query(`select * from psychologists where id=$1`, [r1.id]))[0];
  check('онбординг: поля профиля сохранены',
    doneRow.full_name === 'Новый Специалист' && doneRow.phone === '+375 29 111-22-33'
    && doneRow.city === 'Минск' && doneRow.about === 'Работаю с тревогой');
  check('онбординг: email НЕ изменён', doneRow.email === 'new.person@example.com');
  check('онбординг: is_active НЕ изменён', doneRow.is_active === true);
  check('онбординг: owner_id НЕ изменён', doneRow.owner_id === uidNew);
  check('онбординг: slug НЕ изменён', doneRow.slug === row1.slug);

  /* ========================================================================
   * 11. Колоночные права и RLS для authenticated
   * ====================================================================== */
  check('authenticated МОЖЕТ обновить публичное поле профиля (full_name)',
    await allowed(`update psychologists set full_name = 'Разрешено' where id = $1`, [r1.id], uidNew));
  check('authenticated НЕ может обновить email (подтверждённый email входа)',
    !(await allowed(`update psychologists set email = 'hacker@example.by' where id = $1`, [r1.id], uidNew)));
  check('authenticated НЕ может обновить is_active (статус доступа)',
    !(await allowed(`update psychologists set is_active = false where id = $1`, [r1.id], uidNew)));
  check('authenticated НЕ может обновить owner_id (auth.uid() владельца)',
    !(await allowed(`update psychologists set owner_id = null where id = $1`, [r1.id], uidNew)));
  check('authenticated НЕ может обновить profile_completed (только через RPC)',
    !(await allowed(`update psychologists set profile_completed = false where id = $1`, [r1.id], uidNew)));
  check('authenticated НЕ может создать кабинет прямым INSERT (только через RPC)',
    !(await allowed(
      `insert into psychologists (email, slug, owner_id, is_active) values ('squat@example.by', 'squat', $1, true)`,
      [uidNew], uidNew)));
  // ВАЖНО: RLS не бросает исключение — UPDATE просто затрагивает 0 строк.
  // Проверять нужно ФАКТИЧЕСКОЕ значение, а не отсутствие ошибки (иначе
  // «зелёная» проверка ничего не доказывает).
  const uidStranger = await db.createAuthUser('stranger@example.by', { confirmed: true });
  await db.query(`update psychologists set full_name = 'взлом' where id = $1`,
    [before.id], { role: 'authenticated', uid: uidStranger });
  check('чужой кабинет: RLS не даёт изменить даже публичное поле',
    (await db.query(`select full_name from psychologists where id = $1`, [before.id]))[0].full_name
      === 'Существующий Профиль');

  /* ========================================================================
   * 12. Публичный каталог
   * ====================================================================== */
  const raceRow = (await db.query(
    `select slug, profile_completed from psychologists where owner_id = $1`, [uidRace]))[0];
  check('недозаполненный кабинет отсутствует в public_profiles',
    raceRow.profile_completed === false
    && (await db.count('public_profiles', `where slug = $1`, [raceRow.slug])) === 0);
  check('заполненный кабинет есть в public_profiles',
    (await db.count('public_profiles', `where id = $1`, [r1.id])) === 1);
  check('привязанный существующий профиль остался в каталоге',
    (await db.count('public_profiles', `where id = $1`, [before.id])) === 1);

} catch (e) {
  console.error('FATAL', e);
  check('набор выполнен без исключения', false, String(e?.message || e));
} finally {
  await db.stop().catch(() => {});
}

const f = failed();
console.log(`\n${results.length - f.length}/${results.length} проверок пройдено`);
if (f.length) console.log('Провалено:\n' + f.map(([n]) => '  - ' + n).join('\n'));
await finishSuite(f.length);
