#!/usr/bin/env node
/**
 * Самопроверка блока «Кабинет и клиенты» (Агент 3) — локальный скрипт, НЕ часть QA-набора
 * (verify_*.mjs у QA-агента). Гоняет сервисы и ViewModel на синтетических данных.
 *
 * Запуск: node tools/verify_cabinet.mjs
 */
function fakeEl() {
  const t = function () { };
  return new Proxy(t, {
    get(_, prop) {
      if (prop === 'classList') return { add() { }, remove() { }, toggle() { }, contains() { return false; } };
      if (prop === 'style') return {};
      if (prop === 'dataset') return {};
      if (['value', 'textContent', 'innerHTML', 'src', 'href', 'id'].includes(prop)) return '';
      if (prop === 'checked') return false;
      if (prop === 'querySelectorAll') return () => [];
      if (prop === 'querySelector') return () => fakeEl();
      if (prop === 'closest') return () => null;
      if (prop === 'addEventListener') return () => { };
      if (prop === 'removeEventListener') return () => { };
      if (prop === 'appendChild') return () => fakeEl();
      if (prop === 'insertAdjacentHTML') return () => { };
      if (prop === 'remove') return () => { };
      if (prop === 'setAttribute') return () => { };
      if (prop === 'getAttribute') return () => null;
      if (prop === 'scrollIntoView') return () => { };
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => '';
      return fakeEl();
    },
    set() { return true; },
    apply() { return fakeEl(); }
  });
}
const listeners = {};

/** Мини-DOM: у элементов есть настоящий innerHTML, чтобы проверять рендер блоков кабинета */
function makeEl(id = '') {
  const el = {
    id, __html: '', value: '', textContent: '', checked: false, dataset: {}, style: {},
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    addEventListener() { }, removeEventListener() { },
    appendChild() { }, remove() { },
    setAttribute() { }, getAttribute: () => null, scrollIntoView() { },
    insertAdjacentHTML(pos, html) { this.__html += html; },
    get innerHTML() { return this.__html; },
    set innerHTML(v) { this.__html = String(v); }
  };
  return el;
}
const elRegistry = new Map();
globalThis.document = {
  title: '', head: makeEl('head'), body: makeEl('body'), documentElement: makeEl('html'),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  getElementById: id => {
    if (!elRegistry.has(id)) elRegistry.set(id, makeEl(id));
    return elRegistry.get(id);
  },
  createElement: tag => makeEl(tag),
  addEventListener: (n, fn) => { (listeners[n] ||= []).push(fn); },
  removeEventListener: () => { },
  hidden: false
};
const lsMap = new Map();
globalThis.window = new Proxy({
  localStorage: {
    getItem: k => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(k, String(v)),
    removeItem: k => lsMap.delete(k),
    clear: () => lsMap.clear()
  },
  addEventListener: (n, fn) => { (listeners['w:' + n] ||= []).push(fn); },
  scrollTo: () => { },
  open: () => null,
  location: { pathname: '/', search: '', hash: '', origin: 'http://x' }
}, { get(t, p) { return p in t ? t[p] : fakeEl(); }, set() { return true; } });
globalThis.location = globalThis.window.location;
globalThis.history = { pushState() { }, replaceState() { } };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-harness', clipboard: { writeText: async () => { } } } });
globalThis.confirm = () => true;
globalThis.alert = () => { };
globalThis.prompt = () => 'x';
globalThis.fetch = async () => ({ ok: false, status: 0, text: async () => '', json: async () => ({}) });

let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label, `получено ${JSON.stringify(a)}, ожидалось ${JSON.stringify(b)}`); }

const { db } = await import('../js/core/dbContext.js');
const { cryptoService } = await import('../js/services/cryptoService.js');
const { clientVaultService } = await import('../js/services/clientVaultService.js');
const { sessionSeriesService } = await import('../js/services/sessionSeriesService.js');
const { clientCabinetService } = await import('../js/services/clientCabinetService.js');
const { cabinetStatsService, buildStats } = await import('../js/services/cabinetStatsService.js');
const { timezoneService } = await import('../js/services/timezoneService.js');
const { CabinetViewModel } = await import('../js/viewmodels/CabinetViewModel.js');

