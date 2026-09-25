/**
 * CalendarService — интеграция с внешними календарями (Google Calendar / iCal).
 *
 * 1) «Добавить в календарь» — ссылка-шаблон calendar/render?action=TEMPLATE
 *    (та же механика, что у Calendly/Booksy для карточки события).
 * 2) Импорт занятости из iCal-фидов (Google Calendar → Настройки → «Secret address
 *    in iCal format», basic.ics): события календаря превращаются в блокировки занятости.
 *    Импорт идёт браузером психолога (адрес — секретный, публично не отдаётся);
 *    публично видны только итоговые free/busy блоки.
 * 3) «Добавить в календарь (.ics)» (#65) — файл iCalendar (RFC 5545) для Apple
 *    Calendar / Outlook / любого клиента: buildIcsEvent + icsFileName + icsHref.
 *    Артефакт существующей записи, как и googleAddLink; длительность — только
 *    через канонический resolveDurationMinutes (RULES §6.14).
 * Для двусторонней синхронизации в проде — Google Calendar API (OAuth), см. docs.
 *
 * ВАЖНО (аудит AUDIT-REG-DRY-001): этот модуль — СЕРВИС интеграции, а не домен
 * часовых поясов. Собственные реализации detectTimeZone / zoneOffsetMinutes /
 * zonedTimeToUtc / convertWallClock / isPastMoment отсюда удалены: каноническая
 * реализация одна — js/services/timezoneService.js. Всё, что связано с поясами,
 * импортируется оттуда (см. re-export ниже — он оставлен только чтобы не ломать
 * старые импорты, новой точкой входа считать timezoneService).
 */
import {
  addMinutesToTime, timeToMinutes, addDaysStr,
  zonedToInstant, instantToZoned, offsetMinutes, isValidZone, DEFAULT_TIMEZONE
} from './timezoneService.js';
import { resolveDurationMinutes } from '../domain/duration.js';

const GCAL_TEMPLATE = 'https://calendar.google.com/calendar/render';

/** Ссылка «Добавить событие в Google Calendar */
export function googleAddLink({ title, date, time, durationMin = 60, details = '', location = '', timezone = 'Europe/Minsk' }) {
  const end = endOfSlot(date, time, durationMin);
  const start = gcalDateTime(date, time);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title || 'Консультация',
    dates: `${start}/${gcalDateTime(end.date, end.time)}`,
    details: details || '',
    location: location || '',
    ctz: timezone
  });
  return `${GCAL_TEMPLATE}?${params.toString()}`;
}

function gcalDateTime(date, time) {
  return `${String(date).replaceAll('-', '')}T${String(time || '00:00').replace(':', '')}00`;
}

/**
 * Конец слота: «23:30» + 60 мин → следующий день 00:30.
 * Арифметика — строго над «настенными» значениями (даты в шаблоне Google
 * трактуются в `ctz`), поэтому Date/локальный пояс браузера не используются.
 */
export function endOfSlot(date, time, minutes) {
  const start = timeToMinutes(time);
  if (start == null) return { date, time: time || '00:00' };
  const total = start + (Number(minutes) || 0);
  return {
    date: addDaysStr(String(date).slice(0, 10), Math.floor(total / 1440)),
    time: addMinutesToTime(time, minutes)
  };
}

/* ============================================================================
 * .ics «Добавить в календарь» (#65, BL-08)
 * ========================================================================== */

const ICS_PRODID = '-//Psihologist-cabinet//Booking//RU';

/** Экранирование TEXT по RFC 5545 §3.3.11: \ ; , и перевод строки */
function icsText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Фолдинг строки по RFC 5545 §3.1: не длиннее 75 октетов UTF-8, продолжение —
 * CRLF + пробел. Режем по символам (code points), чтобы не разорвать
 * многобайтовую кириллицу/эмодзи посередине.
 */
function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74; // у строк-продолжений первый октет — пробел
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** 'YYYY-MM-DD' + 'HH:MM' → 'YYYYMMDDTHHMM00' (локальное время с TZID) */
function icsLocal(date, time) {
  return `${String(date).replaceAll('-', '')}T${String(time || '00:00').slice(0, 5).replace(':', '')}00`;
}

