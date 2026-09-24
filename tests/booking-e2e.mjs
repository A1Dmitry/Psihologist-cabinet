#!/usr/bin/env node
/**
 * D1 recovery — E2E операционного пути записи (наблюдаемое конечное состояние).
 *
 *   node tests/booking-e2e.mjs   (или DB_PORT=xxxx node ...)
 *
 * Настоящий BookingViewModel (без DOM — ViewModel DOM-free) + настоящий
 * public.create_booking из дословного supabase/schema.sql на настоящем
 * PostgreSQL. Подменён ТОЛЬКО транспортной шов: supabaseApi.createBooking
 * и три list* читают embedded PG вместо HTTP (PostgREST как транспорт —
 * ответственность Supabase, не наша; стабы возвращают PostgREST-форму:
 * даты строками 'YYYY-MM-DD'). Весь остальной код — боевой: маппинги
 * pushBooking/refreshAvailability, engine, fraud, vault, reminders, telegram.
 *
 * Проверяется КОНЕЧНОЕ состояние, а не HTTP 200 / текст успеха:
 *  E1 valid_booking: слот принят → строка sessions в PG + строка clients +
 *     запись в booking_attempts + слот busy при перепроверке (VM и прямой
 *     RPC) + зеркало обновлено серверными id + уведомления wired
 *     (bookingText, структурированный no-webhook без throw, reminders).
 *     Meet: автогенерации ссылок НЕТ (SR-002 design-only) — фиксируем
 *     by-design: video_platform записан, meetLink пуст.
 *  E2 blocked_slot: закрытый день исключён из сетки + submit отказывает +
 *     прямой RPC отказывает + в PG пусто.
 *  E3 unauthorized: честные отказы без краша + RLS-изоляция + серверная
 *     деривация оплаты/статуса поверх кованых полей.
 */
import { startTestDatabaseOrExit, finishSuite } from '../tools/dbtest/index.mjs';
import { db } from '../js/core/dbContext.js';
import { Psychologist, Service, SessionSettings } from '../js/models/entities.js';
import { BookingViewModel } from '../js/viewmodels/BookingViewModel.js';
import { fraudProtectionService } from '../js/services/fraudProtectionService.js';
import { supabaseApi } from '../js/services/supabaseApi.js';
import { supabaseSync } from '../js/services/supabaseSync.js';
import { telegramService } from '../js/services/telegramService.js';

const isTeardownNoise = (e) => /terminating connection|57P01/.test(String(e?.message || e));
process.on('uncaughtException', (e) => { if (isTeardownNoise(e)) return; console.error(e); process.exitCode = 1; });
process.on('unhandledRejection', (e) => { if (isTeardownNoise(e)) return; console.error(e); process.exitCode = 1; });

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const dstr = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return dstr(d); };
const pgDate = (v) => (v instanceof Date ? dstr(v) : String(v)).slice(0, 10);

let phoneSeq = 6000000;
const phone = () => `+37533${String(phoneSeq++).padStart(7, '0')}`;

const dbe = await startTestDatabaseOrExit({ port: Number(process.env.DB_PORT || 55437) });
console.log('=== D1 booking E2E: real ViewModel + real RPC ===');

// --- транспортные стабы (PostgREST-форма поверх embedded PG) ---
const origCreate = supabaseApi.createBooking;
const origSlots = supabaseApi.listBookedSlots;
const origBlocks = supabaseApi.listBusyBlocks;
const origOverrides = supabaseApi.listOverrides;
supabaseApi.createBooking = (payload) => dbe.rpc('create_booking', payload, { role: 'anon' });
supabaseApi.listBookedSlots = async (psyId, from, to) => (await dbe.query(
  `select session_date, session_time, duration_min from public_booked_slots
   where psychologist_id = $1 and session_date >= $2 and session_date <= $3`,
  [psyId, from || '2000-01-01', to || '2100-01-01'], { role: 'anon' }))
  .map(r => ({ psychologist_id: psyId, session_date: pgDate(r.session_date), session_time: r.session_time, duration_min: r.duration_min }));
