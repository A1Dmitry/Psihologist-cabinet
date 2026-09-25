#!/usr/bin/env node
/**
 * tools/prod-probe/probe.mjs — READ-ONLY инспекция production Supabase.
 *
 *   node tools/prod-probe/probe.mjs            # отчёт в stdout
 *   node tools/prod-probe/probe.mjs --json     # только JSON (для машины)
 *
 * Зачем (issue #46, TASK 1 / 2 / 5):
 *   production-схему нельзя считать совпадающей с `supabase/schema.sql` «по
 *   presence кода в репозитории». Этот инструмент снимает фактическое состояние
 *   прода тем каналом, который доступен без секретов владельца: PostgREST +
 *   GoTrue с ПУБЛИЧНЫМ anon key (он и так опубликован в собранном сайте).
 *
 * Что именно различает инструмент (это и есть drift-детектор):
 *   200                  — объект читается анонимно (публичный контракт);
 *   42501 permission     — объект ЕСТЬ, anon-грант отозван (ожидаемо для PII);
 *   42703 column missing — таблица есть, КОЛОНКИ из репозитория нет → DRIFT;
 *   PGRST205             — объекта НЕТ в production schema → DRIFT;
 *   PGRST202/PGRST203    — RPC нет / несколько overload-сигнатур → DRIFT.
 *
 * Границы безопасности (Poka-Yoke):
 *   • только GET, кроме трёх вызовов RPC, которые НЕ ПИШУТ (обоснование ниже);
 *   • секретов не требует, не читает и не печатает (anon key — публичный);
 *   • OTP, токены, PII не выводятся.
 *
 * НЕ ПЫТАТЬСЯ «починить» прод этим инструментом: он только фиксирует факт.
 * Применение схемы — действие владельца (docs/OWNER-CHECKLIST-E2E.md).
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, APPLICATION_URL } from '../../js/services/supabaseConfig.js';

const JSON_ONLY = process.argv.includes('--json');
const results = [];
const startedAt = new Date().toISOString();

const log = (...a) => { if (!JSON_ONLY) console.log(...a); };
const brief = (v, n = 400) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Сетевой вызов. НЕ бросает исключений: сеть до прода может быть недоступна
 * (песочница исполнителя), и тогда отчёт обязан дойти до конца и честно
 * показать NETWORK_ERROR по каждому зонду, а не упасть на первом же.
 */
async function call(method, path, { body, auth = true } = {}) {
  const headers = {};
  if (auth) {
    headers.apikey = SUPABASE_ANON_KEY;
    headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  }
  if (body) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(SUPABASE_URL + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 0, text: String(e?.message || e), json: null, networkError: true };
  }
}

function rec(group, name, fact) {
  results.push({ group, name, ...fact });
  log(`${String(fact.verdict).padEnd(24)} ${group} :: ${name}${fact.detail ? `\n${' '.repeat(26)}${fact.detail}` : ''}`);
}

/** Классификация ответа PostgREST/GoTrue (см. шапку файла). */
function classify(r) {
  if (r.networkError) return { verdict: 'NETWORK_ERROR', code: '', status: 0, detail: brief(r.text, 260) };
  const code = r.json?.code || '';
  const msg = r.json?.message || '';
  let verdict = 'UNKNOWN';
  if (r.status === 200) verdict = Array.isArray(r.json) ? `READABLE(rows=${r.json.length})` : 'READABLE';
  else if (code === '42703' || /does not exist/.test(msg)) verdict = 'DRIFT: column missing';
  else if (code === 'PGRST205') verdict = 'DRIFT: object missing';
  else if (code === 'PGRST202') verdict = 'DRIFT: rpc missing';
  else if (code === 'PGRST203') verdict = 'DRIFT: rpc ambiguous';
  else if (code === 'PGRST204') verdict = 'DRIFT: column not in cache';
  else if (code === '42501' || /permission denied/i.test(msg)) verdict = 'EXISTS(denied for anon)';
  else if (r.status === 406 && code === 'PGRST116') verdict = 'EXISTS(empty)';
  else if (r.status === 404 && code === 'NOT_FOUND') verdict = 'NOT_DEPLOYED';
  else if (r.status === 401) verdict = 'DENIED(401)';
  return { verdict, code, status: r.status, detail: brief(msg || r.json?.hint || r.text, 260) };
}

/** GET-зонд объекта схемы: существование + наличие колонок из репозитория. */
async function probeObject(group, table, cols) {
  const r = await call('GET', `/rest/v1/${table}?select=${cols}&limit=1`);
  rec(group, `${table}(${cols})`, classify(r));
}

/* ════════════════════════════════════════════════════════════════════════════
 * A. Edge Functions (TASK 2) — задеплоены ли вообще
 * ══════════════════════════════════════════════════════════════════════════ */