/** Date → 'YYYYMMDDTHHMMSSZ' (UTC) */
function icsUtc(instant) {
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Смещение в минутах → '+0300' / '-0530' (UTC-OFFSET, RFC 5545 §3.3.14) */
function icsOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

/**
 * VTIMEZONE для события: смещение пояса, действующее в момент встречи.
 * Правила DST на все годы не нужны — в файле одно событие. Если внутри
 * встречи случается переход (ночь смены летнего времени), добавляется второй
 * компонент с точным моментом перехода (поиск до минуты).
 */
function icsVtimezone(tz, startInstant, endInstant) {
  const offStart = offsetMinutes(startInstant, tz);
  const offEnd = offsetMinutes(endInstant, tz);
  const lines = [
    'BEGIN:VTIMEZONE', `TZID:${tz}`,
    'BEGIN:STANDARD', 'DTSTART:19700101T000000',
    `TZOFFSETFROM:${icsOffset(offStart)}`, `TZOFFSETTO:${icsOffset(offStart)}`,
    'END:STANDARD'
  ];
  if (offEnd !== offStart) {
    let lo = startInstant.getTime();
    let hi = endInstant.getTime();
    while (hi - lo > 60000) {
      const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
      if (offsetMinutes(new Date(mid), tz) === offStart) lo = mid; else hi = mid;
    }
    // DTSTART компонента — местное время по «старому» смещению (RFC 5545 §3.6.5)
    const localAtChange = new Date(hi + offStart * 60000).toISOString();
    const kind = offEnd > offStart ? 'DAYLIGHT' : 'STANDARD';
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${icsLocal(localAtChange.slice(0, 10), localAtChange.slice(11, 16))}`,
      `TZOFFSETFROM:${icsOffset(offStart)}`, `TZOFFSETTO:${icsOffset(offEnd)}`,
      `END:${kind}`
    );
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

/**
 * Файл iCalendar для одной встречи (VCALENDAR + VTIMEZONE + VEVENT).
 *
 * Время — «настенное» в поясе специалиста (как хранится запись); TZID/VTIMEZONE
 * позволяют календарю клиента самому показать встречу в его поясе.
 * Длительность — только канонический resolveDurationMinutes (снимок записи →
 * услуга → дефолт). Конец считается от момента начала + длительность, поэтому
 * верен и через полночь, и через переход на летнее время.
 *
 * @returns {string} текст .ics (CRLF), или '' если дата/время некорректны
 */
export function buildIcsEvent({
  title, date, time, durationMin = null, service = null, timezone = DEFAULT_TIMEZONE,
  location = '', url = '', description = '', uid = '', now = new Date()
} = {}) {
  const tz = isValidZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const day = String(date || '').slice(0, 10);
  const hhmm = String(time || '').slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || timeToMinutes(hhmm) == null) return '';
  const start = zonedToInstant(day, hhmm, tz);
  if (!start) return '';
  const minutes = resolveDurationMinutes({ durationMin, service });
  const end = new Date(start.getTime() + minutes * 60000);
  const endLocal = instantToZoned(end, tz);
  const stamp = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...icsVtimezone(tz, start, end),
    'BEGIN:VEVENT',
    `UID:${icsText(uid || `${icsUtc(start)}-${Math.random().toString(36).slice(2, 10)}`)}@psihologist-cabinet`,
    `DTSTAMP:${icsUtc(stamp)}`,
    `DTSTART;TZID=${tz}:${icsLocal(day, hhmm)}`,
    `DTEND;TZID=${tz}:${icsLocal(endLocal.date, endLocal.time)}`,
    `SUMMARY:${icsText(title || 'Консультация')}`
  ];
  if (location) lines.push(`LOCATION:${icsText(location)}`);
  if (url) lines.push(`URL:${String(url).replace(/[\r\n]/g, '')}`);
  if (description) lines.push(`DESCRIPTION:${icsText(description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/**
 * Человекочитаемое имя файла: «Консультация — Анна Иванова — 2026-10-05 10-00.ics».
 * Символы, запрещённые в именах файлов (Windows/macOS/iOS), вырезаются.
 */
export function icsFileName({ specialist = '', date = '', time = '' } = {}) {
  const clean = v => String(v || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = ['Консультация', clean(specialist), [clean(date), clean(String(time).replace(':', '-'))].filter(Boolean).join(' ')]
    .filter(Boolean);
  return `${parts.join(' — ').slice(0, 120)}.ics`;
}

/**
 * href для <a download> — data:-URI с UTF-8. Работает в HTML-строках без
 * обработчиков и отзыва blob-URL; на iPhone Safari открывает системное
 * «Добавить в Календарь», на десктопе скачивает файл.
 */
export function icsHref(icsText) {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(icsText || '')}`;
}

/**
 * Минимальный парсер iCal (VEVENT: SUMMARY/DTSTART/DTEND/UID) → события.
 * Поддерживает форматы YYYYMMDD, YYYYMMDDTHHMMSS(Z). TZID не разбирается —
 * время трактуется как локальное (для free/busy этого достаточно).
 */
export function parseIcs(text) {
  const events = [];
  const unfolded = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, ''); // unfolding long lines
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
  for (const raw of blocks) {
    const body = raw.split('END:VEVENT')[0] || '';
    const ev = { uid: '', summary: '', dateFrom: '', timeFrom: '', dateTo: '', timeTo: '', allDay: false };
    for (const line of body.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const keyPart = line.slice(0, idx);
      const value = line.slice(idx + 1).trim();
      const key = keyPart.split(';')[0].toUpperCase();
      if (key === 'UID') ev.uid = value;
      if (key === 'SUMMARY') ev.summary = value.replace(/\\,/g, ',').replace(/\\n/g, ' ');
      if (key === 'DTSTART' || key === 'DTEND') {
        const isDateOnly = /VALUE=DATE(;|$)/.test(keyPart) || /^\d{8}$/.test(value);
        const parsed = parseIcsDate(value);
        if (!parsed) continue;
        if (key === 'DTSTART') { ev.dateFrom = parsed.date; ev.timeFrom = parsed.time; }
        else { ev.dateTo = parsed.date; ev.timeTo = parsed.time; }
        if (isDateOnly) ev.allDay = true;
      }
    }
    if (ev.dateFrom) {
      if (!ev.dateTo) ev.dateTo = ev.dateFrom;
      // iCal DTEND для событий «весь день» — эксклюзивный (следующий день) → сдвигаем на день назад
      if (ev.allDay && ev.dateTo > ev.dateFrom) {
        const d = new Date(`${ev.dateTo}T12:00:00`);
        d.setDate(d.getDate() - 1);
        ev.dateTo = d.toISOString().slice(0, 10);
      }
      events.push(ev);
    }
  }
  return events;
}

function parseIcsDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(String(value).trim());
  if (!m) return null;
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: m[4] != null ? `${m[4]}:${m[5]}` : ''
  };
}

/** События iCal → данные для ScheduleBlock (kind=busy, source=google) */
export function icsEventsToBlocks(events, psychologistId) {
  return events.map(ev => ({
    psychologistId,
    dateFrom: ev.dateFrom,
    dateTo: ev.dateTo,
    timeFrom: ev.allDay ? '' : ev.timeFrom,
    timeTo: ev.allDay ? '' : ev.timeTo,
    kind: 'busy',
    title: ev.summary || 'Занят (Google Calendar)',
    note: 'Импортировано из Google Calendar',
    source: 'google',
    googleEventId: ev.uid
  }));
}

/**
 * Скачать iCal-фид и вернуть блокировки.
 * Браузер может блокировать CORS — тогда возвращаем { ok:false, reason:'cors' }.
 */
export async function fetchGoogleBusyBlocks(icalUrl, psychologistId) {
  try {
    const res = await fetch(icalUrl, { method: 'GET', mode: 'cors' });
    if (!res.ok) return { ok: false, reason: 'http', message: `HTTP ${res.status}` };
    const text = await res.text();
    const events = parseIcs(text);
    return { ok: true, blocks: icsEventsToBlocks(events, psychologistId), count: events.length };
  } catch (e) {
    return { ok: false, reason: 'cors', message: String(e?.message || e) };
  }
}

export const calendarService = {
  googleAddLink, endOfSlot, buildIcsEvent, icsFileName, icsHref,
  parseIcs, icsEventsToBlocks, fetchGoogleBusyBlocks
};
