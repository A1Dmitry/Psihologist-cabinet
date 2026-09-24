#!/usr/bin/env node
/**
 * D1 — Availability + Booking Policy Engine: чистые доменные проверки (без БД).
 *
 *   node tests/availability-policy.mjs
 *
 * Фиксированный fake-clock: «сейчас» = 2026-09-24T09:00:00Z (четверг),
 * настенное время трактуется как UTC (пояс инжектится вызывателем —
 * здесь детерминированная подмена timezoneService).
 * Серверный паритет тех же правил — в tests/availability-db.mjs.
 */
import {
  AvailabilityDefaults,
  parseTimeToMinutes,
  minutesToTimeLabel,
  isoWeekdayOf,
  isoWeekStartOf,
  addDaysIso,
  normalizePolicy,
  normalizeServiceAvailability,
  resolveEffectiveSchedule,
  overrideOn,
  generateCandidates,
  evaluateDate,
  evaluateSlot,
  computeBookableSlots,
  isSlotBookable
} from '../js/domain/availability.js';
import { timeToMinutes as canonicalTimeToMinutes } from '../js/services/timezoneService.js';

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

// Fake clock: now = Thu 2026-09-24 09:00 UTC; стена = UTC.
const NOW_MS = Date.parse('2026-09-24T09:00:00Z');
const fakeClock = (today = '2026-09-24') => ({
  nowMs: NOW_MS,
  today,
  slotMs: (date, time) => {
    const ms = Date.parse(`${date}T${String(time).slice(0, 5)}:00Z`);
    return Number.isNaN(ms) ? null : ms;
  }
});

const baseSchedule = {
  workDays: [1, 2, 3, 4, 5],
  slotStart: '10:00',
  slotEnd: '18:00',
  slotTimes: null,
  stepMin: 60,
  timezone: 'UTC'
};

/* ===== 1. Примитивы ===== */
check('parse: 10:30 → 630', parseTimeToMinutes('10:30') === 630);
check('parse: 9:05 → 545', parseTimeToMinutes('9:05') === 545);
check('parse: 24:00 → 1440 (конец суток)', parseTimeToMinutes('24:00') === 1440);
for (const bad of ['', 'abc', '25:00', '10:60', '10', '24:30', null, undefined]) {
  check(`parse: ${JSON.stringify(bad)} → null`, parseTimeToMinutes(bad) === null);
}
// Паритет с каноническим парсером на корпусе обычных времён.
const corpus = ['00:00', '09:05', '10:00', '12:30', '18:00', '23:59', '24:00', '7:15'];
const parity = corpus.every(t => parseTimeToMinutes(t) === canonicalTimeToMinutes(t));
check('parse: паритет с timezoneService.timeToMinutes', parity);
check('label: 630 → 10:30', minutesToTimeLabel(630) === '10:30');
check('label: 1440 → 00:00 (заворот)', minutesToTimeLabel(1440) === '00:00');
check('weekday: 2026-09-24 = четверг (4)', isoWeekdayOf('2026-09-24') === 4);
check('weekday: 2026-09-27 = воскресенье (7)', isoWeekdayOf('2026-09-27') === 7);
check('weekday: мусор → null', isoWeekdayOf('nope') === null);
check('weekStart: 2026-09-24 → 2026-09-21 (Пн)', isoWeekStartOf('2026-09-24') === '2026-09-21');
check('weekStart: 2026-09-27 (Вс) → 2026-09-21', isoWeekStartOf('2026-09-27') === '2026-09-21');
check('addDays: +3 через конец месяца', addDaysIso('2026-09-24', 3) === '2026-09-27');