for (const fn of ['auth-code', 'telegram-notify']) {
  try {
    // GET: у задеплоенной функции ответ приходит ОТ ФУНКЦИИ (405/400/200 +
    // её тело), у незадеплоенной — от gateway: 404 {"code":"NOT_FOUND"}.
    const r = await call('GET', `/functions/v1/${fn}`, { auth: false });
    const deployed = !(r.status === 404 && r.json?.code === 'NOT_FOUND');
    rec('A edge-functions', `GET /functions/v1/${fn}`, {
      verdict: r.networkError ? 'NETWORK_ERROR' : (deployed ? 'DEPLOYED' : 'NOT_DEPLOYED'),
      status: r.status, code: r.json?.code || '', detail: brief(r.text, 260)
    });
  } catch (e) {
    rec('A edge-functions', `GET /functions/v1/${fn}`, { verdict: 'NETWORK_ERROR', detail: brief(e) });
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * B. Инвентаризация production (TASK 1)
 * ══════════════════════════════════════════════════════════════════════════ */
try {
  const r = await call('GET', '/rest/v1/');
  const defs = Object.keys(r.json?.definitions || {}).sort();
  const rpcs = Object.keys(r.json?.paths || {})
    .filter(p => p.startsWith('/rpc/')).map(p => p.slice(5)).sort();
  rec('B inventory', 'GET /rest/v1/ (OpenAPI root)', {
    verdict: r.status === 200 ? `OK(tables/views=${defs.length}, rpc=${rpcs.length})` : `HTTP_${r.status}`,
    status: r.status,
    detail: `objects: ${defs.join(', ')}\n${' '.repeat(26)}rpc: ${rpcs.join(', ')}`
  });
} catch (e) {
  rec('B inventory', 'GET /rest/v1/', { verdict: 'NETWORK_ERROR', detail: brief(e) });
}

try {
  const r = await call('GET', '/auth/v1/settings');
  const j = r.json || {};
  rec('B inventory', 'GET /auth/v1/settings', {
    verdict: r.status === 200 ? 'OK' : `HTTP_${r.status}`,
    status: r.status,
    detail: brief(JSON.stringify({
      external_email: j.external?.email, external_google: j.external?.google,
      disable_signup: j.disable_signup, mailer_autoconfirm: j.mailer_autoconfirm,
      passkeys_enabled: j.passkeys_enabled, sms_provider: j.sms_provider
    }), 300)
  });
} catch (e) {
  rec('B inventory', 'GET /auth/v1/settings', { verdict: 'NETWORK_ERROR', detail: brief(e) });
}

/* ════════════════════════════════════════════════════════════════════════════
 * C. Drift по объектам схемы (TASK 1)
 * ══════════════════════════════════════════════════════════════════════════ */
const privateObjects = [
  // auth-контур (SR-004): без этих колонок auth-code работает в legacy-режиме
  ['auth_login_codes', 'id,issued_token_hash,issues,consumed_at'],
  // ownership: без owner_id привязка кабинета к auth.uid() невозможна
  ['psychologists', 'id,owner_id,is_active,key_verifier'],
  ['sessions', 'id,hold_expires_at,duration_min,client_timezone,client_utc_offset_min,payment_policy'],
  ['session_settings', 'psychologist_id,timezone,min_notice_minutes,max_advance_days,slot_increment_min,max_bookings_per_day,max_bookings_per_week'],
  ['schedule_overrides', 'id,date,is_closed,open_from,open_to'],
  ['client_risks', 'phone_key,blocked'],
  ['booking_attempts', 'id,phone_key,fingerprint,success,created_at'],
  ['services', 'id,psychologist_id,price,currency,payment_policy,deposit_percent,availability'],
  ['clients', 'id,consent,consent_at'],
  ['payments', 'id'],
  ['client_error_logs', 'id']
];
for (const [t, c] of privateObjects) await probeObject('C drift private', t, c);

const publicObjects = [
  ['public_profiles', 'id,slug,is_active'],
  ['public_settings', 'psychologist_id,timezone,min_notice_minutes,max_bookings_per_week'],
  ['public_booked_slots', 'psychologist_id,session_date,duration_min'],
  ['public_schedule_blocks', 'psychologist_id,date_from,date_to'],
  ['public_schedule_overrides', 'psychologist_id,date,is_closed']
];
for (const [t, c] of publicObjects) await probeObject('C drift public', t, c);

/**
 * RLS-контроль: таблицы, у которых anon-грант есть, но политик нет,
 * обязаны отдавать 0 строк (default deny). Любая строка — утечка.
 */
try {
  const r = await call('GET', '/rest/v1/auth_login_codes?select=id&limit=1');
  const rows = Array.isArray(r.json) ? r.json.length : -1;
  rec('C rls control', 'auth_login_codes rows visible to anon', {
    verdict: r.networkError ? 'NETWORK_ERROR' : (r.status === 200 && rows === 0 ? 'DENIED_BY_RLS(ok)' : `LEAK(rows=${rows})`),
    status: r.status, detail: brief(r.text, 200)
  });
} catch (e) {
  rec('C rls control', 'auth_login_codes', { verdict: 'NETWORK_ERROR', detail: brief(e) });
}

/* ════════════════════════════════════════════════════════════════════════════
 * D. RPC: существование, единственность сигнатуры, гранты (TASK 1 / 5)
 * ══════════════════════════════════════════════════════════════════════════ */
/**
 * Единственный POST, доходящий до тела функции, и он гарантированно не пишет:
 * дата в прошлом отклоняется на шаге 0 `create_booking` — до advisory lock,
 * до INSERT в clients/sessions и до booking_attempts.
 */
try {
  const r = await call('POST', '/rest/v1/rpc/create_booking', {
    body: { p_psychologist_id: '__probe__', p_session_date: '1900-01-01', p_session_time: '00:00' }
  });
  rec('D rpc', 'create_booking(past date) — server-side reject, no write', {
    verdict: r.status === 200 && r.json?.ok === false ? 'EXISTS + server validation' : classify(r).verdict,
    status: r.status, code: r.json?.code || '', detail: brief(JSON.stringify(r.json ?? r.text), 260)
  });
} catch (e) {
  rec('D rpc', 'create_booking', { verdict: 'NETWORK_ERROR', detail: brief(e) });
}

/**
 * Заведомо неизвестный аргумент: PostgREST отвечает PGRST202 и ПЕРЕЧИСЛЯЕТ
 * кандидатов — это фактический список overload-сигнатур в проде
 * (замена `select * from pg_proc`, которой у агента без секретов нет).
 */
for (const fn of ['create_booking', 'claim_psychologist_profile']) {
  try {
    const r = await call('POST', `/rest/v1/rpc/${fn}`, { body: { zz_probe_unknown_arg: 1 } });
    rec('D rpc', `${fn} — overload inventory (unknown arg)`, {
      ...classify(r),
      detail: brief(`${r.json?.message || ''} ${r.json?.hint || ''}`, 700)
    });
  } catch (e) {
    rec('D rpc', fn, { verdict: 'NETWORK_ERROR', detail: brief(e) });
  }
}

/**
 * claim_psychologist_profile без аргументов (все параметры имеют defaults).
 * Ожидание: 42501 — EXECUTE отозван у anon (schema.sql). Это одновременно
 * доказательство существования функции и отзыва гранта. Даже если грант
 * окажется выдан (drift), функция вернётся на `auth.uid() is null` без записи.
 */
try {
  const r = await call('POST', '/rest/v1/rpc/claim_psychologist_profile', { body: {} });
  rec('D rpc', 'claim_psychologist_profile — anon must be denied', {
    ...classify(r),
    detail: brief(r.json?.message || r.text, 260)
  });
} catch (e) {
  rec('D rpc', 'claim_psychologist_profile', { verdict: 'NETWORK_ERROR', detail: brief(e) });
}

/* ════════════════════════════════════════════════════════════════════════════
 * E. Публичный контракт жив (приложение действительно читает этот прод)
 * ══════════════════════════════════════════════════════════════════════════ */
try {
  const r = await call('GET', '/rest/v1/public_profiles?select=slug&is_active=eq.true&limit=200');
  const n = Array.isArray(r.json) ? r.json.length : -1;
  rec('E public contract', 'public_profiles is_active=true', {
    verdict: r.networkError ? 'NETWORK_ERROR' : (n >= 0 ? `OK(active=${n})` : `HTTP_${r.status}`),
    status: r.status, detail: brief(r.text, 200)
  });
} catch (e) {
  rec('E public contract', 'public_profiles', { verdict: 'NETWORK_ERROR', detail: brief(e) });
}

/* ════════════════════════════════════════════════════════════════════════════
 * Итог
 * ══════════════════════════════════════════════════════════════════════════ */
const drift = results.filter(r => String(r.verdict).startsWith('DRIFT') || r.verdict === 'NOT_DEPLOYED' || String(r.verdict).startsWith('LEAK'));
const report = {
  tool: 'tools/prod-probe/probe.mjs (read-only, anon key only)',
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  project_url: SUPABASE_URL,
  application_url: APPLICATION_URL,
  anon_key_fingerprint: `${SUPABASE_ANON_KEY.slice(0, 10)}…len=${SUPABASE_ANON_KEY.length}`,
  summary: {
    probes: results.length,
    drift_or_missing: drift.length,
    drift_items: drift.map(r => `${r.group} :: ${r.name} → ${r.verdict}`)
  },
  results
};

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n──── SUMMARY ────');
  console.log(`probes: ${report.summary.probes}, drift/missing: ${report.summary.drift_or_missing}`);
  for (const d of report.summary.drift_items) console.log(`  ${d}`);
}

// Отчёт — это диагностика, а не гейт сборки: выход всегда 0, чтобы read-only
// инспекция не красила CI. Строгость решает вызывающий (см. summary.drift_items).
process.exit(0);