supabaseApi.listBusyBlocks = async (psyId, from, to) => (await dbe.query(
  `select date_from, date_to, time_from, time_to, kind, title from public_schedule_blocks
   where psychologist_id = $1 and date_to >= $2 and date_from <= $3`,
  [psyId, from || '2000-01-01', to || '2100-01-01'], { role: 'anon' }))
  .map(r => ({ psychologist_id: psyId, date_from: pgDate(r.date_from), date_to: pgDate(r.date_to), time_from: r.time_from, time_to: r.time_to, kind: r.kind, title: r.title }));
supabaseApi.listOverrides = async (psyId, from, to) => (await dbe.query(
  `select date, is_closed, open_from, open_to, title from public_schedule_overrides
   where psychologist_id = $1 and date >= $2 and date <= $3`,
  [psyId, from || '2000-01-01', to || '2100-01-01'], { role: 'anon' }))
  .map(r => ({ psychologist_id: psyId, date: pgDate(r.date), is_closed: r.is_closed, open_from: r.open_from, open_to: r.open_to, title: r.title }));

const PSY_SLUG = 'e2e-psy';
let psyId = null, svcId = null;
try {
  // ---------- setup: один психолог в обоих мирах (id совпадают) ----------
  const em = 'e2e@example.com';
  const uid = await dbe.createAuthUser(em);
  const claim = await dbe.rpc('claim_psychologist_profile', {
    p_email: em, p_full_name: 'E2E Psy', p_phone: '+375290009001',
    p_specialization: 'P', p_city: 'M', p_about: ''
  }, { uid });
  psyId = claim.id;
  check('E0: профиль создан', !!psyId);
  await dbe.query(`insert into session_settings
    (psychologist_id, timezone, work_days, slot_start, slot_end, slot_step_min, payment_policy)
    values ($1,'UTC','[1,2,3,4,5,6,7]','10:00','18:00',60,'none')
    on conflict (psychologist_id) do update set timezone='UTC',
    work_days='[1,2,3,4,5,6,7]', slot_start='10:00', slot_end='18:00',
    slot_step_min=60, payment_policy='none'`, [psyId]);
  svcId = (await dbe.query(
    `insert into services (psychologist_id, title, duration_min, price, currency, is_active)
     values ($1,'E2E Online',60,100,'BYN',true) returning id`, [psyId]))[0].id;

  db.psychologists.push(new Psychologist({
    id: psyId, fullName: 'E2E Psy', slug: PSY_SLUG, isActive: true, email: em
  }));
  db.services.push(new Service({ id: svcId, psychologistId: psyId, name: 'E2E Online', duration: 60, format: 'online', price: 100 }));
  db.settings.push(new SessionSettings({
    psychologistId: psyId, timezone: 'UTC', workDays: [1, 2, 3, 4, 5, 6, 7],
    slotStart: '10:00', slotEnd: '18:00', slotStepMin: 60,
    paymentPolicy: 'none' // зеркало PG; дефолт сущности — DEPOSIT
  }));

  const vm = new BookingViewModel();
  check('E0: loadBySlug находит кабинет', vm.loadBySlug(PSY_SLUG) === true);
  fraudProtectionService.formOpenedAt = Date.now() - 30000; // не «слишком быстро»
  const D1 = plusDays(2);
  vm.selectDate(D1);
  await vm.refreshAvailability(); // реальный путь через стабы list*
  const slot12 = vm.slots.find(s => s.time === '12:00');
  check('E0: сетка собрана, 12:00 свободен', slot12?.available === true, slot12 ? `${slot12.code}` : 'нет слота');

  // ---------- E1: valid_booking ----------
  vm.time = '12:00';
  vm.nickname = 'E2E Client';
  vm.phone = '+375291234567';
  vm.contact = '+375291234567';
  vm.note = '';
  vm.consent = true;
  const res = await vm.submit();
  check('E1: submit вернул сессию (не false)', !!res && typeof res === 'object', vm.error || '');
  check('E1: done=true, создан id', vm.done === true && !!vm.createdSessionId, vm.error || '');
  const pgSes = res ? (await dbe.query(`select * from sessions where id = $1`, [res.id]))[0] : null;
  check('E1: строка sessions в PG', !!pgSes, res?.id || 'no-res');
  check('E1: серверная деривация (confirmed/unpaid/60)',
    pgSes?.status === 'confirmed' && pgSes?.payment_status === 'unpaid' && Number(pgSes?.duration_min) === 60,
    JSON.stringify(pgSes && { st: pgSes.status, ps: pgSes.payment_status, dur: pgSes.duration_min }));
  check('E1: video_platform записан, meetLink пуст by-design (SR-002)',
    pgSes?.video_platform === 'google_meet' && (res.meetLink || '') === '',
    `video=${pgSes?.video_platform} meet=${res?.meetLink}`);
  const pgCli = pgSes ? (await dbe.query(`select * from clients where id = $1`, [pgSes.client_id]))[0] : null;
  check('E1: строка clients в PG с согласием', !!pgCli && pgCli.consent === true, JSON.stringify(pgCli && { c: pgCli.consent }));
  check('E1: попытка залогирована (booking_attempts)',
    (await dbe.count('booking_attempts', 'where psychologist_id = $1', [psyId])) >= 1);
  check('E1: зеркало обновлено серверными id',
    res.clientId === pgSes?.client_id && res.durationMin === 60, `${res?.clientId}/${pgSes?.client_id}`);
  // слот теперь занят — обеими сторонами
  const slot12busy = vm.slots.find(s => s.time === '12:00');
  check('E1: VM-сетка: 12:00 теперь busy', slot12busy && slot12busy.available === false, slot12busy?.code || '');
  const rebook = await dbe.rpc('create_booking', {
    p_psychologist_id: psyId, p_service_id: svcId, p_session_date: D1, p_session_time: '12:00',
    p_client_name: 'Second', p_client_phone: phone()
  }, { role: 'anon' });
  check('E1: прямой RPC на тот же слот отклоняется', rebook?.ok === false, JSON.stringify(rebook));
  // уведомления wired (без выдумывания доставки)
  const svcLocal = db.services.find(s => s.id === svcId);
  const cliLocal = db.clients.find(c => c.id === res.clientId) || { name: 'E2E Client' };
  const text = telegramService.bookingText(res, cliLocal, svcLocal);
  check('E1: bookingText содержит клиента/дату/время',
    /Новая запись/.test(text) && text.includes('E2E Client') && text.includes(D1) && text.includes('12:00'), text.slice(0, 120));
  let notifyRes = null, notifyThrew = false;
  try {
    notifyRes = await telegramService.notifyViaWebhook(psyId, 'booking', text, res.createdAt);
  } catch { notifyThrew = true; }
  check('E1: notifyViaWebhook структурно обработан (no-webhook, без throw)',
    notifyThrew === false && notifyRes?.reason === 'no-webhook', JSON.stringify(notifyRes));
  const rems = db.reminders.filter(r => r.sessionId === res.id && r.status === 'scheduled');
  check('E1: напоминания запланированы', rems.length >= 1, String(rems.length));

  // ---------- E2: blocked_slot ----------
  const D2 = plusDays(4);
  await dbe.query(`insert into schedule_overrides (psychologist_id, date, is_closed, title)
    values ($1,$2,true,'Отпуск')`, [psyId, D2]);
  db.addScheduleOverride({ psychologistId: psyId, date: D2, isClosed: true, title: 'Отпуск' });
  vm.selectDate(D2);
  await vm.refreshAvailability();
  const daySlots = vm.slots;
  check('E2: закрытый день — сетка пуста (кандидатов нет)',
    daySlots.length === 0, daySlots.map(s => `${s.time}:${s.code}`).join(','));
  vm.time = '12:00';
  const resBlocked = await vm.submit();
  check('E2: submit на закрытый день отказывает честно',
    resBlocked === false && /недоступно/.test(vm.error || ''), vm.error || '');
  const rpcBlocked = await dbe.rpc('create_booking', {
    p_psychologist_id: psyId, p_service_id: svcId, p_session_date: D2, p_session_time: '12:00',
    p_client_name: 'X', p_client_phone: phone()
  }, { role: 'anon' });
  check('E2: прямой RPC на закрытый день отклоняется',
    rpcBlocked?.ok === false && /записи нет/.test(rpcBlocked?.error || ''), JSON.stringify(rpcBlocked));
  check('E2: в PG на закрытую дату ничего не создано',
    (await dbe.count('sessions', 'where psychologist_id = $1 and session_date = $2', [psyId, D2])) === 0);

  // ---------- E3: unauthorized ----------
  const vmGhost = new BookingViewModel();
  check('E3: неизвестный slug не грузится', vmGhost.loadBySlug('no-such-slug') === false);
  const resGhost = await vmGhost.submit();
  check('E3: submit без психолога — честный отказ без краша',
    resGhost === false && /не выбран/.test(vmGhost.error || ''), vmGhost.error || '');
  let anonReadBlocked = false;
  try {
    await dbe.query(`select * from clients where psychologist_id = $1`, [psyId], { role: 'anon' });
  } catch { anonReadBlocked = true; }
  check('E3: anon не читает clients (RLS)', anonReadBlocked);
  const uidAlien = await dbe.createAuthUser('e2ealien@example.com');
  const alienRows = await dbe.query(`select * from sessions where psychologist_id = $1`,
    [psyId], { role: 'authenticated', uid: uidAlien });
  check('E3: чужой владелец не видит чужие sessions', alienRows.length === 0, String(alienRows.length));
  // кованый push через НАСТОЯЩИЙ supabaseSync.pushBooking (транспорт — стаб)
  const forged = await supabaseSync.pushBooking({
    psychologistId: psyId,
    client: { id: 'cli_forge', name: 'Forge', nickname: 'Forge', phone: phone(), contact: '', note: '', consent: true, consentAt: new Date().toISOString() },
    session: {
      id: 'ses_forge', serviceId: svcId, date: plusDays(5), time: '10:00',
      status: 'done', note: '', videoPlatform: '', paymentPolicy: 'none',
      paymentStatus: 'paid', amountDue: 500, amountPaid: 999, currency: 'BYN',
      clientTimezone: '', clientUtcOffsetMin: null, durationMin: 999
    }
  });
  const frow = forged?.ok ? (await dbe.query(`select status, payment_status, amount_paid, amount_due, duration_min
    from sessions where id = $1`, [forged.sessionId]))[0] : null;
  check('E3: кованые поля перезаписаны сервером (авторитетная деривация)',
    forged?.ok === true && frow?.status === 'confirmed' && frow?.payment_status === 'unpaid'
      && Number(frow?.amount_paid) === 0 && Number(frow?.amount_due) === 0 && Number(frow?.duration_min) === 60,
    JSON.stringify({ forged, frow }));
} catch (e) {
  results.push(['FATAL: suite crashed: ' + (e?.message || e), false]);
  console.error('FATAL:', e);
} finally {
  supabaseApi.createBooking = origCreate;
  supabaseApi.listBookedSlots = origSlots;
  supabaseApi.listBusyBlocks = origBlocks;
  supabaseApi.listOverrides = origOverrides;
  if (psyId) {
    db.psychologists = db.psychologists.filter(p => p.id !== psyId);
    db.services = db.services.filter(s => s.psychologistId !== psyId);
    db.settings = db.settings.filter(s => s.psychologistId !== psyId);
    db.sessions = db.sessions.filter(s => s.psychologistId !== psyId);
  }
  await dbe.stop();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
await finishSuite(failed.length);
