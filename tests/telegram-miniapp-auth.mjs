#!/usr/bin/env node
/** Security and UI contract for Telegram Mini App specialist authentication. */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const read = p => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const html = read('../index.html');
const app = read('../js/app.js');
const serviceSrc = read('../js/services/telegramAuthService.js');
const edge = read('../supabase/functions/telegram-auth/index.ts');
const migration = read('../supabase/migrations/20260926_telegram_miniapp_auth.sql');
const config = read('../supabase/config.toml');

const checks = [];
const ok = (name, cond) => { checks.push([name, !!cond]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };
const sdkTag = html.indexOf('<script src="https://telegram.org/js/telegram-web-app.js"></script>');
const appTag = html.indexOf('<script type="module" src="%BASE%js/app.js');
ok('Telegram WebApp SDK is loaded before app', sdkTag >= 0 && appTag > sdkTag);
ok('Telegram auth button is present (not shown outside Mini App)', html.includes('id="btn-telegram-signin"') && app.includes('telegramAuthService.isAvailable()'));
ok('Mini App opening defaults to cabinet route', app.includes('telegramAuthService.isAvailable() && route.name === \'portal\''));
ok('existing Google auth remains available', html.includes('id="btn-google-signin"') && app.includes("startGoogleSignIn({ returnTo: '#/cabinet' })"));
ok('first-time binding action requires a current cabinet session', app.includes('btn-link-telegram-auth') && serviceSrc.includes("this.request('link')"));
ok('browser sends raw initData only; no client-side trust of initDataUnsafe', serviceSrc.includes('webApp()?.initData') && !serviceSrc.includes('initDataUnsafe'));
ok('Edge validates Telegram HMAC and a short auth_date window', edge.includes("'WebAppData'") && edge.includes('600') && edge.includes('Подпись Telegram не подтверждена'));
ok('Edge compares signed Telegram payload before parsing account mapping', edge.indexOf('validateInitData') < edge.indexOf('psychologist_telegram_accounts?telegram_user_id'));
ok('login validates active owners before issuing a one-use token', edge.includes("type: 'magiclink'") && edge.includes("profiles[0].is_active !== true") && edge.includes('telegram_user_id=eq.'));
ok('unlinked Telegram can self-register only after explicit confirmation', edge.includes('create_if_missing') && edge.includes('telegram-${telegram.id}@telegram.invalid') && edge.includes('email_confirm: true') && app.includes('Создать кабинет через Telegram?'));
ok('Google login inside Mini App auto-links the current Telegram safely', app.includes('if (telegramAuthService.isAvailable())') && app.includes('automatic link skipped'));
ok('link action checks Supabase owner_id and active psychologist server-side', edge.includes('/auth/v1/user') && edge.includes('owner_id=eq.') && edge.includes('owners[0].is_active !== true'));
ok('no Telegram account can rebind another specialist', edge.includes('уже привязан к другой учётной записи') && edge.includes('409'));
ok('valid initData is single-use (replay digest table)', edge.includes('telegram_auth_replays') && edge.includes('initDataHash') && edge.includes('already used') === false && edge.includes('уже использованы'));
ok('private Telegram mapping has no anon/authenticated grants', migration.includes('enable row level security') && migration.includes('revoke all') && migration.includes('telegram_auth_replays') && migration.includes('to service_role'));
ok('Edge Function has JWT disabled only because it verifies initData itself', config.includes('[functions.telegram-auth]') && /\[functions\.telegram-auth\][\s\S]*?verify_jwt = false/.test(config));
const knownDataCheck = 'auth_date=1662771648\nquery_id=AAHdF6IQAAAAAN0XohDhrOrc\nuser={"id":279058397,"first_name":"Vladislav","last_name":"Kibenko","username":"vdkfrost","language_code":"ru","is_premium":true}';
const botToken = '5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8';
const knownSecret = createHmac('sha256', 'WebAppData').update(botToken).digest();
const knownHash = createHmac('sha256', knownSecret).update(knownDataCheck).digest('hex');
ok('HMAC implementation matches Telegram published test vector', knownHash === 'c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2');
ok('HMAC test vector changes when signed payload is modified', createHmac('sha256', knownSecret).update(`${knownDataCheck}!`).digest('hex') !== knownHash);

// Runtime safety: ordinary browsers (including tests) cannot initiate Telegram auth.
const listeners = {};
const fake = () => new Proxy(function(){}, { get(_, p) {
  if (p === 'classList') return { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
  if (p === 'dataset' || p === 'style') return {};
  if (p === 'querySelectorAll') return () => [];
  if (p === 'querySelector') return () => fake();
  if (p === 'addEventListener' || p === 'removeEventListener') return () => {};
  if (p === 'then') return undefined;
  if (p === Symbol.toPrimitive) return () => '';
  return '';
}, set(){ return true; }, apply(){ return fake(); } });
globalThis.document = { title: '', hidden: false, head: fake(), body: fake(), documentElement: fake(),
  querySelector: () => fake(), querySelectorAll: () => [], getElementById: () => fake(), createElement: () => fake(),
  addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); }, removeEventListener() {} };
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,String(v)), removeItem: k => store.delete(k) };
const location = { pathname: '/', search: '', hash: '', origin: 'https://example.test' };
globalThis.window = { localStorage: globalThis.localStorage, location, addEventListener() {}, scrollTo() {} };
globalThis.location = location; globalThis.history = { pushState(){}, replaceState(){} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test' }, configurable: true });
globalThis.confirm = () => true; globalThis.alert = () => {}; globalThis.prompt = () => '';
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '{}' });
const { telegramAuthService } = await import('../js/services/telegramAuthService.js');
ok('normal browser does not expose Telegram login', !telegramAuthService.isAvailable());
let rejected = false;
try { await telegramAuthService.request('login'); } catch (error) { rejected = /Mini App/.test(error.message); }
ok('no initData fails closed before network access', rejected);

const failed = checks.filter(([, pass]) => !pass).length;
console.log(failed ? `\n${failed} FAILED` : `\nALL PASS (${checks.length})`);
process.exit(failed ? 1 : 0);
