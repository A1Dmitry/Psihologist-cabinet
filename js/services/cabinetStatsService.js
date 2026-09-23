/**
 * CabinetStatsService — аналитика кабинета (T-20): загрузка и доход.
 *
 * Считаем на данных, которые уже есть в схеме:
 *  - sessions: дата/время/статус/amount_due/amount_paid/currency/payment_status;
 *  - services: цена и валюта (если у сессии нет собственной суммы — бонус T-09);
 *  - session_settings: рабочие дни/слоты/пояс — для «свободных часов»;
 *  - schedule_blocks: занятость вне сессий.
 *
 * Доход разводим по валютам (BYN/RUB/…) и по состояниям:
 *   получено  — amount_paid (деньги уже пришли);
 *   ожидается — сумма будущих не отменённых сессий;
 *   недополучено — прошлые проведённые сессии без полной оплаты.
 *
 * Все функции чистые: принимают данные, возвращают цифры (легко проверять тестами).
 */
import { addDaysStr, todayStr, weekdayOf, DEFAULT_TIMEZONE } from './timezoneService.js';

const CLOSED = ['cancelled', 'expired'];
const PAST_DONE = ['done', 'no_show'];

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function slotTimesOf(settings) {
  if (settings?.slotTimes?.length) return settings.slotTimes.slice();
  const toMin = t => {
    const [h, m] = String(t || '10:00').split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const start = toMin(settings?.slotStart || '10:00');
  const end = toMin(settings?.slotEnd || '18:00');
  const step = Math.max(15, Number(settings?.slotStepMin) || 60);
  const out = [];
  for (let m = start; m < end; m += step) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out.length ? out : ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
}

/** Сумма сессии: сумма из записи (индивидуальные условия) или цена услуги */
export function sessionAmount(session, service) {
  const due = Number(session?.amountDue) || 0;
  if (due > 0) return due;
  return Number(service?.price) || 0;
}

export function sessionCurrency(session, service) {
  return session?.currency || service?.currency || 'BYN';
}

/** Деньги по валютам: {BYN: 120, RUB: 0} */
function moneyBy(list) {
  return list.reduce((acc, x) => {
    acc[x.currency] = money((acc[x.currency] || 0) + x.amount);
    return acc;
  }, {});
}

function rangeDates(from, to) {
  const out = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard++ < 800) {
    out.push(d);
    d = addDaysStr(d, 1);
  }
  return out;
}

/**
 * Полная статистика кабинета.
 * @param {{sessions: Array, services: Array, settings: object, blocks: Array, clients: Array, today?: string}} input
 */
