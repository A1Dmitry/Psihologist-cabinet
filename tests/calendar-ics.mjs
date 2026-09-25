#!/usr/bin/env node
/**
 * .ics «Добавить в календарь» для клиента (#65, BL-08).
 *
 *   node tests/calendar-ics.mjs
 *
 * Проверяет наблюдаемый результат — сам файл iCalendar, а не «функция есть»:
 *  - структура VCALENDAR/VTIMEZONE/VEVENT и обязательные свойства RFC 5545;
 *  - CRLF и фолдинг ≤ 75 октетов без разрыва многобайтовых символов;
 *  - моменты начала/конца, восстановленные НЕЗАВИСИМО по VTIMEZONE из файла
 *    (не по Intl внутри генератора), совпадают с ожидаемыми UTC-моментами;
 *  - длительность — канонический приоритет (снимок → услуга → дефолт);
 *  - полночь в поясе специалиста и в поясе клиента; переход на летнее время;
 *  - экранирование TEXT, UTF-8, человекочитаемое имя файла;
 *  - страница успеха и мини-кабинет используют генератор (регресс-страховка).
 */
import { readFileSync } from 'node:fs';
import { buildIcsEvent, icsFileName, icsHref, parseIcs } from '../js/services/calendarService.js';
import { instantToZoned } from '../js/services/timezoneService.js';
import { DEFAULT_DURATION_MIN } from '../js/domain/duration.js';

