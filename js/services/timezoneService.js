/**
 * TimezoneService — работа с часовыми поясами в расписании.
 *
 * Зачем: кабинет хранит дату/время сессии как «настенное» время специалиста
 * (YYYY-MM-DD + HH:MM, см. sessions.session_date/session_time). Клиент может
 * быть в другом поясе — тогда одно и то же настенное время читается им иначе.
 *
 * Сервис умеет:
 *  - считать смещение пояса на конкретный момент (Intl, без библиотек);
 *  - переводить «настенное» время одного пояса в другой (T-23);
 *  - подписывать время человекочитаемо («10:00 в Минске ≈ 09:00 у вас»).
 *
 * Всё чистое и без побочных эффектов — годится для юнит-проверок в Node.
 */

export const DEFAULT_TIMEZONE = 'Europe/Minsk';

/** Города/подписи для распространённых поясов (компактно, без Intl.DisplayNames) */
const ZONE_LABELS = {
  'Europe/Minsk': 'Минск',
  'Europe/Kaliningrad': 'Калининград',
  'Europe/Moscow': 'Москва',
  'Europe/Kyiv': 'Киев',
  'Europe/Kiev': 'Киев',
  'Europe/Warsaw': 'Варшава',
  'Europe/Berlin': 'Берлин',
  'Europe/Paris': 'Париж',
  'Europe/London': 'Лондон',
  'Europe/Lisbon': 'Лиссабон',
  'Europe/Prague': 'Прага',
  'Europe/Vilnius': 'Вильнюс',
  'Europe/Riga': 'Рига',
  'Europe/Tallinn': 'Таллин',
  'Europe/Bucharest': 'Бухарест',
  'Asia/Almaty': 'Алматы',
  'Asia/Tbilisi': 'Тбилиси',
  'Asia/Yerevan': 'Ереван',
  'Asia/Dubai': 'Дубай',
  'Asia/Tel_Aviv': 'Тель-Авив',
  'Asia/Jerusalem': 'Иерусалим',
  'Asia/Bangkok': 'Бангкок',
  'Asia/Tokyo': 'Токио',
  'Asia/Shanghai': 'Шанхай',
  'Asia/Seoul': 'Сеул',
  'Asia/Novosibirsk': 'Новосибирск',
  'Asia/Yekaterinburg': 'Екатеринбург',
  'Asia/Vladivostok': 'Владивосток',
  'America/New_York': 'Нью-Йорк',
  'America/Chicago': 'Чикаго',
  'America/Denver': 'Денвер',
  'America/Los_Angeles': 'Лос-Анджелес',
  'America/Sao_Paulo': 'Сан-Паулу',
  'America/Toronto': 'Торонто',
  'Australia/Sydney': 'Сидней',
  'Pacific/Auckland': 'Окленд',
  'UTC': 'UTC'
};

function partsOf(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type === 'literal') continue;
    out[p.type] = p.value;
  }
  return out;
}

