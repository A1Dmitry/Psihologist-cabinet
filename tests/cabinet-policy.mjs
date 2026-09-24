#!/usr/bin/env node
/**
 * D1 — кабинет: особые дни, политика доступности, доступность услуги.
 *
 *   node tests/cabinet-policy.mjs
 *
 * Проверяет CabinetViewModel (без DOM и сети): формы сохраняют значения
 * в сущности с той же нормализацией, что сервер (числа, null-лимиты).
 */
import { db } from '../js/core/dbContext.js';
import { Psychologist, SessionSettings } from '../js/models/entities.js';
import { CabinetViewModel } from '../js/viewmodels/CabinetViewModel.js';

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const PSY = 'psy_cabpol_1';
for (const coll of ['psychologists', 'services', 'settings', 'sessions', 'scheduleBlocks', 'scheduleOverrides']) {
  db[coll] = (db[coll] || []).filter(x => (x.psychologistId || x.id) !== PSY);
}
db.psychologists.push(new Psychologist({
  id: PSY, fullName: 'CabPol Test', slug: 'cabpol-test', isActive: true, email: 'cabpol@example.invalid'
}));
db.settings.push(new SessionSettings({ psychologistId: PSY }));
db.setCurrentPsychologist(PSY);

const vm = new CabinetViewModel();
check('cabpol: psyId из текущей сессии', vm.psyId === PSY);

// --- особые дни ---
check('cabpol: без даты не сохраняет', vm.addOverride({ date: '' }) === false);
check('cabpol: мусорная дата не сохраняется', vm.addOverride({ date: 'xx' }) === false);
check('cabpol: закрытый день сохраняется',
  vm.addOverride({ date: '2026-12-25', isClosed: true, title: 'Рождество' }) === true);
check('cabpol: override в списке', vm.overrides.length === 1 && vm.overrides[0].isClosed === true);
check('cabpol: повтор по той же дате заменяет (unique)',
  vm.addOverride({ date: '2026-12-25', isClosed: false, openFrom: '12:00', openTo: '14:00', title: 'Короткий день' }) === true
  && vm.overrides.length === 1 && vm.overrides[0].isClosed === false);
const ovrId = vm.overrides[0].id;
vm.removeOverride(ovrId);
check('cabpol: удаление убирает из списка', vm.overrides.length === 0);

// --- политика (строки как из input) ---
vm.savePaymentSettings({
  paymentPolicy: 'none', depositPercent: '30', holdMinutes: '60',
  maxActiveUnpaidPerPhone: '1', maxBookingsPerDayPerPhone: '2', blockAfterNoShows: '2',
  reminderEnabled: true, reminderHoursBefore: '24', reminderSecondHoursBefore: '12',
  minNoticeMinutes: '120', maxAdvanceDays: '30', bufferBeforeMin: '10', bufferAfterMin: '15',
  slotIncrementMin: '15', maxBookingsPerDay: '4', maxBookingsPerWeek: ''
});
const st = vm.settings;
check('cabpol: notice числом', st.minNoticeMinutes === 120, String(st.minNoticeMinutes));
check('cabpol: горизонт числом', st.maxAdvanceDays === 30, String(st.maxAdvanceDays));
check('cabpol: буферы числами', st.bufferBeforeMin === 10 && st.bufferAfterMin === 15);
check('cabpol: инкремент числом', st.slotIncrementMin === 15, String(st.slotIncrementMin));
check('cabpol: дневной лимит числом', st.maxBookingsPerDay === 4, String(st.maxBookingsPerDay));
check('cabpol: пустой недельный лимит → null', st.maxBookingsPerWeek === null, String(st.maxBookingsPerWeek));

vm.savePaymentSettings({
  paymentPolicy: 'none', depositPercent: '30', holdMinutes: '60',
  maxActiveUnpaidPerPhone: '1', maxBookingsPerDayPerPhone: '2', blockAfterNoShows: '2',
  reminderEnabled: true, reminderHoursBefore: '24', reminderSecondHoursBefore: '12',
  minNoticeMinutes: '-5', maxAdvanceDays: '', bufferBeforeMin: 'x', bufferAfterMin: '',
  slotIncrementMin: '', maxBookingsPerDay: '', maxBookingsPerWeek: ''
});
const st2 = vm.settings;
check('cabpol: отрицательный notice → 0', st2.minNoticeMinutes === 0, String(st2.minNoticeMinutes));
check('cabpol: мусорный буфер → 0', st2.bufferBeforeMin === 0, String(st2.bufferBeforeMin));
check('cabpol: пустые лимиты → null',
  st2.maxAdvanceDays === null && st2.slotIncrementMin === null && st2.maxBookingsPerDay === null);

// --- доступность услуги ---
check('cabpol: услуга с доступностью добавляется', vm.addService({
  name: 'Только утро', price: 50, currency: 'BYN', duration: 60, format: 'offline',
  days: '1,2,3,4,5', start: '10:00', end: '12:00'
}) === true);
const created = vm.services.find(s => s.name === 'Только утро');
check('cabpol: дни нормализованы', JSON.stringify(created?.availability?.days) === '[1,2,3,4,5]', JSON.stringify(created?.availability));
check('cabpol: окно сохранено', created?.availability?.start === '10:00' && created?.availability?.end === '12:00');
check('cabpol: услуга без доступности → null', vm.addService({ name: 'Обычная', price: 10 }) === true
  && vm.services.find(s => s.name === 'Обычная')?.availability === null);

// --- cleanup ---
for (const coll of ['psychologists', 'services', 'settings', 'sessions', 'scheduleBlocks', 'scheduleOverrides']) {
  db[coll] = (db[coll] || []).filter(x => (x.psychologistId || x.id) !== PSY);
}
db.clearCurrentPsychologist();
db.saveChanges();

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exitCode = failed.length ? 1 : 0;