/* ===== 2. Нормализация ===== */
{
  const p = normalizePolicy({ minNoticeMinutes: -5, bufferBeforeMin: 'x', maxAdvanceDays: 7.9 });
  check('policy: отрицательный notice → 0', p.minNoticeMinutes === 0);
  check('policy: мусорный буфер → 0', p.bufferBeforeMin === 0);
  check('policy: дробный горизонт → floor', p.maxAdvanceDays === 7);
  check('policy: неуказанные лимиты → null', p.maxBookingsPerDay === null && p.maxBookingsPerWeek === null);
  check('policy: дефолты сохраняют поведение до D1',
    AvailabilityDefaults.minNoticeMinutes === 0 && AvailabilityDefaults.maxAdvanceDays === null &&
    AvailabilityDefaults.bufferBeforeMin === 0 && AvailabilityDefaults.slotIncrementMin === null);
}
{
  const full = normalizeServiceAvailability({ days: [1, 2, 2, 9], start: '12:00', end: 'xx' });
  check('svcAvail: дни чистятся/дедупятся', JSON.stringify(full.days) === '[1,2]');
  check('svcAvail: валидный start сохраняется', full.start === '12:00');
  check('svcAvail: мусорный end отбрасывается', full.end === null);
  check('svcAvail: мусор → null (наследовать всё)', normalizeServiceAvailability({ days: [9] }) === null);
  check('svcAvail: null → null', normalizeServiceAvailability(null) === null);
}
{
  const eff = resolveEffectiveSchedule({ settings: baseSchedule });
  check('schedule: наследование дней из настроек', JSON.stringify(eff.workDays) === '[1,2,3,4,5]');
  const ov = resolveEffectiveSchedule({
    serviceAvailability: { days: [6], start: '12:00' },
    settings: baseSchedule
  });
  check('schedule: услуга перекрывает дни', JSON.stringify(ov.workDays) === '[6]');
  check('schedule: услуга перекрывает start', ov.slotStart === '12:00');
  check('schedule: end наследуется', ov.slotEnd === '18:00');
}
check('overrideOn: массив находит дату', overrideOn([{ date: '2026-09-25', isClosed: true }], '2026-09-25')?.isClosed === true);
check('overrideOn: map находит дату', overrideOn({ '2026-09-25': { date: '2026-09-25' } }, '2026-09-25') !== null);
check('overrideOn: нет → null', overrideOn([], '2026-09-25') === null);

/* ===== 3. Кандидаты ===== */
{
  const g = generateCandidates({ schedule: { ...baseSchedule } });
  check('candidates: почасовая сетка 10:00–17:00 = 8 стартов (старт строго до закрытия)',
    g.candidates.length === 8 && g.candidates[0] === '10:00' && g.candidates[7] === '17:00',
    g.candidates.join(','));
  check('candidates: windowEnd = max(last+step, slotEnd) = 18:00', g.windowEndMin === 1080);
  const g15 = generateCandidates({ schedule: { ...baseSchedule }, policy: { slotIncrementMin: 15 } });
  check('candidates: инкремент 15 → 32 старта (10:00–17:45)', g15.candidates.length === 32, String(g15.candidates.length));
  check('candidates: инкремент 15 включает 10:15', g15.candidates.includes('10:15'));
  const gExp = generateCandidates({ schedule: { ...baseSchedule, slotTimes: ['10:00', '14:00'] } });
  check('candidates: явный slotTimes — как есть', JSON.stringify(gExp.candidates) === '["10:00","14:00"]');
  check('candidates: явный список побеждает инкремент',
    generateCandidates({
      schedule: { ...baseSchedule, slotTimes: ['10:00', '14:00'] },
      policy: { slotIncrementMin: 15 }
    }).candidates.length === 2);
  const gClosed = generateCandidates({
    schedule: baseSchedule, override: { date: '2026-09-25', isClosed: true }
  });
  check('candidates: closed → пусто', gClosed.candidates.length === 0);
  const gWin = generateCandidates({
    schedule: baseSchedule, override: { date: '2026-09-25', openFrom: '12:00', openTo: '14:00' }
  });
  check('candidates: override-окно 12:00–14:00 → 12:00,13:00',
    JSON.stringify(gWin.candidates) === '["12:00","13:00"]', gWin.candidates.join(','));
}

