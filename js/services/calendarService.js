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
  const d = new Date(`${date}T${time || '00:00'}:00`);
  d.setMinutes(d.getMinutes() + (Number(minutes) || 60));
  return {
    date: d.toISOString().slice(0, 10),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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

export const calendarService = { googleAddLink, parseIcs, icsEventsToBlocks, fetchGoogleBusyBlocks };