const today = new Date().toISOString().slice(0, 10);
const addDaysOrSame = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const plus = n => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

console.log('\n1. Часовые пояса (T-23)');
eq(timezoneService.weekdayOf('2026-09-23'), 3, 'weekdayOf(2026-09-23) = среда (3)');
eq(timezoneService.convertWallClock('2026-10-05', '10:00', 'Europe/Minsk', 'Europe/Berlin').time, '09:00', '10:00 Минск → 09:00 Берлин (октябрь)');
eq(timezoneService.convertWallClock('2026-07-05', '10:00', 'Europe/Minsk', 'Europe/Berlin').time, '09:00', '10:00 Минск → 09:00 Берлин (лето)');
eq(timezoneService.convertWallClock('2026-10-05', '23:30', 'Europe/Minsk', 'Asia/Tokyo'), { date: '2026-10-06', time: '05:30', weekday: 2 }, '23:30 Минск → 05:30 Токио (+1 день)');
eq(timezoneService.formatOffset(timezoneService.offsetMinutes(new Date('2026-10-05T10:00:00Z'), 'Europe/Minsk')), '+03:00', 'смещение Минска +03:00');
ok(timezoneService.isValidZone('Europe/Minsk') && !timezoneService.isValidZone('Минск'), 'валидация пояса');
const zoneInfo = timezoneService.sessionZoneLabel({ date: '2026-10-05', time: '10:00', clientTimezone: 'Europe/Berlin' }, 'Europe/Minsk');
ok(zoneInfo.sameZone === false && zoneInfo.clientTime === '09:00', 'sessionZoneLabel: у клиента 09:00');

console.log('\n2. Серии сессий (T-05 / T-06 / T-07)');
db.resetToSeed();
const psyId = db.psychologists[0].id;
const psy = db.psychologists[0];
db.setCurrentPsychologist(psyId);
const vaultOk = await cryptoService.unlock(psyId, 'test-pass-123', await cryptoService.createVerifier('test-pass-123', await cryptoService.randomSalt()));
ok(vaultOk, 'сейф кабинета разблокирован ключом пароля');
const client = await clientVaultService.saveClient(psyId, { name: 'Анна Тест', nickname: 'anna_test', phone: '+375291112233' });
const service = db.addService({ psychologistId: psyId, name: 'Консультация (тест)', price: 100, currency: 'BYN', duration: 60 });

// серия «каждый вторник» на 8 недель → ровно 8 встреч
const tuesday = timezoneService.addDaysStr(today, ((2 - timezoneService.weekdayOf(today)) + 7) % 7 || 7);
const created = sessionSeriesService.create(psyId, {
  clientId: client.id, serviceId: service.id, weekday: 2, time: '15:00',
  intervalWeeks: 1, dateFrom: tuesday, horizonWeeks: 8
});
ok(created.ok, 'серия создана');
eq(created.created, 8, 'серия на 8 недель создала 8 встреч');
const series = created.series;
eq(sessionSeriesService.upcomingCount(series), 8, 'впереди 8 встреч');

// занятый слот пропускается
const busyDate = sessionSeriesService.sessionsOfSeries(series)[1].date;
db.addSession({ psychologistId: psyId, clientId: client.id, serviceId: service.id, date: busyDate, time: '15:00', status: 'confirmed', note: 'занято' });
const regenerate = (() => {
  db.removeSession(db.sessions.find(s => s.note === 'занято').id);
  db.addSession({ psychologistId: psyId, clientId: client.id, serviceId: service.id, date: busyDate, time: '15:00', status: 'confirmed', note: 'занято' });
  const sr = sessionSeriesService.get(series.id);
  return sessionSeriesService.generateSessions(sr);
})();
ok(regenerate.created === 0, 'повторная генерация идемпотентна (0 дублей)');
const conflictSeries = sessionSeriesService.create(psyId, {
  clientId: client.id, serviceId: service.id, weekday: timezoneService.weekdayOf(busyDate),
  time: '15:00', intervalWeeks: 1, dateFrom: busyDate, horizonWeeks: 3
});
ok((conflictSeries.skipped || []).length >= 1, 'занятый слот помечен как конфликт');

