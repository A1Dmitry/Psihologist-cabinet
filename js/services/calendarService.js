/**
 * CalendarService — интеграция с Google Calendar (известные наработки):
 * 1) «Добавить в календарь» — ссылка-шаблон calendar/render?action=TEMPLATE
 *    (та же механика, что у Calendly/Booksy для карточки события).
 * 2) Импорт занятости из iCal-фидов (Google Calendar → Настройки → «Secret address
 *    in iCal format», basic.ics): события календаря превращаются в блокировки занятости.
 *    Импорт идёт браузером психолога (адрес — секретный, публично не отдаётся);
 *    публично видны только итоговые free/busy блоки.
 * 3) Часовые пояса клиента/специалиста (T-03) и проверка длительности слота (T-02).
 * 4) T-22: черновик события Meet через Calendar API — см. meetEventDraft()
 *    (OAuth на стороне владельца, поля — заявка SR-002).
 */

const GCAL_TEMPLATE = 'https://calendar.google.com/calendar/render';
const DEFAULT_TZ = 'Europe/Minsk';

/** Ссылка «Добавить событие в Google Calendar» */
export function googleAddLink({ title, date, time, durationMin = 60, details = '', location = '', timezone = DEFAULT_TZ }) {
  const start = gcalDateTime(date, time);
  const endDate = addMinutes(date, time, durationMin);
  const end = gcalDateTime(endDate.date, endDate.time);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title || 'Консультация',
    dates: `${start}/${end}`,
    details: details || '',
    location: location || '',
    ctz: timezone || DEFAULT_TZ
  });
  return `${GCAL_TEMPLATE}?${params.toString()}`;
}

function gcalDateTime(date, time) {
  return `${String(date).replaceAll('-', '')}T${String(time || '00:00').replace(':', '')}00`;
}

/** Гражданское +N минут без UTC-сдвига (date/time трактуются как «настенные»). */
export function addMinutes(date, time, minutes) {
  const [y, mo, d] = String(date).split('-').map(Number);
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  let total = (hh * 60 + (mm || 0)) + (Number(minutes) || 60);
  let dayAdd = Math.floor(total / (24 * 60));
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const utc = Date.UTC(y, (mo || 1) - 1, d || 1);
  const next = new Date(utc + dayAdd * 86400000);
  return {
    date: next.toISOString().slice(0, 10),
    time: `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  };
}

export function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToTime(min) {
  const n = ((Number(min) % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/**
 * Конец рабочего окна: из «Пн–Пт 10:00–19:00», иначе slotEnd + slotStepMin
 * (slotEnd — время СТАРТА последнего слота).
 */
export function workWindowEnd(settings) {
  const wh = settings?.workHours || '';
  const m = /(\d{1,2}:\d{2})\s*[–\-—]\s*(\d{1,2}:\d{2})/.exec(wh);
  if (m) {
    const [h, min] = m[2].split(':');
    return `${String(h).padStart(2, '0')}:${min}`;
  }
  const endStart = settings?.slotEnd || '18:00';
  const step = Number(settings?.slotStepMin) || 60;
  return minutesToTime(timeToMinutes(endStart) + step);
}

export function detectClientTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export function timeZoneOffsetLabel(timeZone, at = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' });
    const part = fmt.formatToParts(at).find(p => p.type === 'timeZoneName');
    return part?.value || '';
  } catch {
    return '';
  }
}

export function clientUtcOffsetMinutes(timeZone, at = new Date()) {
  try {
    const label = timeZoneOffsetLabel(timeZone, at); // GMT+2 / UTC+2 / GMT-5
    const m = /([+-])(\d{1,2})(?::?(\d{2}))?/.exec(label || '');
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch {
    return 0;
  }
}

export function formatTimeZoneCaption(clientTz, psyTz) {
  const clientBit = formatTz(clientTz);
  if (!psyTz || psyTz === clientTz) return `Время в вашем поясе: ${clientBit}`;
  return `Время в вашем поясе: ${clientBit}. У специалиста: ${formatTz(psyTz)}`;
}

function formatTz(tz) {
  const off = timeZoneOffsetLabel(tz);
  return off ? `${tz} (${off})` : tz;
}

/** Смещение зоны относительно UTC для данного инстанта (мс). */
function tzOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const map = Object.fromEntries(dtf.formatToParts(instant).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - instant.getTime();
}

/** Настенные date+time в зоне timeZone → UTC Date. */
export function zonedLocalToUtc(date, time, timeZone) {
  const [y, m, d] = String(date).split('-').map(Number);
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  let utc = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  const guess = new Date(utc);
  utc -= tzOffsetMs(guess, timeZone || DEFAULT_TZ);
  const again = tzOffsetMs(new Date(utc), timeZone || DEFAULT_TZ);
  const first = tzOffsetMs(guess, timeZone || DEFAULT_TZ);
  if (again !== first) utc = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0) - again;
  return new Date(utc);
}

export function wallTimeInZone(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || DEFAULT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23'
  });
  const map = Object.fromEntries(dtf.formatToParts(instant).map(p => [p.type, p.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`
  };
}

