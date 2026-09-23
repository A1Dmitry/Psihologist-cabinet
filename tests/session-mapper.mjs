#!/usr/bin/env node
/**
 * Канонический маппер сессий (фаза 6).
 *
 *   node tests/session-mapper.mjs
 *
 * Проверяет js/services/sessionMapper.js — единственное преобразование
 * «строка БД ↔ доменная Session». До аудита такой маппер был продублирован
 * (cabinetApi + clientCabinetService), и расхождение полей означало, что
 * кабинет и мини-кабинет клиента по-разному понимали одну и ту же запись.
 */
import { sessionFromRow, sessionToRow } from '../js/services/sessionMapper.js';
import { DEFAULT_DURATION_MIN, resolveDurationMinutes } from '../js/domain/duration.js';
import { Session } from '../js/models/entities.js';

const results = [];
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` → получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`}`);
};
const ok = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const ROW = {
  id: 'ses_1',
  psychologist_id: 'psy_1',
  client_id: 'cli_1',
  service_id: 'svc_1',
  session_date: '2026-10-05',
  session_time: '17:00',
  status: 'confirmed',
  note: 'Запрос клиента: прошу вечером',
  video_platform: 'google_meet',
  meet_link: 'https://meet.google.example/abc',
  payment_policy: 'deposit',
  payment_status: 'deposit_paid',
  amount_due: '120.00',
  amount_paid: '40.00',
  currency: 'BYN',
  hold_expires_at: '2026-10-05T15:00:00Z',
  requires_payment: true,
  client_response: 'confirmed',
  client_responded_at: '2026-09-30T10:00:00Z',
  pending_change: { date: '2026-10-12', time: '18:00', reason: 'командировка' },
  previous_slot: { date: '2026-10-05', time: '17:00' },
  change_consent_status: 'pending',
  google_event_id: 'gcal_1',
  client_timezone: 'Asia/Tashkent',
  client_utc_offset_min: 300,
  duration_min: 90,
  created_at: '2026-09-20T09:00:00Z'
};

/* ——— DB → domain ——— */
const s = sessionFromRow(ROW);
ok('возвращает доменную Session', s instanceof Session);
eq('основные поля', [s.id, s.psychologistId, s.clientId, s.serviceId, s.date, s.time, s.status],
  ['ses_1', 'psy_1', 'cli_1', 'svc_1', '2026-10-05', '17:00', 'confirmed']);
eq('numeric приводится к числу (Postgres отдаёт numeric строкой)',
  [s.amountDue, s.amountPaid], [120, 40]);
eq('пояс клиента: IANA', s.clientTimezone, 'Asia/Tashkent');
eq('пояс клиента: снимок смещения', s.clientUtcOffsetMin, 300);
eq('снимок длительности из строки', s.durationMin, 90);
eq('вложенные jsonb сохраняются как есть', s.pendingChange, ROW.pending_change);
eq('предыдущий слот сохраняется', s.previousSlot, ROW.previous_slot);

/* ——— duration: канонический приоритет источников ——— */
eq('нет снимка → длительность услуги',
  sessionFromRow({ ...ROW, duration_min: null }, { service: { duration: 45 } }).durationMin, 45);
eq('нет снимка и услуги → шаг сетки',
  sessionFromRow({ ...ROW, duration_min: null }, { slotStepMin: 30 }).durationMin, 30);
eq('нет ничего → канонический дефолт',
  sessionFromRow({ ...ROW, duration_min: null }).durationMin, DEFAULT_DURATION_MIN);
eq('снимок важнее услуги (историческая корректность)',
  sessionFromRow(ROW, { service: { duration: 60 } }).durationMin, 90);
eq('резолвер и маппер согласованы',
  s.durationMin, resolveDurationMinutes({ durationMin: ROW.duration_min, service: { duration: 60 } }));

/* ——— domain → DB ——— */
const back = sessionToRow(s);
eq('обратный маппинг: имена колонок', Object.keys(back).sort(), [
  'amount_due', 'amount_paid', 'change_consent_status', 'client_response', 'client_responded_at',
  'client_timezone', 'client_utc_offset_min', 'currency', 'duration_min', 'google_event_id',
  'hold_expires_at', 'meet_link', 'note', 'payment_policy', 'payment_status', 'pending_change',
  'previous_slot', 'requires_payment', 'session_date', 'session_time', 'status', 'video_platform'
].sort());
eq('round-trip: дата/время/статус', [back.session_date, back.session_time, back.status],
  [ROW.session_date, ROW.session_time, ROW.status]);
eq('round-trip: пояс клиента не теряется',
  [back.client_timezone, back.client_utc_offset_min], [ROW.client_timezone, ROW.client_utc_offset_min]);
eq('round-trip: снимок длительности не теряется', back.duration_min, 90);
eq('round-trip: jsonb не теряется', back.pending_change, ROW.pending_change);
ok('несовместимого поля timezone_offset в строке нет', !('timezone_offset' in back));

/* ——— Пустые/частичные строки (публичный view отдаёт не всё) ——— */
const partial = sessionFromRow({ id: 'ses_2', psychologist_id: 'psy_1', session_date: '2026-10-06', session_time: '10:00' });
eq('частичная строка: дефолты', [partial.status, partial.currency, partial.clientTimezone, partial.durationMin],
  ['pending', 'BYN', '', DEFAULT_DURATION_MIN]);
eq('null-строка → null (а не падение)', sessionFromRow(null), null);
eq('обратный маппинг без optional-полей не роняет null в NOT NULL колонки',
  sessionToRow(new Session({ date: '2026-10-06', time: '10:00' })).note, '');

const failed = results.filter(r => !r[1]).length;
console.log(failed ? `\n${failed} FAILED` : `\nALL PASS (${results.length})`);
process.exit(failed ? 1 : 0);
