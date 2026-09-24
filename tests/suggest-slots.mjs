#!/usr/bin/env node
/**
 * D1 — suggestSlots (перенос «предложить другое время») на каноническом engine.
 *
 *   node tests/suggest-slots.mjs
 *
 * До D1 здесь был второй калькулятор доступности (точное совпадение времени,
 * без duration/buffers/policy). Регресс фиксирует: перенос считает тем же
 * engine, что публичная запись.
 */
import { db } from '../js/core/dbContext.js';
import { Psychologist, Service, SessionSettings, Session } from '../js/models/entities.js';
import { suggestSlots } from '../js/services/clientCabinetService.js';

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

// --- фикстура: кабинет UTC, все дни, окно 10:00–14:00, шаг 60 ---
const PSY = 'psy_suggest_1';
db.psychologists = db.psychologists.filter(p => p.id !== PSY);
db.services = db.services.filter(s => s.psychologistId !== PSY);
db.settings = db.settings.filter(s => s.psychologistId !== PSY);
db.sessions = db.sessions.filter(s => s.psychologistId !== PSY);
db.scheduleBlocks = db.scheduleBlocks.filter(b => b.psychologistId !== PSY);
db.scheduleOverrides = (db.scheduleOverrides || []).filter(o => o.psychologistId !== PSY);

db.psychologists.push(new Psychologist({
  id: PSY, fullName: 'Suggest Test', slug: 'suggest-test', isActive: true, email: 'suggest@example.invalid'
}));
db.settings.push(new SessionSettings({
  psychologistId: PSY, timezone: 'UTC', workDays: [1, 2, 3, 4, 5, 6, 7],
  slotStart: '10:00', slotEnd: '14:00', slotStepMin: 60
}));
const svc = new Service({ id: 'svc_suggest_90', psychologistId: PSY, name: 'S90', duration: 90 });
db.services.push(svc);

const dstr = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + n); return dstr(t); };
const D1 = plusDays(3);
const D2 = plusDays(4);

// Занято: D1 11:00–12:00 (60 мин)
db.sessions.push(new Session({
  id: 'ses_suggest_1', psychologistId: PSY, clientId: 'cli_x', serviceId: svc.id,
  date: D1, time: '11:00', durationMin: 60, status: 'confirmed'
}));

// D2 — закрытый override
db.addScheduleOverride({ psychologistId: PSY, date: D2, isClosed: true, title: 'Отпуск' });

// --- 60-мин предложения ---
const s60 = suggestSlots({ psychologistId: PSY, days: 6, limit: 50, durationMin: 60 });
const onD1 = s60.filter(s => s.date === D1).map(s => s.time);
check('suggest: D1 содержит 10:00', onD1.includes('10:00'), onD1.join(','));
check('suggest: D1 не содержит занятые 11:00', !onD1.includes('11:00'), onD1.join(','));
check('suggest: D1 содержит 12:00 (касание границы)', onD1.includes('12:00'), onD1.join(','));
check('suggest: закрытый D2 исключён', !s60.some(s => s.date === D2), s60.filter(s => s.date === D2).length);

// --- 90-мин предложения учитывают длительность ---
const s90 = suggestSlots({ psychologistId: PSY, days: 6, limit: 50, durationMin: 90 });
const onD1_90 = s90.filter(s => s.date === D1).map(s => s.time);
check('suggest: 90 мин в 10:00 пересекает 11:00 → исключено', !onD1_90.includes('10:00'), onD1_90.join(','));
check('suggest: 90 мин в 12:00 свободно → есть', onD1_90.includes('12:00'), onD1_90.join(','));
// windowEnd = max(last(13:00)+60, 14:00) = 14:00; 13:00+90=14:30 > 14:00 → исключено:
check('suggest: 90 мин в 13:00 (конец 14:30 > 14:00) → исключено', !onD1_90.includes('13:00'), onD1_90.join(','));

// --- лимит выдачи ---
const sLim = suggestSlots({ psychologistId: PSY, days: 6, limit: 3, durationMin: 60 });
check('suggest: limit=3 → ровно 3', sLim.length === 3, String(sLim.length));

// --- буферы из настроек учитываются ---
const st = db.settingsOf(PSY);
st.bufferAfterMin = 60;
const sBuf = suggestSlots({ psychologistId: PSY, days: 6, limit: 50, durationMin: 60 });
const onD1buf = sBuf.filter(s => s.date === D1).map(s => s.time);
check('suggest: buffer_after 60 закрывает 12:00 после 11:00–12:00', !onD1buf.includes('12:00'), onD1buf.join(','));
check('suggest: buffer_after 60 оставляет 13:00', onD1buf.includes('13:00'), onD1buf.join(','));
st.bufferAfterMin = 0;

// --- прошлое не предлагается ---
const sPast = suggestSlots({ psychologistId: PSY, days: 1, limit: 50, durationMin: 60 });
const todayUtc = dstr(new Date());
const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
const badPast = sPast.filter(s => s.date === todayUtc && s.time < `${String(Math.floor(nowMin / 60)).padStart(2, '0')}:${String(nowMin % 60).padStart(2, '0')}`);
check('suggest: прошлое сегодня не предлагается', badPast.length === 0, badPast.map(s => s.time).join(','));

// --- cleanup ---
db.psychologists = db.psychologists.filter(p => p.id !== PSY);
db.services = db.services.filter(s => s.psychologistId !== PSY);
db.settings = db.settings.filter(s => s.psychologistId !== PSY);
db.sessions = db.sessions.filter(s => s.psychologistId !== PSY);
db.scheduleBlocks = db.scheduleBlocks.filter(b => b.psychologistId !== PSY);
db.scheduleOverrides = (db.scheduleOverrides || []).filter(o => o.psychologistId !== PSY);
db.saveChanges();

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exitCode = failed.length ? 1 : 0;