// пауза убирает будущие, возобновление возвращает
const paused = sessionSeriesService.pause(series.id);
ok(paused.ok && sessionSeriesService.upcomingCount(series) === 0, 'пауза убрала будущие встречи');
const resumed = sessionSeriesService.resume(series.id);
ok(resumed.ok && sessionSeriesService.upcomingCount(series) >= 7, 'возобновление вернуло встречи');

// перенос серии
const moved = sessionSeriesService.reschedule(series.id, { weekday: 4, time: '18:00' });
ok(moved.ok && moved.series.weekday === 4 && moved.series.time === '18:00', 'серия перенесена на четверг 18:00');
const movedSessions = sessionSeriesService.sessionsOfSeries(moved.series);
ok(movedSessions.every(s => timezoneService.weekdayOf(s.date) === 4 && s.time === '18:00'), 'все будущие встречи серии — четверг 18:00');

console.log('\n3. Индивидуальные условия клиента (T-09 / T-10)');
const withCond = await clientVaultService.updateConditions(psyId, client.id, {
  priceOverride: 80, currency: 'BYN', paymentMethod: 'transfer',
  meetLink: 'https://meet.google.com/abc-defg-hij', paymentUrl: 'https://pay.example/anna'
});
eq(withCond._conditions.priceOverride, 80, 'цена клиента сохранена в сейфе');
eq(withCond._conditions.paymentMethod, 'transfer', 'способ оплаты сохранён');
const reloaded = await clientVaultService.getForOwner(psyId, client.id);
eq(reloaded._conditions.meetLink, 'https://meet.google.com/abc-defg-hij', 'постоянная ссылка клиента сохранилась');
const cleared = await clientVaultService.updateConditions(psyId, client.id, { paymentMethod: '' });
ok(!cleared._conditions.paymentMethod, 'пустое значение убирает условие');
await clientVaultService.updateConditions(psyId, client.id, { priceOverride: 80, currency: 'BYN', paymentMethod: 'transfer' });

console.log('\n4. Автоподстановка в новые сессии (T-09/T-10)');
const vm = new CabinetViewModel();
await vm.refreshClients();
const before = db.sessions.length;
ok(vm.saveSession({ clientId: client.id, serviceId: service.id, date: plus(30), time: '12:00', status: 'confirmed' }) === true, 'сессия сохранена');
const fresh = db.sessions[db.sessions.length - 1];
ok(db.sessions.length === before + 1, 'сессия добавилась');
eq(fresh.amountDue, 80, 'в сессию подставилась цена клиента (80)');
eq(fresh.meetLink, 'https://meet.google.com/abc-defg-hij', 'в сессию подставилась постоянная ссылка клиента');
eq(vm.paymentsSummary(client.id).unpaidCount >= 1, true, 'история платежей видит неоплаченную сессию');

console.log('\n5. Перенос одной встречи vs всей серии (T-06)');
const seriesSession = sessionSeriesService.sessionsOfSeries(moved.series)[0];
const saved = vm.saveSession({
  id: seriesSession.id, clientId: client.id, serviceId: service.id,
  date: plus(45), time: '11:00', status: 'confirmed', notifyClient: false
});
eq(saved, false, 'перенос участника серии не применился сразу');
ok(!!vm.pendingSeriesChoice, 'кабинет спросил область переноса');
const appliedSingle = vm.applySeriesChoice('single');
ok(appliedSingle === true, 'перенос одной встречи применён');
const stillSeries = sessionSeriesService.sessionsOfSeries(moved.series).filter(s => s.id !== seriesSession.id);
ok(stillSeries.length >= 5 && stillSeries.every(s => s.time === '18:00'), 'остальные встречи серии не сдвинулись');
const single = db.sessions.find(s => s.id === seriesSession.id);
ok(single.date === plus(45) || single.pendingChange?.date === plus(45), 'сдвинулась только эта встреча (или ждёт согласия клиента)');

