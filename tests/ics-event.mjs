#!/usr/bin/env node
/**
 * Issue #65 / BL-08 — универсальный .ics «Добавить в календарь» для клиента.
 *
 *   node tests/ics-event.mjs
 *
 * Проверяет канонический генератор (js/services/calendarService.js):
 *  - валидный VCALENDAR (RFC 5545): структура, CRLF, сворачивание на 75 октетах;
 *  - корректные DTSTART/DTEND в настенном времени специалиста (в т.ч. слот,
 *    переходящий через полночь, и переход через полночь в ПОЯСЕ КЛИЕНТА);
 *  - VTIMEZONE: фиксированный пояс (Минск) и DST-пояса обоих полушарий
 *    (США и Австралия — реальные переходы 2026 из timezoneService, не таблицы);
 *  - экранирование, UTF-8, человекочитаемое имя файла;
 *  - длительность — переиспользование resolveDurationMinutes (без второго расчёта).
 */
import {
  icsEventText, icsEventBlob, icsEventFileName, endOfSlot
} from '../js/services/calendarService.js';
import { resolveDurationMinutes } from '../js/domain/duration.js';
import { convertWallClock } from '../js/services/timezoneService.js';

const results = [];
const ok = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

/** Разбор .ics: строки после unfolding'а (пробел в начале строки — продолжение). */
function icsLines(text) {
  const unfolded = String(text).split('\r\n').reduce((acc, line) => {
    if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += line.slice(1);
    else if (line !== '') acc.push(line);
    return acc;
  }, []);
  return unfolded;
}
const field = (lines, name, params = '') =>
  lines.find(l => l.startsWith(`${name};${params}:`))?.split(':').slice(1).join(':') || null;
const plain = (lines, name) =>
  lines.find(l => l.startsWith(`${name}:`))?.slice(name.length + 1) || null;

const BASE = {
  title: 'Консультация · Анна Иванова',
  date: '2026-10-05',
  time: '14:00',
  durationMin: 60,
  timezone: 'Europe/Minsk'
};

/* ——— Структура VCALENDAR ——— */
const text = icsEventText(BASE);
const lines = icsLines(text);
ok('первая строка — BEGIN:VCALENDAR', lines[0] === 'BEGIN:VCALENDAR', lines[0]);
ok('последняя строка — END:VCALENDAR', lines[lines.length - 1] === 'END:VCALENDAR');
ok('VERSION:2.0', lines.includes('VERSION:2.0'));
ok('PRODID указан', (plain(lines, 'PRODID') || '').includes('PsyPortal'));
ok('CALSCALE:GREGORIAN', lines.includes('CALSCALE:GREGORIAN'));
{
  const stack = [];
  let balanced = true;
  for (const l of lines) {
    if (l.startsWith('BEGIN:')) stack.push(l.slice(6));
    else if (l.startsWith('END:')) {
      if (stack.pop() !== l.slice(4)) { balanced = false; break; }
    }
  }
  ok('BEGIN/END сбалансированы (VCALENDAR/VTIMEZONE/VEVENT)', balanced && stack.length === 0);
}
ok('CRLF-разделители (RFC 5545)', /\r\nBEGIN:VEVENT\r\n/.test(text));
ok('UID присутствует (авто, при явном uid — стабильный; ниже)',
  (plain(lines, 'UID') || '').startsWith('psyportal-'), plain(lines, 'UID'));
ok('DTSTAMP в формате UTC YYYYMMDDTHHMMSSZ', /^DTSTAMP:\d{8}T\d{6}Z$/.test(lines.find(l => l.startsWith('DTSTAMP:')) || ''));

/* ——— Даты/длительность в поясе специалиста ——— */
ok('DTSTART;TZID=Europe/Minsk:20261005T140000',
  field(lines, 'DTSTART', 'TZID=Europe/Minsk') === '20261005T140000',
  field(lines, 'DTSTART', 'TZID=Europe/Minsk'));
ok('DTEND = 15:00 (60 минут)',
  field(lines, 'DTEND', 'TZID=Europe/Minsk') === '20261005T150000',
  field(lines, 'DTEND', 'TZID=Europe/Minsk'));

