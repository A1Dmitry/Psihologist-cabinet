#!/usr/bin/env node
/**
 * SQL-контракт supabase/schema.sql — проверка на НАСТОЯЩЕМ PostgreSQL.
 *
 *   npm run verify:db          (или node tests/db-contract.mjs)
 *
 * Поднимается embedded PostgreSQL (tools/dbtest), к нему дословно применяется
 * supabase/schema.sql, затем проверяются те инварианты, которые живые только
 * в БД и которые до этого не проверял ни один смоук-скрипт:
 *
 *   • схема ПРИМЕНЯЕТСЯ без ошибок (раньше она падала на revoke/grant
 *     create_booking с неверной сигнатурой — и всё, что ниже, не создавалось);
 *   • claim_psychologist_profile: owner_id = auth.uid(), все обязательные поля,
 *     повторный вход не создаёт дубль, чужой профиль не отбирается;
 *   • create_booking: перекрытие по интервалам с учётом 90-минутной услуги,
 *     снимок длительности, канонические поля пояса клиента;
 *   • ГОНКА: две параллельные транзакции на один слот → ровно одна запись;
 *   • RLS: аноним не видит клиентов и сессии, владелец видит свои.
 */
import { startTestDatabase } from '../tools/dbtest/index.mjs';

/**
 * Гонка при остановке PostgreSQL: pg_ctl гасит сервер, а «спящий» клиент пула
 * успевает получить FATAL 57P01 «terminating connection due to administrator
 * command». pg.Pool пробрасывает его как unhandled 'error' — процесс падал с
 * кодом 1 ещё ДО печати итога (плавающий результат `npm run verify`).
 * Обработчики ставим ДО поднятия БД: событие прилетает во время db.stop().
 * На результат проверок это не влияет — они к тому моменту все выполнены,
 * а любая настоящая ошибка печатается и взводит ненулевой код выхода.
 */
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

const db = await startTestDatabase({ port: Number(process.env.DB_PORT || 55432) });
check('schema.sql применён к пустой БД без ошибок', true);

