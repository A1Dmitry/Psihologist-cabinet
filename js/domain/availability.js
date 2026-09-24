/**
 * D1 — Availability + Booking Policy Engine (каноническая реализация).
 *
 * Единственный источник истины для решения «можно ли записаться»:
 *   Service + BookingPolicy + Schedule + BusySources
 *     → CandidateSlots → PolicyFilter → BookableSlots
 *
 * Потребители: публичная запись (BookingViewModel), перенос (reschedule),
 * серии (recurring), подбор waitlist (D2), полоса доступности каталога (T-26).
 * Запрещено создавать второй availability-калькулятор (UI-only или иной):
 * все потребители вызывают этот модуль.
 *
 * Серверный близнец: проверки в `public.create_booking` (supabase/schema.sql,
 * секция D1/SR-D1) повторяют те же правила. Клиентский engine — advisory
 * (подсказывает доступность), сервер — authoritative (отклоняет нарушения
 * прямым RPC). Паритет решений покрыт tests/availability-db.mjs.
 *
 * Модуль чистый: без DOM, без db, без импортов сервисов. Перевод
 * «настенное время в поясе специалиста → момент» инжектится через `clock`,
 * чтобы не дублировать timezoneService (single tz implementation).
 *
 * Входные структуры — plain data:
 *   schedule: { workDays:[1..7], slotStart:'HH:MM', slotEnd:'HH:MM',
 *               slotTimes:['HH:MM']|null, stepMin:60, timezone:'...' }
 *   policy:   { minNoticeMinutes, maxAdvanceDays|null, bufferBeforeMin,
 *               bufferAfterMin, slotIncrementMin|null,
 *               maxBookingsPerDay|null, maxBookingsPerWeek|null }
 *   serviceAvailability: { days:[1..7]|null, start:'HH:MM'|null, end:'HH:MM'|null }|null
 *   overrides: [{ date:'YYYY-MM-DD', isClosed, openFrom, openTo, title }]
 *   busy: [{ from, to, kind:'booked'|'block', title }] — минуты в дне специалиста
 *   counts: { day, week } — занятых мест сегодня / на неделе (для лимитов)
 *   clock: { nowMs, today:'YYYY-MM-DD' (сегодня в поясе специалиста),
 *            slotMs(date, time) -> ms|null }
 *
 * Коды решений (стабильные, используются и сервером в текстах ошибок):
 *   ok, closed, day_off, advance, day_limit, week_limit,
 *   outside_window, too_long, busy, past, notice, misaligned, unavailable
 */

export const AvailabilityDefaults = Object.freeze({
  minNoticeMinutes: 0,
  maxAdvanceDays: null, // null = без ограничения (поведение до D1)
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  slotIncrementMin: null, // null = шаг сетки (поведение до D1)
  maxBookingsPerDay: null,
  maxBookingsPerWeek: null
});

const DAY_MINUTES = 24 * 60;

/** 'HH:MM' → минуты от полуночи, иначе null. Домен-примитив (близнец
 *  timezoneService.timeToMinutes; паритет зафиксирован тестом). */
