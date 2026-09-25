#!/usr/bin/env node
/**
 * .ics «Добавить в календарь» для клиента (#65, BL-08) — независимая проверка
 * канонического генератора и его обвязки в UI.
 *
 *   node tests/calendar-ics.mjs
 *
 * Дополняет (не дублирует) tests/ics-event.mjs (структура генератора) и
 * tests/ics-success-page.mjs (DOM-привязка кнопок): здесь наблюдаемый
 * результат проверяется СНАРУЖИ —
 *  - моменты начала/конца восстанавливаются НЕЗАВИСИМО по VTIMEZONE из самого
 *    файла (не через Intl генератора), поэтому совпадают с реальными минутами;
 *  - полночь в поясе специалиста и в поясе клиента (оба направления);
 *  - DST-пояс: реальные переходы в VTIMEZONE, корректный момент события;
 *  - получасовое смещение (Калькутта);
 *  - файл читается собственным парсером проекта (parseIcs) без потерь;
 *  - имя файла транслитом без запрещённых символов; data-URI мини-кабинета
 *    декодируется обратно в тот же файл (UTF-8 сохранён);
 *  - регресс-страховка: генератор в коде ровно один (история с дублём
 *    генератора, сломавшим гейт 2026-09-25, не должна повториться).
 */
import { readFileSync } from 'node:fs';
import { icsEventText, icsEventFileName, parseIcs } from '../js/services/calendarService.js';
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

/* ——— Независимый мини-разборщик .ics для проверки ——— */
const unfold = t => t.replace(/\r\n[ \t]/g, '');
const props = t => unfold(t).split('\r\n').filter(Boolean).map(l => {
  const i = l.indexOf(':');
  const [name, ...params] = l.slice(0, i).split(';');
  return { name, params, value: l.slice(i + 1) };
});
/** Свойство события: сначала ищем внутри VEVENT (в VTIMEZONE есть свои DTSTART) */
const prop = (t, name) => {
  const ev = /BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT/.exec(unfold(t))?.[0] || '';
  return props(ev).find(p => p.name === name)
    || props(t).find(p => p.name === name);
};
/** Тело компонента VTIMEZONE (STANDARD/DAYLIGHT) — независимо от порядка */
const vtzBlock = (t, kind) =>
  new RegExp(`BEGIN:${kind}\\r\\n([\\s\\S]*?)END:${kind}`).exec(unfold(t))?.[1] || '';
const offMin = v => { // '+0300' → 180
  const m = /^([+-])(\d{2})(\d{2})$/.exec(v);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
};
const localMs = v => { // '20261005T100000' → «наивный» UTC-мс
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
};
/**
 * Момент (UTC) для DTSTART/DTEND — только по компонентам VTIMEZONE из файла.
 * Базовое смещение — стандартное (минимальное): им действует время до первого
 * перехода года; далее применяются переходы, случившиеся не позже момента.
 */
function instantFromFile(t, name) {
  const p = prop(t, name);
  const naive = localMs(p.value);
  const comps = [...unfold(t).matchAll(/BEGIN:(STANDARD|DAYLIGHT)\r\n([\s\S]*?)END:\1/g)].map(m => {
    const body = m[2];
    const g = k => new RegExp(`^${k}:(.*)$`, 'm').exec(body)[1].trim();
    return { start: localMs(g('DTSTART')), from: offMin(g('TZOFFSETFROM')), to: offMin(g('TZOFFSETTO')) };
  });
  const standard = Math.min(...comps.map(c => Math.min(c.from, c.to)));
  let off = standard;
  const transitions = comps
    .map(c => ({ utc: c.start - c.from * 60000, to: c.to }))
    .sort((a, b) => a.utc - b.utc);
  for (const c of transitions) if (naive - off * 60000 >= c.utc) off = c.to;
  return new Date(naive - off * 60000);
}

