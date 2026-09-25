/**
 * CalendarService — интеграция с внешними календарями (Google Calendar / iCal).
 *
 * 1) «Добавить в календарь» — ссылка-шаблон calendar/render?action=TEMPLATE
 *    (та же механика, что у Calendly/Booksy для карточки события).
 * 2) Импорт занятости из iCal-фидов (Google Calendar → Настройки → «Secret address
 *    in iCal format», basic.ics): события календаря превращаются в блокировки занятости.
 *    Импорт идёт браузером психолога (адрес — секретный, публично не отдаётся);
 *    публично видны только итоговые free/busy блоки.
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
  isValidZone, offsetMinutes, DEFAULT_TIMEZONE
} from './timezoneService.js';
import { toDurationMinutes, DEFAULT_DURATION_MIN } from '../domain/duration.js';

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

/* ============================================================================
 * «Добавить в календарь» — универсальный .ics (Apple / Outlook / Google / Яндекс)
 *
 * Issue #65 / BL-08: на успехе записи клиенту предлагается не только
 * template-link Google, а стандартный .ics-артефакт — один тап добавляет
 * событие в любой календарный клиент (iPhone/Apple Calendar, Outlook, …).
 *
 * Канон (RULES §6.14, AUDIT-REG-DRY-001):
 *  - вся арифметика времени — только через timezoneService (offsetMinutes) и
 *    endOfSlot; собственных «часов» здесь нет;
 *  - длительность — вызывающий передаёт УЖЕ разрешённую durationMin
 *    (снимок записи / resolveDurationMinutes); генератор не переиводит её;
 *  - событие — в настенном времени специалиста (как в БД и как gcal-link);
 *    пояс клиента в артефакт не участвует (он только для отображения);
 *  - это артефакт существующей записи, НЕ отдельный календарный движок.
 * RFC 5545: CRLF, сворачивание строк на 75 октетах, экранирование \ ; , \n.
 * ========================================================================== */

const ICS_PRODID = '-//PsyPortal//Psyhologist-cabinet//RU';

