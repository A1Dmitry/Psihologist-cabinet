/**
 * CalendarService — интеграция с Google Calendar (известные наработки):
 * 1) «Добавить в календарь» — ссылка-шаблон calendar/render?action=TEMPLATE
 *    (та же механика, что у Calendly/Booksy для карточки события).
 * 2) Импорт занятости из iCal-фидов (Google Calendar → Настройки → «Secret address
 *    in iCal format», basic.ics): события календаря превращаются в блокировки занятости.
 *    Импорт идёт браузером психолога (адрес — секретный, публично не отдаётся);
 *    публично видны только итоговые free/busy блоки.
 * Для двусторонней синхронизации в проде — Google Calendar API (OAuth), см. docs.
 */

const GCAL_TEMPLATE = 'https://calendar.google.com/calendar/render';

/* ============================================================================
 * Часовые пояса (T-03 «Часовой пояс клиента»)
 * --------------------------------------------------------------------------
 * Расписание специалиста хранится в ЕГО поясе (session_settings.timezone):
 * сетка слотов — это «стенное» время специалиста на конкретную дату.
 * Клиент может быть в другом поясе, поэтому:
 *   1) слот переводится в абсолютный момент (UTC) по поясу специалиста;
 *   2) тот же момент форматируется в поясе клиента — так получается честное
 *      «время в вашем поясе» без ручного сложения/вычитания часов
 *      (правильно работает с DST и с полуторачасовыми оффсетами);
 *   3) в БД пишется время специалиста + (после SR-001) пояс клиента.
 * ========================================================================== */

const ZONE_FMT = new Map();
function zoneFormatter(timeZone) {
  let f = ZONE_FMT.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    ZONE_FMT.set(timeZone, f);
  }
  return f;
}

/** IANA-пояс браузера («Europe/Minsk»). На старых/заблокированных — fallback. */
export function detectTimeZone(fallback = 'UTC') {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
  } catch (_) {
    return fallback;
  }
}

/** Смещение пояса в минутах на момент `at` (положительное — восточнее UTC). */
export function zoneOffsetMinutes(timeZone, at = new Date()) {
  const instant = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(instant.getTime())) return 0;
  const parts = {};
  for (const p of zoneFormatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  // hour12:false в ряде движков отдаёт «24» вместо «00» для полуночи
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** «UTC+3», «UTC−3:30», «UTC+0» — подпись оффсета для человека. */
export function formatUtcOffset(minutes) {
  const total = Math.round(Number(minutes) || 0);
  const sign = total < 0 ? '−' : '+';
  const abs = Math.abs(total);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** «Стенное» время `time` в поясе `timeZone` на дату `date` → абсолютный момент. */
export function zonedTimeToUtc(date, time, timeZone) {
  const [y, m, d] = String(date || '').split('-').map(Number);
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  const naive = Date.UTC(y || 1970, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  // два прохода: оффсет уточняется по найденному моменту (корректно на границах DST)
  let ts = naive - zoneOffsetMinutes(timeZone, new Date(naive)) * 60000;
  ts = naive - zoneOffsetMinutes(timeZone, new Date(ts)) * 60000;
  return new Date(ts);
}

/** Часы (HH:MM) момента `instant` в поясе `timeZone`. */
export function formatInZone(instant, timeZone) {
  const parts = {};
  for (const p of zoneFormatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  return `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}`;
}

/** Дата (YYYY-MM-DD) момента `instant` в поясе `timeZone`. */
export function dateInZone(instant, timeZone) {
  const parts = {};
  for (const p of zoneFormatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Перенос «стенного» времени из одного пояса в другой.
 * dayShift — на сколько суток сдвинулась календарная дата (слот «уехал»
 * на следующий/предыдущий день по lokal'ному календарю клиента).
 */
export function convertWallClock(date, time, fromZone, toZone) {
  const instant = zonedTimeToUtc(date, time, fromZone);
  const outDate = dateInZone(instant, toZone);
  const outTime = formatInZone(instant, toZone);
  const day = 24 * 60 * 60 * 1000;
  const dayShift = Math.round(
    (Date.parse(`${outDate}T00:00:00Z`) - Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`)) / day
  );
  return { date: outDate, time: outTime, dayShift };
}

/** Слот уже начался (прошедшее время не предлагаем). */
export function isPastMoment(date, time, timeZone, now = new Date()) {
  return zonedTimeToUtc(date, time, timeZone).getTime() <= now.getTime();
}


/** Ссылка «Добавить событие в Google Calendar» */
export function googleAddLink({ title, date, time, durationMin = 60, details = '', location = '', timezone = 'Europe/Minsk' }) {
  const start = gcalDateTime(date, time);
  const endDate = addMinutes(date, time, durationMin);
  const end = gcalDateTime(endDate.date, endDate.time);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title || 'Консультация',
    dates: `${start}/${end}`,
    details: details || '',
    location: location || '',
    ctz: timezone
  });
  return `${GCAL_TEMPLATE}?${params.toString()}`;
}

function gcalDateTime(date, time) {
  return `${String(date).replaceAll('-', '')}T${String(time || '00:00').replace(':', '')}00`;
}

function addMinutes(date, time, minutes) {
  // Calendar template dates are wall-clock values in `ctz`; using Date here
  // would silently apply the preview/browser timezone and break around UTC/DST.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(time || '00:00'));
  if (!match || !timeMatch) return { date, time: time || '00:00' };
  const total = Number(timeMatch[1]) * 60 + Number(timeMatch[2]) + (Number(minutes) || 60);
  const dayOffset = Math.floor(total / 1440);
  const dayMinutes = ((total % 1440) + 1440) % 1440;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return {
    date: d.toISOString().slice(0, 10),
    time: `${String(Math.floor(dayMinutes / 60)).padStart(2, '0')}:${String(dayMinutes % 60).padStart(2, '0')}`
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

export const calendarService = {
  googleAddLink, parseIcs, icsEventsToBlocks, fetchGoogleBusyBlocks,
  // часовые пояса (T-03)
  detectTimeZone, zoneOffsetMinutes, formatUtcOffset, zonedTimeToUtc,
  formatInZone, dateInZone, convertWallClock, isPastMoment
};