/* ===== 4. Дата ===== */
{
  const ok = evaluateDate({ date: '2026-09-24', today: '2026-09-24', schedule: baseSchedule });
  check('date: будний день → ok', ok.available && ok.code === 'ok');
  const sun = evaluateDate({ date: '2026-09-27', today: '2026-09-24', schedule: baseSchedule });
  check('date: воскресенье → day_off', !sun.available && sun.code === 'day_off');
  const closed = evaluateDate({
    date: '2026-09-25', today: '2026-09-24', schedule: baseSchedule,
    override: { date: '2026-09-25', isClosed: true, title: 'Отпуск' }
  });
  check('date: override closed → closed с подписью', !closed.available && closed.code === 'closed' && /Отпуск/.test(closed.reason));
  const adv = evaluateDate({
    date: '2026-10-05', today: '2026-09-24', schedule: baseSchedule, policy: { maxAdvanceDays: 7 }
  });
  check('date: за горизонтом → advance', !adv.available && adv.code === 'advance');
  const advEdge = evaluateDate({
    date: '2026-10-01', today: '2026-09-24', schedule: baseSchedule, policy: { maxAdvanceDays: 7 }
  });
  check('date: граница горизонта (today+7) → ok', advEdge.available);
  const dl = evaluateDate({
    date: '2026-09-24', today: '2026-09-24', schedule: baseSchedule,
    policy: { maxBookingsPerDay: 2 }, counts: { day: 2, week: 2 }
  });
  check('date: дневной лимит исчерпан → day_limit', !dl.available && dl.code === 'day_limit');
  const wl = evaluateDate({
    date: '2026-09-24', today: '2026-09-24', schedule: baseSchedule,
    policy: { maxBookingsPerWeek: 5 }, counts: { day: 1, week: 5 }
  });
  check('date: недельный лимит исчерпан → week_limit', !wl.available && wl.code === 'week_limit');
  const lim0 = evaluateDate({
    date: '2026-09-24', today: '2026-09-24', schedule: baseSchedule,
    policy: { maxBookingsPerDay: 0 }, counts: { day: 0 }
  });
  check('date: лимит 0 = закрыто', !lim0.available && lim0.code === 'day_limit');
}