export function buildStats({ sessions = [], services = [], settings = null, blocks = [], clients = [], today = todayStr() } = {}) {
  const serviceById = new Map(services.map(s => [s.id, s]));
  const active = sessions.filter(s => !CLOSED.includes(s.status));
  const withMoney = s => ({ amount: sessionAmount(s, serviceById.get(s.serviceId)), currency: sessionCurrency(s, serviceById.get(s.serviceId)) });

  const past = active.filter(s => s.date < today || PAST_DONE.includes(s.status));
  const done = active.filter(s => s.status === 'done');
  const upcoming = active.filter(s => s.date >= today && !PAST_DONE.includes(s.status));
  const cancelled = sessions.filter(s => s.status === 'cancelled');
  const noShow = sessions.filter(s => s.status === 'no_show');
  const heldUnpaid = active.filter(s => s.status === 'held' || (s.requiresPayment && s.paymentStatus === 'unpaid'));

  const receivedItems = [];
  const expectedItems = [];
  const outstandingItems = [];
  for (const s of active) {
    const m = withMoney(s);
    if (Number(s.amountPaid) > 0) receivedItems.push({ ...m, amount: Number(s.amountPaid) });
    if (s.date >= today && !PAST_DONE.includes(s.status)) expectedItems.push(m);
    if (s.date < today && s.status !== 'no_show' && Number(s.amountPaid) < m.amount) {
      outstandingItems.push({ ...m, amount: money(m.amount - (Number(s.amountPaid) || 0)) });
    }
  }

  const clientIds = new Set(active.map(s => s.clientId).filter(Boolean));
  const slots = slotTimesOf(settings);
  const workDays = settings?.workDays?.length ? settings.workDays : [1, 2, 3, 4, 5];

  const load = (days) => {
    const from = today;
    const to = addDaysStr(today, days - 1);
    const dates = rangeDates(from, to);
    const workDates = dates.filter(d => workDays.includes(weekdayOf(d)));
    const capacity = workDates.length * slots.length;
    let busy = 0;
    const busyKey = new Set();
    for (const s of active) {
      if (s.date < from || s.date > to) continue;
      const key = `${s.date} ${s.time}`;
      if (busyKey.has(key)) continue;
      busyKey.add(key);
      busy++;
    }
    for (const b of blocks) {
      for (const d of workDates) {
        if (!b.covers ? !(d >= b.dateFrom && d <= (b.dateTo || b.dateFrom)) : !b.covers(d)) continue;
        if (!b.timeFrom && !b.timeTo) {
          // блокировка всего дня: вычитаем все слоты дня из ёмкости
          const free = slots.filter(t => !busyKey.has(`${d} ${t}`)).length;
          busy += free;
        } else {
          for (const t of slots) {
            if (t >= (b.timeFrom || '00:00') && t < (b.timeTo || '23:59') && !busyKey.has(`${d} ${t}`)) {
              busyKey.add(`${d} ${t}`);
              busy++;
            }
          }
        }
      }
    }
    const free = Math.max(0, capacity - busy);
    return {
      days,
      from,
      to,
      workDays: workDates.length,
      capacityHours: capacity,
      busyHours: busy,
      freeHours: free,
      loadPercent: capacity ? Math.round((busy / capacity) * 100) : 0
    };
  };

  // ——— по неделям (6 прошедших + текущая + 3 будущих) ———
  const buckets = (kind) => {
    const out = [];
    const count = kind === 'week' ? 10 : 6;
    const step = kind === 'week' ? 7 : 30;
    const startOffset = kind === 'week' ? -7 * 5 : -30 * 3;
    for (let i = 0; i < count; i++) {
      const from = addDaysStr(today, startOffset + i * step);
      const to = addDaysStr(from, step - 1);
      const list = active.filter(s => s.date >= from && s.date <= to);
      const received = moneyBy(list.filter(s => Number(s.amountPaid) > 0)
        .map(s => ({ ...withMoney(s), amount: Number(s.amountPaid) })));
      const expected = moneyBy(list.filter(s => s.date >= today && !PAST_DONE.includes(s.status)).map(withMoney));
      out.push({
        from, to,
        label: kind === 'week' ? `нед. ${from.slice(8, 10)}.${from.slice(5, 7)}` : `${from.slice(5, 7)}.${from.slice(0, 4)}`,
        count: list.length,
        done: list.filter(s => s.status === 'done').length,
        received,
        expected
      });
    }
    return out;
  };

  const byWeekday = [1, 2, 3, 4, 5, 6, 7].map(wd => ({
    weekday: wd,
    count: active.filter(s => weekdayOf(s.date) === wd).length
  }));

  const topServices = services.map(sv => {
    const list = active.filter(s => s.serviceId === sv.id);
    const m = moneyBy(list.map(s => ({ amount: sessionAmount(s, sv), currency: sessionCurrency(s, sv) })));
    return { id: sv.id, name: sv.name, count: list.length, amount: m };
  }).sort((a, b) => b.count - a.count);

  return {
    timezone: settings?.timezone || DEFAULT_TIMEZONE,
    today,
    counts: {
      upcoming: upcoming.length,
      today: active.filter(s => s.date === today).length,
      next7: active.filter(s => s.date >= today && s.date <= addDaysStr(today, 6)).length,
      past: past.length,
      done: done.length,
      cancelled: cancelled.length,
      noShow: noShow.length,
      heldUnpaid: heldUnpaid.length,
      clients: clientIds.size,
      totalClients: clients.length
    },
    money: {
      received: moneyBy(receivedItems),
      expected: moneyBy(expectedItems),
      outstanding: moneyBy(outstandingItems)
    },
    load: {
      week: load(7),
      month: load(30)
    },
    byWeek: buckets('week'),
    byMonth: buckets('month'),
    byWeekday,
    topServices
  };
}

/** «120 BYN · 3 000 ₽» — компактная подпись сумм по валютам */
export function moneyLabel(map, { empty = '0' } = {}) {
  const entries = Object.entries(map || {}).filter(([, v]) => Number(v) > 0);
  if (!entries.length) return empty;
  return entries.map(([cur, v]) => (cur === 'RUB' ? `${v} ₽` : `${v} ${cur}`)).join(' · ');
}

export const cabinetStatsService = { buildStats, moneyLabel, slotTimesOf, sessionAmount, sessionCurrency };