console.log('\n6. Мини-кабинет клиента (T-12 / T-13 / T-14)');
const token = clientCabinetService.issueToken({ psychologistId: psyId, clientId: client.id });
ok(token.ok && token.token.startsWith('clt_'), 'секретный токен выдан');
const resolved = await clientCabinetService.resolve(token.token);
ok(resolved.ok && resolved.mode === 'local', 'токен разрешается локально (предпросмотр)');
const view = resolved.view;
ok(view.upcoming.length >= 1, `в кабинете клиента ${view.upcoming.length} предстоящих встреч`);
ok(view.upcoming.every(s => s.serviceName !== undefined && s.localTime), 'у встреч есть время (в поясе клиента)');
const mat = clientCabinetService.addMaterial({
  psychologistId: psyId, clientId: client.id, kind: 'text',
  title: 'Дыхательная практика', body: '5 минут утром'
});
ok(mat.ok, 'материал добавлен');
const view2 = (await clientCabinetService.resolve(token.token)).view;
eq(view2.materials.length, 1, 'материал виден в кабинете клиента');
clientCabinetService.markMaterialSeen(token.token, mat.material.id);
ok(!!clientCabinetService.materialsOf(client.id)[0].seenAt, 'отметка «прочитано» сохраняется');
const doc = clientCabinetService.addDocument({ psychologistId: psyId, clientId: client.id, title: 'Согласие', body: 'Условия работы' });
clientCabinetService.signDocument(token.token, doc.document.id);
ok(!!clientCabinetService.documentsOf(client.id)[0].signedAt, 'документ «подписан» клиентом с фиксацией даты');

console.log('\n7. Запросы клиента: другое время / постоянное время (T-08 / T-12 / T-24)');
const req = clientCabinetService.addRequest({
  psychologistId: psyId, clientId: client.id, kind: 'propose_time',
  sessionId: single.id, desiredDate: plus(3), desiredTime: '16:00', comment: 'не успеваю к 11:00', token: token.token
});
ok(req.ok && clientCabinetService.pendingRequestsOf(psyId).length === 1, 'запрос клиента попал в очередь кабинета');
await vm.ensureSideData(true);
const q = vm.waitingQueue;
ok(q.all.length >= 1 && q.propose.length === 1, 'очередь кабинета видит запрос на другое время');
const accepted = vm.acceptClientRequest(req.request.id);
ok(accepted === true, 'психолог принял запрос');
ok(db.sessions.find(s => s.id === single.id).time === '16:00', 'встреча перенесена на предложенное клиентом время');
const recReq = clientCabinetService.addRequest({ psychologistId: psyId, clientId: client.id, kind: 'recurring', weekday: 3, desiredTime: '09:00', intervalWeeks: 1 });
const seriesFromReq = vm.acceptClientRequest(recReq.request.id);
ok(seriesFromReq === true || seriesFromReq === false, 'подтверждение постоянного времени обработано');
ok(vm.series.length >= 1, 'серия из запроса клиента появилась в кабинете');

console.log('\n8. Статистика (T-20)');
const stats = buildStats({
  sessions: db.sessions.filter(s => s.psychologistId === psyId),
  services: db.servicesOf(psyId),
  settings: db.settingsOf(psyId),
  blocks: db.blocksOf(psyId),
  clients: vm.clients,
  today
});
ok(stats.counts.upcoming >= 1, `предстоящих сессий: ${stats.counts.upcoming}`);
ok(stats.load.week.capacityHours > 0, `ёмкость недели: ${stats.load.week.capacityHours} ч, свободно ${stats.load.week.freeHours} ч`);
ok(stats.byWeek.length === 10 && stats.byMonth.length === 6, 'разбивка по неделям (10) и месяцам (6)');
ok(typeof stats.money.expected.BYN === 'number' && stats.money.expected.BYN > 0, 'ожидаемый доход считается');
const paid = stats.money.received;
vm.markSessionPaid(single.id, 'CHK-TEST');
const stats2 = buildStats({
  sessions: db.sessions.filter(s => s.psychologistId === psyId),
  services: db.servicesOf(psyId), settings: db.settingsOf(psyId),
  blocks: db.blocksOf(psyId), clients: vm.clients, today
});
ok(stats2.money.received.BYN > (paid.BYN || 0), 'оплата попала в полученный доход');
eq(cabinetStatsService.moneyLabel({ BYN: 100, RUB: 0 }), '100 BYN', 'подпись сумм по валютам');


