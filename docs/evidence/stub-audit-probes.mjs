/** Diagnostic reproduction of existing defects, NOT a product acceptance test.
 * Run: node docs/evidence/stub-audit-probes.mjs
 * Synthetic data only. Network is disabled before importing application modules.
 * Exit 0 means the documented defects were reproduced, NOT that the app is correct.
 */
import assert from 'node:assert/strict';
const memory = new Map();
globalThis.window = { localStorage: {
  getItem: k => memory.get(k) ?? null,
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: k => memory.delete(k)
} };
globalThis.fetch = async () => { throw new Error('NETWORK DISABLED: audit'); };
const { db } = await import('../../js/core/dbContext.js');
const { supabaseApi } = await import('../../js/services/supabaseApi.js');
const { ClientCabinetService } = await import('../../js/services/clientCabinetService.js');
const { cabinetApi } = await import('../../js/services/cabinetApi.js');
const { reminderService } = await import('../../js/services/reminderService.js');
const { SessionSeriesService } = await import('../../js/services/sessionSeriesService.js');
const { safeStorage } = await import('../../js/core/safeStorage.js');
let calls = 0;
supabaseApi.request = async () => { calls++; throw new Error('SIMULATED RPC FAILURE'); };
supabaseApi.hasSession = () => false;

const svc = new ClientCabinetService();
const req = svc.addRequest({ psychologistId: 'audit-psy', clientId: 'audit-client',
  kind: 'propose_time', desiredDate: '2030-01-01', desiredTime: '12:00', token: 'audit-token' });
assert.equal(req.ok, true);
await new Promise(resolve => setImmediate(resolve));
assert.equal(calls, 1);
assert.equal(svc.serverState.rpc, false);
assert.equal(svc.requestsOf('audit-psy').length, 1);
console.log('REPRODUCED: client request ok=true despite rejected RPC; local request persists');

calls = 0;
const result = cabinetApi.pushSessionPatch('audit-session', { status: 'cancelled' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(result, undefined);
assert.equal(calls, 0);
console.log('REPRODUCED: cabinet write with no session returns undefined; no request/no propagated failure');

const doc = svc.addDocument({ psychologistId: 'audit-psy', clientId: 'audit-client',
  title: 'Synthetic document', body: 'Synthetic content' });
assert.equal(doc.ok, true);
assert.equal(calls, 0);
svc.serverState.tokens = false;
const signed = svc.signDocument('arbitrary-token', doc.document.id);
assert.equal(signed.ok, true);
assert.ok(signed.document.signedAt);
assert.equal(calls, 0);
console.log('REPRODUCED: document created/signed locally with arbitrary token and no server call (NOT a live server exploit)');

svc.serverState.materials = false;
const mat = svc.addMaterial({ psychologistId: 'audit-psy', clientId: 'audit-client', title: 'Synthetic material' });
assert.equal(svc.markMaterialSeen('arbitrary-token', mat.material.id).ok, true);
assert.equal(calls, 0);
console.log('REPRODUCED: material read receipt accepts arbitrary token locally, without server');

const series = new SessionSeriesService();
assert.equal((await series.pull('audit-psy')).localOnly, true);
assert.equal((await series.pull('audit-psy', { force: true })).ok, true);
console.log('REPRODUCED: series pull without authenticated session returns ok=true/localOnly=true');

db.sessions = [{ id: 'audit-session', psychologistId: 'audit-psy', clientId: 'audit-client',
  date: '2030-01-01', time: '10:00' }];
db.clients = []; db.psychologists = []; db.reminders = [];
const rem = reminderService.notifyReschedule('audit-session', { newDate: '2030-01-02', newTime: '10:00' });
assert.equal(rem.ok, true);
assert.equal(rem.reminder.status, 'sent');
assert.equal(calls, 0);
console.log('REPRODUCED: reschedule notification marked sent without any transport/server call');

const snapshot = safeStorage.getJSON('psy_portal_cf_v5');
assert.equal(snapshot.sessions[0].id, 'audit-session');
assert.equal(snapshot.reminders[0].status, 'sent');
console.log('REPRODUCED: shared sessions/reminders persisted in browser snapshot');
console.log('7 diagnostic reproductions confirmed. No production requests. This is defect evidence, not PASS acceptance.');