/* Слот, переходящий через полночь (в поясе специалиста) */
const overnight = icsLines(icsEventText({ ...BASE, time: '23:30', durationMin: 90 }));
ok('переход через полночь: 23:30 + 90 мин → DTEND следующего дня 01:00',
  field(overnight, 'DTSTART', 'TZID=Europe/Minsk') === '20261005T233000' &&
  field(overnight, 'DTEND', 'TZID=Europe/Minsk') === '20261006T010000',
  `${field(overnight, 'DTSTART', 'TZID=Europe/Minsk')} → ${field(overnight, 'DTEND', 'TZID=Europe/Minsk')}`);

/* Слот с переходом через полночь в ПОЯСЕ КЛИЕНТА (DoD #65):
 * Токио = Минск + 6 ч, поэтому клиент видит 2026-10-06 05:30–07:00 (dayShift +1),
 * но артефакт — строго в настенном времени специалиста. */
{
  const clientView = convertWallClock('2026-10-05', '23:30', 'Europe/Minsk', 'Asia/Tokyo');
  ok('клиент (Токио) видит слот за полночь своего дня (dayShift +1)',
    clientView.date === '2026-10-06' && clientView.time === '05:30' && clientView.dayShift === 1,
    JSON.stringify(clientView));
  const clientViewEnd = convertWallClock('2026-10-06', '01:00', 'Europe/Minsk', 'Asia/Tokyo');
  ok('конец слота у клиента — 07:00 того же дня',
    clientViewEnd.date === '2026-10-06' && clientViewEnd.time === '07:00',
    JSON.stringify(clientViewEnd));
  const t = icsEventText({ ...BASE, time: '23:30', durationMin: 90 });
  ok('артефакт не зависит от пояса клиента (нигде нет Asia/Tokyo)',
    !t.includes('Tokyo') && t.includes('TZID=Europe/Minsk'));
}

/* ——— VTIMEZONE ——— */
/* Минск: без DST с 2011 → единственный STANDARD, +0300 */
ok('Минск: один STANDARD, TZOFFSETTO:+0300',
  lines.filter(l => l === 'BEGIN:STANDARD').length === 1 &&
  !lines.includes('BEGIN:DAYLIGHT') &&
  lines.some(l => l === 'TZOFFSETTO:+0300'));
ok('Минск: TZID=Europe/Minsk в VTIMEZONE', lines.includes('TZID:Europe/Minsk'));

/* США (северное полушарие): DST 2026 с 08.03 (02:00 EST→EDT) до 01.11 (02:00 EDT→EST) */
const ny = icsLines(icsEventText({
  ...BASE, date: '2026-07-05', time: '16:00', timezone: 'America/New_York'
}));
{
  const daylight = ny.filter((l, i) => l === 'BEGIN:DAYLIGHT').length === 1;
  const block = (name) => {
    const i = ny.indexOf(`BEGIN:${name}`);
    return i >= 0 ? ny.slice(i, ny.indexOf(`END:${name}`, i) + 1) : [];
  };
  const d = block('DAYLIGHT');
  const s = block('STANDARD');
  ok('Нью-Йорк: VTIMEZONE со STANDARD и DAYLIGHT', daylight && d.length > 0 && s.length > 0);
  ok('Нью-Йорк: DAYLIGHT -0500→-0400, DTSTART 20260308T020000 (реальный переход 2026)',
    d.includes('TZOFFSETFROM:-0500') && d.includes('TZOFFSETTO:-0400') && d.includes('DTSTART:20260308T020000'),
    d.join(' | '));
  ok('Нью-Йорк: STANDARD -0400→-0500, DTSTART 20261101T020000',
    s.includes('TZOFFSETFROM:-0400') && s.includes('TZOFFSETTO:-0500') && s.includes('DTSTART:20261101T020000'),
    s.join(' | '));
  ok('Нью-Йорк: событие 16:00 EDT, DTEND 17:00 (TZID=America/New_York)',
    field(ny, 'DTSTART', 'TZID=America/New_York') === '20260705T160000' &&
    field(ny, 'DTEND', 'TZID=America/New_York') === '20260705T170000');
}