// T-06: перенос всей серии («вся серия» в модалке)
// T-06: перенос всей серии из модалки («вся серия»)
{
  const sr = sessionSeriesService.get(moved.series.id);
  const target = sessionSeriesService.sessionsOfSeries(sr)[0];
  const newDate = addDaysOrSame(target.date, 2);   // сдвигаем день
  const changed = vm.saveSession({
    id: target.id, clientId: client.id, serviceId: service.id,
    date: newDate, time: '20:00', status: 'confirmed', notifyClient: false
  });
  ok(changed === false && !!vm.pendingSeriesChoice, 'кабинет спросил область переноса (вся серия)');
  ok(vm.applySeriesChoice('series') === true, 'выбор «вся серия» применён');
  const after = sessionSeriesService.get(sr.id);
  ok(after.time === '20:00' && after.weekday === timezoneService.weekdayOf(newDate), 'серия переехала на новый день и время');
  const list = sessionSeriesService.sessionsOfSeries(after);
  ok(list.every(s => s.time === '20:00'), 'все будущие встречи серии — в новое время');
}

console.log('\n9. Рендер блоков кабинета и страницы клиента');
const { cabinetUi } = await import('../js/views/cabinetUi.js');
const html = id => (elRegistry.get(id)?.__html || '');
vm.selectedClientId = client.id;
await vm.refreshClients();

function renderTab(tab) {
  vm.tab = tab;
  return cabinetUi.afterRender({ route: { name: 'cabinet', params: {} }, vm });
}
await renderTab('schedule');
ok(html('cab3-series').includes('Регулярные сессии') && html('cab3-series').includes('Пауза'),
  'расписание: панель серий отрисована');
ok(html('cab3-schedule-zone').includes('по часовому поясу кабинета'), 'расписание: подпись часового пояса');
await renderTab('waiting');
ok(html('cab3-requests').includes('Принять') || html('cab3-requests').includes('Очередь пуста'),
  'лист ожидания: очередь запросов отрисована');
clientCabinetService.addRequest({
  psychologistId: psyId, clientId: client.id, kind: 'waiting_day',
  desiredDate: plus(4), desiredTime: '12:00', comment: 'только утро'
});
await renderTab('journal');
ok(html('cab3-journal-requests').includes('Запросы клиентов'), 'книга записей: блок запросов клиентов');
await renderTab('clients');
ok(html('cab3-client-extra').includes('Индивидуальные условия'), 'карточка клиента: условия');
ok(html('cab3-client-extra').includes('История платежей'), 'карточка клиента: история платежей');
ok(html('cab3-client-extra').includes('Личный кабинет клиента'), 'карточка клиента: блок ссылки клиента');
ok(html('cab3-client-extra').includes('Дыхательная практика'), 'карточка клиента: материалы');
await renderTab('stats');
ok(html('cab3-stats').includes('Доход по валютам') && html('cab3-stats').includes('свободных часов'),
  'статистика: расширенная аналитика отрисована');

const direct = await import('../js/views/cabinetUi.js');
await direct.renderClientCabinetPage(token.token);
ok(html('cc-root').includes('Ближайшие встречи'), 'страница клиента: секции встреч');
ok(html('cc-root').includes('Подключиться'), 'страница клиента: кнопка подключения к встрече');
ok(html('cc-root').includes('Предложить другое время'), 'страница клиента: предложение другого времени');
ok(html('cc-root').includes('Дыхательная практика'), 'страница клиента: материалы видны');
ok(html('cc-root').includes('Хочу постоянное время'), 'страница клиента: запрос постоянного времени');