/** Слот специалиста (его пояс) → подпись во поясе клиента. */
export function convertPsySlotToClient(date, time, psyTz, clientTz) {
  const psy = psyTz || DEFAULT_TZ;
  const cli = clientTz || psy;
  if (cli === psy) return { date, time, label: time, dayShift: 0 };
  const utc = zonedLocalToUtc(date, time, psy);
  const wall = wallTimeInZone(utc, cli);
  let dayShift = 0;
  if (wall.date > date) dayShift = 1;
  else if (wall.date < date) dayShift = -1;
  let label = wall.time;
  if (dayShift === 1) label += ' (+1 дн.)';
  if (dayShift === -1) label += ' (−1 дн.)';
  return { date: wall.date, time: wall.time, label, dayShift };
}

export function isPastSlot(date, time, timeZone) {
  try {
    return zonedLocalToUtc(date, time, timeZone || DEFAULT_TZ).getTime() <= Date.now() - 30 * 1000;
  } catch {
    return false;
  }
}

/**
 * Слот длительности durationMin, стартующий в `time`, укладывается в рабочее
 * окно и не пересекается с занятостью/блоками.
 */
export function slotFitsDuration({ time, durationMin, workEnd, intervals = [], blocks = [], date }) {
  const start = timeToMinutes(time);
  const dur = Number(durationMin) || 60;
  const end = start + dur;
  const winEnd = timeToMinutes(workEnd || '19:00');
  if (end > winEnd) return { ok: false, reason: 'duration' };
  if (intervals.some(iv => start < iv.end && end > iv.start)) return { ok: false, reason: 'busy' };
  if (date && blocks.some(b => intervalHitsBlock(b, date, start, end))) return { ok: false, reason: 'block' };
  return { ok: true, reason: '' };
}

export function intervalHitsBlock(b, date, startMin, endMin) {
  const from = b.dateFrom || '';
  const to = b.dateTo || b.dateFrom || '';
  if (!from || date < from || date > to) return false;
  if (!b.timeFrom && !b.timeTo) return true;
  const bStart = timeToMinutes(b.timeFrom || '00:00');
  const bEnd = timeToMinutes(b.timeTo || '23:59');
  return startMin < bEnd && endMin > bStart;
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
      // iCal DTEND для全天-событий — эксклюзивный (следующий день) → сдвигаем на день назад
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

/**
 * T-22 · черновик Google Calendar event с автосозданием Meet-конференции.
 * Не вызывается, пока владелец не настроит OAuth (см. docs/T-22-MEET.md, SR-002).
 * POST https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1
 */
export function meetEventDraft({
  title, date, time, durationMin = 60, timezone = DEFAULT_TZ,
  description = '', location = '', attendees = [], requestId = ''
}) {
  const start = zonedLocalToUtc(date, time, timezone);
  const endWall = addMinutes(date, time, durationMin);
  const end = zonedLocalToUtc(endWall.date, endWall.time, timezone);
  return {
    summary: title || 'Консультация',
    description: description || '',
    location: location || '',
    start: { dateTime: start.toISOString(), timeZone: timezone },
    end: { dateTime: end.toISOString(), timeZone: timezone },
    attendees: (attendees || []).filter(Boolean).map(email => ({ email })),
    conferenceData: {
      createRequest: {
        requestId: requestId || `meet-${date}-${String(time).replace(':', '')}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  };
}

export const calendarService = {
  googleAddLink, parseIcs, icsEventsToBlocks, fetchGoogleBusyBlocks,
  addMinutes, timeToMinutes, minutesToTime, workWindowEnd,
  detectClientTimeZone, formatTimeZoneCaption, convertPsySlotToClient,
  zonedLocalToUtc, wallTimeInZone, isPastSlot, slotFitsDuration,
  clientUtcOffsetMinutes, meetEventDraft, intervalHitsBlock
};
