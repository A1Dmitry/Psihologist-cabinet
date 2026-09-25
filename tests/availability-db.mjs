#!/usr/bin/env node
/**
 * D1 — Booking Policy / Availability: серверное enforcement в create_booking.
 *
 *   node tests/availability-db.mjs   (или DB_PORT=xxxx node ...)
 *
 * Поднимается embedded PostgreSQL, применяется дословный supabase/schema.sql.
 * Пояс кабинета — UTC (детерминированные notice/proшлое), окно 00:00–23:00,
 * все дни рабочие, оплата none. Каждая запись — с уникальным телефоном
 * (не пересекаться с anti-spam T03).
 *
 * Клиентский близнец правил — js/domain/availability.js (+ tests/availability-policy.mjs).
 */
import { startTestDatabaseOrExit, finishSuite } from '../tools/dbtest/index.mjs';

const isTeardownNoise = (e) => /terminating connection|57P01/.test(String(e?.message || e));
process.on('uncaughtException', (e) => { if (isTeardownNoise(e)) return; console.error(e); process.exitCode = 1; });
process.on('unhandledRejection', (e) => { if (isTeardownNoise(e)) return; console.error(e); process.exitCode = 1; });

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

// --- UTC-календарь (пояс кабинета в тестах — UTC) ---
const dstr = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return dstr(d); };
const plusMinutes = (n) => new Date(Date.now() + n * 60000);
const isoDow = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
};
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n, 12, 0, 0));
  return t.toISOString().slice(0, 10);
};

let phoneSeq = 3000000;
const phone = () => `+37529${String(phoneSeq++).padStart(7, '0')}`;

const db = await startTestDatabaseOrExit({ port: Number(process.env.DB_PORT || 55435) });
console.log('=== D1 availability/policy server suite ===');