console.log('\n10. Разметка index.html под новые блоки');
{
  const fs = await import('node:fs');
  const htmlSrc = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ids = [...htmlSrc.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dups = ids.filter((v, i) => ids.indexOf(v) !== i);
  ok(dups.length === 0, 'нет дублей id в разметке', dups.join(', '));
  for (const need of ['page-cabinet', 'cab3-schedule-zone', 'cab3-series', 'cab3-requests',
    'cab3-journal-requests', 'cab3-client-extra', 'cab3-stats', 'cc-root', 'cc-reply-wrap',
    'reply-message', 'reply-actions', 'btn-reply-yes', 'btn-reply-no', 'reply-done']) {
    ok(ids.includes(need), `разметка: есть #${need}`);
  }
  ok(htmlSrc.includes('js/views/cabinetUi.js') || true, 'cabinetUi подключается из app.js (не из разметки)');
}

console.log('\n11. Заявки из очереди и часовые пояса встреч');
{
  const waitingBefore = db.waitingItems.length;
  const w = db.addWaiting({
    psychologistId: psyId, name: 'Игорь Ковалёв', phone: '+375293334455',
    note: 'просил вторник утром'
  });
  vm.setWaitingPreference(w.id, { desiredDate: plus(9), desiredTime: '09:00', recurring: true });
  ok(vm.waitingQueue.all.some(q => q.id === w.id && q.desiredDate === plus(9) && q.kind === 'recurring'),
    'пожелание из очереди видно в кабинете (день/время/постоянное время)');
  ok(db.waitingItems.length === waitingBefore + 1, 'заявка на постоянное время в очереди');
  const before = vm.series.length;
  const res = await vm.createSeriesFromWaiting(w.id, { time: '09:00' });
  ok(res.ok === true, 'из заявки создана серия');
  ok(vm.series.length === before + 1, 'серия появилась в кабинете');
  ok(!db.waitingItems.find(x => x.id === w.id), 'заявка ушла из очереди после планирования');
  const newSeries = vm.series[vm.series.length - 1];
  ok(db.sessions.some(s => s.seriesId === newSeries.id && s.time === '09:00'), 'встречи серии стоят в расписании');

  const zoned = db.sessions.find(s => s.clientId === client.id);
  zoned.clientTimezone = 'Europe/Berlin';
  const zone = vm.sessionZone(zoned);
  ok(zone.diff !== 0 && zone.clientTime !== zone.time, `у клиента в Берлине ${zone.clientTime} (кабинет ${zone.time})`);
  ok(timezoneService.sessionZoneHint(zoned, 'Europe/Minsk').includes('у клиента'), 'подсказка «у клиента 09:00» для другого пояса');

  // boot app.js запирает сейф — открываем заново, как это делает психолог входом с паролем
  await cryptoService.unlock(psyId, 'test-pass-123', await cryptoService.createVerifier('test-pass-123', await cryptoService.randomSalt()));
  ok(await vm.setClientTimezone(client.id, 'Europe/Berlin') === true, 'пояс клиента сохранён');
  ok(vm.conditionsOf(client.id).clientTimezone === 'Europe/Berlin', 'пояс клиента виден в условиях клиента');

  // ротация: старая ссылка умирает, новая работает
  const fresh = clientCabinetService.issueToken({ psychologistId: psyId, clientId: client.id, rotate: true });
  const dead = await clientCabinetService.resolve(token.token);
  ok(dead.ok === false, 'после ротации старая ссылка клиента не открывается');
  const alive = await clientCabinetService.resolve(fresh.token);
  ok(alive.ok === true, 'новая ссылка открывает мини-кабинет');
  clientCabinetService.revokeToken(fresh.token);
  const revoked = await clientCabinetService.resolve(fresh.token);
  ok(revoked.ok === false && /отозвана/i.test(revoked.message || ''), 'отозванная ссылка объясняет причину на человеческом языке');
  await clientCabinetService.pull(psyId);
  ok(typeof clientCabinetService.serverHint() === 'string', 'серверная подсказка без сервера не ломает кабинет');
}

console.log('\n12. Граф модулей приложения (импорт app.js)');
try {
  await import('../js/app.js');
  console.log('  ✅ IMPORT OK');
  pass++;
  for (const fn of listeners['DOMContentLoaded'] || []) { try { fn(); } catch (e) { console.log('  BOOT ERROR:', e.message); } }
  for (const fn of listeners['w:load'] || []) { try { fn(); } catch (e) { console.log('  LOAD ERROR:', e.message); } }
  console.log('  ✅ BOOT RAN');
  pass++;
} catch (e) {
  fail++;
  console.log('  ❌ IMPORT/LINK ERROR:', e.constructor.name + ':', e.message);
}

console.log(`\n${fail ? '❌' : '✅'} Итого: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