/* Австралия (южное полушарие): DST 2026 с 04.10 (02:00 AEST→AEDT) до 05.04 (03:00 AEDT→AEST) */
const syd = icsLines(icsEventText({
  ...BASE, date: '2026-06-15', time: '10:00', timezone: 'Australia/Sydney'
}));
{
  const block = (name) => {
    const i = syd.indexOf(`BEGIN:${name}`);
    return i >= 0 ? syd.slice(i, syd.indexOf(`END:${name}`, i) + 1) : [];
  };
  const d = block('DAYLIGHT');
  const s = block('STANDARD');
  ok('Сидней: DAYLIGHT +1000→+1100, DTSTART 20261004T020000 (южное полушарие)',
    d.includes('TZOFFSETFROM:+1000') && d.includes('TZOFFSETTO:+1100') && d.includes('DTSTART:20261004T020000'),
    d.join(' | '));
  ok('Сидней: STANDARD +1100→+1000, DTSTART 20260405T030000',
    s.includes('TZOFFSETFROM:+1100') && s.includes('TZOFFSETTO:+1000') && s.includes('DTSTART:20260405T030000'),
    s.join(' | '));
}

/* Невалидный пояс → фолбэк на Europe/Minsk, без падения */
const badTz = icsLines(icsEventText({ ...BASE, timezone: 'Not/AZone' }));
ok('невалидный IANA-пояс → фолбэк Europe/Minsk',
  badTz.some(l => l.includes('TZID=Europe/Minsk')) &&
  badTz.includes('TZID:Europe/Minsk') && badTz.some(l => l === 'TZOFFSETTO:+0300'));

/* ——— Поля события ——— */
const withFields = icsLines(icsEventText({
  ...BASE,
  title: 'Терапия, когнитивная; сессия 2',
  location: 'Минск, пр-т Машерова 11',
  details: 'Пожалуйста, приходите за 5 минут.\nВторой этаж, лифт.',
  url: 'https://a1dmitry.github.io/Psihologist-cabinet/#/psy/anna-ivanova'
}));
ok('SUMMARY экранирует запятую и точку с запятой',
  plain(withFields, 'SUMMARY') === 'Терапия\\, когнитивная\\; сессия 2',
  plain(withFields, 'SUMMARY'));
ok('LOCATION передаётся',
  (plain(withFields, 'LOCATION') || '').includes('Машерова 11'));
ok('DESCRIPTION экранирует перевод строки как \\n',
  (plain(withFields, 'DESCRIPTION') || '').includes('5 минут.\\nВторой этаж'),
  plain(withFields, 'DESCRIPTION'));
ok('URL передаётся (с # без искажений)',
  (plain(withFields, 'URL') || '').endsWith('/psy/anna-ivanova'));

/* Экранирование обратимое: после unescape получаем исходный текст */
{
  const raw = plain(withFields, 'SUMMARY');
  const unescaped = raw.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  ok('unescape(SUMMARY) возвращает исходный текст', unescaped === 'Терапия, когнитивная; сессия 2', unescaped);
}

/* ——— Сворачивание строк (75 октетов, UTF-8) ——— */
const longDesc = 'Задание на неделю: '.repeat(30); // 1080+ октетов кириллицей
const foldedText = icsEventText({ ...BASE, details: longDesc, title: 'Длинное название'.repeat(10) });
const rawLines = foldedText.replace(/\r\n$/, '').split('\r\n');
ok('все строки .ics ≤ 75 октетов (с учётом UTF-8)',
  rawLines.every(l => Buffer.byteLength(l, 'utf8') <= 75),
  `макс ${Math.max(...rawLines.map(l => Buffer.byteLength(l, 'utf8')))} окт.`);
ok('продолжающиеся строки начинаются с пробела',
  rawLines.filter(l => l !== '').every((l, i) => i === 0 || /^[A-Za-z]/.test(l) || l.startsWith(' ')));
{
  const unfolded = icsLines(foldedText);
  const desc = plain(unfolded, 'DESCRIPTION');
  ok('unfolding восстанавливает исходный DESCRIPTION', desc === longDesc,
    `len ${desc?.length ?? 'null'} / ${longDesc.length}`);
}