/* ===== 5. Слот ===== */
const winOf = (w = {}) => ({ windowStartMin: 600, windowEndMin: 1140, ...w });
{
  const v = evaluateSlot({ date: '2026-09-24', time: '10:00', durationMin: 60, window: winOf(), clock: fakeClock() });
  check('slot: свободный будущий → ok', v.available && v.code === 'ok', v.code);
  const early = evaluateSlot({ date: '2026-09-24', time: '09:00', durationMin: 60, window: winOf(), clock: fakeClock() });
  check('slot: раньше окна → outside_window', !early.available && early.code === 'outside_window', early.code);
  const past = evaluateSlot({
    date: '2026-09-24', time: '08:30', durationMin: 60,
    window: winOf({ windowStartMin: 480 }), clock: fakeClock()
  });
  check('slot: прошлое → past', !past.available && past.code === 'past', past.code);
  const long = evaluateSlot({ date: '2026-09-24', time: '18:30', durationMin: 60, window: winOf(), clock: fakeClock() });
  check('slot: 60 мин в 18:30 не влезает → too_long', !long.available && long.code === 'too_long', long.code);
  const edge = evaluateSlot({ date: '2026-09-24', time: '18:00', durationMin: 60, window: winOf(), clock: fakeClock() });
  check('slot: 18:00+60 = границе окна → ok', edge.available, edge.code);
  const busy = evaluateSlot({
    date: '2026-09-24', time: '11:00', durationMin: 60, window: winOf(), clock: fakeClock(),
    busy: [{ from: 660, to: 720, kind: 'booked', title: 'Время занято' }]
  });
  check('slot: пересечение с записью → busy', !busy.available && busy.code === 'busy', busy.code);
  const blocked = evaluateSlot({
    date: '2026-09-24', time: '11:00', durationMin: 60, window: winOf(), clock: fakeClock(),
    busy: [{ from: 660, to: 720, kind: 'block', title: 'Отпуск' }]
  });
  check('slot: пересечение с блокировкой → blocked с подписью',
    !blocked.available && blocked.code === 'blocked' && blocked.reason === 'Отпуск', blocked.code);
  const touch = evaluateSlot({
    date: '2026-09-24', time: '12:00', durationMin: 60, window: winOf(), clock: fakeClock(),
    busy: [{ from: 660, to: 720, kind: 'booked', title: 'Время занято' }]
  });
  check('slot: касание границы (12:00 после 11:00–12:00) → ok', touch.available, touch.code);
  const notice = evaluateSlot({
    date: '2026-09-24', time: '10:00', durationMin: 60, window: winOf(), clock: fakeClock(),
    policy: { minNoticeMinutes: 120 }
  });
  check('slot: ближе notice (10:00 при now 09:00 + 120 мин) → notice', !notice.available && notice.code === 'notice', notice.code);
  check('slot: notice кратно часу формулируется в часах (паритет с сервером)',
    /минимум за 2 ч/.test(notice.reason), notice.reason);
  const noticeOk = evaluateSlot({
    date: '2026-09-24', time: '11:00', durationMin: 60, window: winOf(), clock: fakeClock(),
    policy: { minNoticeMinutes: 120 }
  });
  check('slot: ровно на границе notice (11:00) → ok', noticeOk.available, noticeOk.code);
  const mis = evaluateSlot({
    date: '2026-09-24', time: '10:15', durationMin: 60, window: winOf(), clock: fakeClock(),
    policy: { slotIncrementMin: 30 }
  });
  check('slot: 10:15 при инкременте 30 → misaligned', !mis.available && mis.code === 'misaligned', mis.code);
  const misExp = evaluateSlot({
    date: '2026-09-24', time: '10:15', durationMin: 60, window: winOf(), clock: fakeClock(),
    policy: { slotIncrementMin: 30 }, explicitGrid: true
  });
  check('slot: явная сетка отменяет инкремент → ok', misExp.available, misExp.code);
  const noClock = evaluateSlot({ date: '2026-09-24', time: '10:00', durationMin: 60, window: winOf(), clock: {} });
  check('slot: нет clock → unavailable (fail-closed)', !noClock.available && noClock.code === 'unavailable', noClock.code);
}

/* ===== 6. Буферы ===== */
{
  const booked11 = [{ from: 660, to: 720, kind: 'booked', title: 'Время занято' }];
  const buf = { bufferBeforeMin: 0, bufferAfterMin: 30 };
  const v = evaluateSlot({
    date: '2026-09-24', time: '12:00', durationMin: 60, window: winOf(), clock: fakeClock(),
    busy: booked11, policy: buf
  });
  check('buffer: 12:00 после 11:00–12:00 + buffer_after 30 → busy', !v.available && v.code === 'busy', v.code);
  const v2 = evaluateSlot({
    date: '2026-09-24', time: '12:30', durationMin: 60, window: winOf(), clock: fakeClock(),
    busy: booked11, policy: buf
  });
  check('buffer: 12:30 (за буфером) → ok', v2.available, v2.code);
  const v3 = evaluateSlot({
    date: '2026-09-24', time: '10:00', durationMin: 60, window: winOf(), clock: fakeClock(),
    busy: booked11, policy: { bufferBeforeMin: 15, bufferAfterMin: 0 }
  });
  check('buffer: 10:00–11:00 упирается в буфер записи 11:00 → busy', !v3.available && v3.code === 'busy', v3.code);
  const v4 = evaluateSlot({
    date: '2026-09-24', time: '09:45', durationMin: 60, window: winOf({ windowStartMin: 540 }), clock: fakeClock(),
    busy: booked11, policy: { bufferBeforeMin: 15, bufferAfterMin: 0 }
  });
  check('buffer: касание границы буфера (конец 10:45) → ok', v4.available, v4.code);
  const blockRaw = evaluateSlot({
    date: '2026-09-24', time: '12:00', durationMin: 60, window: winOf(), clock: fakeClock(),
    busy: [{ from: 660, to: 720, kind: 'block', title: 'Перерыв' }], policy: buf
  });
  check('buffer: блокировки не расширяются (12:00 после блока до 12:00) → ok',
    blockRaw.available, blockRaw.code);
}

