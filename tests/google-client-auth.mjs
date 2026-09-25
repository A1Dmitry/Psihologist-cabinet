#!/usr/bin/env node
/**
 * Google client identity contract: GIS nonce → Supabase Auth session →
 * isolated booking Authorization header. No real Google/Supabase calls.
 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
globalThis.PSY_GOOGLE_CLIENT_ID = 'test-web-client.apps.googleusercontent.com';

const local = new Map();
const tab = new Map();
globalThis.localStorage = {
  getItem: key => local.has(key) ? local.get(key) : null,
  setItem: (key, value) => local.set(key, String(value)),
  removeItem: key => local.delete(key),
  clear: () => local.clear()
};
globalThis.sessionStorage = {
  getItem: key => tab.has(key) ? tab.get(key) : null,
  setItem: (key, value) => tab.set(key, String(value)),
  removeItem: key => tab.delete(key),
  clear: () => tab.clear()
};

const dispatches = [];
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
};
globalThis.dispatchEvent = event => dispatches.push(event);
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement: () => ({ addEventListener() {}, setAttribute() {} }),
  querySelector: () => null,
  getElementById: () => null,
  dispatchEvent: event => dispatches.push(event)
};

let authUser = {
  id: 'supabase-user-42',
  email: 'anna@example.com',
  email_confirmed_at: '2026-09-24T10:00:00.000Z',
  app_metadata: { provider: 'google', providers: ['google'] },
  user_metadata: { full_name: 'Anna Example', avatar_url: 'https://example.com/avatar.png' },
  identities: [{
    id: 'google-sub-42',
    provider: 'google',
    identity_data: {
      sub: 'google-sub-42', email: 'anna@example.com', email_verified: true,
      name: 'Anna Example', picture: 'https://example.com/avatar.png'
    }
  }]
};
let tokenExchangeStatus = 200;
let requestNumber = 0;
const requests = [];
const response = (body, status = 200, contentType = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => String(name).toLowerCase() === 'content-type' ? contentType : null },
  json: async () => body,
  text: async () => JSON.stringify(body)
});
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ url: u, method, headers: options.headers || {}, body });
  requestNumber++;

  if (u.includes('grant_type=id_token')) {
    if (tokenExchangeStatus !== 200) return response({ msg: 'Google token rejected' }, tokenExchangeStatus);
    return response({
      access_token: 'supabase-client-access-1',
      refresh_token: 'supabase-client-refresh-1',
      expires_in: 3600,
      token_type: 'bearer',
      user: authUser
    });
  }
  if (u.includes('grant_type=refresh_token')) {
    return response({
      access_token: 'supabase-client-access-refreshed',
      refresh_token: 'supabase-client-refresh-2',
      expires_in: 3600,
      token_type: 'bearer',
      user: authUser
    });
  }
  if (u.endsWith('/auth/v1/user')) return response(authUser);
  if (u.includes('/auth/v1/logout')) return response(null, 204, '');
  if (u.includes('/rest/v1/rpc/create_booking')) return response([{ ok: true, session_id: 'ses-1' }]);
  return response({ msg: `Unexpected URL ${u}` }, 500);
};

let gisConfig = null;
let buttonRenderCount = 0;
let promptCount = 0;
let disableAutoSelectCount = 0;
globalThis.google = {
  accounts: {
    id: {
      initialize: config => { gisConfig = config; },
      renderButton: (container, options) => { assert.ok(container); assert.equal(options.text, 'continue_with'); buttonRenderCount++; },
      prompt: callback => { promptCount++; callback?.({ isNotDisplayed: () => false, isSkippedMoment: () => false }); },
      cancel() {},
      disableAutoSelect() { disableAutoSelectCount++; }
    }
  }
};

const { googleClientAuthService } = await import('../js/services/googleClientAuthService.js');
const { supabaseApi, setAuthToken } = await import('../js/services/supabaseApi.js');
const { SUPABASE_ANON_KEY } = await import('../js/services/supabaseConfig.js');

const checks = [];
function check(name, condition, detail = '') {
  const passed = !!condition;
  checks.push(passed);
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed || !detail ? '' : ` → ${detail}`}`);
}

check('Google + Supabase client auth reports configured', googleClientAuthService.isConfigured());
const rendered = await googleClientAuthService.renderGoogleButton({}, {
  onSuccess: result => { globalThis.lastGoogleResult = result; },
  onError: error => { globalThis.lastGoogleError = error; }
});
check('GIS standard button renders', rendered && buttonRenderCount === 1);
check('One Tap is not auto-prompted', promptCount === 0);
check('GIS nonce is a 64-character SHA-256 hex value', /^[0-9a-f]{64}$/.test(gisConfig?.nonce || ''), gisConfig?.nonce);
await googleClientAuthService.promptOneTap();
check('One Tap is available only after explicit method call', promptCount === 1);

await gisConfig.callback({ credential: 'raw-google-id-token-never-persist-this' });
const exchange = requests.find(r => r.url.includes('grant_type=id_token'));
const submittedRawNonce = exchange?.body?.nonce || '';
const nonceDigest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(submittedRawNonce));
const expectedHashedNonce = Array.from(new Uint8Array(nonceDigest), b => b.toString(16).padStart(2, '0')).join('');
check('GIS ID token is exchanged directly with Supabase Auth',
  exchange?.body?.provider === 'google' && exchange?.body?.id_token === 'raw-google-id-token-never-persist-this');
check('raw nonce goes to Supabase; GIS receives the matching hash',
  !!submittedRawNonce && expectedHashedNonce === gisConfig?.nonce);
check('verified Google identity is returned from the Supabase user response',
  globalThis.lastGoogleResult?.user?.google_id === 'google-sub-42' &&
  globalThis.lastGoogleResult?.user?.email === 'anna@example.com' &&
  globalThis.lastGoogleResult?.user?.email_verified === true);
check('user_authenticated event exposes profile, not credentials',
  dispatches.some(event => event.type === 'user_authenticated' && event.detail?.google_id === 'google-sub-42') &&
  !('access_token' in (dispatches.find(event => event.type === 'user_authenticated')?.detail || {})));
check('Google ID token is not persisted in browser storage',
  ![...local.values(), ...tab.values()].some(value => String(value).includes('raw-google-id-token-never-persist-this')));
check('local profile cache is display-only and omits Google subject',
  JSON.parse(local.get('psihologist_client_auth') || '{}').email === 'anna@example.com' &&
  !('google_id' in JSON.parse(local.get('psihologist_client_auth') || '{}')));

const verifiedSession = await googleClientAuthService.getVerifiedSession();
const userRequest = requests.filter(r => r.url.endsWith('/auth/v1/user')).at(-1);
check('restored/current session is revalidated with GoTrue',
  verifiedSession?.user?.auth_user_id === 'supabase-user-42' &&
  userRequest?.headers?.Authorization === 'Bearer supabase-client-access-1');
const exchangeCountBeforeReplay = requests.filter(r => r.url.includes('grant_type=id_token')).length;
await gisConfig.callback({ credential: 'raw-google-id-token-never-persist-this' });
check('a consumed GIS callback cannot replay the Google ID token',
  requests.filter(r => r.url.includes('grant_type=id_token')).length === exchangeCountBeforeReplay);

googleClientAuthService.clearLocalSession();
tab.set('psy_client_google_session_v1', JSON.stringify({
  access_token: 'expired-client-access', refresh_token: 'usable-client-refresh',
  expires_at: 1, token_type: 'bearer'
}));
const refreshedSession = await googleClientAuthService.getVerifiedSession();
const refreshRequest = requests.find(r => r.url.includes('grant_type=refresh_token'));
check('expired client session refreshes through GoTrue without psychologist state',
  refreshedSession?.session?.access_token === 'supabase-client-access-refreshed' &&
  refreshRequest?.body?.refresh_token === 'usable-client-refresh');

const sessionStorageBeforeLogout = tab.get('psy_client_google_session_v1') || '';
check('client session is stored separately in tab-scoped storage',
  sessionStorageBeforeLogout.includes('supabase-client-access-refreshed') &&
  !local.has('psy_auth_session_v1'));
await googleClientAuthService.logout();
check('client logout clears only client session and profile',
  !tab.has('psy_client_google_session_v1') && !local.has('psihologist_client_auth') && disableAutoSelectCount === 1);

// Reject unverified Google email even if an ID-token exchange returned a session.
authUser = {
  ...authUser,
  email_confirmed_at: null,
  identities: [{ ...authUser.identities[0], identity_data: { ...authUser.identities[0].identity_data, email_verified: false } }],
  user_metadata: { ...authUser.user_metadata, email_verified: false }
};
await googleClientAuthService.renderGoogleButton({}, {
  onSuccess: result => { globalThis.unverifiedResult = result; },
  onError: error => { globalThis.unverifiedError = error; }
});
await gisConfig.callback({ credential: 'unverified-google-id-token' });
check('unverified Google email is rejected after Supabase exchange',
  !globalThis.unverifiedResult && /не подтвердил email/.test(globalThis.unverifiedError?.message || ''));
check('rejected identity does not leave a client session', !tab.has('psy_client_google_session_v1'));

tokenExchangeStatus = 401;
await googleClientAuthService.renderGoogleButton({}, {
  onSuccess: result => { globalThis.invalidTokenResult = result; },
  onError: error => { globalThis.invalidTokenError = error; }
});
await gisConfig.callback({ credential: 'invalid-google-id-token' });
check('GoTrue rejection of an invalid Google token leaves no session',
  !globalThis.invalidTokenResult && /Google token rejected/.test(globalThis.invalidTokenError?.message || '') &&
  !tab.has('psy_client_google_session_v1'));

tokenExchangeStatus = 200;

// A psychologist token must never leak into the public booking RPC.
const rpcRequestsBefore = requests.length;
setAuthToken('psychologist-otp-access-token');
await supabaseApi.createBooking({ p_session_note: '' });
const guestRpc = requests.slice(rpcRequestsBefore).find(r => r.url.includes('/rest/v1/rpc/create_booking'));
check('guest booking uses anon Authorization even with psychologist login active',
  guestRpc?.headers?.Authorization === `Bearer ${SUPABASE_ANON_KEY}`);
await supabaseApi.createBooking({ p_session_note: 'triage' }, { accessToken: 'explicit-client-google-access-token' });
const clientRpc = requests.filter(r => r.url.includes('/rest/v1/rpc/create_booking')).at(-1);
check('triage booking uses its explicit client Google session',
  clientRpc?.headers?.Authorization === 'Bearer explicit-client-google-access-token');
setAuthToken(null);

const failed = checks.filter(value => !value).length;
console.log(failed ? `\n${failed} FAILED (${checks.length - failed}/${checks.length} passed)` : `\nALL PASS (${checks.length}/${checks.length})`);
process.exit(failed ? 1 : 0);