try {
  // ---------- setup ----------
  const uidA = await db.createAuthUser('d1psyA@example.com');
  const uidB = await db.createAuthUser('d1psyB@example.com');
  const claimA = await db.rpc('claim_psychologist_profile', {
    p_email: 'd1psyA@example.com', p_full_name: 'D1 Psy A', p_phone: '+375291111111',
    p_specialization: 'Psych', p_city: 'Minsk', p_about: 'd1'
  }, { uid: uidA });
  const claimB = await db.rpc('claim_psychologist_profile', {
    p_email: 'd1psyB@example.com', p_full_name: 'D1 Psy B', p_phone: '+375292222222',
    p_specialization: 'Psych', p_city: 'Minsk', p_about: 'd1'
  }, { uid: uidB });
  check('setup: psy A+B created', claimA?.ok && claimB?.ok);
  const psy = claimA.id;

  await db.query(`insert into session_settings
    (psychologist_id, timezone, work_days, slot_start, slot_end, slot_step_min, payment_policy)
    values ($1, 'UTC', '[1,2,3,4,5,6,7]', '00:00', '23:00', 60, 'none')
    on conflict (psychologist_id) do update set timezone='UTC', work_days='[1,2,3,4,5,6,7]',
      slot_start='00:00', slot_end='23:00', slot_step_min=60, payment_policy='none'`, [psy]);
  const setPolicy = (patch) => {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    return db.query(`update session_settings set ${sets} where psychologist_id = $1`, [psy, ...keys.map(k => patch[k])]);
  };
  const svc = (await db.query(
    `insert into services (psychologist_id, title, duration_min, price, currency, is_active)
     values ($1,'D1 Service',60,0,'BYN',true) returning id`, [psy]))[0].id;
  check('setup: service created', !!svc);

  const book = (date, time, extra = {}) => db.rpc('create_booking', {
    p_psychologist_id: psy,
    p_service_id: svc,
    p_session_date: date,
    p_session_time: time,
    p_client_name: 'D1 Client',
    p_client_phone: phone(),
    ...extra
  }, { role: 'anon' });

  // ---------- D1.0: объекты схемы ----------
  const setCols = (await db.query(
    `select column_name from information_schema.columns where table_name='session_settings'`)).map(r => r.column_name);
  for (const col of ['min_notice_minutes', 'max_advance_days', 'buffer_before_min', 'buffer_after_min',
    'slot_increment_min', 'max_bookings_per_day', 'max_bookings_per_week']) {
    check(`schema: session_settings.${col}`, setCols.includes(col));
  }
  const svcCols = (await db.query(
    `select column_name from information_schema.columns where table_name='services'`)).map(r => r.column_name);
  check('schema: services.availability', svcCols.includes('availability'));
  check('schema: table schedule_overrides', (await db.count('schedule_overrides')) === 0);
  const pubSetCols = (await db.query(
    `select column_name from information_schema.columns where table_name='public_settings'`)).map(r => r.column_name);
  check('schema: public_settings exposes policy', pubSetCols.includes('min_notice_minutes') && pubSetCols.includes('max_advance_days'));
  let pubOvrOk = true;
  try { await db.query(`select * from public_schedule_overrides limit 1`, [], { role: 'anon' }); }
  catch { pubOvrOk = false; }
  check('schema: anon can read public_schedule_overrides', pubOvrOk);

  // ---------- D1.1: minimum scheduling notice ----------
  await setPolicy({ min_notice_minutes: 180 });
  const near = plusMinutes(30);
  const rNotice = await book(dstr(near), near.toISOString().slice(11, 16));
  check('notice: слот через 30 мин при notice 180 → reject',
    rNotice?.ok === false && /минимум за 3 ч/.test(rNotice?.error || ''), JSON.stringify(rNotice));
  const rNoticeOk = await book(plusDays(2), '10:00');
  check('notice: слот через 2 дня → ok', rNoticeOk?.ok === true, JSON.stringify(rNoticeOk));
  await setPolicy({ min_notice_minutes: 0 });

  // ---------- D1.2: maximum advance window ----------
  await setPolicy({ max_advance_days: 7 });
  const rAdv = await book(plusDays(10), '10:00');
  check('advance: +10 дн при горизонте 7 → reject',
    rAdv?.ok === false && /только на 7 дн/.test(rAdv?.error || ''), JSON.stringify(rAdv));
  const rAdvOk = await book(plusDays(3), '10:00');
  check('advance: +3 дн → ok', rAdvOk?.ok === true, JSON.stringify(rAdvOk));
  await setPolicy({ max_advance_days: null });

  // ---------- D1.3: buffers ----------
  await setPolicy({ buffer_before_min: 0, buffer_after_min: 30 });
  const dBuf = plusDays(4);
  const rBufBase = await book(dBuf, '10:00');
  check('buffer: базовая 10:00 → ok', rBufBase?.ok === true, JSON.stringify(rBufBase));
  const rBufHit = await book(dBuf, '11:00');
  check('buffer: 11:00 упирается в буфер 30 мин → reject',
    rBufHit?.ok === false && /только что заняли/.test(rBufHit?.error || ''), JSON.stringify(rBufHit));
  const rBufEdge = await book(dBuf, '11:30');
  check('buffer: 11:30 (касание границы буфера) → ok', rBufEdge?.ok === true, JSON.stringify(rBufEdge));
  await setPolicy({ buffer_before_min: 0, buffer_after_min: 0 });

  // ---------- D1.4: slot increment ----------
  await setPolicy({ slot_increment_min: 30 });
  const dInc = plusDays(5);
  const rIncBad = await book(dInc, '10:15');
  check('increment: 10:15 при шаге 30 → reject',
    rIncBad?.ok === false && /каждые 30 мин/.test(rIncBad?.error || ''), JSON.stringify(rIncBad));
  const rIncOk = await book(dInc, '10:30');
  check('increment: 10:30 → ok', rIncOk?.ok === true, JSON.stringify(rIncOk));
  await setPolicy({ slot_increment_min: null });

  // ---------- D1.5: service-specific availability ----------
  const dSvc = plusDays(6);
  const svc2 = (await db.query(
    `insert into services (psychologist_id, title, duration_min, price, currency, is_active, availability)
     values ($1,'D1 Narrow',60,0,'BYN',true,$2) returning id`,
    [psy, JSON.stringify({ days: [isoDow(dSvc)], start: '12:00', end: '14:00' })]))[0].id;
  const rSvcOut = await book(dSvc, '10:00', { p_service_id: svc2 });
  check('svcAvail: 10:00 вне окна услуги 12–14 → reject',
    rSvcOut?.ok === false && /вне часов приёма/i.test(rSvcOut?.error || ''), JSON.stringify(rSvcOut));
  const rSvcIn = await book(dSvc, '12:00', { p_service_id: svc2 });
  check('svcAvail: 12:00 внутри окна → ok', rSvcIn?.ok === true, JSON.stringify(rSvcIn));
  const rSvcDay = await book(plusDays(7), '12:00', { p_service_id: svc2 });
  check('svcAvail: другой день недели → reject',
    rSvcDay?.ok === false && /приёма нет/.test(rSvcDay?.error || ''), JSON.stringify(rSvcDay));

  // ---------- D1.6: overrides ----------
  const dClosed = plusDays(8);
  await db.query(`insert into schedule_overrides (psychologist_id, date, is_closed, title)
    values ($1,$2,true,'Отпуск')`, [psy, dClosed]);
  const rClosed = await book(dClosed, '10:00');
  check('override: закрытый день → reject с подписью',
    rClosed?.ok === false && /В этот день записи нет \(Отпуск\)/.test(rClosed?.error || ''), JSON.stringify(rClosed));
  const dWin = plusDays(9);
  await db.query(`insert into schedule_overrides (psychologist_id, date, is_closed, open_from, open_to, title)
    values ($1,$2,false,'12:00','14:00','Короткий день')`, [psy, dWin]);
  const rWinOut = await book(dWin, '10:00');
  check('override: 10:00 вне особого окна → reject',
    rWinOut?.ok === false && /вне часов приёма/i.test(rWinOut?.error || ''), JSON.stringify(rWinOut));
  const rWinIn = await book(dWin, '12:00');
  check('override: 12:00 в особом окне → ok', rWinIn?.ok === true, JSON.stringify(rWinIn));
  await db.query(`delete from schedule_overrides where psychologist_id = $1`, [psy]);

  // ---------- D1.7: лимиты ----------
  await setPolicy({ max_bookings_per_day: 1 });
  const dLim = plusDays(10);
  const rLim1 = await book(dLim, '10:00');
  check('dayLimit: первая запись → ok', rLim1?.ok === true, JSON.stringify(rLim1));
  const rLim2 = await book(dLim, '12:00');
  check('dayLimit: вторая в тот же день → reject',
    rLim2?.ok === false && /На этот день мест больше нет/.test(rLim2?.error || ''), JSON.stringify(rLim2));
  await setPolicy({ max_bookings_per_day: null });

  await setPolicy({ max_bookings_per_week: 1 });
  // Неделя лимита обязана быть СВОБОДНОЙ от записей других сценариев:
  // при base = plusDays(14) её понедельник совпадал с plusDays(10) из
  // dayLimit-блока (когда today+10 — пн…чт), слот оказывался занят, и проверка
  // «первая запись на неделе → ok» падала не из-за недельного лимита, а из-за
  // коллизии данных (найдено при исполнении #46). plusDays(28): понедельник
  // этой недели ≥ today+22 — заведомо дальше всех дат набора (макс. +15).
  const base = plusDays(28);
  const monday = addDays(base, -(isoDow(base) - 1));
  const tuesday = addDays(monday, 1);
  const rWeek1 = await book(monday, '10:00');
  check('weekLimit: первая на неделе → ok', rWeek1?.ok === true, JSON.stringify(rWeek1));
  const rWeek2 = await book(tuesday, '10:00');
  check('weekLimit: вторая на той же неделе → reject',
    rWeek2?.ok === false && /На эту неделю мест больше нет/.test(rWeek2?.error || ''), JSON.stringify(rWeek2));
  await setPolicy({ max_bookings_per_week: null });

  // ---------- D1.8: явный slot_times побеждает инкремент ----------
  await setPolicy({ slot_increment_min: 30, slot_times: JSON.stringify(['10:00', '14:00']) });
  const rExpOk = await book(plusDays(15), '14:00');
  check('explicit grid: 14:00 из списка при инкременте 30 → ok',
    rExpOk?.ok === true, JSON.stringify(rExpOk));
  await setPolicy({ slot_increment_min: null, slot_times: null });

  // ---------- D1.9: RLS overrides ----------
  let anonBlocked = false;
  try { await db.query(`select * from schedule_overrides limit 1`, [], { role: 'anon' }); }
  catch { anonBlocked = true; }
  check('rls: anon не читает schedule_overrides напрямую', anonBlocked);
  await db.query(`insert into schedule_overrides (psychologist_id, date, is_closed, title)
    values ($1,$2,true,'A')`, [psy, plusDays(21)]);
  const ownRows = await db.query(`select * from schedule_overrides where psychologist_id = $1`,
    [psy], { role: 'authenticated', uid: uidA });
  check('rls: владелец читает свои overrides', ownRows.length === 1, String(ownRows.length));
  const alienRows = await db.query(`select * from schedule_overrides`,
    [], { role: 'authenticated', uid: uidB });
  check('rls: чужой владелец не видит overrides', alienRows.length === 0, String(alienRows.length));
  await db.query(`delete from schedule_overrides where psychologist_id = $1`, [psy]);

  // ---------- D1.10: дефолты = поведение до D1 (fail-open) ----------
  const rFree = await book(plusDays(20), '10:07');
  check('defaults: 10:07 без инкремента → ok (любой старт в окне)',
    rFree?.ok === true, JSON.stringify(rFree));

  // ---------- D1.11: паритет engine ↔ server на одной фикстуре ----------
  // Тот же сценарий решает и js/domain/availability.js, и create_booking.
  // Чтобы принятые пробы не меняли занятость друг друга — отдельный
  // психолог на каждую пробу (дешёвый изолированный контур).
  const { isSlotBookable } = await import('../js/domain/availability.js');
  const parityDate = plusDays(2);
  const engineClock = {
    nowMs: Date.now(),
    today: dstr(new Date()),
    slotMs: (d, t) => {
      const ms = Date.parse(`${d}T${t}:00Z`);
      return Number.isNaN(ms) ? null : ms;
    }
  };
  const engineSchedule = {
    workDays: [1, 2, 3, 4, 5, 6, 7], slotStart: '10:00', slotEnd: '12:00',
    slotTimes: null, stepMin: 60, timezone: 'UTC'
  };
  const parityCases = [
    // [время, занятость, ожидание]
    ['10:00', [{ from: 600, to: 660, kind: 'booked', title: 'Время занято' }], false],
    ['10:30', [{ from: 600, to: 660, kind: 'booked', title: 'Время занято' }], false],
    ['11:00', [{ from: 600, to: 660, kind: 'booked', title: 'Время занято' }], true],
    ['13:00', [], false] // 13:00+60=14:00 > grace 12:00+60=13:00
  ];
  let parityN = 0;
  for (const [ptime, busy, expected] of parityCases) {
    const eng = isSlotBookable({
      date: parityDate, time: ptime, durationMin: 60,
      schedule: engineSchedule, policy: {}, busy, clock: engineClock
    });
    const em = `par${parityN}@example.com`;
    const puid = await db.createAuthUser(em);
    const pcl = await db.rpc('claim_psychologist_profile', {
      p_email: em, p_full_name: 'Par', p_phone: `+37529000${100 + parityN}`,
      p_specialization: 'P', p_city: 'M', p_about: ''
    }, { uid: puid });
    const ppsy = pcl.id;
    await db.query(`insert into session_settings
      (psychologist_id, timezone, work_days, slot_start, slot_end, slot_step_min, payment_policy)
      values ($1,'UTC','[1,2,3,4,5,6,7]','10:00','12:00',60,'none')
      on conflict (psychologist_id) do update set timezone='UTC',
      work_days='[1,2,3,4,5,6,7]', slot_start='10:00', slot_end='12:00',
      slot_step_min=60, payment_policy='none'`, [ppsy]);
    const psvc = (await db.query(
      `insert into services (psychologist_id, title, duration_min, price, currency, is_active)
       values ($1,'Par',60,0,'BYN',true) returning id`, [ppsy]))[0].id;
    if (busy.length) {
      await db.rpc('create_booking', {
        p_psychologist_id: ppsy, p_service_id: psvc, p_session_date: parityDate,
        p_session_time: '10:00', p_client_name: 'Busy', p_client_phone: phone()
      }, { role: 'anon' });
    }
    const srv = await db.rpc('create_booking', {
      p_psychologist_id: ppsy, p_service_id: psvc, p_session_date: parityDate,
      p_session_time: ptime, p_client_name: 'Probe', p_client_phone: phone()
    }, { role: 'anon' });
    const serverOk = srv?.ok === true;
    check(`parity: ${ptime} engine=${eng.ok} server=${serverOk} (ожидание ${expected})`,
      eng.ok === expected && serverOk === expected,
      `engine=${eng.code}/${eng.reason} server=${JSON.stringify(srv)}`);
    parityN++;
  }
} catch (e) {
  // Любой крэш основного потока — красный чек, иначе хвост пропускается
  // и async-exit-hook форсит exit 0 (маскировка провала, D1-QG-004).
  results.push(['FATAL: suite crashed: ' + (e?.message || e), false]);
  console.error('FATAL:', e);
} finally {
  await db.stop();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
await finishSuite(failed.length);