/* ===== 7. computeBookableSlots — день целиком ===== */
{
  const r = computeBookableSlots({
    date: '2026-09-24', durationMin: 60, schedule: baseSchedule, clock: fakeClock()
  });
  check('day: 8 кандидатов в будний день (10:00–17:00)', r.slots.length === 8, String(r.slots.length));
  check('day: все будущие свободны → 8 available',
    r.slots.filter(s => s.available).length === 8, r.slots.map(s => `${s.time}:${s.code}`).join(','));
  check('day: dateAvailable=true', r.dateAvailable === true);
  const rSun = computeBookableSlots({
    date: '2026-09-27', durationMin: 60, schedule: baseSchedule, clock: fakeClock()
  });
  check('day: воскресенье → dateAvailable=false, код day_off',
    rSun.dateAvailable === false && rSun.dateCode === 'day_off', rSun.dateCode);
  check('day: воскресенье → все слоты недоступны',
    rSun.slots.length === 8 && rSun.slots.every(s => !s.available && s.code === 'day_off'));
  const rBusy = computeBookableSlots({
    date: '2026-09-24', durationMin: 90, schedule: baseSchedule, clock: fakeClock(),
    busy: [{ from: 720, to: 780, kind: 'booked', title: 'Время занято' }]
  });
  const byTime = Object.fromEntries(rBusy.slots.map(s => [s.time, s]));
  check('day: 90 мин в 11:00 пересекает 12:00–13:00 → busy', byTime['11:00'].code === 'busy', byTime['11:00'].code);
  check('day: 90 мин в 13:00 свободно → ok', byTime['13:00'].available, byTime['13:00'].code);
  check('day: 18:00 не кандидат (старт в закрытие не предлагается)', byTime['18:00'] === undefined);
  check('day: 90 мин в 17:00 не влезает → too_long', byTime['17:00'].code === 'too_long', byTime['17:00'].code);
  const rSvc = computeBookableSlots({
    date: '2026-09-24', durationMin: 60, schedule: baseSchedule, clock: fakeClock(),
    serviceAvailability: { days: [2], start: '12:00', end: '14:00' }
  });
  check('day: услуга только по Вт → Ср недоступен (day_off)',
    rSvc.dateAvailable === false && rSvc.dateCode === 'day_off', rSvc.dateCode);
  const rSvcTue = computeBookableSlots({
    date: '2026-09-29', durationMin: 60, // вторник
    schedule: baseSchedule, clock: fakeClock('2026-09-29'),
    serviceAvailability: { days: [2], start: '12:00', end: '14:00' }
  });
  check('day: услуга Вт 12–14 → во Вт 2 кандидата (12:00,13:00)',
    rSvcTue.candidates.length === 2, rSvcTue.candidates.join(','));
}

/* ===== 8. isSlotBookable — точечная проверка ===== */
{
  const ok = isSlotBookable({
    date: '2026-09-25', time: '10:00', durationMin: 60, schedule: baseSchedule, clock: fakeClock()
  });
  check('single: свободный слот → ok', ok.ok && ok.code === 'ok', ok.code);
  const off = isSlotBookable({
    date: '2026-09-25', time: '10:07', durationMin: 60, schedule: baseSchedule, clock: fakeClock(),
    policy: { slotIncrementMin: 30 }
  });
  check('single: 10:07 при инкременте 30 → misaligned', !off.ok && off.code === 'misaligned', off.code);
  const lim = isSlotBookable({
    date: '2026-09-25', time: '10:00', durationMin: 60, schedule: baseSchedule, clock: fakeClock(),
    policy: { maxBookingsPerDay: 1 }, counts: { day: 1, week: 1 }
  });
  check('single: дневной лимит → day_limit', !lim.ok && lim.code === 'day_limit', lim.code);
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} провалов` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
