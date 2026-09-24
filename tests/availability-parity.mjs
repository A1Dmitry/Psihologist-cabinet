#!/usr/bin/env node
/**
 * D1 recovery (D1-QG-003) — дифференциальная parity-матрица client ↔ server.
 *
 *   node tests/availability-parity.mjs   (или DB_PORT=xxxx node ...)
 *
 * Один и тот же бизнес-сценарий решают ДВЕ настоящие реализации:
 *   client (advisory): resolveCandidateDurationMinutes + isSlotBookable
 *                      из js/domain/* (импорты настоящие, не моки);
 *   server (authoritative): public.create_booking из дословного
 *                      supabase/schema.sql на настоящем PostgreSQL.
 * Входы engine выводятся из тех же строк БД, что читает сервер.
 * Изолированный психолог на кейс — пробы не влияют друг на друга.
 *
 * Контракт паритета (что именно утверждается):
 *  - одинаковый ok-исход при одиночном нарушении + то же правило
 *    (engine code / server error-regex);
 *  - при МНОЖЕСТВЕННЫХ нарушениях — только исход (порядок проверок
 *    разный: сервер смотрит прошлое раньше закрытия; зафиксировано кейсом);
 *  - well-formed входы. Garbage-in (битые work_days/времена) намеренно
 *    различается: сервер fail-open, engine fail-closed — задокументировано,
 *    не бизнес-сценарий;
 *  - вне скоупа availability (намеренно односторонние серверные решения):
 *    анти-спам, client_risks, деривация оплаты/статуса. Их асимметрия —
 *    архитектура (advisory не должен предсказывать фрод-контроль), кейс P20
 *    фиксирует её явно;
 *  - границы времени — с запасом ≥60с от now (engine и сервер читают часы
 *    в разные миллисекунды); точное равенство на границе (inclusive,
 *    строгий `<` с обеих сторон) — code-proof, не исполнимо детерминированно.
 */
