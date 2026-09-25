/**
 * cabinetUi — слой представления новых блоков кабинета (Агент 3).
 *
 * Что рендерит:
 *  - «Регулярные сессии» в расписании (T-05/T-06/T-07) + переключатель области переноса;
 *  - карточку клиента: индивидуальные условия (T-09/T-10), история платежей (T-11),
 *    ссылка клиента, материалы (T-13) и документы (T-14);
 *  - лист ожидания и запросы клиентов (T-08/T-24);
 *  - расширенную статистику (T-20);
 *  - подписи часовых поясов в расписании (T-23);
 *  - страницу клиента по секретной ссылке (T-12).
 *
 * Принципы:
 *  - модуль не правит чужие файлы: рисует в собственные контейнеры внутри
 *    #page-cabinet и страницы клиента, которые создаются им же;
 *  - вся логика — в CabinetViewModel/сервисах, здесь только DOM и события;
 *  - ничего не делаем при импорте, кроме подписки на события (безопасно для смоук-тестов).
 */
import { db } from '../core/dbContext.js';
import { sessionSeriesService } from '../services/sessionSeriesService.js';
import { clientCabinetService, suggestSlots, MATERIAL_KINDS, weekdayOfLabel } from '../services/clientCabinetService.js';
import { cabinetStatsService, moneyLabel } from '../services/cabinetStatsService.js';
import { reminderService } from '../services/reminderService.js';
import { buildIcsEvent, icsFileName, icsHref } from '../services/calendarService.js';
import {
  timezoneService, todayStr, addDaysStr, weekdayOf, weekdayTimeLabel,
  WEEKDAY_NAMES_SHORT, zoneCity, zoneLabel
} from '../services/timezoneService.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function statusLabel(st) {
  return ({
    confirmed: 'Подтверждено', pending: 'Ожидает', held: 'Ожидает оплаты',
    paid: 'Оплачено', done: 'Проведено', cancelled: 'Отменено', no_show: 'Неявка', expired: 'Истёк'
  })[st] || st;
}

function statusClass(st) {
  return ({
    confirmed: 'bg-emerald-50 text-emerald-700', pending: 'bg-amber-50 text-amber-700',
    held: 'bg-orange-50 text-orange-700', paid: 'bg-sky-50 text-sky-700',
    done: 'bg-slate-100 text-slate-600', cancelled: 'bg-rose-50 text-rose-600',
    no_show: 'bg-rose-50 text-rose-700', expired: 'bg-slate-100 text-slate-500'
  })[st] || 'bg-slate-100 text-slate-600';
}

function money(n, currency = 'BYN') {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return currency === 'RUB' ? `${v} ₽` : `${v} ${currency}`;
}

function dateLabel(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][d.getMonth()]}`;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-full text-sm font-medium shadow-lg ' +
    (isError ? 'bg-rose-600 text-white' : 'bg-slate-900 text-white');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3200);
}

function rerenderCabinet() {
  if (typeof window !== 'undefined' && typeof window.navigate === 'function') {
    window.navigate('cabinet');
    return;
  }
  cabinetUi.afterRender({ route: { name: 'cabinet', params: {} }, vm: cabinetUi.vm });
}

/* ——— модалки: создаём на лету, чтобы не плодить статичную разметку ——— */
function closeModalEl(el) {
  el?.remove();
}

function openModal({ id = 'cab3-modal', title = '', body = '', onSubmit = null, submitLabel = 'Сохранить', submitAttr = '' }) {
  const host = document.getElementById('page-cabinet') || document.body;
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.id = id;
  wrap.className = 'fixed inset-0 z-[60] flex items-center justify-center modal-bg p-4';
  wrap.innerHTML = `
    <div class="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl max-h-[90vh] overflow-y-auto" data-c3-modal-card>
      <div class="flex items-start justify-between gap-3 mb-3">
        <h3 class="text-lg font-bold">${esc(title)}</h3>
        <button type="button" data-c3="modal-close" class="text-slate-400 hover:text-slate-700 text-xl leading-none">&times;</button>
      </div>
      <form data-c3-form="${id}" class="space-y-3 text-sm">
        ${body}
        <div class="flex gap-3 pt-2">
          <button type="submit" ${submitAttr} class="flex-1 py-2.5 rounded-full bg-indigo-600 text-white font-medium">${esc(submitLabel)}</button>
          <button type="button" data-c3="modal-close" class="px-5 py-2.5 rounded-full border">Отмена</button>
        </div>
      </form>
    </div>`;
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  host.appendChild(wrap);
  if (onSubmit) {
    $$(`form[data-c3-form="${id}"]`, wrap).forEach(form => {
      form.addEventListener('submit', ev => {
        ev.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const keepOpen = onSubmit(data, form);
        if (keepOpen && typeof keepOpen.then === 'function') {
          // асинхронная обработка (например, создание серии из заявки)
          keepOpen.then(res => { if (!res) wrap.remove(); }).catch(() => wrap.remove());
        } else if (!keepOpen) {
          wrap.remove();
        }
      });
    });
  }
  return wrap;
}

function field(label, inner, hint = '') {
  return `<div><label class="font-medium">${esc(label)}</label>${inner}${hint ? `<div class="text-xs text-slate-400 mt-0.5">${hint}</div>` : ''}</div>`;
}

function input(name, { type = 'text', value = '', placeholder = '', extra = '' } = {}) {
  return `<input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" class="w-full mt-1 px-3 py-2 rounded-xl border" ${extra}>`;
}