export function parseTimeToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function minutesToTimeLabel(total) {
  const m = ((Math.round(total) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function asNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function asOptionalLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** ISO-день недели 1=Пн..7=Вс из 'YYYY-MM-DD' (чистая календарная математика
 *  в UTC, чтобы пояс браузера не влиял на день специалиста). */
export function isoWeekdayOf(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  if (Number.isNaN(d.getTime())) return null;
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/** Понедельник ISO-недели, содержащей дату ('YYYY-MM-DD'). */
export function isoWeekStartOf(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  if (Number.isNaN(d.getTime())) return null;
  const shift = (d.getUTCDay() + 6) % 7; // дней после понедельника
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

/** Нормализация политики: числа санитизируются, лимиты null = ∞. */
export function normalizePolicy(input = {}) {
  return {
    minNoticeMinutes: asNonNegativeInt(input.minNoticeMinutes, AvailabilityDefaults.minNoticeMinutes),
    maxAdvanceDays: asOptionalLimit(input.maxAdvanceDays),
    bufferBeforeMin: asNonNegativeInt(input.bufferBeforeMin, AvailabilityDefaults.bufferBeforeMin),
    bufferAfterMin: asNonNegativeInt(input.bufferAfterMin, AvailabilityDefaults.bufferAfterMin),
    slotIncrementMin: asOptionalLimit(input.slotIncrementMin),
    maxBookingsPerDay: asOptionalLimit(input.maxBookingsPerDay),
    maxBookingsPerWeek: asOptionalLimit(input.maxBookingsPerWeek)
  };
}

/** Нормализация service-specific availability: частичное переопределение,
 *  отсутствующие ключи наследуются из расписания (null = наследовать всё). */
export function normalizeServiceAvailability(input) {
  if (!input || typeof input !== 'object') return null;
  let days = null;
  if (Array.isArray(input.days)) {
    const clean = input.days.map(Number).filter(n => n >= 1 && n <= 7);
    if (clean.length) days = [...new Set(clean)];
  }
  const start = parseTimeToMinutes(input.start) !== null ? String(input.start).trim() : null;
  const end = parseTimeToMinutes(input.end) !== null ? String(input.end).trim() : null;
  if (!days && !start && !end) return null;
  return { days, start, end };
}

/** Эффективное расписание: услуга перекрывает дни/окно настроек. */
export function resolveEffectiveSchedule({ serviceAvailability = null, settings = {} } = {}) {
  const svc = normalizeServiceAvailability(serviceAvailability);
  const workDays = svc?.days
    || (Array.isArray(settings.workDays) && settings.workDays.length
      ? settings.workDays.map(Number).filter(n => n >= 1 && n <= 7)
      : [1, 2, 3, 4, 5]);
  return {
    workDays: workDays.length ? workDays : [1, 2, 3, 4, 5],
    slotStart: svc?.start || settings.slotStart || '10:00',
    slotEnd: svc?.end || settings.slotEnd || '18:00',
    slotTimes: Array.isArray(settings.slotTimes) && settings.slotTimes.length
      ? settings.slotTimes.slice()
      : null,
    stepMin: asNonNegativeInt(settings.stepMin ?? settings.slotStepMin, 60) || 60
  };
}

/** Override на дату: принимает массив или map {date: override}. */
export function overrideOn(overrides, date) {
  if (!overrides || !date) return null;
  if (Array.isArray(overrides)) {
    return overrides.find(o => o && o.date === date) || null;
  }
  const hit = overrides[date];
  return hit && typeof hit === 'object' ? hit : null;
}

/**
 * Кандидаты-слоты на дату (до policy-фильтра).
 *  - override closed → [];
 *  - явный slotTimes → как есть (выбор психолога побеждает генерацию);
 *  - иначе генерация от slotStart строго до slotEnd с шагом
 *    slotIncrementMin ?? stepMin (старт в момент закрытия не предлагается —
 *    сессия оказалась бы целиком после закрытия).
 * Возвращает { candidates:['HH:MM'], windowStartMin, windowEndMin, lastStartMin }.
 * windowEndMin — «конец приёма + grace в один шаг сетки» (зеркало
 * BookingViewModel.dayWindowEndMinutes / create_booking): сессия обязана
 * закончиться не позже него.
 */
export function generateCandidates({ schedule, override = null, policy = {} } = {}) {
  const sch = schedule || {};
  if (override?.isClosed) {
    return { candidates: [], windowStartMin: null, windowEndMin: null, lastStartMin: null };
  }
  const startRaw = override?.openFrom || sch.slotStart || '10:00';
  const endRaw = override?.openTo || sch.slotEnd || '18:00';
  const windowStartMin = parseTimeToMinutes(startRaw);
  const slotEndMin = parseTimeToMinutes(endRaw);
  const stepMin = asNonNegativeInt(sch.stepMin, 60) || 60;
  if (windowStartMin === null || slotEndMin === null) {
    return { candidates: [], windowStartMin, windowEndMin: null, lastStartMin: null };
  }
  if (Array.isArray(sch.slotTimes) && sch.slotTimes.length) {
    const candidates = sch.slotTimes.filter(t => parseTimeToMinutes(t) !== null);
    const lastStartMin = candidates.length
      ? Math.max(...candidates.map(parseTimeToMinutes))
      : null;
    const windowEndMin = lastStartMin === null
      ? slotEndMin
      : Math.max(lastStartMin + stepMin, slotEndMin);
    return { candidates, windowStartMin, windowEndMin, lastStartMin };
  }
  const inc = asOptionalLimit(policy.slotIncrementMin) || stepMin;
  const candidates = [];
  let guard = 0;
  for (let m = windowStartMin; m < slotEndMin && guard < 500; m += inc, guard++) {
    candidates.push(minutesToTimeLabel(m));
  }
  const lastStartMin = candidates.length ? parseTimeToMinutes(candidates[candidates.length - 1]) : null;
  const windowEndMin = lastStartMin === null ? slotEndMin : Math.max(lastStartMin + stepMin, slotEndMin);
  return { candidates, windowStartMin, windowEndMin, lastStartMin };
}

function formatNotice(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} ч`;
  }
  return `${minutes} мин`;
}

/**
 * Проверки уровня даты (закрытие/день/горизонт/лимиты).
 * Возвращает { available, code, reason }.
 */
export function evaluateDate({ date, today, schedule, override = null, policy = {}, counts = {} } = {}) {
  const pol = normalizePolicy(policy);
  if (override?.isClosed) {
    const title = override.title ? ` (${override.title})` : '';
    return { available: false, code: 'closed', reason: `В этот день записи нет${title}` };
  }
  const weekday = isoWeekdayOf(date);
  const workDays = Array.isArray(schedule?.workDays) ? schedule.workDays : [1, 2, 3, 4, 5];
  if (weekday === null || !workDays.includes(weekday)) {
    return { available: false, code: 'day_off', reason: 'В этот день недели приёма нет' };
  }
  if (pol.maxAdvanceDays !== null && today && date > addDaysIso(today, pol.maxAdvanceDays)) {
    return {
      available: false,
      code: 'advance',
      reason: `Запись открыта только на ${pol.maxAdvanceDays} дн вперёд`
    };
  }
  const dayCount = asNonNegativeInt(counts.day, 0);
  if (pol.maxBookingsPerDay !== null && dayCount >= pol.maxBookingsPerDay) {
    return { available: false, code: 'day_limit', reason: 'На этот день мест больше нет' };
  }
  const weekCount = asNonNegativeInt(counts.week, 0);
  if (pol.maxBookingsPerWeek !== null && weekCount >= pol.maxBookingsPerWeek) {
    return { available: false, code: 'week_limit', reason: 'На эту неделю мест больше нет' };
  }
  return { available: true, code: 'ok', reason: '' };
}

/** +N дней к 'YYYY-MM-DD' (UTC-математика). */
export function addDaysIso(isoDate, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return isoDate;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

/**
 * Проверка одного слота. `window` — из generateCandidates
 * ({ windowStartMin, windowEndMin }); busy — интервалы {from,to,kind,title}.
 */
export function evaluateSlot({
  date, time, durationMin, window, busy = [], policy = {}, clock = {}, explicitGrid = false
} = {}) {
  const pol = normalizePolicy(policy);
  const dur = asNonNegativeInt(durationMin, 60) || 60;
  const start = parseTimeToMinutes(time);
  if (start === null || window?.windowStartMin === null || window?.windowEndMin === null) {
    return { available: false, code: 'unavailable', reason: 'Время недоступно' };
  }
  if (start < window.windowStartMin) {
    return { available: false, code: 'outside_window', reason: 'Время вне часов приёма' };
  }
  if (start + dur > window.windowEndMin) {
    return { available: false, code: 'too_long', reason: `не хватает ${dur} мин до конца приёма` };
  }
  // Пересечение с буферами: кандидат занимает [s-bb, e+ba); чужие записи —
  // тоже с буферами (симметрично серверу); блокировки — жёсткие, как есть.
  const candFrom = start - pol.bufferBeforeMin;
  const candTo = start + dur + pol.bufferAfterMin;
  const overlap = (busy || []).find(iv => {
    if (iv == null || !Number.isFinite(iv.from) || !Number.isFinite(iv.to)) return false;
    const expand = iv.kind !== 'block';
    const from = expand ? iv.from - pol.bufferBeforeMin : iv.from;
    const to = expand ? iv.to + pol.bufferAfterMin : iv.to;
    return candFrom < to && from < candTo;
  });
  if (overlap) {
    return { available: false, code: overlap.kind === 'block' ? 'blocked' : 'busy', reason: overlap.title || 'Время занято' };
  }
  // Прошлое / минимальный срок (часы сравниваются как моменты через clock).
  let slotMs = null;
  try {
    slotMs = typeof clock.slotMs === 'function' ? clock.slotMs(date, time) : null;
  } catch (_) {
    slotMs = null;
  }
  const nowMs = Number(clock.nowMs);
  if (!Number.isFinite(slotMs) || !Number.isFinite(nowMs)) {
    return { available: false, code: 'unavailable', reason: 'Время недоступно' };
  }
  if (slotMs < nowMs) {
    return { available: false, code: 'past', reason: 'время уже прошло' };
  }
  if (pol.minNoticeMinutes > 0 && slotMs < nowMs + pol.minNoticeMinutes * 60000) {
    return {
      available: false,
      code: 'notice',
      reason: `Записаться можно минимум за ${formatNotice(pol.minNoticeMinutes)} до начала`
    };
  }
  // Шаг сетки — только для сгенерированной сетки (явный slotTimes побеждает).
  const inc = pol.slotIncrementMin;
  if (!explicitGrid && inc !== null && inc > 0) {
    const base = window.windowStartMin;
    if (((start - base) % inc + inc) % inc !== 0) {
      return {
        available: false,
        code: 'misaligned',
        reason: `Начало записи — каждые ${formatNotice(inc)}`
      };
    }
  }
  return { available: true, code: 'ok', reason: '' };
}

/**
 * Полный расчёт дня: кандидаты → фильтр → слоты.
 * Возвращает { slots:[{time,available,code,reason}], dateAvailable, dateCode,
 * dateReason, candidates, window }.
 */
export function computeBookableSlots({
  date, durationMin, schedule, policy = {}, serviceAvailability = null,
  overrides = [], busy = [], counts = {}, clock = {}
} = {}) {
  const eff = resolveEffectiveSchedule({ serviceAvailability, settings: schedule });
  const pol = normalizePolicy(policy);
  const override = overrideOn(overrides, date);
  const window = generateCandidates({ schedule: eff, override, policy: pol });
  const dateVerdict = evaluateDate({
    date,
    today: clock.today,
    schedule: eff,
    override,
    policy: pol,
    counts
  });
  const explicitGrid = Array.isArray(eff.slotTimes) && eff.slotTimes.length > 0;
  const slots = window.candidates.map(t => {
    if (!dateVerdict.available) {
      return { time: t, available: false, code: dateVerdict.code, reason: dateVerdict.reason };
    }
    const v = evaluateSlot({
      date,
      time: t,
      durationMin,
      window,
      busy,
      policy: pol,
      clock,
      explicitGrid
    });
    return { time: t, available: v.available, code: v.code, reason: v.reason };
  });
  return {
    slots,
    dateAvailable: dateVerdict.available && window.candidates.length > 0,
    dateCode: window.candidates.length === 0 && dateVerdict.available ? 'closed' : dateVerdict.code,
    dateReason: window.candidates.length === 0 && dateVerdict.available
      ? 'Нет окон для записи'
      : dateVerdict.reason,
    candidates: window.candidates,
    window
  };
}

/**
 * Точечная проверка (перенос, серия, waitlist matching): тот же контракт,
 * но для одного момента без генерации сетки.
 */
export function isSlotBookable({
  date, time, durationMin, schedule, policy = {}, serviceAvailability = null,
  overrides = [], busy = [], counts = {}, clock = {}
} = {}) {
  const eff = resolveEffectiveSchedule({ serviceAvailability, settings: schedule });
  const pol = normalizePolicy(policy);
  const override = overrideOn(overrides, date);
  const window = generateCandidates({ schedule: eff, override, policy: pol });
  const dateVerdict = evaluateDate({
    date, today: clock.today, schedule: eff, override, policy: pol, counts
  });
  if (!dateVerdict.available) {
    return { ok: false, code: dateVerdict.code, reason: dateVerdict.reason };
  }
  const explicitGrid = Array.isArray(eff.slotTimes) && eff.slotTimes.length > 0;
  const v = evaluateSlot({
    date, time, durationMin, window, busy, policy: pol, clock, explicitGrid
  });
  return { ok: v.available, code: v.code, reason: v.reason };
}