import { startTestDatabaseOrExit, finishSuite } from '../tools/dbtest/index.mjs';
import { isSlotBookable } from '../js/domain/availability.js';
import { resolveCandidateDurationMinutes } from '../js/domain/duration.js';
import { zonedToInstant, instantToZoned } from '../js/services/timezoneService.js';

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
const plusMinutes = (n) => new Date(Date.now() + n * 60000);
const hhmm = (d) => d.toISOString().slice(11, 16);
const isoDow = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
};
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return dstr(new Date(Date.UTC(y, m - 1, d + n, 12, 0, 0)));
};
const t2m = (t) => { const m = /^(\d{2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };

let phoneSeq = 5000000;
const phone = () => `+37544${String(phoneSeq++).padStart(7, '0')}`;

const db = await startTestDatabaseOrExit({ port: Number(process.env.DB_PORT || 55436) });
console.log('=== D1 parity matrix: client engine vs server RPC ===');

const utcClock = () => ({
  nowMs: Date.now(),
  today: dstr(new Date()),
  slotMs: (d, t) => {
    const ms = Date.parse(`${d}T${t}:00Z`);
    return Number.isNaN(ms) ? null : ms;
  }
});
const minskClock = () => {
  const now = new Date();
  return {
    nowMs: now.getTime(),
    today: (instantToZoned(now, 'Europe/Minsk') || {}).date,
    slotMs: (d, t) => {
      const z = zonedToInstant(d, t, 'Europe/Minsk');
      return z ? z.getTime() : null;
    }
  };
};
const berlinClock = () => {
  const now = new Date();
  return {
    nowMs: now.getTime(),
    today: (instantToZoned(now, 'Europe/Berlin') || {}).date,
    slotMs: (d, t) => {
      const z = zonedToInstant(d, t, 'Europe/Berlin');
      return z ? z.getTime() : null;
    }
  };
};

let psySeq = 0;
/** Изолированный психолог + настройки + услуга под кейс. */
async function makePsy({
  tz = 'UTC', workDays = [1, 2, 3, 4, 5, 6, 7],
  slotStart = '10:00', slotEnd = '18:00', step = 60,
  policy = {}, serviceDur = 60, svcAvail = null, slotTimes = null
} = {}) {
  const n = psySeq++;
  const em = `parity${n}@example.com`;
  const uid = await db.createAuthUser(em);
  const claim = await db.rpc('claim_psychologist_profile', {
    p_email: em, p_full_name: 'Parity', p_phone: `+37529001${String(100 + n)}`,
    p_specialization: 'P', p_city: 'M', p_about: ''
  }, { uid });
  const psy = claim.id;
  await db.query(`insert into session_settings
    (psychologist_id, timezone, work_days, slot_start, slot_end, slot_step_min, payment_policy,
     min_notice_minutes, max_advance_days, buffer_before_min, buffer_after_min,
     slot_increment_min, max_bookings_per_day, max_bookings_per_week, slot_times)
    values ($1,$2,$3,$4,$5,$6,'none',$7,$8,$9,$10,$11,$12,$13,$14)
    on conflict (psychologist_id) do update set timezone=$2, work_days=$3,
      slot_start=$4, slot_end=$5, slot_step_min=$6, payment_policy='none',
      min_notice_minutes=$7, max_advance_days=$8, buffer_before_min=$9,
      buffer_after_min=$10, slot_increment_min=$11, max_bookings_per_day=$12,
      max_bookings_per_week=$13, slot_times=$14`,
    [psy, tz, JSON.stringify(workDays), slotStart, slotEnd, step,
      policy.minNoticeMinutes ?? 0, policy.maxAdvanceDays ?? null,
      policy.bufferBeforeMin ?? 0, policy.bufferAfterMin ?? 0,
      policy.slotIncrementMin ?? null, policy.maxBookingsPerDay ?? null,
      policy.maxBookingsPerWeek ?? null,
      slotTimes ? JSON.stringify(slotTimes) : null]);
  const svc = (await db.query(
    `insert into services (psychologist_id, title, duration_min, price, currency, is_active, availability)
     values ($1,'Parity Svc',$2,0,'BYN',true,$3) returning id`,
    [psy, serviceDur, svcAvail ? JSON.stringify(svcAvail) : null]))[0].id;
  return { psy, uid, svc, tz, workDays, slotStart, slotEnd, step, policy, serviceDur, svcAvail, slotTimes };
}

const book = (fx, date, time, extra = {}) => db.rpc('create_booking', {
  p_psychologist_id: fx.psy, p_service_id: fx.svc,
  p_session_date: date, p_session_time: time,
  p_client_name: 'Parity', p_client_phone: phone(), ...extra
}, { role: 'anon' });

/** Занятость engine — из тех же таблиц, что читает сервер. */
async function engineBusy(fx, date) {
  const out = [];
  const rows = await db.query(
    `select s.session_time as t,
            coalesce(s.duration_min, sv.duration_min, ss.slot_step_min, 60) as dur
     from sessions s
     left join services sv on sv.id = s.service_id
     left join session_settings ss on ss.psychologist_id = s.psychologist_id
     where s.psychologist_id = $1 and s.session_date = $2
       and s.status not in ('cancelled','expired','no_show')
       and (s.status <> 'held' or s.hold_expires_at is null or s.hold_expires_at > now())`,
    [fx.psy, date]);
  for (const r of rows) {
    const from = t2m(r.t);
    if (from === null) continue;
    out.push({ from, to: from + Math.max(1, Number(r.dur) || 60), kind: 'booked', title: 'Время занято' });
  }
  const blocks = await db.query(
    `select time_from as tf, time_to as tt, title from schedule_blocks
     where psychologist_id = $1 and $2 between date_from and date_to`, [fx.psy, date]);
  for (const b of blocks) {
    if (!b.tf && !b.tt) { out.push({ from: 0, to: 1440, kind: 'block', title: b.title || 'Закрыто' }); continue; }
    const f = t2m(b.tf || '00:00'), t = t2m(b.tt || '23:59');
    if (f !== null && t !== null && t > f) out.push({ from: f, to: t, kind: 'block', title: b.title || 'Закрыто' });
  }
  return out;
}

/** Счётчики engine — тем же фильтром, что серверные лимиты. */
async function engineCounts(fx, date) {
  const day = (await db.query(
    `select count(*)::int as n from sessions
     where psychologist_id = $1 and session_date = $2
       and status not in ('cancelled','expired','no_show')
       and (status <> 'held' or hold_expires_at is null or hold_expires_at > now())`,
    [fx.psy, date]))[0].n;
  const week = (await db.query(
    `select count(*)::int as n from sessions
     where psychologist_id = $1 and date_trunc('week', session_date::date) = date_trunc('week', $2::date)
       and status not in ('cancelled','expired','no_show')
       and (status <> 'held' or hold_expires_at is null or hold_expires_at > now())`,
    [fx.psy, date]))[0].n;
  return { day, week };
}

async function engineOverrides(fx) {
  const rows = await db.query(
    `select date as d, is_closed as c, open_from as f, open_to as t, title from schedule_overrides
     where psychologist_id = $1`, [fx.psy]);
  return rows.map(r => ({
    date: (r.d instanceof Date ? dstr(r.d) : String(r.d)).slice(0, 10),
    isClosed: !!r.c, openFrom: r.f || '', openTo: r.t || '', title: r.title || ''
  }));
}

/**
 * Вердикт клиентской цепочки: длительность — каноническим резолвером
 * по строке услуги из БД, решение — engine. Возвращает { ok, code, dur }.
 */
async function clientVerdict(fx, date, time, clock) {
  const svcRow = (await db.query(`select duration_min from services where id = $1`, [fx.svc]))[0];
  const dur = resolveCandidateDurationMinutes({
    service: { durationMin: svcRow?.duration_min ?? null }, slotStepMin: fx.step
  });
  const v = isSlotBookable({
    date, time, durationMin: dur,
    schedule: {
      workDays: fx.workDays, slotStart: fx.slotStart, slotEnd: fx.slotEnd,
      slotTimes: fx.slotTimes, stepMin: fx.step, timezone: fx.tz
    },
    policy: {
      minNoticeMinutes: fx.policy.minNoticeMinutes ?? 0,
      maxAdvanceDays: fx.policy.maxAdvanceDays ?? null,
      bufferBeforeMin: fx.policy.bufferBeforeMin ?? 0,
      bufferAfterMin: fx.policy.bufferAfterMin ?? 0,
      slotIncrementMin: fx.policy.slotIncrementMin ?? null,
      maxBookingsPerDay: fx.policy.maxBookingsPerDay ?? null,
      maxBookingsPerWeek: fx.policy.maxBookingsPerWeek ?? null
    },
    serviceAvailability: fx.svcAvail,
    overrides: await engineOverrides(fx),
    busy: await engineBusy(fx, date),
    counts: await engineCounts(fx, date),
    clock
  });
  return { ok: v.ok, code: v.code, reason: v.reason, dur };
}

/** Пара проб: engine + сервер обязаны совпасть с ожиданием. */
async function expectPair(name, fx, date, time, expected, clock, serverRe) {
  const c = await clientVerdict(fx, date, time, clock);
  const s = await book(fx, date, time);
  const srvOk = s?.ok === true;
  const ruleOk = expected ? true : (serverRe ? serverRe.test(s?.error || '') : true);
  const pass = c.ok === expected && srvOk === expected && ruleOk;
  check(`${name} [client=${c.ok}/${c.code} dur=${c.dur} server=${srvOk} ожидание=${expected}]`,
    pass, `client=${c.code}/${c.reason} server=${JSON.stringify(s)}`);
  return { c, s, srvOk };
}

try {
  // ---------- P0: фабрика ----------
  const fx0 = await makePsy();
  check('P0: изолированный психолог создаётся', !!fx0.psy && !!fx0.svc);

  // ---------- P1: closed day (матрица: closed day) ----------
  {
    const fx = await makePsy();
    const d = plusDays(2);
    await db.query(`insert into schedule_overrides (psychologist_id, date, is_closed, title)
      values ($1,$2,true,'Отпуск')`, [fx.psy, d]);
    const c = await clientVerdict(fx, d, '10:00', utcClock());
    const s = await book(fx, d, '10:00');
    check(`P1: закрытый день [client=${c.ok}/${c.code} server=${s?.ok}]`,
      c.ok === false && c.code === 'closed' && s?.ok === false && /В этот день записи нет \(Отпуск\)/.test(s?.error || ''),
      `client=${c.reason} server=${JSON.stringify(s)}`);
    await expectPair('P1-control: обычный день', fx, plusDays(3), '10:00', true, utcClock());
  }

  // ---------- P2: service window (матрица: outside service window) ----------
  {
    const d = plusDays(2);
    const fx = await makePsy({ svcAvail: { days: [isoDow(d)], start: '12:00', end: '14:00' } });
    const c = await clientVerdict(fx, d, '10:00', utcClock());
    const s = await book(fx, d, '10:00');
    check(`P2: 10:00 вне окна услуги [client=${c.ok}/${c.code} server=${s?.ok}]`,
      c.ok === false && c.code === 'outside_window' && s?.ok === false && /вне часов приёма/i.test(s?.error || ''),
      `client=${c.reason} server=${JSON.stringify(s)}`);
    await expectPair('P2-control: 12:00 внутри окна', fx, d, '12:00', true, utcClock());
    const dOther = plusDays(3);
    if (isoDow(dOther) !== isoDow(d)) {
      await expectPair('P2: другой день недели', fx, dOther, '12:00', false, utcClock(), /приёма нет/);
    } else {
      check('P2: другой день недели (пропуск совпадения дня)', true);
    }
  }

  // ---------- P3: minimum notice (матрица: minimum notice) ----------
  {
    const fx = await makePsy({ slotStart: '00:00', slotEnd: '23:00', policy: { minNoticeMinutes: 10 } });
    const near = plusMinutes(9);
    await expectPair('P3: +9 мин при notice 10 → reject', fx, dstr(near), hhmm(near), false, utcClock(), /минимум за 10 мин/);
    const okT = plusMinutes(11);
    await expectPair('P3: +11 мин при notice 10 → ok', fx, dstr(okT), hhmm(okT), true, utcClock());
    const ctl = plusMinutes(240);
    await expectPair('P3-control: +240 мин → ok', fx, dstr(ctl), hhmm(ctl), true, utcClock());
  }

  // ---------- P4: maximum advance (матрица: maximum advance) ----------
  {
    const fx = await makePsy({ policy: { maxAdvanceDays: 7 } });
    await expectPair('P4: +8 дн при горизонте 7 → reject', fx, plusDays(8), '10:00', false, utcClock(), /только на 7 дн/);
    await expectPair('P4: граница +7 дн → ok', fx, plusDays(7), '10:00', true, utcClock());
  }

  // ---------- P5: day limit (матрица: day limit) ----------
  {
    const fx = await makePsy({ policy: { maxBookingsPerDay: 1 } });
    const d = plusDays(2);
    await expectPair('P5: первая запись → ok', fx, d, '10:00', true, utcClock());
    await expectPair('P5: вторая в тот же день → reject', fx, d, '12:00', false, utcClock(), /На этот день мест больше нет/);
  }

  // ---------- P6: week limit (матрица: week limit) ----------
  {
    const fx = await makePsy({ policy: { maxBookingsPerWeek: 1 } });
    const base = plusDays(14);
    const monday = addDays(base, -(isoDow(base) - 1));
    await expectPair('P6: первая на неделе → ok', fx, monday, '10:00', true, utcClock());
    await expectPair('P6: вторая на той же неделе → reject', fx, addDays(monday, 1), '10:00', false, utcClock(), /На эту неделю мест больше нет/);
  }

  // ---------- P7: buffers (матрица: buffer before/after) ----------
  {
    const fx = await makePsy({ policy: { bufferBeforeMin: 30, bufferAfterMin: 30 } });
    const d = plusDays(2);
    await expectPair('P7: база 11:00 → ok', fx, d, '11:00', true, utcClock());
    await expectPair('P7: 10:00 упирается в buffer_before → reject', fx, d, '10:00', false, utcClock(), /только что заняли/);
    await expectPair('P7: 12:00 упирается в buffer_after → reject', fx, d, '12:00', false, utcClock(), /только что заняли/);
    await expectPair('P7: 13:00 за буферами (касание) → ok', fx, d, '13:00', true, utcClock());
  }

  // ---------- P8: busy overlap (матрица: busy overlap) ----------
  {
    const fx = await makePsy();
    const d = plusDays(2);
    await expectPair('P8: база 10:00 → ok', fx, d, '10:00', true, utcClock());
    await expectPair('P8: 10:30 пересекает → reject', fx, d, '10:30', false, utcClock(), /только что заняли/);
    await expectPair('P8: 11:00 касание → ok', fx, d, '11:00', true, utcClock());
  }

  // ---------- P9: blocked period (матрица: blocked period) ----------
  {
    const fx = await makePsy();
    const d = plusDays(2);
    await db.query(`insert into schedule_blocks (psychologist_id, date_from, date_to, time_from, time_to, title)
      values ($1,$2,$2,'12:00','14:00','Перерыв')`, [fx.psy, d]);
    const c = await clientVerdict(fx, d, '13:00', utcClock());
    const s = await book(fx, d, '13:00');
    check(`P9: 13:00 в блокировке [client=${c.ok}/${c.code} server=${s?.ok}]`,
      c.ok === false && c.code === 'blocked' && s?.ok === false && /не принимает/.test(s?.error || ''),
      `client=${c.reason} server=${JSON.stringify(s)}`);
    await expectPair('P9-control: 15:00 вне блокировки → ok', fx, d, '15:00', true, utcClock());
  }

  // ---------- P10: explicit grid (матрица: explicit slot grid) ----------
  {
    const fx = await makePsy({ policy: { slotIncrementMin: 30 }, slotTimes: ['10:00', '14:00'] });
    const d = plusDays(2);
    await expectPair('P10: явная сетка бьёт инкремент (10:15) → ok', fx, d, '10:15', true, utcClock());
    const fx2 = await makePsy({ policy: { slotIncrementMin: 30 } });
    await expectPair('P10: инкремент без сетки (10:15) → reject', fx2, d, '10:15', false, utcClock(), /каждые 30 мин/);
  }

  // ---------- P11: past (матрица: past slot) ----------
  {
    const fx = await makePsy({ slotStart: '00:00', slotEnd: '23:00' });
    const past = plusMinutes(-120);
    const c = await clientVerdict(fx, dstr(past), hhmm(past), utcClock());
    const s = await book(fx, dstr(past), hhmm(past));
    check(`P11: прошлое [client=${c.ok}/${c.code} server=${s?.ok}]`,
      c.ok === false && c.code === 'past' && s?.ok === false && /прошло/i.test(s?.error || ''),
      `client=${c.reason} server=${JSON.stringify(s)}`);
    const fut = plusMinutes(180);
    await expectPair('P11-control: будущее → ok', fx, dstr(fut), hhmm(fut), true, utcClock());
  }

  // ---------- P12: grace band (матрица: duration overflow) — РЕГРЕСС D1-QG-003 ----------
  {
    const fx = await makePsy(); // окно 10:00–18:00, шаг 60 → grace 19:00
    const d = plusDays(2);
    const g = await expectPair('P12-REGRESS: 18:00+60 = grace 19:00 → ОБА ПРИНИМАЮТ', fx, d, '18:00', true, utcClock());
    const row = await db.count('sessions', 'where psychologist_id = $1 and session_date = $2 and session_time = $3',
      [fx.psy, d, '18:00']);
    check('P12-REGRESS: запись 18:00 персистентна (end-state)', g.srvOk && row === 1, `rows=${row}`);
    await expectPair('P12: 18:30+60 = 19:30 > grace → оба reject', fx, d, '18:30', false, utcClock(), /не хватает/);
    await expectPair('P12: 19:00+60 = 20:00 > grace → оба reject', fx, d, '19:00', false, utcClock(), /не хватает/);
  }

  // ---------- P13: duration clamp (матрица: duration) — РЕГРЕСС D1-QG-003 ----------
  {
    const fx = await makePsy({ serviceDur: 500 }); // сервер клампит к 60
    const d = plusDays(2);
    const c = await clientVerdict(fx, d, '10:00', utcClock());
    const s = await book(fx, d, '10:00');
    check(`P13-REGRESS: услуга 500 мин [clientDur=${c.dur} serverDur=${s?.duration_min} server=${s?.ok}]`,
      c.dur === 60 && s?.ok === true && s?.duration_min === 60 && c.ok === true,
      `client=${c.code} server=${JSON.stringify(s)}`);
    // Дискриминирующая проба: 15:00 + 500 = 23:20 (старый клиент: too_long),
    // 15:00 + 60 = 16:00 (сервер и новый клиент: ok).
    await expectPair('P13-REGRESS: услуга 500 мин в 15:00 → оба ok (кламп)', fx, d, '15:00', true, utcClock());
    // services.duration_min — NOT NULL: живой null-путь только «запись без услуги»
    // (клиент услугу требует — серверный пин без engine-пары).
    const fx2 = await makePsy({ step: 30 });
    const s2 = await db.rpc('create_booking', {
      p_psychologist_id: fx2.psy, p_service_id: null,
      p_session_date: d, p_session_time: '17:45',
      p_client_name: 'X', p_client_phone: phone()
    }, { role: 'anon' });
    check(`P13: запись без услуги + шаг 30 → длительность 30 [serverDur=${s2?.duration_min}]`,
      s2?.ok === true && s2?.duration_min === 30, JSON.stringify(s2));
  }

  // ---------- P14: кабинет не в UTC (пояс специалиста, не сервера) ----------
  {
    const fx = await makePsy({ tz: 'Europe/Minsk' }); // UTC+3, без DST
    const probeDay = plusDays(2);
    await expectPair('P14: Минск, будущее → оба ok', fx, probeDay, '12:00', true, minskClock());
    // Момент час назад, записанный минской стеной: обе стороны видят прошлое.
    const pastD = dstr(new Date(Date.now() - 3600000));
    const pastT = new Date(Date.now() - 3600000 + 3 * 3600000).toISOString().slice(11, 16);
    const c = await clientVerdict(fx, pastD, pastT, minskClock());
    const s = await book(fx, pastD, pastT);
    check(`P14: Минск, прошлое [client=${c.ok}/${c.code} server=${s?.ok}]`,
      c.ok === false && c.code === 'past' && s?.ok === false,
      `client=${c.reason} server=${JSON.stringify(s)}`);
  }

  // ---------- P21: DST-разрыв (Challenger-атака → регресс-пин) ----------
  // 2027-03-28 02:30 Europe/Berlin не существует (переход 02:00→03:00).
  // Обе стороны резолвят одинаково (pre-transition offset → 01:30Z);
  // исключать ли несуществующие времена из сетки — продуктовое решение
  // владельца, здесь фиксируем согласованность.
  {
    const fx = await makePsy({ tz: 'Europe/Berlin', slotStart: '00:00', slotEnd: '23:00' });
    await expectPair('P21: DST-gap 02:30 → оба ok (одинаковый резолв)', fx, '2027-03-28', '02:30', true, berlinClock());
    await expectPair('P21-control: 12:00 в gap-день → оба ok', fx, '2027-03-28', '12:00', true, berlinClock());
  }

  // ---------- P15: множественные нарушения — только исход ----------
  {
    const fx = await makePsy();
    const d = plusDays(-1); // вчера + закрытие: engine скажет closed, сервер — прошлое
    await db.query(`insert into schedule_overrides (psychologist_id, date, is_closed, title)
      values ($1,$2,true,'X')`, [fx.psy, d]);
    const c = await clientVerdict(fx, d, '10:00', utcClock());
    const s = await book(fx, d, '10:00');
    check(`P15: вчера+закрыто → оба reject (коды МОГУТ различаться) [client=${c.code} server=${JSON.stringify(s?.error)}]`,
      c.ok === false && s?.ok === false, `client=${c.reason}`);
  }

  // ---------- P16: fetch-контракт публичных views ----------
  {
    const fx = await makePsy();
    const d = plusDays(2);
    await book(fx, d, '10:00');
    const rows = await db.query(
      `select session_time as t, duration_min as dur from public_booked_slots
       where psychologist_id = $1 and session_date = $2`, [fx.psy, d], { role: 'anon' });
    check('P16: anon видит блокирующую запись со снимком длительности',
      rows.length === 1 && rows[0].t === '10:00' && Number(rows[0].dur) === 60, JSON.stringify(rows));
  }

  // ---------- P17: unauthorized direct RPC (матрица) ----------
  {
    const fx = await makePsy();
    let anonInsertBlocked = false;
    try {
      await db.query(`insert into sessions (psychologist_id, client_id, session_date, session_time, status)
        values ($1,'x','2030-01-01','10:00','confirmed')`, [fx.psy], { role: 'anon' });
    } catch { anonInsertBlocked = true; }
    check('P17: anon не вставляет sessions напрямую (RLS)', anonInsertBlocked);
    const forged = await book(fx, plusDays(2), '10:00', {
      p_status: 'done', p_payment_status: 'paid', p_amount_paid: 999, p_amount_due: 500, p_duration_min: 999
    });
    const frow = forged?.ok ? (await db.query(
      `select status, payment_status, amount_paid, amount_due, duration_min
       from sessions where id = $1`, [forged.session_id]))[0] : null;
    check('P17: кованые оплата/статус/длительность проигнорированы (авторитет — сервер)',
      forged?.ok === true && frow && frow.status === 'confirmed'
        && frow.payment_status === 'unpaid' && Number(frow.amount_paid) === 0
        && Number(frow.amount_due) === 0 && Number(frow.duration_min) === 60,
      JSON.stringify({ forged, frow }));
    const alien = await makePsy();
    const cross = await db.rpc('create_booking', {
      p_psychologist_id: fx.psy, p_service_id: alien.svc,
      p_session_date: plusDays(3), p_session_time: '10:00',
      p_client_name: 'X', p_client_phone: phone()
    }, { role: 'anon' });
    check('P17: чужая услуга отклоняется (ownership)',
      cross?.ok === false && /не принадлежит/.test(cross?.error || ''), JSON.stringify(cross));
  }

  // ---------- P18: alternate route bypass (матрица) ----------
  {
    const fx = await makePsy();
    const alien = await makePsy();
    let alienInsertBlocked = false;
    try {
      await db.query(`insert into sessions (psychologist_id, client_id, session_date, session_time, status)
        values ($1,'x','2030-01-01','10:00','confirmed')`, [fx.psy],
        { role: 'authenticated', uid: alien.uid });
    } catch { alienInsertBlocked = true; }
    check('P18: чужой владелец не вставляет sessions (RLS)', alienInsertBlocked);
    const before = (await db.query(`select slot_start from session_settings where psychologist_id = $1`, [fx.psy]))[0]?.slot_start;
    let alienUpdateBlocked = false;
    try {
      await db.query(`update session_settings set slot_start = '01:00' where psychologist_id = $1`,
        [fx.psy], { role: 'authenticated', uid: alien.uid });
      const after = (await db.query(`select slot_start from session_settings where psychologist_id = $1`, [fx.psy]))[0]?.slot_start;
      alienUpdateBlocked = after === before;
    } catch { alienUpdateBlocked = true; }
    check('P18: чужой владелец не меняет чужие настройки', alienUpdateBlocked);
  }

  // ---------- P19: invalid input (матрица) ----------
  {
    const fx = await makePsy();
    const bad = [
      ['битая дата', plusDays(2).slice(0, 7) + '-xx', '10:00', /формат даты|Неверная дата/],
      ['несуществующая дата', '2026-13-45', '10:00', /формат даты|Неверная дата/],
      ['битое время', plusDays(2), '25:00', /формат времени|Неверное время/],
      ['мусорное время', plusDays(2), 'ab:cd', /формат времени|Неверное время/],
      ['нет услуги', plusDays(2), '10:00', /Услуга не найдена/, { p_service_id: 'nope' }],
      ['нет психолога', plusDays(2), '10:00', /не найден/, { psy: 'ghost' }]
    ];
    for (const [label, date, time, re, extra] of bad) {
      let threw = false, res = null;
      try {
        res = await db.rpc('create_booking', {
          p_psychologist_id: extra?.psy || fx.psy, p_service_id: extra?.p_service_id ?? fx.svc,
          p_session_date: date, p_session_time: time,
          p_client_name: 'X', p_client_phone: phone()
        }, { role: 'anon' });
      } catch (e) { threw = true; res = { error: String(e?.message || e) }; }
      check(`P19: ${label} → вежливый отказ (без 500)`,
        threw === false && res?.ok === false && re.test(res?.error || ''), JSON.stringify(res));
    }
  }

  // ---------- P20: duplicate + anti-spam (матрица) ----------
  {
    const fx = await makePsy();
    const d = plusDays(3);
    const dup1 = await book(fx, d, '10:00');
    const dup2 = await book(fx, d, '10:00');
    check('P20: повтор на тот же слот отклоняется (busy)',
      dup1?.ok === true && dup2?.ok === false && /только что заняли/.test(dup2?.error || ''),
      JSON.stringify({ dup1, dup2 }));
    const spamPhone = phone();
    const spam = [];
    for (const t of ['11:00', '12:00', '13:00', '14:00']) {
      spam.push(await db.rpc('create_booking', {
        p_psychologist_id: fx.psy, p_service_id: fx.svc, p_session_date: d, p_session_time: t,
        p_client_name: 'Spam', p_client_phone: spamPhone
      }, { role: 'anon' }));
    }
    check('P20: 3 быстрые записи с одного номера → ok',
      spam.slice(0, 3).every(r => r?.ok === true), JSON.stringify(spam));
    const fourth = spam[3];
    const cSpam = await clientVerdict(fx, d, '14:00', utcClock());
    check('P20: 4-я отклоняется анти-спамом (намеренная асимметрия: advisory ok)',
      fourth?.ok === false && /Слишком много/.test(fourth?.error || '') && cSpam.ok === true,
      JSON.stringify({ fourth, client: cSpam.code }));
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