/** Валиден ли идентификатор пояса */
export function isValidZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Пояс браузера клиента (fallback — пояс портала) */
export function browserZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidZone(tz) ? tz : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Смещение пояса в минутах на конкретный момент (например +180 для Минска) */
export function offsetMinutes(date, timeZone) {
  const tz = isValidZone(timeZone) ? timeZone : 'UTC';
  const at = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(at.getTime())) return 0;
  const p = partsOf(at, tz);
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** «+03:00» / «−05:30» */
export function formatOffset(minutes) {
  const sign = minutes < 0 ? '−' : '+';
  const abs = Math.abs(Math.round(minutes));
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

/**
 * Настенное время (дата + время) в указанном поясе → момент времени (UTC).
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} timeStr HH:MM
 * @param {string} timeZone IANA
 */
export function zonedToInstant(dateStr, timeStr, timeZone) {
  const naive = Date.parse(`${dateStr}T${(timeStr || '00:00').slice(0, 5)}:00Z`);
  if (Number.isNaN(naive)) return null;
  // первый проход — оценка, второй — уточнение для переходов на летнее время
  let guess = naive - offsetMinutes(new Date(naive), timeZone) * 60000;
  guess = naive - offsetMinutes(new Date(guess), timeZone) * 60000;
  return new Date(guess);
}

/** Момент времени → настенное время в поясе: {date, time, weekday} */
export function instantToZoned(instant, timeZone) {
  const at = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  const p = partsOf(at, isValidZone(timeZone) ? timeZone : 'UTC');
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`;
  return { date, time, weekday: weekdayOf(date) };
}

/**
 * Перевести настенное время из одного пояса в другой (T-23).
 * @returns {{date: string, time: string, weekday: number}|null}
 */
export function convertWallClock(dateStr, timeStr, fromZone, toZone) {
  const from = isValidZone(fromZone) ? fromZone : DEFAULT_TIMEZONE;
  const to = isValidZone(toZone) ? toZone : DEFAULT_TIMEZONE;
  if (from === to) return { date: dateStr, time: timeStr, weekday: weekdayOf(dateStr) };
  const instant = zonedToInstant(dateStr, timeStr, from);
  if (!instant) return null;
  return instantToZoned(instant, to);
}

/** Разница поясов в минутах (to − from) на указанный момент */
export function zoneDiffMinutes(fromZone, toZone, atInstant = new Date()) {
  return offsetMinutes(atInstant, toZone) - offsetMinutes(atInstant, fromZone);
}

/** День недели: 1 = Пн … 7 = Вс (как session_settings.work_days) */
export function weekdayOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 0;
  const js = d.getUTCDay(); // 0 = Вс
  return js === 0 ? 7 : js;
}

/** Понедельник недели, в которую попадает дата (YYYY-MM-DD) */
export function startOfWeek(dateStr) {
  const wd = weekdayOf(dateStr);
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (wd - 1));
  return d.toISOString().slice(0, 10);
}

export function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export const WEEKDAY_NAMES_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const WEEKDAY_NAMES_FULL = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];

/** «Пн 10:00», «по понедельникам в 10:00» */
export function weekdayTimeLabel(weekday, time, { full = false } = {}) {
  const name = full ? WEEKDAY_NAMES_FULL[weekday] : WEEKDAY_NAMES_SHORT[weekday];
  return full ? `по ${name} в ${time}` : `${name} ${time}`;
}

/** Человекочитаемое имя пояса: «Минск (UTC+03:00)» */
export function zoneLabel(timeZone, atInstant = new Date()) {
  const tz = isValidZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  const city = ZONE_LABELS[tz] || tz.split('/').pop().replace(/_/g, ' ');
  return `${city} (UTC${formatOffset(offsetMinutes(atInstant, tz))})`;
}

/** Короткое имя пояса без смещения: «Минск» */
export function zoneCity(timeZone) {
  const tz = isValidZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  return ZONE_LABELS[tz] || tz.split('/').pop().replace(/_/g, ' ');
}

/**
 * Подпись для карточки сессии: показывает время в поясе психолога и,
 * если клиент в другом поясе, — во сколько это у клиента.
 * @param {{date: string, time: string, clientTimezone?: string, zoneOffsetMin?: number}} session
 * @param {string} psyZone пояс кабинета
 */
export function sessionZoneLabel(session, psyZone = DEFAULT_TIMEZONE) {
  const base = { time: session.time, date: session.date, zone: psyZone, sameZone: true, clientTime: null, clientDate: null, clientOffsetMin: null };
  const clientTz = session?.clientTimezone;
  if (!clientTz || !isValidZone(clientTz) || clientTz === psyZone) {
    // если пояс не сохранён, но есть зафиксированное смещение клиента — считаем по нему
    if (typeof session?.zoneOffsetMin === 'number' && Number.isFinite(session.zoneOffsetMin)) {
      const instant = zonedToInstant(session.date, session.time, psyZone);
      const diff = session.zoneOffsetMin - offsetMinutes(instant, psyZone);
      if (diff !== 0) {
        const local = new Date(instant.getTime() + diff * 60000);
        return {
          ...base,
          sameZone: false,
          clientOffsetMin: session.zoneOffsetMin,
          clientDate: local.toISOString().slice(0, 10),
          clientTime: local.toISOString().slice(11, 16)
        };
      }
    }
    return base;
  }
  const converted = convertWallClock(session.date, session.time, psyZone, clientTz);
  if (!converted) return base;
  if (converted.date === session.date && converted.time === session.time) return base;
  return {
    ...base,
    sameZone: false,
    zone: psyZone,
    clientZone: clientTz,
    clientDate: converted.date,
    clientTime: converted.time,
    clientOffsetMin: zoneDiffMinutes(psyZone, clientTz, zonedToInstant(session.date, session.time, psyZone))
  };
}

/** «10:00 (у клиента 09:00)» — для плотных списков; '' если пояса совпадают */
export function sessionZoneHint(session, psyZone = DEFAULT_TIMEZONE) {
  const z = sessionZoneLabel(session, psyZone);
  if (z.sameZone || !z.clientTime) return '';
  const dayNote = z.clientDate && z.clientDate !== z.date ? ' (др. день)' : '';
  return `у клиента ${z.clientTime}${dayNote}`;
}

export const timezoneService = {
  DEFAULT_TIMEZONE,
  isValidZone,
  browserZone,
  offsetMinutes,
  formatOffset,
  zonedToInstant,
  instantToZoned,
  convertWallClock,
  zoneDiffMinutes,
  weekdayOf,
  startOfWeek,
  addDaysStr,
  todayStr,
  weekdayTimeLabel,
  zoneLabel,
  zoneCity,
  sessionZoneLabel,
  sessionZoneHint,
  WEEKDAY_NAMES_SHORT,
  WEEKDAY_NAMES_FULL
};