/** Экранирование текста поля VCALENDAR (RFC 5545 §3.3.11). */
function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Минуты смещения → параметр «+0300» / «-0530». */
function icsOffsetParam(minutes) {
  const m = Math.round(Number(minutes) || 0);
  const abs = Math.abs(m);
  const sign = m < 0 ? '-' : '+';
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

/** Настенная дата+время → «YYYYMMDDTHHMMSS». */
function icsLocalStamp(dateStr, timeStr) {
  const d = String(dateStr || '').slice(0, 10).replaceAll('-', '');
  const [h = '0', m = '0'] = String(timeStr || '').split(':');
  const hh = String(Math.max(0, Math.min(23, Number(h) || 0))).padStart(2, '0');
  const mm = String(Math.max(0, Math.min(59, Number(m) || 0))).padStart(2, '0');
  return `${d}T${hh}${mm}00`;
}

/** Момент → «YYYYMMDDTHHMMSSZ» (UTC). */
function icsUtcStamp(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsUtf8Len(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** Сворачивание строки RFC 5545: не длиннее 75 ОКТЕТОВ, продолжение — с пробела. */
function icsFoldLine(line) {
  const out = [];
  let current = '';
  let octets = 0;
  for (const ch of String(line)) {
    const len = icsUtf8Len(ch);
    if (octets + len > 75) {
      out.push(current);
      current = ' ' + ch;
      octets = 1 + len;
    } else {
      current += ch;
      octets += len;
    }
  }
  out.push(current);
  return out;
}

/**
 * Настенное время МОМЕНТА перехода, выраженное в смещении, действовавшем
 * ДО перехода (так DTSTART пишется в VTIMEZONE: 20260308T020000 для США —
 * это 02:00 ещё «старого» EST, т.е. сам момент 07:00Z).
 */
function icsWallBeforeTransition(instant, preOffsetMinutes) {
  const shifted = new Date(instant.getTime() + Math.round(Number(preOffsetMinutes) || 0) * 60000);
  const iso = shifted.toISOString();
  return iso.slice(0, 10).replaceAll('-', '') + 'T' + iso.slice(11, 16).replace(':', '') + '00';
}

/** Точный момент перехода смещения в (aMs, bMs] (бинарный поиск по минутам). */
function icsFindTransition(aMs, bMs, zone, targetOffset) {
  let lo = aMs;
  let hi = bMs;
  while (hi - lo > 60000) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetMinutes(new Date(mid), zone) === targetOffset) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

const ICS_TZ_CACHE = new Map();

/**
 * VTIMEZONE для IANA-пояса — строится из РЕАЛЬНЫХ смещений timezoneService
 * (никаких захардкоженных DST-таблиц):
 *  - пояс без DST (Минск, Москва, Ташкент, …) → единственный STANDARD;
 *  - пояс с DST (обе полушария) → STANDARD + DAYLIGHT с реальными датами
 *    переходов, найденными сэмплами смещений за год события.
 * @param {string} tz      IANA-пояс (невалидный → DEFAULT_TIMEZONE)
 * @param {string} yearStr «YYYY» — год события
 */
function icsVtimezone(tz, yearStr) {
  const zone = isValidZone(tz) ? tz : DEFAULT_TIMEZONE;
  const year = Number(String(yearStr || '').slice(0, 4)) || new Date().getFullYear();
  const key = `${zone}@${year}`;
  if (ICS_TZ_CACHE.has(key)) return ICS_TZ_CACHE.get(key);

  const dayMs = 86400000;
  const startMs = Date.UTC(year, 0, 1, 12); // полдень UTC — переходы не маскируются
  const rows = [];
  for (let ms = startMs; ms < startMs + 366 * dayMs; ms += dayMs) {
    rows.push({ ms, off: offsetMinutes(new Date(ms), zone) });
  }
  const offs = [...new Set(rows.map(r => r.off))];
  const transitions = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    if (rows[i].off !== rows[i + 1].off) {
      transitions.push({ a: rows[i].ms, b: rows[i + 1].ms, from: rows[i].off, to: rows[i + 1].off });
    }
  }

  let block;
  if (offs.length < 2 || transitions.length === 0) {
    const off = offs.length === 1 ? offs[0] : offsetMinutes(new Date(startMs), zone);
    block = [
      'BEGIN:VTIMEZONE',
      `TZID:${zone}`,
      'BEGIN:STANDARD',
      `TZOFFSETFROM:${icsOffsetParam(off)}`,
      `TZOFFSETTO:${icsOffsetParam(off)}`,
      'DTSTART:19700101T000000',
      'END:STANDARD',
      'END:VTIMEZONE'
    ].join('\n');
  } else {
    const standard = Math.min(...offs);
    const daylight = Math.max(...offs);
    const toDaylight = transitions.find(t => t.from === standard && t.to === daylight);
    const toStandard = transitions.find(t => t.from === daylight && t.to === standard);
    const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
    if (toDaylight) {
      const inst = icsFindTransition(toDaylight.a, toDaylight.b, zone, daylight);
      lines.push(
        'BEGIN:DAYLIGHT',
        `TZOFFSETFROM:${icsOffsetParam(toDaylight.from)}`,
        `TZOFFSETTO:${icsOffsetParam(toDaylight.to)}`,
        `DTSTART:${icsWallBeforeTransition(inst, toDaylight.from)}`,
        'END:DAYLIGHT'
      );
    }
    if (toStandard) {
      const inst = icsFindTransition(toStandard.a, toStandard.b, zone, standard);
      lines.push(
        'BEGIN:STANDARD',
        `TZOFFSETFROM:${icsOffsetParam(toStandard.from)}`,
        `TZOFFSETTO:${icsOffsetParam(toStandard.to)}`,
        `DTSTART:${icsWallBeforeTransition(inst, toStandard.from)}`,
        'END:STANDARD'
      );
    }
    lines.push('END:VTIMEZONE');
    block = lines.join('\n');
  }
  ICS_TZ_CACHE.set(key, block);
  return block;
}

/**
 * Генератор VCALENDAR (RFC 5545) для существующей записи.
 *
 * @param {object} p
 * @param {string} p.title       SUMMARY («Консультация · Анна Иванова»)
 * @param {string} p.date        настенная дата специалиста YYYY-MM-DD
 * @param {string} p.time        настенное время специалиста HH:MM
 * @param {number} p.durationMin УЖЕ разрешённая длительность (resolveDurationMinutes)
 * @param {string} [p.details]   DESCRIPTION
 * @param {string} [p.location]  LOCATION (адрес или meet-ссылка)
 * @param {string} [p.url]       URL публичной страницы
 * @param {string} [p.timezone]  IANA-пояс специалиста (по умолчанию Europe/Minsk)
 * @param {string} [p.uid]       устойчивый UID (рекомендуется: id записи —
 *                               повторная загрузка .ics ОБНОВЛЯЕТ, а не дублирует событие)
 * @returns {string} текст .ics (CRLF)
 */
export function icsEventText({
  title = 'Консультация',
  date,
  time = '00:00',
  durationMin = DEFAULT_DURATION_MIN,
  details = '',
  location = '',
  url = '',
  timezone = DEFAULT_TIMEZONE,
  uid = ''
} = {}) {
  const zone = isValidZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const start = String(date || '').slice(0, 10);
  const dur = toDurationMinutes(durationMin) ?? DEFAULT_DURATION_MIN;
  const end = endOfSlot(start, time, dur);
  const eventUid = uid
    ? String(uid)
    : `psyportal-${start}T${String(time || '00:00').replace(':', '')}-${Math.random().toString(36).slice(2, 10)}`;

  const vtz = icsVtimezone(zone, start.slice(0, 4)).split('\n');
  const raw = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...vtz,
    'BEGIN:VEVENT',
    `UID:${icsEscape(eventUid)}`,
    `DTSTAMP:${icsUtcStamp(new Date())}`,
    `DTSTART;TZID=${zone}:${icsLocalStamp(start, time)}`,
    `DTEND;TZID=${zone}:${icsLocalStamp(end.date, end.time)}`,
    `SUMMARY:${icsEscape(title)}`,
    location ? `LOCATION:${icsEscape(location)}` : null,
    details ? `DESCRIPTION:${icsEscape(details)}` : null,
    url ? `URL:${icsEscape(url)}` : null,
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean);

  return raw.flatMap(icsFoldLine).join('\r\n') + '\r\n';
}

/** .ics как Blob (text/calendar, UTF-8) — для скачивания через <a download>. */
export function icsEventBlob(params) {
  return new Blob([icsEventText(params)], { type: 'text/calendar;charset=utf-8' });
}

const ICS_TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

/**
 * Человекочитаемое имя файла: специалист (транслитерация), дата, время.
 * «Анна Иванова» + 2026-10-05 14:00 → session-anna-ivanova-2026-10-05-14-00.ics
 */
export function icsEventFileName(name, date, time) {
  const base = String(name || '').trim()
    .toLowerCase()
    .split(/\s+/)
    .map(w => [...w].map(c => (c >= 'а' && c <= 'я') || c === 'ё' ? (ICS_TRANSLIT[c] || '') : c).join(''))
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .slice(0, 3)
    .join('-') || 'consultation';
  const d = String(date || '').slice(0, 10);
  const t = String(time || '00:00').replace(':', '-');
  return `session-${base}-${d}-${t}.ics`;
}

export const calendarService = {
  googleAddLink, endOfSlot, parseIcs, icsEventsToBlocks, fetchGoogleBusyBlocks,
  icsEventText, icsEventBlob, icsEventFileName
};