try {
  /* ========================================================================
   * 0. Объекты схемы на месте
   * ====================================================================== */
  const fns = await db.query(
    `select proname, pg_get_function_identity_arguments(oid) as args
       from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('create_booking','claim_psychologist_profile')`
  );
  check('RPC create_booking существует', fns.some(f => f.proname === 'create_booking'));
  check('RPC claim_psychologist_profile существует (создавался ПОСЛЕ старой точки падения)',
    fns.some(f => f.proname === 'claim_psychologist_profile'),
    fns.map(f => f.proname).join(', '));
  check('таблица auth_login_codes существует',
    (await db.count('auth_login_codes')) === 0);
  // SR-004 (issue #14, п.4): без этих колонок Edge Function не может атомарно
  // гасить код и не умеет восстанавливать сессию (action=recover).
  const codeCols = (await db.query(
    `select column_name from information_schema.columns where table_name = 'auth_login_codes'`
  )).map(r => r.column_name);
  for (const col of ['issued_token_hash', 'issues', 'consumed_at']) {
    check(`auth_login_codes.${col} (SR-004: атомарность погашения кода)`,
      codeCols.includes(col), codeCols.join(', '));
  }
  check('таблица client_error_logs существует (шла в самом конце файла)',
    (await db.query(`select to_regclass('public.client_error_logs') as t`))[0].t !== null);

  const sesCols = (await db.query(
    `select column_name from information_schema.columns where table_name = 'sessions'`
  )).map(r => r.column_name);
  check('sessions.client_timezone (IANA-пояс клиента) есть', sesCols.includes('client_timezone'));
  check('sessions.client_utc_offset_min (снимок смещения) есть', sesCols.includes('client_utc_offset_min'));
  check('sessions.duration_min (снимок длительности) есть', sesCols.includes('duration_min'));
  check('несовместимое поле sessions.timezone_offset удалено', !sesCols.includes('timezone_offset'));

  /* ========================================================================
   * 1. claim_psychologist_profile
   * ====================================================================== */
  const uidA = await db.createAuthUser('natalia@example.by');

  const claim1 = await db.rpc('claim_psychologist_profile', {
    p_email: 'natalia@example.by',
    p_full_name: 'Наталья Тестовая',
    p_phone: '+375291112233',
    p_specialization: 'Клинический психолог',
    p_city: 'Гродно',
    p_about: 'КПТ, тревога и выгорание.'
  }, { uid: uidA });

  check('claim: профиль создан', claim1?.ok === true && claim1?.created === true, JSON.stringify(claim1));
  check('claim: owner_id == auth.uid()', claim1?.owner_id === uidA, `${claim1?.owner_id} vs ${uidA}`);

  const row1 = (await db.query(`select * from psychologists where id = $1`, [claim1.id]))[0];
  check('claim: full_name сохранён', row1.full_name === 'Наталья Тестовая', row1.full_name);
  check('claim: phone сохранён', row1.phone === '+375291112233', row1.phone);
  check('claim: specialization сохранён', row1.specialization === 'Клинический психолог', row1.specialization);
  check('claim: city сохранён', row1.city === 'Гродно', row1.city);
  check('claim: about сохранён', row1.about === 'КПТ, тревога и выгорание.', row1.about);
  check('claim: стартовые настройки кабинета созданы',
    (await db.count('session_settings', 'where psychologist_id = $1', [claim1.id])) === 1);

  // повторный вход тем же email
  const claim2 = await db.rpc('claim_psychologist_profile', {
    p_email: 'NATALIA@example.by ', // другой регистр/пробелы — тот же человек
    p_full_name: 'Наталья Тестовая',
    p_phone: '',
    p_specialization: '',
    p_city: '',
    p_about: ''
  }, { uid: uidA });
  check('claim повторно: тот же id', claim2?.id === claim1.id, `${claim2?.id} vs ${claim1.id}`);
  check('claim повторно: created = false', claim2?.created === false, String(claim2?.created));
  check('claim повторно: дублей нет',
    (await db.count('psychologists', `where lower(email) = 'natalia@example.by'`)) === 1);
  const row2 = (await db.query(`select * from psychologists where id = $1`, [claim1.id]))[0];
  check('claim повторно: пустые поля не затёрли существующие',
    row2.phone === '+375291112233' && row2.about === 'КПТ, тревога и выгорание.');

  // чужой профиль не отбирается
  const uidB = await db.createAuthUser('intruder@example.by');
  const steal = await db.rpc('claim_psychologist_profile', {
    p_email: 'natalia@example.by', p_full_name: 'Злоумышленник'
  }, { uid: uidB });
  check('claim: чужой привязанный профиль не отбирается', steal?.ok === false, JSON.stringify(steal));
  check('claim: owner_id после попытки перехвата не изменился',
    (await db.query(`select owner_id from psychologists where id = $1`, [claim1.id]))[0].owner_id === uidA);

  // аноним вообще не может вызвать привязку профиля (execute отозван)
  let anonError = null;
  try {
    await db.rpc('claim_psychologist_profile', {
      p_email: 'ghost@example.by', p_full_name: 'Призрак'
    }, { uid: null, role: 'anon' });
  } catch (e) {
    anonError = String(e.message || e);
  }
  check('claim от имени anon: вызов запрещён на уровне грантов',
    /permission denied for function/.test(anonError || ''), anonError || 'вызов прошёл');
  check('claim от имени anon: профиль не создан',
    (await db.count('psychologists', `where email = 'ghost@example.by'`)) === 0);

  // authenticated без auth.uid() (JWT есть, sub пуст) — функция отказывает сама
  const noUid = await db.rpc('claim_psychologist_profile', {
    p_email: 'ghost2@example.by', p_full_name: 'Без uid'
  }, { uid: null, role: 'authenticated' });
  check('claim без auth.uid(): отказ по инварианту функции', noUid?.ok === false, JSON.stringify(noUid));
  check('claim без auth.uid(): профиль не создан',
    (await db.count('psychologists', `where email = 'ghost2@example.by'`)) === 0);

  /* ========================================================================
   * 2. create_booking: длительность и перекрытия
   * ====================================================================== */
  const svc90 = (await db.query(
    `insert into services (psychologist_id, title, duration_min, price)
     values ($1, 'Глубокая сессия', 90, 120) returning id`, [claim1.id]))[0].id;
  const svc60 = (await db.query(
    `insert into services (psychologist_id, title, duration_min, price)
     values ($1, 'Обычная сессия', 60, 80) returning id`, [claim1.id]))[0].id;

  const DATE = '2030-03-04'; // понедельник, заведомо в будущем
  const b1 = await db.rpc('create_booking', {
    p_psychologist_id: claim1.id, p_service_id: svc90,
    p_session_date: DATE, p_session_time: '17:00',
    p_client_name: 'Анна', p_client_nickname: 'Anna_T', p_client_phone: '+375291112233',
    p_client_timezone: 'Asia/Tashkent', p_client_utc_offset_min: 300, p_duration_min: 90
  }, { role: 'anon', uid: null });
  check('booking: 90-минутная запись создана', b1?.ok === true, JSON.stringify(b1));
  check('booking: снимок длительности возвращён и равен 90', b1?.duration_min === 90, String(b1?.duration_min));

  const sesRow = (await db.query(`select * from sessions where id = $1`, [b1.session_id]))[0];
  check('booking: sessions.duration_min = 90 (снимок)', sesRow.duration_min === 90, String(sesRow.duration_min));
  check('booking: sessions.client_timezone = Asia/Tashkent', sesRow.client_timezone === 'Asia/Tashkent', sesRow.client_timezone);
  check('booking: sessions.client_utc_offset_min = 300', sesRow.client_utc_offset_min === 300, String(sesRow.client_utc_offset_min));

  // 16:00 на 90 мин = 16:00–17:30 → пересекает 17:00–18:30
  const overlap = await db.rpc('create_booking', {
    p_psychologist_id: claim1.id, p_service_id: svc90,
    p_session_date: DATE, p_session_time: '16:00',
    p_client_name: 'Борис', p_client_phone: '+375297654321'
  }, { role: 'anon', uid: null });
  check('booking: 16:00 (90 мин) отклонён — пересекает запись 17:00–18:30',
    overlap?.ok === false, JSON.stringify(overlap));

  // 15:00 на 60 мин = 15:00–16:00 → не пересекает
  const ok15 = await db.rpc('create_booking', {
    p_psychologist_id: claim1.id, p_service_id: svc60,
    p_session_date: DATE, p_session_time: '15:00',
    p_client_name: 'Вера', p_client_phone: '+375297654322'
  }, { role: 'anon', uid: null });
  check('booking: 15:00 (60 мин) принят — не пересекает', ok15?.ok === true, JSON.stringify(ok15));

  // длительность по умолчанию, если услуга не указана
  const noSvc = await db.rpc('create_booking', {
    p_psychologist_id: claim1.id, p_service_id: null,
    p_session_date: DATE, p_session_time: '10:00',
    p_client_name: 'Глеб', p_client_phone: '+375297654323'
  }, { role: 'anon', uid: null });
  check('booking: без услуги длительность = канонические 60',
    noSvc?.duration_min === 60, String(noSvc?.duration_min));

  // анти-спам: 4-я запись на тот же телефон за сегодня
  const today = new Date().toISOString().slice(0, 10);
  let spamBlocked = null;
  for (let i = 0; i < 4; i++) {
    spamBlocked = await db.rpc('create_booking', {
      p_psychologist_id: claim1.id, p_service_id: svc60,
      p_session_date: today, p_session_time: `${String(8 + i).padStart(2, '0')}:00`,
      p_client_name: 'Спам', p_client_phone: '+375290000000'
    }, { role: 'anon', uid: null });
  }
  check('booking: анти-спам — 4-я запись за день на телефон отклонена',
    spamBlocked?.ok === false, JSON.stringify(spamBlocked));

  /* ========================================================================
   * 3. ГОНКА: две параллельные транзакции на один слот
   * ====================================================================== */
  const RACE_DATE = '2030-03-11';
  const [txA, txB] = await Promise.all([
    db.transaction({ role: 'anon' }),
    db.transaction({ role: 'anon' })
  ]);
  const raceSql = `select create_booking(
      p_psychologist_id => $1, p_service_id => $2,
      p_session_date => $3, p_session_time => '13:00',
      p_client_name => $4, p_client_phone => $5) as r`;
  // Каждая транзакция коммитится СРАЗУ после своего вызова: advisory-блокировка
  // держится до коммита, и если ждать обе — вторая будет ждать вечно (дедлок
  // в самом тесте, а не в схеме).
  const runRace = async (tx, name, phone) => {
    try {
      const rows = await tx.query(raceSql, [claim1.id, svc60, RACE_DATE, name, phone]);
      await tx.commit();
      return rows[0]?.r;
    } catch (e) {
      await tx.rollback();
      return { ok: false, error: String(e.message || e) };
    }
  };
  const outcomes = await Promise.all([
    runRace(txA, 'Первый', '+375291000001'),
    runRace(txB, 'Второй', '+375291000002')
  ]);
  const accepted = outcomes.filter(o => o?.ok === true).length;
  const stored = await db.count('sessions',
    `where psychologist_id = $1 and session_date = $2 and session_time = '13:00'`,
    [claim1.id, RACE_DATE]);
  check('гонка: ровно одна из двух параллельных записей принята', accepted === 1, JSON.stringify(outcomes));
  check('гонка: в БД ровно одна запись на слот 13:00', stored === 1, String(stored));

  /* ========================================================================
   * 4. RLS
   * ====================================================================== */
  // schema.sql отзывает у anon даже грант на таблицу (строже, чем просто RLS):
  // чтение падает с permission denied. Оба исхода означают «аноним данных не видит».
  const anonRead = async (table) => {
    try {
      const rows = await db.query(`select id from ${table}`, [], { role: 'anon', uid: null });
      return { denied: false, count: rows.length };
    } catch (e) {
      return { denied: /permission denied/.test(String(e.message || e)), count: 0 };
    }
  };
  const anonSessions = await anonRead('sessions');
  check('аноним не видит сессии (отозван грант + RLS)',
    anonSessions.denied || anonSessions.count === 0, JSON.stringify(anonSessions));
  const anonClients = await anonRead('clients');
  check('аноним не видит клиентов (отозван грант + RLS)',
    anonClients.denied || anonClients.count === 0, JSON.stringify(anonClients));

  const ownerSessions = await db.query(`select id from sessions`, [], { role: 'authenticated', uid: uidA });
  check('RLS: владелец видит свои сессии', ownerSessions.length > 0, String(ownerSessions.length));
  const strangerSessions = await db.query(`select id from sessions`, [], { role: 'authenticated', uid: uidB });
  check('RLS: чужой владелец не видит сессии', strangerSessions.length === 0, String(strangerSessions.length));

  const publicSlots = await db.query(
    `select session_time, duration_min from public_booked_slots
      where psychologist_id = $1 and session_date = $2 order by session_time`,
    [claim1.id, DATE], { role: 'anon', uid: null });
  check('public_booked_slots: отдаёт длительность чужой записи (SR-003)',
    publicSlots.some(r => r.duration_min === 90), JSON.stringify(publicSlots));
  check('public_booked_slots: не раскрывает данные клиента',
    !JSON.stringify(publicSlots).includes('Анна'), JSON.stringify(publicSlots));
} finally {
  await db.stop();
}

const failed = results.filter(r => !r[1]).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
if (teardownNoise) console.log('(шум остановки PostgreSQL проигнорирован: 57P01 на закрытии соединения)');
process.exitCode = failed ? 1 : 0;
setTimeout(() => process.exit(process.exitCode || 0), 200).unref?.();