/* ——— UTF-8 и Blob ——— */
ok('SUMMARY содержит кириллицу без искажений (UTF-8)',
  plain(lines, 'SUMMARY') === 'Консультация · Анна Иванова');
{
  const blob = icsEventBlob({ ...BASE, uid: 'psyportal-session-blobtest' });
  ok('Blob: type text/calendar;charset=utf-8', blob.type === 'text/calendar;charset=utf-8', blob.type);
  const body = await blob.text();
  // DTSTAMP зависит от момента вызова — нормализуем перед сравнением
  const norm = s => s.replace(/^DTSTAMP:.*$/m, 'DTSTAMP:NORM');
  ok('Blob: тело == icsEventText (CRLF, UTF-8 без искажений)',
    norm(body) === norm(icsEventText({ ...BASE, uid: 'psyportal-session-blobtest' })));
  ok('Blob: кириллица пережила кодирование (UTF-8)', body.includes('Анна Иванова'));
}

/* ——— Длительность: переиспользование resolveDurationMinutes (без второго расчёта) ——— */
{
  const sv = { name: '90 минут', duration: 90 };
  const t = icsEventText({ ...BASE, durationMin: resolveDurationMinutes({ service: sv }) });
  const l = icsLines(t);
  ok('durationMin=resolveDurationMinutes(service 90 мин) → DTEND − DTSTART = 90',
    field(l, 'DTSTART', 'TZID=Europe/Minsk') === '20261005T140000' &&
    field(l, 'DTEND', 'TZID=Europe/Minsk') === '20261005T153000',
    `${field(l, 'DTSTART', 'TZID=Europe/Minsk')} → ${field(l, 'DTEND', 'TZID=Europe/Minsk')}`);
  // снимок записи важнее услуги (тот же приоритет, что в renderSuccess)
  const t2 = icsEventText({
    ...BASE,
    durationMin: resolveDurationMinutes({ durationMin: 120, service: sv })
  });
  const l2 = icsLines(t2);
  ok('снимок durationMin=120 переопределяет длительность услуги',
    field(l2, 'DTEND', 'TZID=Europe/Minsk') === '20261005T160000');
  // консистентность с endOfSlot (каноническая арифметика слота)
  const e = endOfSlot('2026-10-05', '23:30', 90);
  ok('DTEND совпадает с endOfSlot (одна арифметика, не вторая)',
    e.date === '2026-10-06' && e.time === '01:00');
}

/* ——— UID: устойчивость для апдейта события ——— */
{
  const a = icsEventText({ ...BASE, uid: 'psyportal-session-sess_1' });
  const b = icsEventText({ ...BASE, uid: 'psyportal-session-sess_1' });
  ok('устойчивый UID: два генерирования → один UID (календарь обновит, а не задублирует)',
    plain(icsLines(a), 'UID') === plain(icsLines(b), 'UID') &&
    plain(icsLines(a), 'UID') === 'psyportal-session-sess_1');
}

/* ——— Имя файла ——— */
ok('имя файла: специалист (транслит) + дата + время',
  icsEventFileName('Анна Иванова', '2026-10-05', '14:00') === 'session-anna-ivanova-2026-10-05-14-00.ics',
  icsEventFileName('Анна Иванова', '2026-10-05', '14:00'));
ok('имя файла: «Дмитрий Петров» → dmitriy-petrov',
  icsEventFileName('Дмитрий Петров', '2026-12-31', '23:30') === 'session-dmitriy-petrov-2026-12-31-23-30.ics',
  icsEventFileName('Дмитрий Петров', '2026-12-31', '23:30'));
ok('имя файла: без имени — consultation',
  icsEventFileName('', '2026-10-05', '14:00') === 'session-consultation-2026-10-05-14-00.ics',
  icsEventFileName('', '2026-10-05', '14:00'));
ok('имя файла: без пробелов и спецсимволов',
  /^session-[a-z0-9-]+\.ics$/.test(icsEventFileName('Анна И. (онлайн)', '2026-10-05', '14:00')),
  icsEventFileName('Анна И. (онлайн)', '2026-10-05', '14:00'));

/* ——— Итог ——— */
const failed = results.filter(([, pass]) => !pass);
console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено`);
process.exit(failed.length ? 1 : 0);