/* ——— 1. Структура и обязательные свойства (канонический генератор) ——— */
const base = icsEventText({
  title: 'Индивидуальная консультация · Анна Иванова',
  date: '2026-10-05', time: '10:00', durationMin: 60,
  timezone: 'Europe/Minsk', location: 'Минск, пр. Независимости, 1',
  url: 'https://meet.example/abc', details: 'Первая встреча.\nВозьмите воду.',
  uid: 'psyportal-session-sess-1'
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
eq('UID стабилен от id записи (повторная загрузка обновит событие)',
  prop(base, 'UID')?.value, 'psyportal-session-sess-1');
ok('DTSTAMP в формате UTC YYYYMMDDTHHMMSSZ', /^\d{8}T\d{6}Z$/.test(prop(base, 'DTSTAMP')?.value || ''));
eq('DTSTART с TZID пояса специалиста', [prop(base, 'DTSTART').params, prop(base, 'DTSTART').value],
  [['TZID=Europe/Minsk'], '20261005T100000']);
eq('DTEND = начало + 60 мин', prop(base, 'DTEND').value, '20261005T110000');
eq('TZID в VTIMEZONE совпадает с TZID события', prop(base, 'TZID')?.value, 'Europe/Minsk');
eq('VTIMEZONE: смещение Минска +0300', vtzBlock(base, 'STANDARD').includes('TZOFFSETTO:+0300'), true);
eq('момент начала по VTIMEZONE из файла = 07:00Z',
  instantFromFile(base, 'DTSTART').toISOString(), '2026-10-05T07:00:00.000Z');
eq('момент конца по VTIMEZONE из файла = 08:00Z (60 реальных минут)',
  instantFromFile(base, 'DTEND').toISOString(), '2026-10-05T08:00:00.000Z');
eq('SUMMARY в UTF-8 без искажений', prop(base, 'SUMMARY').value, 'Индивидуальная консультация · Анна Иванова');
eq('LOCATION: запятая экранирована', prop(base, 'LOCATION').value, 'Минск\\, пр. Независимости\\, 1');
eq('URL без изменений', prop(base, 'URL').value, 'https://meet.example/abc');
eq('DESCRIPTION: перевод строки → \\n', prop(base, 'DESCRIPTION').value, 'Первая встреча.\\nВозьмите воду.');
eq('без явного uid — авто-UID портала',
  (prop(icsEventText({ date: '2026-10-05', time: '10:00', timezone: 'Europe/Minsk' }), 'UID')?.value || '').startsWith('psyportal-'), true);
eq('существующий парсер проекта читает файл (parseIcs)',
  parseIcs(base).map(e => [e.uid, e.dateFrom, e.timeFrom, e.dateTo, e.timeTo]),
  [['psyportal-session-sess-1', '2026-10-05', '10:00', '2026-10-05', '11:00']]);

/* ——— 2. Экранирование и фолдинг ——— */
const tricky = icsEventText({
  title: 'A\\B; C, D', date: '2026-10-05', time: '10:00', timezone: 'Europe/Minsk', uid: 'x',
  details: 'Очень длинное описание на кириллице 😊 — чтобы строка точно превысила семьдесят пять октетов UTF-8 и была свёрнута несколько раз ✓✓✓'
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

/* ——— 3. Длительность: канон принимает УЖЕ разрешённые минуты ——— */
const dtend = o => prop(icsEventText({ date: '2026-10-05', time: '10:00', timezone: 'Europe/Minsk', uid: 'd', ...o }), 'DTEND').value;
eq('разрешённая длительность 50 мин → конец 10:50', dtend({ durationMin: 50 }), '20261005T105000');
eq('разрешённая длительность 90 мин → конец 11:30', dtend({ durationMin: 90 }), '20261005T113000');
{
  const endMin = 10 * 60 + DEFAULT_DURATION_MIN;
  const hh = String(Math.floor(endMin / 60)).padStart(2, '0');
  const mm = String(endMin % 60).padStart(2, '0');
  eq(`без длительности — дефолт ${DEFAULT_DURATION_MIN} мин`, dtend({}), `20261005T${hh}${mm}00`);
}
eq('мусорная длительность (0) → дефолт', dtend({ durationMin: 0 }), '20261005T110000');

/* ——— 4. Полночь ——— */
const late = icsEventText({ date: '2026-10-05', time: '23:30', durationMin: 60, timezone: 'Europe/Minsk', uid: 'm' });
eq('полночь в поясе специалиста: 23:30 + 60 → 00:30 следующего дня', prop(late, 'DTEND').value, '20261006T003000');
eq('длительность по файлу = 60 мин',
  (instantFromFile(late, 'DTEND') - instantFromFile(late, 'DTSTART')) / 60000, 60);

// Специалист в Минске (UTC+3), клиент в Ташкенте (UTC+5): 22:30–23:30 у специалиста
// → 00:30–01:30 СЛЕДУЮЩЕГО дня у клиента. Календарь клиента должен получить именно это.
const cross = icsEventText({ date: '2026-10-05', time: '22:30', durationMin: 60, timezone: 'Europe/Minsk', uid: 'c' });
const cs = instantToZoned(instantFromFile(cross, 'DTSTART'), 'Asia/Tashkent');
const ce = instantToZoned(instantFromFile(cross, 'DTEND'), 'Asia/Tashkent');
eq('полночь в поясе клиента (Ташкент): начало 2026-10-06 00:30', [cs.date, cs.time], ['2026-10-06', '00:30']);
eq('полночь в поясе клиента (Ташкент): конец 2026-10-06 01:30', [ce.date, ce.time], ['2026-10-06', '01:30']);
eq('в файле дата специалиста не сдвинута (5 октября)', prop(cross, 'DTSTART').value, '20261005T223000');
// И обратное направление: клиент западнее (Нью-Йорк, летом UTC−4) — встреча 01:00
// у специалиста приходится на ПРЕДЫДУЩИЙ день клиента.
const west = icsEventText({ date: '2026-10-06', time: '01:00', durationMin: 50, timezone: 'Europe/Minsk', uid: 'w' });
const ws = instantToZoned(instantFromFile(west, 'DTSTART'), 'America/New_York');
eq('клиент в Нью-Йорке: 01:00 Минска = 18:00 предыдущего дня', [ws.date, ws.time], ['2026-10-05', '18:00']);

/* ——— 5. DST-пояс (Берлин 2026): реальные переходы в VTIMEZONE ——— */
const summer = icsEventText({ date: '2026-07-01', time: '10:00', durationMin: 60, timezone: 'Europe/Berlin', uid: 's' });
const dl = vtzBlock(summer, 'DAYLIGHT');
const st = vtzBlock(summer, 'STANDARD');
ok('DST: DAYLIGHT +0100→+0200 с переходом 29.03.2026 02:00 (местного)',
  dl.includes('TZOFFSETFROM:+0100') && dl.includes('TZOFFSETTO:+0200') && dl.includes('DTSTART:20260329T020000'), dl);
ok('DST: STANDARD +0200→+0100 с переходом 25.10.2026 03:00 (местного)',
  st.includes('TZOFFSETFROM:+0200') && st.includes('TZOFFSETTO:+0100') && st.includes('DTSTART:20261025T030000'), st);
eq('DST: летнее событие — момент по файлу 08:00Z (10:00 CEST)',
  instantFromFile(summer, 'DTSTART').toISOString(), '2026-07-01T08:00:00.000Z');
eq('DST: длительность по файлу ровно 60 мин',
  (instantFromFile(summer, 'DTEND') - instantFromFile(summer, 'DTSTART')) / 60000, 60);
const winter = icsEventText({ date: '2026-01-15', time: '10:00', durationMin: 60, timezone: 'Europe/Berlin', uid: 'wnt' });
eq('DST: зимнее событие — момент по файлу 09:00Z (10:00 CET)',
  instantFromFile(winter, 'DTSTART').toISOString(), '2026-01-15T09:00:00.000Z');
const kolkata = icsEventText({ date: '2026-10-05', time: '10:00', durationMin: 60, timezone: 'Asia/Kolkata', uid: 'k' });
ok('получасовое смещение (Калькутта) +0530', vtzBlock(kolkata, 'STANDARD').includes('TZOFFSETTO:+0530'));
eq('получасовое смещение: момент по файлу 04:30Z',
  instantFromFile(kolkata, 'DTSTART').toISOString(), '2026-10-05T04:30:00.000Z');

/* ——— 6. Некорректный вход ——— */
eq('невалидный пояс → пояс портала по умолчанию',
  prop(icsEventText({ date: '2026-10-05', time: '10:00', timezone: 'Mars/Base', uid: 'z' }), 'DTSTART').params,
  ['TZID=Europe/Minsk']);

/* ——— 7. Имя файла и data-URI мини-кабинета ——— */
eq('имя файла: транслит специалиста, дата, время',
  icsEventFileName('Анна Иванова', '2026-10-05', '10:00'),
  'session-anna-ivanova-2026-10-05-10-00.ics');
ok('имя файла без запрещённых символов', !/[\\/:*?"<>|]/.test(icsEventFileName('A/B:C*D?"<>|', '2026-10-05', '10:00')));
const dataUri = `data:text/calendar;charset=utf-8,${encodeURIComponent(base)}`;
ok('data-URI — text/calendar; charset=utf-8', dataUri.startsWith('data:text/calendar;charset=utf-8,'));
eq('data-URI декодируется обратно в тот же файл (UTF-8 сохранён)',
  decodeURIComponent(dataUri.split(',').slice(1).join(',')), base);

/* ——— 8. Регресс-страховка: генератор один, UI подключён ——— */
const svcSrc = readFileSync(new URL('../js/services/calendarService.js', import.meta.url), 'utf8');
eq('генератор один: ICS_PRODID объявлен ровно один раз',
  (svcSrc.match(/\bconst ICS_PRODID\b/g) || []).length, 1);
eq('генератор один: icsVtimezone объявлена ровно один раз',
  (svcSrc.match(/function icsVtimezone\(/g) || []).length, 1);
ok('генератор один: параллельных реализаций (buildIcsEvent/icsHref) нет',
  !/buildIcsEvent|icsHref/.test(svcSrc));
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../js/views/cabinetUi.js', import.meta.url), 'utf8');
ok('страница успеха: есть кнопка #success-ics рядом с #success-gcal',
  /id="success-ics"/.test(html) && /id="success-gcal"/.test(html));
ok('reply-страница клиента: кнопка #reply-ics присутствует', /id="reply-ics"/.test(html));
const renderSuccess = app.slice(app.indexOf('function renderSuccess()'), app.indexOf('// ——— Event bindings ———'));
ok('renderSuccess строит .ics канонической обвязкой и сохраняет Google-ссылку',
  /wireIcsDownload\(/.test(renderSuccess) && /icsParamsForSession\(/.test(renderSuccess) &&
  /googleAddLink\(/.test(renderSuccess) && /icsEventFileName\(/.test(renderSuccess));
const icsBlock = app.slice(app.indexOf('function wireIcsDownload'), app.indexOf('// ——— Event bindings ———'));
ok('обвязка .ics не считает длительность и конец сама (только канонический резолвер)',
  /resolveDurationMinutes\(/.test(icsBlock) && !/\*\s*60000|addMinutesToTime|endOfSlot\(/.test(icsBlock));
ok('мини-кабинет клиента: кнопка .ics через канонический icsEventText + data-URI',
  /function clientIcsLink[\s\S]*icsEventText\(/.test(ui) &&
  /data:text\/calendar;charset=utf-8,\$\{encodeURIComponent\(ics\)\}/.test(ui) &&
  /\$\{clientIcsLink\(s, psy\)\}/.test(ui));

const failed = results.filter(r => !r).length;
console.log(failed ? `\n${failed} FAILED из ${results.length}` : `\nALL PASS (${results.length})`);
process.exit(failed ? 1 : 0);