function select(name, options, value) {
  return `<select name="${name}" class="w-full mt-1 px-3 py-2 rounded-xl border">${options.map(o =>
    `<option value="${esc(o.id)}" ${String(o.id) === String(value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
}

const weekdayOptions = () => [1, 2, 3, 4, 5, 6, 7].map(d => ({ id: d, label: `${WEEKDAY_NAMES_SHORT[d]} (${d})` }));
const HORIZON_OPTIONS = [
  { id: 4, label: '4 недели' }, { id: 8, label: '8 недель (по умолчанию)' },
  { id: 12, label: '12 недель' }, { id: 26, label: 'полгода' }
];

/* ================================================================== */
/*  ДЕКОРАЦИЯ МОДАЛКИ СЕССИИ: область переноса (T-06) + условия (T-09) */
/* ================================================================== */

function decorateSessionModal(vm, sessionId) {
  const modal = document.getElementById('modal-session');
  if (!modal || modal.classList.contains('hidden')) return;
  const session = sessionId ? vm.sessions.find(s => s.id === sessionId) : null;
  const card = $('[data-c3-modal-card]', modal) || $('.bg-white', modal);
  if (!card) return;
  $$('[data-c3-injected]', card).forEach(el => el.remove());
  if (!session) return;

  const series = vm.seriesForSession(session);
  const conditions = vm.conditionsSummary(session.clientId);
  const zone = vm.sessionZone(session);
  const rows = [];

  if (series) {
    rows.push(`
      <div data-c3-injected class="rounded-xl bg-indigo-50 border border-indigo-100 p-3 space-y-2">
        <div class="text-xs text-indigo-900">Эта встреча — часть серии: <b>${esc(series.label())}</b>.</div>
        <div class="text-xs text-indigo-900">При смене даты/времени спросим: перенести одну встречу или всю серию.</div>
        <div class="flex flex-wrap gap-2">
          <button type="button" data-c3="series-pause" data-id="${esc(series.id)}" class="px-3 py-1 rounded-full border border-indigo-300 text-indigo-700 text-xs">Пауза серии</button>
          <button type="button" data-c3="series-edit" data-id="${esc(series.id)}" class="px-3 py-1 rounded-full border border-indigo-300 text-indigo-700 text-xs">Изменить серию</button>
        </div>
      </div>`);
  }
  if (conditions) {
    rows.push(`<div data-c3-injected class="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs text-slate-600">
      Индивидуальные условия клиента: <b>${esc(conditions)}</b>
      <div class="text-[11px] text-slate-400 mt-0.5">Подставляются в новые сессии автоматически (карточка клиента).</div>
    </div>`);
  }
  if (!zone.sameZone && zone.clientTime) {
    rows.push(`<div data-c3-injected class="rounded-xl bg-amber-50 border border-amber-100 p-3 text-xs text-amber-900">
      Клиент в другом поясе: для него это <b>${esc(zone.clientTime)}</b>${zone.clientDate !== zone.date ? ` (${esc(zone.clientDate)})` : ''}.
    </div>`);
  }
  if (!rows.length) return;
  const footer = $('.flex.gap-3.mt-6', card);
  if (footer) footer.insertAdjacentHTML('beforebegin', rows.join(''));
  else card.insertAdjacentHTML('beforeend', rows.join(''));
}

function askRescheduleScope(vm) {
  const pending = vm.pendingSeriesChoice;
  if (!pending) return;
  openModal({
    id: 'cab3-modal-scope',
    title: 'Что переносим?',
    submitLabel: 'Перенести всю серию',
    body: `
      <p class="text-slate-600">Встреча входит в серию <b>${esc(pending.seriesLabel)}</b>, а вы изменили дату или время.</p>
      <ul class="text-slate-600 text-sm space-y-1 list-disc pl-5">
        <li><b>Только эту встречу</b> — остальные останутся в своём ритме.</li>
        <li><b>Вся серия</b> — новый день/время, будущие встречи пересоздаются автоматически.</li>
      </ul>`,
    onSubmit: () => { vm.error = ''; return false; }
  });
  // у этой модалки две кнопки-развилки: добавляем свою нижнюю панель
  const box = document.getElementById('cab3-modal-scope');
  if (!box) return;
  const actions = $('[data-c3-form] > div:last-child', box);
  if (actions) {
    actions.innerHTML = `
      <button type="button" data-c3="choice-single" class="flex-1 py-2.5 rounded-full bg-indigo-600 text-white font-medium">Только эту встречу</button>
      <button type="button" data-c3="choice-series" class="flex-1 py-2.5 rounded-full bg-slate-900 text-white font-medium">Всю серию</button>
      <button type="button" data-c3="choice-cancel" class="px-5 py-2.5 rounded-full border">Не переносить</button>`;
  }
}

/* ================================================================== */
/*  РЕГУЛЯРНЫЕ СЕССИИ (расписание)                                     */
/* ================================================================== */

function renderSeriesPanel(vm) {
  const box = document.getElementById('cab3-series');
  if (!box) return;
  const cards = vm.seriesCards;
  box.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
      <h2 class="text-sm font-semibold text-slate-600">Регулярные сессии</h2>
      <button type="button" data-c3="series-new" class="text-xs text-indigo-600">+ Серия</button>
    </div>
    ${vm.seriesServerHint ? `<div class="mb-2 rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs text-slate-500">${esc(vm.seriesServerHint)}</div>` : ''}
    ${cards.length ? `<div class="bg-white rounded-xl border divide-y">
      ${cards.map(c => `
        <div class="p-3 flex flex-wrap items-center gap-3 text-sm">
          <span class="text-xs px-2 py-1 rounded-full ${c.paused ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}">${c.paused ? 'пауза' : 'идёт'}</span>
          <div class="flex-1 min-w-[200px]">
            <div class="font-medium">${esc(c.clientName)} · <span class="text-indigo-700">${esc(c.when)}</span></div>
            <div class="text-xs text-slate-500">${esc(c.label)}${c.serviceName ? ` · ${esc(c.serviceName)}` : ''} · встреч впереди: ${c.upcoming}</div>
          </div>
          <div class="flex flex-wrap gap-2">
            ${c.paused
              ? `<button type="button" data-c3="series-resume" data-id="${esc(c.id)}" class="text-xs text-emerald-600">Возобновить</button>`
              : `<button type="button" data-c3="series-pause" data-id="${esc(c.id)}" class="text-xs text-amber-600">Пауза</button>`}
            <button type="button" data-c3="series-edit" data-id="${esc(c.id)}" class="text-xs text-indigo-600">Перенести</button>
            <button type="button" data-c3="series-extend" data-id="${esc(c.id)}" class="text-xs text-indigo-600">Продлить</button>
            <button type="button" data-c3="series-delete" data-id="${esc(c.id)}" class="text-xs text-rose-500">Удалить</button>
          </div>
        </div>`).join('')}
    </div>` : `<div class="bg-white rounded-xl border p-4 text-sm text-slate-400">
      Серий пока нет. Серия — это «каждый вторник в 15:00»: кабинет сам создаст встречи на 8 недель вперёд.
    </div>`}`;
}

function openSeriesModal(vm, series = null) {
  const clients = vm.clients;
  if (!clients.length) { toast('Сначала добавьте клиента', true); return; }
  const clientOptions = clients.map(c => ({ id: c.id, label: c.nickname || c.name }));
  const serviceOptions = [{ id: '', label: '— без услуги —' }, ...vm.services.map(s => ({ id: s.id, label: `${s.name} (${s.priceLabel()})` }))];
  const start = series?.dateFrom || addDaysStr(todayStr(), 1);
  openModal({
    id: 'cab3-modal-series',
    title: series ? 'Серия: перенос' : 'Новая серия встреч',
    submitLabel: series ? 'Перенести будущие встречи' : 'Создать серию',
    body: `
      ${series ? '' : field('Клиент', select('clientId', clientOptions, vm.selectedClientId || clients[0].id))}
      ${series ? '' : field('Услуга', select('serviceId', serviceOptions, vm.services[0]?.id || ''))}
      <div class="grid grid-cols-2 gap-3">
        ${field('День недели', select('weekday', weekdayOptions(), series?.weekday || weekdayOf(start)))}
        ${field('Время', input('time', { type: 'time', value: series?.time || '15:00' }))}
      </div>
      <div class="grid grid-cols-2 gap-3">
        ${field('Периодичность', select('intervalWeeks', [
          { id: 1, label: 'каждую неделю' }, { id: 2, label: 'раз в 2 недели' },
          { id: 3, label: 'раз в 3 недели' }, { id: 4, label: 'раз в 4 недели' }
        ], series?.intervalWeeks || 1))}
        ${field('Горизонт', select('horizonWeeks', HORIZON_OPTIONS, series?.horizonWeeks || 8))}
      </div>
      <div class="grid grid-cols-2 gap-3">
        ${field('Начиная с', input('dateFrom', { type: 'date', value: start }))}
        ${field('По (необязательно)', input('dateTo', { type: 'date', value: series?.dateTo || '' }))}
      </div>
      ${field('Комментарий (увидит клиент в кабинете)', input('note', { value: series?.note || '', placeholder: 'например: еженедельная терапия' }))}
      <p class="text-xs text-slate-400">Встречи создаются только на свободные слоты: занятые и заблокированные пропускаются, конфликты покажем в кабинете.</p>`,
    onSubmit: data => {
      if (series) {
        const res = vm.rescheduleSeries(series.id, {
          weekday: Number(data.weekday),
          time: data.time,
          intervalWeeks: Number(data.intervalWeeks),
          horizonWeeks: Number(data.horizonWeeks),
          reason: data.note || ''
        });
        return !res.ok;
      }
      const res = vm.createSeries({
        clientId: data.clientId,
        serviceId: data.serviceId || null,
        weekday: Number(data.weekday),
        time: data.time,
        intervalWeeks: Number(data.intervalWeeks),
        horizonWeeks: Number(data.horizonWeeks),
        dateFrom: data.dateFrom,
        dateTo: data.dateTo,
        note: data.note
      });
      if (res?.ok && res.skipped?.length) {
        toast(`Пропущено слотов: ${res.skipped.length} (занято или блокировка)`, true);
      }
      rerenderCabinet();
      return !res?.ok;
    }
  });
}

/* ================================================================== */
/*  ЛИСТ ОЖИДАНИЯ И ЗАПРОСЫ КЛИЕНТОВ (T-08 / T-24)                     */
/* ================================================================== */

function renderRequestsPanel(vm, { compact = false } = {}) {
  const box = document.getElementById(compact ? 'cab3-journal-requests' : 'cab3-requests');
  if (!box) return;
  const q = vm.waitingQueue;
  if (!q.all.length) {
    box.innerHTML = compact ? '' : `<div class="bg-white rounded-xl border p-4 text-sm text-slate-400">
      Очередь пуста. Сюда попадают заявки из записи и запросы клиентов из их мини-кабинета.</div>`;
    return;
  }
  const row = item => `
    <div class="p-3 border-b last:border-0 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs px-2 py-1 rounded-full ${item.kind === 'recurring' ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-600'}">${esc(item.kindLabel)}</span>
        <div class="flex-1 min-w-[180px]">${esc(item.text)}</div>
        <div class="flex flex-wrap gap-2">
          ${item.source === 'client'
            ? `<button type="button" data-c3="req-accept" data-id="${esc(item.id)}" class="text-xs text-emerald-600">Принять</button>
               <button type="button" data-c3="req-decline" data-id="${esc(item.id)}" class="text-xs text-slate-400">Отклонить</button>`
            : `<button type="button" data-c3="wait-plan" data-id="${esc(item.id)}" class="text-xs text-indigo-600">Записать</button>`}
          ${item.source === 'client' && item.kind === 'recurring'
            ? `<button type="button" data-c3="req-series" data-id="${esc(item.id)}" class="text-xs text-indigo-600">Настроить серию</button>` : ''}
          ${item.source === 'client'
            ? `<button type="button" data-c3="req-remove" data-id="${esc(item.id)}" class="text-xs text-rose-400">Убрать</button>` : ''}
        </div>
      </div>
      ${item.desiredDate || item.comment ? `<div class="text-xs text-slate-400 mt-1">${item.desiredDate ? `пожелание: ${esc(item.desiredDate)}${item.desiredTime ? ' ' + esc(item.desiredTime) : ''}` : ''}${item.comment ? ` · ${esc(item.comment)}` : ''}</div>` : ''}
    </div>`;
  const queue = q.forDay.length
    ? `<div class="mb-4"><div class="text-xs font-semibold text-slate-500 mb-1">Очередь по дням</div>
        ${Object.entries(q.byDay).map(([day, items]) => `
          <div class="bg-white rounded-xl border mb-2">
            <div class="px-3 py-2 text-xs font-medium bg-slate-50 rounded-t-xl">${esc(day)} (${items.length})</div>
            ${items.map(row).join('')}
          </div>`).join('')}</div>` : '';
  box.innerHTML = compact
    ? `<div class="bg-white rounded-xl border mb-4"><div class="px-3 py-2 text-xs font-semibold bg-amber-50 text-amber-800 rounded-t-xl">Запросы клиентов ждут ответа (${q.all.length})</div>${q.all.map(row).join('')}</div>`
    : `<h2 class="text-sm font-semibold text-slate-600 mb-2">Запросы клиентов</h2>${queue}${q.all.length && !q.forDay.length ? '' : ''}
       <div class="bg-white rounded-xl border">${q.all.map(row).join('')}</div>`;
}

/* ================================================================== */
/*  КАРТОЧКА КЛИЕНТА: условия, ссылка, материалы, платежи (T-09…T-14)  */
/* ================================================================== */

function renderClientExtras(vm) {
  const box = document.getElementById('cab3-client-extra');
  if (!box) return;
  const client = vm.selectedClient;
  if (!client) { box.innerHTML = ''; return; }

  const cond = vm.conditionsOf(client);
  const payments = vm.paymentsSummary(client.id);
  const token = vm.accessTokenOf(client.id);
  const materials = vm.materialsOf(client.id);
  const documents = vm.documentsOf(client.id);
  const locked = !!client.locked;

  box.innerHTML = `
    <div class="grid lg:grid-cols-2 gap-5 mt-5">
      <div class="bg-white rounded-xl border p-5">
        <div class="flex items-center justify-between mb-3">
          <h2 class="font-semibold text-sm">Индивидуальные условия</h2>
          ${locked ? '<span class="text-xs text-rose-500">сейф закрыт</span>' : ''}
        </div>
        <div class="space-y-3 text-sm" ${locked ? 'data-c3-locked' : ''}>
          <div class="grid grid-cols-2 gap-3">
            ${field('Цена (пусто = как в услуге)', input('c3-price', { type: 'number', value: cond.priceOverride ?? '', placeholder: '80' }))}
            ${field('Валюта', select('c3-currency', [
              { id: '', label: '— как в услуге —' }, { id: 'BYN', label: 'BYN' },
              { id: 'RUB', label: 'RUB' }, { id: 'EUR', label: 'EUR' }, { id: 'USD', label: 'USD' }
            ], cond.currency || ''))}
          </div>
          <div class="grid grid-cols-2 gap-3">
            ${field('Способ оплаты', select('c3-method', vm.paymentMethodOptions, cond.paymentMethod || ''))}
            ${field('Пояс клиента', select('c3-zone', [{ id: '', label: '— неизвестен —' },
              ...['Europe/Minsk', 'Europe/Moscow', 'Europe/Kyiv', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/London', 'Asia/Almaty', 'Asia/Tbilisi', 'America/New_York', 'Asia/Dubai']
                .map(tz => ({ id: tz, label: timezoneService.zoneLabel(tz) }))], cond.clientTimezone || ''))}
          </div>
          ${field('Постоянная ссылка на встречу', input('c3-meet', { value: cond.meetLink || '', placeholder: 'https://meet.google.com/…' }), 'Подставляется в новые сессии и в кабинет клиента.')}
          ${field('Ссылка на оплату', input('c3-pay', { value: cond.paymentUrl || '', placeholder: 'https://…' }))}
          <button type="button" data-c3="conditions-save" data-id="${esc(client.id)}" class="w-full py-2.5 rounded-full bg-indigo-600 text-white font-medium" ${locked ? 'disabled' : ''}>Сохранить условия</button>
        </div>
      </div>

      <div class="bg-white rounded-xl border p-5">
        <h2 class="font-semibold text-sm mb-3">Личный кабинет клиента</h2>
        <p class="text-xs text-slate-500 mb-3">Секретная ссылка: клиент открывает её без регистрации и видит свои встречи, ссылку на видеосвязь, материалы и может предложить другое время.</p>
        ${token ? `
          <div class="flex gap-2">
            <input id="c3-link" readonly value="${esc(clientCabinetService.tokenUrl(token.token, currentBase()))}" class="flex-1 px-3 py-2 rounded-xl border text-xs bg-slate-50">
            <button type="button" data-c3="link-copy" class="px-3 py-2 rounded-full bg-slate-900 text-white text-xs">Копировать</button>
          </div>
          <div class="text-xs text-slate-400 mt-1">действует до ${esc((token.expiresAt || '').slice(0, 10))}</div>
          <div class="flex flex-wrap gap-2 mt-3">
            <button type="button" data-c3="link-preview" data-token="${esc(token.token)}" class="px-3 py-1.5 rounded-full border border-indigo-300 text-indigo-700 text-xs">Открыть как клиент</button>
            <button type="button" data-c3="link-rotate" data-id="${esc(client.id)}" class="px-3 py-1.5 rounded-full border text-xs">Заменить ссылку</button>
            <button type="button" data-c3="link-revoke" data-token="${esc(token.token)}" class="px-3 py-1.5 rounded-full border border-rose-200 text-rose-600 text-xs">Отозвать</button>
          </div>` : `
          <button type="button" data-c3="link-create" data-id="${esc(client.id)}" class="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm">Создать ссылку клиента</button>`}
        ${vm.clientCabinetServerHint ? `<div class="mt-3 rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs text-slate-500">${esc(vm.clientCabinetServerHint)}</div>` : ''}

        <div class="mt-5 pt-4 border-t">
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-semibold text-sm">Материалы и задания</h3>
            <button type="button" data-c3="material-add" data-id="${esc(client.id)}" class="text-xs text-indigo-600">+ материал</button>
          </div>
          ${materials.length ? `<div class="space-y-2 max-h-56 overflow-y-auto">${materials.map(m => `
            <div class="rounded-xl border p-3 text-sm">
              <div class="flex items-start gap-2">
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 shrink-0">${esc(MATERIAL_KINDS[m.kind] || m.kind)}</span>
                <div class="flex-1 min-w-0">
                  <div class="font-medium">${esc(m.title || 'Без названия')}</div>
                  ${m.body ? `<div class="text-xs text-slate-500 whitespace-pre-wrap">${esc(m.body.slice(0, 220))}</div>` : ''}
                  ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="text-xs text-indigo-600 break-all">${esc(m.url)}</a>` : ''}
                  <div class="text-[11px] text-slate-400 mt-1">${esc(dateLabel((m.createdAt || '').slice(0, 10)))}${m.seenAt ? ` · клиент открыл ${esc((m.seenAt || '').slice(0, 10))}` : ' · ещё не открыт'}</div>
                </div>
                <div class="flex flex-col gap-1 shrink-0">
                  <button type="button" data-c3="material-pin" data-id="${esc(m.id)}" class="text-[11px] text-amber-600">${m.pinned ? 'открепить' : '📌'}</button>
                  <button type="button" data-c3="material-del" data-id="${esc(m.id)}" class="text-[11px] text-rose-500">удалить</button>
                </div>
              </div>
            </div>`).join('')}</div>` : '<p class="text-xs text-slate-400">Материалов нет. Добавьте текст, ссылку или файл — клиент увидит это в своём кабинете.</p>'}
        </div>

        <div class="mt-5 pt-4 border-t">
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-semibold text-sm">Документы</h3>
            <button type="button" data-c3="doc-add" data-id="${esc(client.id)}" class="text-xs text-indigo-600">+ документ</button>
          </div>
          ${documents.length ? `<div class="space-y-2">${documents.map(d => `
            <div class="rounded-xl border p-3 text-sm flex items-start gap-2">
              <div class="flex-1 min-w-0">
                <div class="font-medium">${esc(d.title)}</div>
                <div class="text-[11px] ${d.signedAt ? 'text-emerald-600' : 'text-slate-400'}">${d.signedAt ? `подписан клиентом ${esc((d.signedAt || '').slice(0, 10))}` : 'ожидает подтверждения клиента'}</div>
              </div>
              <button type="button" data-c3="doc-del" data-id="${esc(d.id)}" class="text-[11px] text-rose-500 shrink-0">удалить</button>
            </div>`).join('')}</div>` : '<p class="text-xs text-slate-400">Согласия и договоры (необязательно). Клиент открывает документ по своей ссылке и подтверждает — дата фиксируется.</p>'}
        </div>
      </div>

      <div class="bg-white rounded-xl border p-5 lg:col-span-2">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 class="font-semibold text-sm">История платежей</h2>
          <div class="text-xs text-slate-500">получено: ${esc(payments.totalLabel)}${payments.unpaidCount ? ` · не закрыто: ${payments.unpaidCount}` : ''}${payments.debtLabel && payments.debtLabel !== 'долгов нет' ? ` · долг: ${esc(payments.debtLabel)}` : ''}</div>
        </div>
        ${payments.rows.length ? `<div class="overflow-x-auto"><table class="w-full text-sm">
          <thead><tr class="text-xs text-slate-400 text-left"><th class="py-1">Дата</th><th>Услуга</th><th>Статус</th><th class="text-right">К оплате</th><th class="text-right">Оплачено</th><th class="text-right">Остаток</th></tr></thead>
          <tbody>
            ${payments.rows.map(r => `<tr class="border-t">
              <td class="py-1.5 font-mono text-xs text-slate-500">${esc(r.date)} ${esc(r.time)}</td>
              <td>${esc(r.serviceName)}${r.method ? `<span class="text-xs text-slate-400"> · ${esc(vm.paymentMethodLabel(r.method))}</span>` : ''}</td>
              <td><span class="text-xs px-2 py-0.5 rounded-full ${statusClass(r.status)}">${esc(statusLabel(r.status))}</span></td>
              <td class="text-right">${esc(money(r.due, r.currency))}</td>
              <td class="text-right text-emerald-700">${esc(money(r.paid, r.currency))}</td>
              <td class="text-right ${r.debt > 0 ? 'text-rose-600' : 'text-slate-400'}">${esc(money(r.debt, r.currency))}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<p class="text-xs text-slate-400">Сессий и платежей пока нет.</p>'}
      </div>
    </div>`;
}

/* ================================================================== */
/*  СТАТИСТИКА (T-20)                                                  */
/* ================================================================== */

function renderStatsExtras(vm) {
  const box = document.getElementById('cab3-stats');
  if (!box) return;
  const st = vm.stats;
  const c = st.counts;
  const card = (label, value, hint = '', cls = '') => `
    <div class="bg-white rounded-xl border p-4 ${cls}">
      <div class="text-2xl font-bold">${esc(value)}</div>
      <div class="text-xs text-slate-500">${esc(label)}</div>
      ${hint ? `<div class="text-[11px] text-slate-400 mt-0.5">${esc(hint)}</div>` : ''}
    </div>`;
  const moneyRow = rows => `
    <div class="bg-white rounded-xl border p-4">
      <div class="text-sm font-semibold mb-2">Доход по валютам</div>
      <div class="space-y-1 text-sm">
        <div class="flex justify-between"><span class="text-slate-500">Получено</span><b>${esc(moneyLabel(st.money.received, {}))}</b></div>
        <div class="flex justify-between"><span class="text-slate-500">Ожидается (будущие)</span><b>${esc(moneyLabel(st.money.expected, {}))}</b></div>
        <div class="flex justify-between"><span class="text-slate-500">Недополучено (прошлые)</span><b class="${Object.values(st.money.outstanding).some(v => v > 0) ? 'text-rose-600' : ''}">${esc(moneyLabel(st.money.outstanding, { empty: '0' }))}</b></div>
      </div>
    </div>`;
  const table = (title, rows, unit) => `
    <div class="bg-white rounded-xl border p-4">
      <div class="text-sm font-semibold mb-2">${esc(title)}</div>
      <div class="overflow-x-auto"><table class="w-full text-xs">
        <thead><tr class="text-slate-400 text-left"><th class="py-1">Период</th><th class="text-right">Встреч</th><th class="text-right">Проведено</th><th class="text-right">Получено</th><th class="text-right">Ожидается</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="border-t">
          <td class="py-1">${esc(r.label)}</td>
          <td class="text-right">${r.count}</td>
          <td class="text-right">${r.done}</td>
          <td class="text-right text-emerald-700">${esc(moneyLabel(r.received, { empty: '—' }))}</td>
          <td class="text-right text-slate-500">${esc(moneyLabel(r.expected, { empty: '—' }))}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="text-[11px] text-slate-400 mt-1">${esc(unit)}</div>
    </div>`;

  box.innerHTML = `
    <div class="mt-6">
      <h2 class="text-sm font-semibold text-slate-600 mb-2">Загрузка и деньги · ${esc(zoneLabel(st.timezone))}</h2>
      <div class="grid sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        ${card('предстоящих', c.upcoming)}
        ${card('сегодня', c.today)}
        ${card('на 7 дней', c.next7)}
        ${card('проведено', c.done)}
        ${card('отмен', c.cancelled)}
        ${card('неявок', c.noShow)}
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        ${card('свободных часов (неделя)', st.load.week.freeHours, `занято ${st.load.week.busyHours} из ${st.load.week.capacityHours} · загрузка ${st.load.week.loadPercent}%`)}
        ${card('свободных часов (месяц)', st.load.month.freeHours, `загрузка ${st.load.month.loadPercent}%`)}
        ${card('ждут оплаты', c.heldUnpaid, 'резервы и неоплаченные')}
        ${card('клиентов в работе', c.clients, `всего карточек: ${c.totalClients}`)}
      </div>
      <div class="grid lg:grid-cols-2 gap-3 mb-4">
        ${moneyRow()}
        <div class="bg-white rounded-xl border p-4">
          <div class="text-sm font-semibold mb-2">Загрузка по дням недели</div>
          ${st.byWeekday.map(w => {
            const max = Math.max(1, ...st.byWeekday.map(x => x.count));
            return `<div class="flex items-center gap-2 text-xs mb-1">
              <span class="w-6 text-slate-500">${esc(WEEKDAY_NAMES_SHORT[w.weekday])}</span>
              <span class="flex-1 bg-slate-100 rounded-full h-2"><span class="block h-2 rounded-full bg-indigo-500" style="width:${Math.round((w.count / max) * 100)}%"></span></span>
              <span class="w-6 text-right text-slate-500">${w.count}</span>
            </div>`;
          }).join('')}
          ${st.topServices.length ? `<div class="mt-3 text-xs text-slate-500">Услуги: ${st.topServices.slice(0, 4).map(s => `${esc(s.name)} — ${s.count}`).join(' · ')}</div>` : ''}
        </div>
      </div>
      <div class="grid lg:grid-cols-2 gap-3">
        ${table('По неделям', st.byWeek, 'последние 5 недель, текущая и 4 будущих')}
        ${table('По месяцам', st.byMonth, 'полгода')}
      </div>
    </div>`;
}

/* ================================================================== */
/*  ПОЯСА В РАСПИСАНИИ (T-23)                                          */
/* ================================================================== */

function renderScheduleZoneNote(vm) {
  const box = document.getElementById('cab3-schedule-zone');
  if (!box) return;
  const zone = vm.scheduleZone;
  const clientZones = new Set((vm.clients || []).map(c => vm.conditionsOf(c).clientTimezone).filter(Boolean));
  box.innerHTML = `
    <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
      <span>Все времена в расписании — по часовому поясу кабинета: <b>${esc(zoneLabel(zone))}</b>.</span>
      ${clientZones.size ? `<span>Клиенты из других поясов: ${esc([...clientZones].map(zoneCity).join(', '))} — у встреч покажем их местное время.</span>` : ''}
    </div>`;
}

/* ================================================================== */
/*  ПОДПИСИ В СПИСКАХ: серия + пояс клиента (T-06 / T-23)              */
/* ================================================================== */

/**
 * Списки расписания и книги записей рисует app.js; мы аккуратно дописываем
 * к каждой встрече бейдж «серия» и «у клиента 09:00», не меняя чужой код.
 */
function decorateRows(vm, containerId) {
  const box = document.getElementById(containerId);
  if (!box || typeof box.querySelectorAll !== 'function') return;
  let buttons = [];
  try { buttons = box.querySelectorAll('[data-edit-session], [data-del-session]'); } catch { return; }
  [...buttons].forEach(btn => {
    const id = btn.dataset?.editSession || btn.dataset?.delSession;
    const session = (vm.sessions || []).find(s => s.id === id);
    if (!session) return;
    const row = btn.closest?.('div') || btn.parentElement;
    if (!row || !row.insertAdjacentHTML) return;
    const host = row.querySelector?.('.flex-1') || row;
    if (host.querySelector?.('[data-c3-injected]')) return;
    const series = vm.seriesForSession(session);
    const hint = vm.sessionZone(session).hint;
    if (!series && !hint) return;
    const chips = [
      series ? `серия: ${series.label()}` : '',
      hint
    ].filter(Boolean);
    // аккуратно дописываем подпись под названием услуги, не ломая чужую верстку
    host.insertAdjacentHTML('beforeend',
      `<div data-c3-injected class="text-[11px] text-slate-400 mt-0.5">${esc(chips.join(' · '))}</div>`);
  });
}

/* ================================================================== */
/*  СТРАНИЦА КЛИЕНТА ПО СЕКРЕТНОЙ ССЫЛКЕ (T-12)                        */
/* ================================================================== */

function renderClientMessage(root, { title, text, hint = '' }) {
  root.innerHTML = `
    <div class="bg-white rounded-2xl border p-8 text-center">
      <div class="text-3xl mb-3">🔒</div>
      <h1 class="text-xl font-bold mb-2">${esc(title)}</h1>
      <p class="text-sm text-slate-600">${esc(text)}</p>
      ${hint ? `<p class="text-xs text-slate-400 mt-3">${esc(hint)}</p>` : ''}
      <button onclick="navigate('portal')" class="mt-6 text-sm text-indigo-600">На портал</button>
    </div>`;
  return root;
}

/**
 * «В календарь (.ics)» для встречи в мини-кабинете клиента (#65).
 * s.date/s.time — настенное время кабинета (пояс специалиста), TZID в файле
 * даёт календарю клиента показать встречу в его собственном поясе.
 */
function clientIcsLink(s, psy) {
  const ics = buildIcsEvent({
    title: `${s.serviceName || 'Консультация'} · ${psy.fullName}`,
    date: s.date,
    time: s.time,
    durationMin: s.durationMin,
    timezone: s.psyZone || psy.timezone,
    location: s.joinUrl || '',
    url: s.joinUrl || '',
    description: s.joinUrl ? `Ссылка на встречу: ${s.joinUrl}` : '',
    uid: s.id
  });
  if (!ics) return '';
  const name = icsFileName({ specialist: psy.fullName, date: s.date, time: s.time });
  return `<a href="${esc(icsHref(ics))}" download="${esc(name)}" data-cc-ics="${esc(s.id)}" class="px-4 py-2 rounded-full border text-xs">📅 В календарь</a>`;
}

function clientCabinetHtml(view, { localOnly } = {}) {
  const psy = view.psychologist;
  const client = view.client;
  const next = view.upcoming[0];
  return `
    <div class="bg-white rounded-2xl border p-6 mb-5">
      <div class="text-xs text-slate-400">Личный кабинет клиента</div>
      <h1 class="text-xl font-bold mt-1">${esc(client.displayName)}</h1>
      <p class="text-sm text-slate-500">${esc(psy.fullName)}${psy.specialization ? ` · ${esc(psy.specialization)}` : ''} · ${esc(psy.timezoneLabel || '')}</p>
      ${localOnly ? '<div class="mt-3 rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">Предпросмотр: данные берутся из этого браузера. Полноценно ссылка заработает после применения серверной части (заявки SR-103…SR-106) — тогда клиент откроет её с любого устройства.</div>' : ''}
    </div>

    ${view.pendingReply ? `
    <div class="bg-white rounded-2xl border p-6 mb-5">
      <h2 class="font-semibold text-sm mb-2">${view.pendingReply.kind === 'reschedule_request' ? 'Нужно согласие на перенос' : 'Подтвердите встречу'}</h2>
      <pre class="whitespace-pre-wrap text-xs text-slate-600 bg-slate-50 rounded-xl p-3 mb-3">${esc(view.pendingReply.message)}</pre>
      <div class="flex flex-col sm:flex-row gap-2">
        <button type="button" data-c3="cc-reply-yes" data-token="${esc(view.pendingReply.token)}" class="flex-1 py-2.5 rounded-full bg-emerald-600 text-white text-sm font-medium">
          ${view.pendingReply.kind === 'reschedule_request' ? 'Согласен на новое время' : 'Подтвердить запись'}</button>
        <button type="button" data-c3="cc-reply-no" data-token="${esc(view.pendingReply.token)}" class="flex-1 py-2.5 rounded-full border border-rose-300 text-rose-700 text-sm font-medium">Отказаться</button>
      </div>
    </div>` : ''}

    <div class="bg-white rounded-2xl border p-6 mb-5">
      <div class="flex items-center justify-between mb-3">
        <h2 class="font-semibold text-sm">Ближайшие встречи</h2>
        <span class="text-xs text-slate-400">${esc(zoneLabel(psy.timezone))}</span>
      </div>
      ${view.upcoming.length ? `<div class="space-y-3">${view.upcoming.slice(0, 6).map(s => `
        <div class="rounded-xl border p-4">
          <div class="flex flex-wrap items-center gap-2">
            <div class="font-semibold">${esc(dateLabel(s.localDate))} · ${esc(s.localTime)}</div>
            <span class="text-xs text-slate-400">${esc(s.zoneHint)}</span>
            <span class="text-xs px-2 py-0.5 rounded-full ${statusClass(s.status)} ml-auto">${esc(statusLabel(s.status))}</span>
          </div>
          <div class="text-sm text-slate-500 mt-0.5">${esc(s.serviceName)}${s.durationMin ? ` · ${s.durationMin} мин` : ''}${s.price ? ` · ${esc(money(s.price, s.currency))}` : ''}</div>
          <div class="flex flex-wrap gap-2 mt-3">
            ${s.joinUrl
              ? `<a href="${esc(s.joinUrl)}" target="_blank" rel="noopener" class="px-4 py-2 rounded-full bg-indigo-600 text-white text-xs font-medium">Подключиться</a>`
              : (s.isOnline ? '<span class="text-xs text-slate-400 self-center">ссылка на встречу появится здесь</span>' : '<span class="text-xs text-slate-400 self-center">очная встреча</span>')}
            ${s.paymentUrl ? `<a href="${esc(s.paymentUrl)}" target="_blank" rel="noopener" class="px-4 py-2 rounded-full border text-xs">Оплатить</a>` : ''}
            ${clientIcsLink(s, psy)}
            ${s.canPropose ? `<button type="button" data-c3="cc-propose" data-session="${esc(s.id)}" data-date="${esc(s.localDate)}" data-time="${esc(s.localTime)}" class="px-4 py-2 rounded-full border text-xs">Предложить другое время</button>` : ''}
          </div>
          ${s.pendingChange ? `<div class="text-xs text-amber-700 mt-2">специалист предложил: ${esc(s.pendingChange.date)} ${esc(s.pendingChange.time)}</div>` : ''}
        </div>`).join('')}</div>` : '<p class="text-sm text-slate-400">Запланированных встреч пока нет.</p>'}
      <div class="flex flex-wrap gap-2 mt-4">
        <button type="button" data-c3="cc-recurring" class="px-4 py-2 rounded-full border border-indigo-300 text-indigo-700 text-xs">Хочу постоянное время</button>
        <button type="button" data-c3="cc-wait-day" class="px-4 py-2 rounded-full border text-xs">Встать в очередь на день</button>
      </div>
      ${view.past?.length ? `<div class="mt-4 pt-3 border-t text-xs text-slate-400">Прошедшие встречи: ${view.past.slice(0, 6).map(p => `${esc(dateLabel(p.date))} (${esc(statusLabel(p.status))})`).join(', ')}</div>` : ''}
    </div>

    <div class="bg-white rounded-2xl border p-6 mb-5">
      <h2 class="font-semibold text-sm mb-3">Материалы и задания</h2>
      ${view.materials.length ? `<div class="space-y-3">${view.materials.map(m => `
        <div class="rounded-xl border p-4">
          <div class="flex items-start gap-2">
            <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 shrink-0">${esc(MATERIAL_KINDS[m.kind] || m.kind)}</span>
            <div class="flex-1 min-w-0">
              <div class="font-medium">${esc(m.title || 'Материал')}</div>
              ${m.body ? `<div class="text-sm text-slate-600 whitespace-pre-wrap mt-1">${esc(m.body)}</div>` : ''}
              ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="text-xs text-indigo-600 break-all">${esc(m.url)}</a>` : ''}
            </div>
          </div>
          ${m.seenAt ? '<div class="text-[11px] text-emerald-600 mt-2">отмечено как просмотренное</div>'
            : `<button type="button" data-c3="cc-material-seen" data-id="${esc(m.id)}" class="mt-2 text-xs text-indigo-600">Отметить как прочитанное</button>`}
        </div>`).join('')}</div>` : '<p class="text-sm text-slate-400">Пока ничего не добавлено.</p>'}
    </div>

    ${view.documents?.length ? `
    <div class="bg-white rounded-2xl border p-6 mb-5">
      <h2 class="font-semibold text-sm mb-3">Документы</h2>
      ${view.documents.map(d => `
        <div class="rounded-xl border p-4 mb-2">
          <div class="font-medium text-sm">${esc(d.title)}</div>
          ${d.body ? `<div class="text-xs text-slate-600 whitespace-pre-wrap mt-1">${esc(d.body)}</div>` : ''}
          ${d.signedAt
            ? `<div class="text-[11px] text-emerald-600 mt-2">подписано ${esc((d.signedAt || '').slice(0, 10))}</div>`
            : `<button type="button" data-c3="cc-doc-sign" data-id="${esc(d.id)}" class="mt-2 px-3 py-1.5 rounded-full bg-slate-900 text-white text-xs">Ознакомлен и подтверждаю</button>`}
        </div>`).join('')}
    </div>` : ''}

    <div class="text-center text-xs text-slate-400 pb-8">
      ${psy.publicEmail ? `Связаться: <a class="text-indigo-600" href="mailto:${esc(psy.publicEmail)}">${esc(psy.publicEmail)}</a><br>` : ''}
      Ссылка персональная — не пересылайте её другим.
    </div>`;
}

/** Свободные окна для «предложить другое время» — в поясе клиента, если он отличается */
function slotsForClient(psychologistId, psyZone) {
  const clientZone = timezoneService.browserZone();
  const slots = suggestSlots({ psychologistId }).slice(0, 18);
  if (!psyZone || clientZone === psyZone) return slots.map(s => ({ ...s, clientZone }));
  return slots.map(s => {
    const conv = timezoneService.convertWallClock(s.date, s.time, psyZone, clientZone);
    return { ...s, clientDate: conv?.date || s.date, clientTime: conv?.time || s.time, clientZone };
  });
}

async function renderClientCabinetPage(token) {
  const root = document.getElementById('cc-root');
  const legacy = document.getElementById('cc-reply-wrap');
  if (!root) return;
  if (!token) {
    if (legacy) legacy.classList.remove('hidden');
    return;
  }

  // 1) секретный токен мини-кабинета (clt_…) — полноценный кабинет клиента
  const isAccess = String(token).startsWith('clt_');

  if (isAccess) {
    if (legacy) legacy.classList.add('hidden');
    root.innerHTML = '<div class="bg-white rounded-2xl border p-8 text-center text-sm text-slate-400">Открываем кабинет…</div>';
    // сначала локальная проба (без сети) — чтобы взять условия клиента из сейфа кабинета
    const probe = clientCabinetService.localProbe(token);
    const conds = probe.ok ? await localConditions(probe.view?.client?.id) : null;
    const res = await clientCabinetService.resolve(token, conds ? { conditions: conds } : {});
    if (!res.ok) {
      renderClientMessage(root, {
        title: 'Ссылка недоступна',
        text: res.message || 'Ссылка недействительна',
        hint: 'Попросите специалиста прислать актуальную ссылку.'
      });
      return;
    }
    const view = res.view || {};
    // пояс клиента запоминаем только когда кабинет открыл сам клиент (не предпросмотр психолога)
    rememberClientZone(view, { skip: res.mode === 'local' });
    view.suggestedSlots = view.psychologist?.id ? slotsForClient(view.psychologist.id, view.timezone) : [];
    cabinetUi.bindClientContext(token, { view, vm: cabinetUi.vm });
    root.innerHTML = clientCabinetHtml(view, { localOnly: res.mode === 'local' });
    return;
  }

  // 2) токен напоминания: карточка ответа остаётся, ниже — мини-кабинет того же клиента
  if (legacy) legacy.classList.remove('hidden');
  const rem = db.reminders.find(r => r.responseToken === token);
  const clientId = rem?.clientId;
  const psyId = rem?.psychologistId;
  if (!clientId || !psyId) {
    root.innerHTML = '';
    return;
  }
  const view = clientCabinetService.buildView({
    psychologistId: psyId, clientId, token, localOnly: true, conditions: await localConditions(clientId)
  });
  view.suggestedSlots = slotsForClient(psyId, view.psychologist?.timezone);
  cabinetUi.bindClientContext(token, { view, vm: cabinetUi.vm });
  root.innerHTML = clientCabinetHtml(view, { localOnly: true });
}

/**
 * Условия клиента из расшифрованного сейфа кабинета (если открыто в браузере психолога).
 * На устройстве клиента их нет — там данные даёт серверный RPC (SR-103).
 */
async function localConditions(clientId = null) {
  const vm = cabinetUi.vm;
  try {
    if (!vm?.psyId) return null;
    if (!vm.clients?.length) await vm.refreshClients();
    if (clientId) return vm.conditionsOf(clientId);
    return null;
  } catch {
    return null;
  }
}

/** Если клиент открыл кабинет из другого пояса — сохраняем пояс в его условиях (для расписания психолога) */
function rememberClientZone(view, { skip = false } = {}) {
  if (skip) return;
  try {
    const zone = timezoneService.browserZone();
    const psyZone = view?.psychologist?.timezone;
    const clientId = view?.client?.id;
    if (!clientId || !zone || !psyZone || zone === psyZone) return;
    clientCabinetService.rememberClientTimezone(clientId, zone);
  } catch { /* не критично */ }
}

function currentBase() {
  try {
    const p = location.pathname.replace(/(cabinet|auth|reply|booking-done|psy\/[^/]*|book\/[^/]*)\/?$/i, '');
    return p.endsWith('/') ? p : p + '/';
  } catch {
    return '/';
  }
}

/* ================================================================== */
/*  СОБЫТИЯ                                                            */
/* ================================================================== */

const handlers = {
  'choice-single': (el, vm) => { vm.applySeriesChoice('single'); document.getElementById('cab3-modal-scope')?.remove(); rerenderCabinet(); },
  'choice-series': (el, vm) => { vm.applySeriesChoice('series'); document.getElementById('cab3-modal-scope')?.remove(); rerenderCabinet(); },
  'choice-cancel': (el, vm) => { vm.applySeriesChoice('cancel'); document.getElementById('cab3-modal-scope')?.remove(); rerenderCabinet(); },

  'series-new': (el, vm) => openSeriesModal(vm),
  'series-edit': (el, vm) => {
    const series = vm.series.find(s => s.id === el.dataset.id);
    if (series) openSeriesModal(vm, series);
  },
  'series-pause': (el, vm) => { vm.pauseSeries(el.dataset.id); rerenderCabinet(); },
  'series-resume': (el, vm) => { vm.resumeSeries(el.dataset.id); rerenderCabinet(); },
  'series-delete': (el, vm) => {
    if (confirm('Удалить серию? Будущие встречи серии будут сняты.')) {
      vm.removeSeries(el.dataset.id);
      rerenderCabinet();
    }
  },
  'series-extend': (el, vm) => { vm.extendSeries(el.dataset.id, 12); rerenderCabinet(); },

  'conditions-save': (el, vm) => {
    const price = $('#c3-price')?.value;
    const cond = {
      priceOverride: price === '' ? null : Number(price),
      currency: $('#c3-currency')?.value || null,
      paymentMethod: $('#c3-method')?.value || null,
      meetLink: $('#c3-meet')?.value || null,
      paymentUrl: $('#c3-pay')?.value || null,
      clientTimezone: $('#c3-zone')?.value || null
    };
    vm.saveClientConditions(el.dataset.id, cond).then(() => rerenderCabinet());
  },

  'link-create': (el, vm) => {
    const res = vm.clientAccessLink(el.dataset.id);
    if (!res?.ok) { toast(res?.message || 'Не удалось создать ссылку', true); return; }
    rerenderCabinet();
    toast('Ссылка клиента создана');
  },
  'link-rotate': (el, vm) => {
    if (!confirm('Заменить ссылку? Старая перестанет открываться у клиента.')) return;
    vm.clientAccessLink(el.dataset.id, { rotate: true });
    rerenderCabinet();
  },
  'link-revoke': (el, vm) => {
    if (!confirm('Отозвать доступ по ссылке?')) return;
    vm.revokeClientAccessLink(el.dataset.token);
    rerenderCabinet();
  },
  'link-copy': async (el, vm) => {
    const value = $('#c3-link')?.value || '';
    try { await navigator.clipboard.writeText(value); toast('Ссылка скопирована'); }
    catch { window.prompt('Скопируйте ссылку:', value); }
  },
  'link-preview': (el, vm) => {
    const url = clientCabinetService.tokenUrl(el.dataset.token, currentBase());
    window.open(url, '_blank', 'noopener');
  },

  'material-add': (el, vm) => openModal({
    id: 'cab3-modal-material',
    title: 'Новый материал для клиента',
    submitLabel: 'Добавить',
    body: `
      ${field('Тип', select('kind', Object.entries(MATERIAL_KINDS).map(([id, label]) => ({ id, label })), 'text'))}
      ${field('Заголовок', input('title', { placeholder: 'Дыхательная практика' }))}
      ${field('Текст / задание', `<textarea name="body" rows="4" class="w-full mt-1 px-3 py-2 rounded-xl border resize-none"></textarea>`)}
      ${field('Ссылка (если есть)', input('url', { placeholder: 'https://…' }))}`,
    onSubmit: data => {
      const res = vm.addMaterial({ clientId: el.dataset.id, ...data });
      if (res.ok) rerenderCabinet();
      else toast(res.message || 'Не удалось добавить', true);
      return !res.ok;
    }
  }),
  'material-del': (el, vm) => { vm.removeMaterial(el.dataset.id); rerenderCabinet(); },
  'material-pin': (el, vm) => { vm.toggleMaterialPin(el.dataset.id); rerenderCabinet(); },

  'doc-add': (el, vm) => openModal({
    id: 'cab3-modal-doc',
    title: 'Документ для клиента',
    submitLabel: 'Добавить',
    body: `
      ${field('Заголовок', input('title', { placeholder: 'Информированное согласие' }))}
      ${field('Текст документа', `<textarea name="body" rows="6" class="w-full mt-1 px-3 py-2 rounded-xl border resize-none" placeholder="Условия работы, конфиденциальность, порядок отмены…"></textarea>`)}`,
    onSubmit: data => {
      const res = vm.addDocument({ clientId: el.dataset.id, ...data });
      if (res.ok) rerenderCabinet();
      return !res.ok;
    }
  }),
  'doc-del': (el, vm) => { vm.removeDocument(el.dataset.id); rerenderCabinet(); },

  'req-accept': (el, vm) => { vm.acceptClientRequest(el.dataset.id); rerenderCabinet(); },
  'req-decline': (el, vm) => { vm.declineClientRequest(el.dataset.id); rerenderCabinet(); },
  'req-remove': (el, vm) => { vm.removeClientRequest(el.dataset.id); rerenderCabinet(); },
  'req-series': (el, vm) => {
    const r = vm.clientRequests.find(x => x.id === el.dataset.id);
    if (!r) return;
    openModal({
      id: 'cab3-modal-req-series',
      title: 'Постоянное время по запросу клиента',
      submitLabel: 'Создать серию',
      body: `
        <div class="grid grid-cols-2 gap-3">
          ${field('День недели', select('weekday', weekdayOptions(), r.weekday || 1))}
          ${field('Время', input('time', { type: 'time', value: r.desiredTime || '15:00' }))}
        </div>
        <div class="grid grid-cols-2 gap-3">
          ${field('Периодичность', select('intervalWeeks', [{ id: 1, label: 'каждую неделю' }, { id: 2, label: 'раз в 2 недели' }], r.intervalWeeks || 1))}
          ${field('Горизонт', select('horizonWeeks', HORIZON_OPTIONS, 8))}
        </div>
        ${field('Услуга', select('serviceId', [{ id: '', label: '— как у клиента —' }, ...vm.services.map(s => ({ id: s.id, label: s.name }))], ''))}`,
      onSubmit: data => {
        const res = vm.createSeriesFromRequest(el.dataset.id, data);
        rerenderCabinet();
        return !res?.ok;
      }
    });
  },
  'wait-plan': (el, vm) => {
    const w = vm.waiting.find(x => x.id === el.dataset.id);
    if (!w) return;
    openModal({
      id: 'cab3-modal-wait',
      title: 'Заявка из очереди',
      submitLabel: 'Сохранить пожелание',
      body: `
        <p class="text-slate-600 text-sm">${esc(w.name || 'Клиент')} · ${esc(w.note || '')}</p>
        <div class="grid grid-cols-2 gap-3">
          ${field('Желаемый день', input('desiredDate', { type: 'date', value: w.desiredDate || '' }))}
          ${field('Желаемое время', input('desiredTime', { type: 'time', value: w.desiredTime || '' }))}
        </div>
        <label class="flex items-center gap-2"><input type="checkbox" name="recurring" value="1" ${w.recurring ? 'checked' : ''} class="accent-indigo-600"> Хочет постоянное время (можно создать серию)</label>`,
      onSubmit: async data => {
        vm.setWaitingPreference(el.dataset.id, {
          desiredDate: data.desiredDate,
          desiredTime: data.desiredTime,
          recurring: !!data.recurring,
          weekday: data.desiredDate ? weekdayOf(data.desiredDate) : null
        });
        if (data.recurring) {
          await vm.createSeriesFromWaiting(el.dataset.id, {
            time: data.desiredTime || '10:00',
            weekday: data.desiredDate ? weekdayOf(data.desiredDate) : null
          });
        }
        rerenderCabinet();
        return false;
      }
    });
  },

  // ——— страница клиента ———
  'cc-reply-yes': (el) => {
    const res = reminderService.respond(el.dataset.token, 'confirmed');
    toast(res.message, !res.ok);
    if (res.ok) setTimeout(() => renderClientCabinetPage(el.dataset.token), 50);
    document.getElementById('cc-reply-wrap')?.remove();
    document.querySelectorAll('#reply-actions').forEach(a => a.classList.add('hidden'));
  },
  'cc-reply-no': (el) => {
    if (!confirm('Отменить запись?')) return;
    const res = reminderService.respond(el.dataset.token, 'declined');
    toast(res.message, !res.ok);
    setTimeout(() => renderClientCabinetPage(el.dataset.token), 50);
    document.querySelectorAll('#reply-actions').forEach(a => a.classList.add('hidden'));
  },
  'cc-material-seen': (el) => {
    const token = clientContextToken();
    clientCabinetService.markMaterialSeen(token, el.dataset.id);
    toast('Отмечено');
    setTimeout(() => renderClientCabinetPage(token), 30);
  },
  'cc-doc-sign': (el) => {
    const token = clientContextToken();
    const res = clientCabinetService.signDocument(token, el.dataset.id);
    toast(res.ok ? 'Документ подтверждён' : (res.message || 'Не удалось'), !res.ok);
    setTimeout(() => renderClientCabinetPage(token), 30);
  },
  'cc-propose': (el, vm) => openProposeModal(el, vm),
  'cc-recurring': (el, vm) => openRecurringModal(vm),
  'cc-wait-day': (el, vm) => openWaitDayModal(vm)
};

function clientContextToken() {
  try {
    const qs = new URLSearchParams(location.search);
    return qs.get('reply') || qs.get('token') || window.__c3token || '';
  } catch {
    return window.__c3token || '';
  }
}

async function openProposeModal(el, vm) {
  const token = clientContextToken();
  const view = vm.__clientView;
  const slots = view?.suggestedSlots || [];
  const options = slots.map(s => ({ id: `${s.date} ${s.time}`, label: `${dateLabel(s.date)} · ${s.time}` }));
  openModal({
    id: 'cab3-modal-propose',
    title: 'Предложить другое время',
    submitLabel: 'Отправить специалисту',
    body: `
      <p class="text-sm text-slate-600">Выберите удобное время — специалист подтвердит его в кабинете.</p>
      ${options.length
        ? field('Свободные окна', select('slot', options, options[0].id))
        : `<div class="grid grid-cols-2 gap-3">
             ${field('Дата', input('date', { type: 'date', value: el.dataset.date || '' }))}
             ${field('Время', input('time', { type: 'time', value: el.dataset.time || '' }))}
           </div>`}
      ${field('Комментарий', input('comment', { placeholder: 'например: не успеваю к 10:00' }))}`,
    onSubmit: data => {
      let date = data.date;
      let time = data.time;
      if (data.slot) [date, time] = String(data.slot).split(' ');
      const res = vm.__clientActions?.proposeSlot({ date, time, comment: data.comment, sessionId: el.dataset.session });
      toast(res?.message || 'Запрос отправлен', !res?.ok);
      if (res?.ok) setTimeout(() => renderClientCabinetPage(token), 30);
      return !res?.ok;
    }
  });
}

function openRecurringModal(vm) {
  const token = clientContextToken();
  openModal({
    id: 'cab3-modal-recurring',
    title: 'Хочу постоянное время',
    submitLabel: 'Отправить запрос',
    body: `
      <p class="text-sm text-slate-600">Специалист увидит запрос в кабинете и предложит постоянный слот.</p>
      <div class="grid grid-cols-2 gap-3">
        ${field('Удобный день недели', select('weekday', weekdayOptions(), 2))}
        ${field('Удобное время', input('time', { type: 'time', value: '15:00' }))}
      </div>
      ${field('Как часто', select('intervalWeeks', [{ id: 1, label: 'каждую неделю' }, { id: 2, label: 'раз в 2 недели' }], 1))}
      ${field('Комментарий', input('comment', { placeholder: 'например: только после 18:00' }))}`,
    onSubmit: data => {
      const res = vm.__clientActions?.requestRecurring({
        weekday: Number(data.weekday), time: data.time,
        intervalWeeks: Number(data.intervalWeeks), comment: data.comment
      });
      toast(res?.message || 'Запрос отправлен', !res?.ok);
      if (res?.ok) setTimeout(() => renderClientCabinetPage(token), 30);
      return !res?.ok;
    }
  });
}

function openWaitDayModal(vm) {
  const token = clientContextToken();
  openModal({
    id: 'cab3-modal-waitday',
    title: 'Встать в очередь на конкретный день',
    submitLabel: 'Встать в очередь',
    body: `
      <p class="text-sm text-slate-600">Если на этот день всё занято — специалист увидит вас первым в очереди.</p>
      ${field('День', input('date', { type: 'date', value: todayStr() }))}
      ${field('Удобное время', input('time', { type: 'time', value: '15:00' }))}
      ${field('Комментарий', input('comment', { placeholder: 'например: могу только утром' }))}`,
    onSubmit: data => {
      const res = vm.__clientActions?.requestWaitingDay({ date: data.date, time: data.time, comment: data.comment });
      toast(res?.message || 'Вы в очереди', !res?.ok);
      if (res?.ok) setTimeout(() => renderClientCabinetPage(token), 30);
      return !res?.ok;
    }
  });
}

/* ================================================================== */
/*  ПУБЛИЧНЫЙ ИНТЕРФЕЙС                                                */
/* ================================================================== */

export const cabinetUi = {
  vm: null,
  installed: false,

  install() {
    if (this.installed || typeof document === 'undefined') return;
    this.installed = true;

    document.addEventListener('click', e => {
      const closeBtn = e.target.closest('[data-c3="modal-close"]');
      if (closeBtn) {
        closeBtn.closest('[id^="cab3-modal"]')?.remove();
        return;
      }
      const el = e.target.closest('[data-c3]');
      if (!el) return;
      const action = el.dataset.c3;
      if (action === 'modal-close') return;
      const fn = handlers[action];
      if (!fn) return;
      e.preventDefault();
      try {
        fn(el, this.vm);
      } catch (err) {
        console.warn('[cabinetUi]', action, err);
        toast('Не получилось выполнить действие', true);
      }
    });

    // T-06: ловим сохранение сессии, чтобы после ответа ViewModel показать выбор области переноса
    document.addEventListener('click', e => {
      if (!e.target.closest('#sess-save')) return;
      setTimeout(() => {
        if (this.vm?.pendingSeriesChoice) askRescheduleScope(this.vm);
      }, 0);
    }, true);

    // условия клиента/серия в модалке сессии — сразу после её открытия
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-edit-session]');
      if (!btn || !this.vm) return;
      setTimeout(() => decorateSessionModal(this.vm, btn.dataset.editSession), 0);
    }, true);
  },

  /** Вызывается из app.js после каждого render() — рисует мои блоки под текущий маршрут */
  async afterRender({ route, vm } = {}) {
    this.vm = vm || this.vm;
    const v = this.vm;
    if (!v) return;

    if (route?.name === 'clientReply') {
      const token = route.params?.token || clientContextToken();
      if (token) {
        window.__c3token = token;
        await renderClientCabinetPage(token);
      }
      return;
    }
    if (route?.name !== 'cabinet') return;

    // боковые данные (серии/материалы/запросы) — один раз на вход
    v.ensureSideData?.();

    const tab = v.tab;
    if (tab === 'schedule') {
      renderScheduleZoneNote(v);
      renderSeriesPanel(v);
      decorateRows(v, 'sch-list');
    }
    if (tab === 'waiting') renderRequestsPanel(v);
    if (tab === 'journal') { renderRequestsPanel(v, { compact: true }); decorateRows(v, 'journal-list'); }
    if (tab === 'clients') renderClientExtras(v);
    if (tab === 'stats') renderStatsExtras(v);

    // модалка сессии могла остаться открытой (например, после ошибки) — обновим подсказки
    const sessId = document.getElementById('sess-id')?.value;
    if (sessId && !document.getElementById('modal-session')?.classList.contains('hidden')) {
      decorateSessionModal(v, sessId);
    }
  },

  /** Рендер страницы клиента (используется и из обработчиков, и из app.js) */
  renderClientPage(token) {
    return renderClientCabinetPage(token);
  },

  /** Помощник для клиентского кабинета: действия клиента по токену */
  bindClientContext(token, { view, vm } = {}) {
    if (vm) vm.__clientView = view;
    const actions = {
      proposeSlot: ({ date, time, comment, sessionId }) => {
        const psyId = view?.psychologist?.id;
        const clientId = view?.client?.id;
        if (!psyId || !clientId) return { ok: false, message: 'Нет данных' };
        return clientCabinetService.addRequest({
          psychologistId: psyId, clientId, kind: 'propose_time', sessionId: sessionId || null,
          desiredDate: date, desiredTime: time, comment, token
        });
      },
      requestRecurring: ({ weekday, time, intervalWeeks, comment }) => {
        const psyId = view?.psychologist?.id;
        const clientId = view?.client?.id;
        if (!psyId || !clientId) return { ok: false, message: 'Нет данных' };
        return clientCabinetService.addRequest({
          psychologistId: psyId, clientId, kind: 'recurring',
          weekday, desiredTime: time, intervalWeeks, comment, token
        });
      },
      requestWaitingDay: ({ date, time, comment }) => {
        const psyId = view?.psychologist?.id;
        const clientId = view?.client?.id;
        if (!psyId || !clientId) return { ok: false, message: 'Нет данных' };
        return clientCabinetService.addRequest({
          psychologistId: psyId, clientId, kind: 'waiting_day',
          desiredDate: date, desiredTime: time, comment, token
        });
      }
    };
    if (vm) vm.__clientActions = actions;
    return actions;
  }
};

cabinetUi.install();

export { renderClientCabinetPage, suggestSlots };