const results = [];
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` → получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`}`);
};
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const NOW = new Date('2026-09-25T09:00:00Z');

/* ——— Независимый мини-разборщик .ics для проверки ——— */
const unfold = t => t.replace(/\r\n[ \t]/g, '');
const props = t => unfold(t).split('\r\n').filter(Boolean).map(l => {
  const i = l.indexOf(':');
  const [name, ...params] = l.slice(0, i).split(';');
  return { name, params, value: l.slice(i + 1) };
});
/** Свойство события: DTSTART/DTEND ищутся только внутри VEVENT (в VTIMEZONE есть свои DTSTART) */
const prop = (t, name) => {
  const ev = /BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT/.exec(unfold(t))?.[0] || '';
  return props(ev).find(p => p.name === name)
    || props(t).find(p => p.name === name);
};
const offMin = v => { // '+0300' → 180
  const m = /^([+-])(\d{2})(\d{2})$/.exec(v);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
};
const localMs = v => { // '20261005T100000' → «наивный» UTC-мс
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
};
/** Момент (UTC) для DTSTART/DTEND — только по компонентам VTIMEZONE из файла */
function instantFromFile(t, name) {
  const p = prop(t, name);
  const naive = localMs(p.value);
  const comps = [...unfold(t).matchAll(/BEGIN:(STANDARD|DAYLIGHT)\r\n([\s\S]*?)END:\1/g)].map(m => {
    const body = m[2];
    const g = k => new RegExp(`^${k}:(.*)$`, 'm').exec(body)[1].trim();
    return { start: localMs(g('DTSTART')), from: offMin(g('TZOFFSETFROM')), to: offMin(g('TZOFFSETTO')) };
  }).sort((a, b) => a.start - b.start);
  // действующий компонент: последний, чей переход (в UTC) не позже момента
  let off = comps[0].to;
  for (const c of comps) if (naive - c.from * 60000 >= c.start - c.from * 60000) off = c.to;
  return new Date(naive - off * 60000);
}

/* ——— 1. Структура и обязательные свойства ——— */
const base = buildIcsEvent({
  title: 'Индивидуальная консультация · Анна Иванова',
  date: '2026-10-05', time: '10:00', durationMin: 60,
  timezone: 'Europe/Minsk', location: 'Минск, пр. Независимости, 1',
  url: 'https://meet.example/abc', description: 'Первая встреча.\nВозьмите воду.',
  uid: 'sess-1', now: NOW
});
ok('генерируется непустой текст', typeof base === 'string' && base.length > 0);
ok('все строки разделены CRLF, голых LF нет', !/[^\r]\n/.test(base) && base.endsWith('\r\n'));
const names = props(base).map(p => `${p.name}${p.name === 'BEGIN' || p.name === 'END' ? ':' + p.value : ''}`);
eq('вложенность BEGIN/END сбалансирована: VCALENDAR ⊃ VTIMEZONE, VEVENT',
  names.filter(n => n.startsWith('BEGIN:') || n.startsWith('END:')),
  ['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'BEGIN:STANDARD', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'END:VEVENT', 'END:VCALENDAR']);
eq('VERSION:2.0', prop(base, 'VERSION')?.value, '2.0');
ok('PRODID задан', !!prop(base, 'PRODID')?.value);
eq('UID стабилен от id записи', prop(base, 'UID')?.value, 'sess-1@psihologist-cabinet');
eq('DTSTAMP в UTC', prop(base, 'DTSTAMP')?.value, '20260925T090000Z');
eq('DTSTART с TZID пояса специалиста', [prop(base, 'DTSTART').params, prop(base, 'DTSTART').value],
  [['TZID=Europe/Minsk'], '20261005T100000']);
eq('DTEND = начало + 60 мин', prop(base, 'DTEND').value, '20261005T110000');
eq('TZID в VTIMEZONE совпадает с TZID события', prop(base, 'TZID')?.value, 'Europe/Minsk');
eq('VTIMEZONE: смещение Минска +0300', prop(base, 'TZOFFSETTO')?.value, '+0300');
eq('момент начала по VTIMEZONE из файла = 07:00Z',
  instantFromFile(base, 'DTSTART').toISOString(), '2026-10-05T07:00:00.000Z');
eq('SUMMARY в UTF-8 без искажений', prop(base, 'SUMMARY').value, 'Индивидуальная консультация · Анна Иванова');
eq('LOCATION: запятая экранирована', prop(base, 'LOCATION').value, 'Минск\\, пр. Независимости\\, 1');
eq('URL без изменений', prop(base, 'URL').value, 'https://meet.example/abc');
eq('DESCRIPTION: перевод строки → \\n', prop(base, 'DESCRIPTION').value, 'Первая встреча.\\nВозьмите воду.');
eq('существующий парсер проекта читает файл (parseIcs)',
  parseIcs(base).map(e => [e.uid, e.dateFrom, e.timeFrom, e.dateTo, e.timeTo]),
  [['sess-1@psihologist-cabinet', '2026-10-05', '10:00', '2026-10-05', '11:00']]);

/* ——— 2. Экранирование и фолдинг ——— */
const tricky = buildIcsEvent({
  title: 'A\\B; C, D', date: '2026-10-05', time: '10:00', timezone: 'Europe/Minsk', now: NOW, uid: 'x',
  description: 'Очень длинное описание на кириллице 😊 — чтобы строка точно превысила семьдесят пять октетов UTF-8 и была свёрнута несколько раз ✓✓✓'
});
eq('SUMMARY: \\ ; , экранированы', prop(tricky, 'SUMMARY').value, 'A\\\\B\\; C\\, D');
const enc = new TextEncoder();
const rawLines = tricky.split('\r\n').filter(Boolean);
ok('каждая физическая строка ≤ 75 октетов UTF-8',
  rawLines.every(l => enc.encode(l).length <= 75),
  rawLines.map(l => enc.encode(l).length).join(','));
ok('длинная строка действительно свёрнута', rawLines.some(l => l.startsWith(' ')));
ok('фолдинг не рвёт многобайтовые символы (нет U+FFFD после decode)',
  !new TextDecoder().decode(enc.encode(tricky)).includes('\uFFFD') && rawLines.every(l => !/[\uD800-\uDBFF]$/.test(l)));
eq('после unfold описание восстанавливается целиком',
  prop(tricky, 'DESCRIPTION').value,
  'Очень длинное описание на кириллице 😊 — чтобы строка точно превысила семьдесят пять октетов UTF-8 и была свёрнута несколько раз ✓✓✓');

/* ——— 3. Длительность — канонический резолвер ——— */
const dtend = o => prop(buildIcsEvent({ date: '2026-10-05', time: '10:00', timezone: 'Europe/Minsk', now: NOW, uid: 'd', ...o }), 'DTEND').value;
eq('снимок записи важнее услуги (50 при услуге 90)', dtend({ durationMin: 50, service: { duration: 90 } }), '20261005T105000');
eq('без снимка — длительность услуги (90)', dtend({ service: { duration: 90 } }), '20261005T113000');
eq(`без снимка и услуги — дефолт ${DEFAULT_DURATION_MIN} мин`, dtend({}), '20261005T110000');
eq('мусорный снимок (0/"") → услуга', dtend({ durationMin: 0, service: { duration: 45 } }), '20261005T104500');

/* ——— 4. Полночь ——— */
const late = buildIcsEvent({ date: '2026-10-05', time: '23:30', durationMin: 60, timezone: 'Europe/Minsk', now: NOW, uid: 'm' });
eq('полночь в поясе специалиста: 23:30 + 60 → 00:30 следующего дня', prop(late, 'DTEND').value, '20261006T003000');
eq('длительность по файлу = 60 мин',
  (instantFromFile(late, 'DTEND') - instantFromFile(late, 'DTSTART')) / 60000, 60);

// Специалист в Минске (UTC+3), клиент в Ташкенте (UTC+5): 22:30–23:30 у специалиста
// → 00:30–01:30 СЛЕДУЮЩЕГО дня у клиента. Календарь клиента должен получить именно это.
const cross = buildIcsEvent({ date: '2026-10-05', time: '22:30', durationMin: 60, timezone: 'Europe/Minsk', now: NOW, uid: 'c' });
const cs = instantToZoned(instantFromFile(cross, 'DTSTART'), 'Asia/Tashkent');
const ce = instantToZoned(instantFromFile(cross, 'DTEND'), 'Asia/Tashkent');
eq('полночь в поясе клиента (Ташкент): начало 2026-10-06 00:30', [cs.date, cs.time], ['2026-10-06', '00:30']);
eq('полночь в поясе клиента (Ташкент): конец 2026-10-06 01:30', [ce.date, ce.time], ['2026-10-06', '01:30']);
eq('в файле дата специалиста не сдвинута (5 октября)', prop(cross, 'DTSTART').value, '20261005T223000');
// И обратное направление: клиент западнее (Нью-Йорк, UTC−4) — встреча 01:00 у специалиста
// приходится на ПРЕДЫДУЩИЙ день клиента.
const west = buildIcsEvent({ date: '2026-10-06', time: '01:00', durationMin: 50, timezone: 'Europe/Minsk', now: NOW, uid: 'w' });
const ws = instantToZoned(instantFromFile(west, 'DTSTART'), 'America/New_York');
eq('клиент в Нью-Йорке: 01:00 Минска = 18:00 предыдущего дня', [ws.date, ws.time], ['2026-10-05', '18:00']);

/* ——— 5. Переход на летнее время внутри встречи (Берлин, 29.03.2026 02:00→03:00) ——— */
const dst = buildIcsEvent({ date: '2026-03-29', time: '01:30', durationMin: 90, timezone: 'Europe/Berlin', now: NOW, uid: 'dst' });
eq('DST: реальные 90 мин от 01:30 CET заканчиваются в 04:00 CEST', prop(dst, 'DTEND').value, '20260329T040000');
ok('DST: VTIMEZONE содержит компонент DAYLIGHT', /BEGIN:DAYLIGHT[\s\S]*TZOFFSETFROM:\+0100\r\nTZOFFSETTO:\+0200/.test(dst));
ok('DST: момент перехода 02:00 местного', /BEGIN:DAYLIGHT\r\nDTSTART:20260329T020000/.test(dst));
eq('DST: по файлу длительность ровно 90 мин',
  (instantFromFile(dst, 'DTEND') - instantFromFile(dst, 'DTSTART')) / 60000, 90);
const summer = buildIcsEvent({ date: '2026-07-01', time: '10:00', timezone: 'Europe/Berlin', now: NOW, uid: 's' });
eq('летом смещение Берлина +0200', prop(summer, 'TZOFFSETTO').value, '+0200');
const kolkata = buildIcsEvent({ date: '2026-10-05', time: '10:00', timezone: 'Asia/Kolkata', now: NOW, uid: 'k' });
eq('получасовое смещение (Калькутта) +0530', prop(kolkata, 'TZOFFSETTO').value, '+0530');

/* ——— 6. Некорректный вход ——— */
eq('нет даты → пустая строка (кнопка не показывается)', buildIcsEvent({ time: '10:00' }), '');
eq('некорректное время → пустая строка', buildIcsEvent({ date: '2026-10-05', time: '25:99' }), '');
eq('невалидный пояс → пояс портала по умолчанию',
  prop(buildIcsEvent({ date: '2026-10-05', time: '10:00', timezone: 'Mars/Base', now: NOW, uid: 'z' }), 'DTSTART').params,
  ['TZID=Europe/Minsk']);

/* ——— 7. Имя файла и href ——— */
eq('имя файла: специалист, дата, время',
  icsFileName({ specialist: 'Анна Иванова', date: '2026-10-05', time: '10:00' }),
  'Консультация — Анна Иванова — 2026-10-05 10-00.ics');
ok('имя файла без запрещённых символов', !/[\\/:*?"<>|]/.test(icsFileName({ specialist: 'A/B:C*D?"<>|', date: '2026-10-05', time: '10:00' })));
const href = icsHref(base);
ok('href — data:text/calendar; charset=utf-8', href.startsWith('data:text/calendar;charset=utf-8,'));
eq('href декодируется обратно в тот же файл (UTF-8 сохранён)', decodeURIComponent(href.split(',').slice(1).join(',')), base);

/* ——— 8. Регресс-страховка: UI действительно подключён к генератору ——— */
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../js/views/cabinetUi.js', import.meta.url), 'utf8');
ok('страница успеха: есть кнопка #success-ics рядом с #success-gcal',
  /id="success-ics"/.test(html) && /id="success-gcal"/.test(html));
const renderSuccess = app.slice(app.indexOf('function renderSuccess()'), app.indexOf('// ——— Event bindings ———'));
ok('renderSuccess строит .ics через buildIcsEvent и сохраняет Google-ссылку',
  /buildIcsEvent\(/.test(renderSuccess) && /googleAddLink\(/.test(renderSuccess) && /icsFileName\(/.test(renderSuccess));
ok('renderSuccess не считает длительность сам (передаёт снимок + услугу)',
  !/\*\s*60000|addMinutesToTime|endOfSlot/.test(renderSuccess));
ok('мини-кабинет клиента: кнопка .ics через buildIcsEvent', /function clientIcsLink[\s\S]*buildIcsEvent\(/.test(ui) && /\$\{clientIcsLink\(s, psy\)\}/.test(ui));

const failed = results.filter(r => !r).length;
console.log(failed ? `\n${failed} FAILED из ${results.length}` : `\nALL PASS (${results.length})`);
process.exit(failed ? 1 : 0);
