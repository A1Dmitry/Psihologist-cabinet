#!/usr/bin/env node
/**
 * Часовой пояс и длительность — канонические доменные правила (фаза 6).
 *
 *   node tests/timezone-domain.mjs
 *
 * Проверяет единственную реализацию (js/services/timezoneService.js) и
 * единственный резолвер длительности (js/domain/duration.js) на реальных
 * переходах DST и на границе суток, а не «что функция существует».
 */
import {
  convertWallClock, zonedToInstant, instantToZoned, offsetMinutes, formatOffset,
  formatUtcOffset, zoneDiffMinutes, isPastMoment, weekdayOf, addDaysStr,
  daysFromToday, todayStr, timeToMinutes, minutesToTime, addMinutesToTime,
  isValidZone, browserZone, sessionZoneLabel, sessionZoneHint, DEFAULT_TIMEZONE
} from '../js/services/timezoneService.js';
import {
  DEFAULT_DURATION_MIN, resolveDurationMinutes, formatDuration, toDurationMinutes
} from '../js/domain/duration.js';
import { endOfSlot } from '../js/services/calendarService.js';

const results = [];
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` → получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`}`);
};
const ok = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

/* ——— Конвертация между поясами ——— */
eq('10:00 Минск → 09:00 Берлин (октябрь, до перехода ЕС)',
  convertWallClock('2026-10-05', '10:00', 'Europe/Minsk', 'Europe/Berlin').time, '09:00');
// Минск UTC+3 круглый год, Берлин летом UTC+2 → разница 1 ч (зимой будет 2 ч)
eq('10:00 Минск → 09:00 Берлин (июль, лето в ЕС)',
  convertWallClock('2026-07-05', '10:00', 'Europe/Minsk', 'Europe/Berlin').time, '09:00');
eq('17:00 Минск → 19:00 Ташкент',
  convertWallClock('2026-10-05', '17:00', 'Europe/Minsk', 'Asia/Tashkent').time, '19:00');
eq('переход суток: 23:30 Минск → 05:30 Токио следующего дня',
  convertWallClock('2026-10-05', '23:30', 'Europe/Minsk', 'Asia/Tokyo'),
  { date: '2026-10-06', time: '05:30', weekday: 2, dayShift: 1 });
eq('обратный переход суток: 01:00 Токио → 19:00 Минска предыдущего дня',
  convertWallClock('2026-10-06', '01:00', 'Asia/Tokyo', 'Europe/Minsk'),
  { date: '2026-10-05', time: '19:00', weekday: 1, dayShift: -1 });
eq('тот же пояс — без изменений',
  convertWallClock('2026-10-05', '10:00', 'Europe/Minsk', 'Europe/Minsk'),
  { date: '2026-10-05', time: '10:00', weekday: 1, dayShift: 0 });

/* ——— Граница DST ——— */
// ЕС переходит на зимнее время 25 октября 2026 в 03:00 → 02:00; Беларусь не переходит.
eq('день до перехода ЕС: разница Минск−Берлин = 1 ч',
  zoneDiffMinutes('Europe/Minsk', 'Europe/Berlin', new Date('2026-10-24T12:00:00Z')), -60);
eq('день после перехода ЕС: разница Минск−Берлин = 2 ч',
  zoneDiffMinutes('Europe/Minsk', 'Europe/Berlin', new Date('2026-10-26T12:00:00Z')), -120);
eq('смещение Минска постоянно (+03:00 и летом, и зимой)',
  [formatOffset(offsetMinutes(new Date('2026-07-05T12:00:00Z'), 'Europe/Minsk')),
   formatOffset(offsetMinutes(new Date('2026-12-05T12:00:00Z'), 'Europe/Minsk'))],
  ['+03:00', '+03:00']);
eq('смещение Берлина меняется на DST (+02:00 → +01:00)',
  [formatOffset(offsetMinutes(new Date('2026-07-05T12:00:00Z'), 'Europe/Berlin')),
   formatOffset(offsetMinutes(new Date('2026-12-05T12:00:00Z'), 'Europe/Berlin'))],
  ['+02:00', '+01:00']);
// Нью-Йорк: переход 8 марта 2026, 02:00 → 03:00. Настенного 02:30 в этот день нет.
eq('DST-«провал» не ломает конверсию (02:30 Нью-Йорк 8 марта → валидный момент)',
  (() => {
    const inst = zonedToInstant('2026-03-08', '02:30', 'America/New_York');
    return inst instanceof Date && !Number.isNaN(inst.getTime());
  })(), true);
eq('полуторачасовое смещение: Калькутта +05:30',
  formatOffset(offsetMinutes(new Date('2026-07-05T12:00:00Z'), 'Asia/Kolkata')), '+05:30');
eq('компактная подпись смещения', formatUtcOffset(-210), 'UTC−3:30');
eq('round-trip: момент → пояс → момент',
  (() => {
    const inst = new Date('2026-10-25T01:30:00Z'); // прямо в окне перехода ЕС
    const z = instantToZoned(inst, 'Europe/Berlin');
    return zonedToInstant(z.date, z.time, 'Europe/Berlin').toISOString();
  })(), '2026-10-25T01:30:00.000Z');

/* ——— «Прошлое» время ——— */
ok('isPastMoment: прошедший слот в поясе специалиста',
  isPastMoment('2020-01-01', '10:00', 'Europe/Minsk'));
ok('isPastMoment: будущий слот не прошедший',
  !isPastMoment('2099-01-01', '10:00', 'Europe/Minsk'));
ok('isPastMoment: зависит от пояса (23:00 в Токио уже прошло, в Минске ещё нет)',
  (() => {
    const now = new Date('2026-10-05T20:30:00Z'); // 23:30 Минск, 05:30 Токио 6-го
    return isPastMoment('2026-10-06', '05:00', 'Asia/Tokyo', now) === true
      && isPastMoment('2026-10-06', '05:00', 'Europe/Minsk', now) === false;
  })());

/* ——— Календарная арифметика (одна реализация) ——— */
eq('weekdayOf: 2026-09-23 — среда (3)', weekdayOf('2026-09-23'), 3);
eq('weekdayOf: воскресенье — 7, а не 0', weekdayOf('2026-09-27'), 7);
eq('addDaysStr: переход через месяц', addDaysStr('2026-01-31', 1), '2026-02-01');
eq('addDaysStr: переход через год', addDaysStr('2026-12-31', 1), '2027-01-01');
eq('addDaysStr: високосный год', addDaysStr('2028-02-28', 1), '2028-02-29');
eq('daysFromToday(0) === todayStr()', daysFromToday(0), todayStr());
eq('daysFromToday(1) === addDaysStr(today, 1)', daysFromToday(1), addDaysStr(todayStr(), 1));

/* ——— «HH:MM» ↔ минуты ——— */
eq('timeToMinutes: 17:00', timeToMinutes('17:00'), 1020);
eq('timeToMinutes: невалидное → null', timeToMinutes('25:00'), null);
eq('timeToMinutes: пустое → null', timeToMinutes(''), null);
eq('minutesToTime: заворот за полночь', minutesToTime(1440 + 30), '00:30');
eq('addMinutesToTime: 23:30 + 90 → 01:00', addMinutesToTime('23:30', 90), '01:00');
eq('endOfSlot: перенос на следующий день', endOfSlot('2026-10-05', '23:30', 90),
  { date: '2026-10-06', time: '01:00' });

/* ——— Валидация поясов ——— */
ok('isValidZone: IANA принимается', isValidZone('Europe/Minsk') && isValidZone('Asia/Tashkent'));
ok('isValidZone: произвольная строка отклоняется', !isValidZone('Минск') && !isValidZone(''));
ok('browserZone: всегда валидный IANA', isValidZone(browserZone()));
ok('DEFAULT_TIMEZONE валиден', isValidZone(DEFAULT_TIMEZONE));

/* ——— Подписи сессий ——— */
const zoned = sessionZoneLabel({ date: '2026-10-05', time: '10:00', clientTimezone: 'Europe/Berlin' }, 'Europe/Minsk');
ok('подпись: другой пояс помечен', zoned.sameZone === false && zoned.clientTime === '09:00', JSON.stringify(zoned));
ok('подсказка: «у клиента 09:00»', sessionZoneHint({ date: '2026-10-05', time: '10:00', clientTimezone: 'Europe/Berlin' }, 'Europe/Minsk').includes('у клиента 09:00'));
ok('тот же пояс: подсказки нет',
  sessionZoneHint({ date: '2026-10-05', time: '10:00', clientTimezone: 'Europe/Minsk' }, 'Europe/Minsk') === '');

/* ——— Длительность: один канонический дефолт ——— */
eq('канонический дефолт — 60', DEFAULT_DURATION_MIN, 60);
eq('приоритет: снимок записи важнее услуги',
  resolveDurationMinutes({ durationMin: 45, service: { duration: 90 }, slotStepMin: 30 }), 45);
eq('приоритет: услуга важнее шага сетки',
  resolveDurationMinutes({ durationMin: null, service: { duration: 90 }, slotStepMin: 30 }), 90);
eq('приоритет: шаг сетки важнее дефолта',
  resolveDurationMinutes({ durationMin: null, service: null, slotStepMin: 30 }), 30);
eq('нет ничего — канонический дефолт',
  resolveDurationMinutes({}), DEFAULT_DURATION_MIN);
ok('0 и мусор не считаются значением', toDurationMinutes(0) === null && toDurationMinutes('abc') === null);
eq('formatDuration: 90 → «1,5 ч»', formatDuration(90), '1,5 ч');
eq('formatDuration: 60 → «1 ч»', formatDuration(60), '1 ч');
eq('formatDuration: 45 → «45 мин»', formatDuration(45), '45 мин');

const failed = results.filter(r => !r[1]).length;
console.log(failed ? `\n${failed} FAILED` : `\nALL PASS (${results.length})`);
process.exit(failed ? 1 : 0);
