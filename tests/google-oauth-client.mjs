#!/usr/bin/env node
/**
 * Вход специалиста через Google: клиентский контракт (без обращений в сеть).
 *
 *   node tests/google-oauth-client.mjs
 *
 * Проверяется то, что нельзя проверить SQL-тестом:
 *   • redirect_to для GitHub Pages = origin + base path БЕЗ hash (иначе
 *     GoTrue допишет ?code= после # и Hash History сломается);
 *   • запуск входа уходит на /auth/v1/authorize с provider=google и PKCE;
 *   • возврат ?code= обменивается на сессию С code_verifier;
 *   • URL очищается, повторный reload не тратит одноразовый code повторно;
 *   • ?error=… превращается в понятное сообщение, токен не запрашивается;
 *   • в RPC привязки/создания кабинета НЕ передаётся email — identity
 *     определяется сервером по auth.uid();
 *   • не применённая миграция (PGRST202) даёт внятный «не настроено», а не
 *     «успешный вход»;
 *   • имя/email для UI берутся из auth/v1/user, а не из локального JWT.
 */
import assert from 'node:assert/strict';

const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

/* ——— окружение браузера (минимум, нужный сервису) ——— */
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear()
};

let currentHref = 'https://a1dmitry.github.io/Psihologist-cabinet/';
function setLocation(href) {
  const u = new URL(href);
  currentHref = href;
  globalThis.location = {
    href: u.href,
    origin: u.origin,
    hostname: u.hostname,
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
    assign: url => { assigned.push(url); }
  };
}
const assigned = [];
const replaced = [];
globalThis.history = {
  replaceState: (_s, _t, url) => { replaced.push(url); }
};

setLocation('https://a1dmitry.github.io/Psihologist-cabinet/');

/* ——— мок сети ——— */
const calls = [];
let tokenResponse = { ok: true, status: 200, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) };
let userResponse = {
  ok: true, status: 200,
  json: async () => ({
    id: 'uid-1',
    email: 'Anna@Example.com',
    email_confirmed_at: '2026-09-25T10:00:00Z',
    user_metadata: { full_name: 'Анна Пример', picture: 'https://pic' },
    identities: [{ provider: 'google', identity_data: { email: 'anna@example.com', email_verified: true, name: 'Анна Пример' } }]
  })
};
let rpcResponse = { ok: true, status: 200, json: async () => ([{ ok: true, code: 'created', id: 'psy_1', profile_completed: false }]) };
let rpcError = null;

/** ПостгREST-клиент читает content-type из res.headers — мок обязан его вернуть. */
const jsonHeaders = { get: () => 'application/json' };

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  calls.push({ url: u, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  if (u.includes('/auth/v1/token')) {
    if (!tokenResponse.ok) {
      const body = tokenResponse.bodyText || '{"error":"invalid_grant"}';
      return { ok: false, status: 400, headers: jsonHeaders, text: async () => body, json: async () => JSON.parse(body) };
    }
    return { ok: true, status: 200, headers: jsonHeaders, json: async () => tokenResponse.json ? await tokenResponse.json() : tokenResponse };
  }
  if (u.includes('/auth/v1/user')) {
    if (!userResponse.ok) return { ok: false, status: 401, headers: jsonHeaders, text: async () => 'unauthorized', json: async () => ({}) };
    return { ok: true, status: 200, headers: jsonHeaders, json: async () => (userResponse.json ? await userResponse.json() : userResponse) };
  }
  if (u.includes('/auth/v1/logout')) return { ok: true, status: 204, headers: jsonHeaders, json: async () => ({}) };
  if (u.includes('/rest/v1/rpc/')) {
    if (rpcError) {
      const e = new Error(rpcError);
      e.status = 0;
      throw e;
    }
    if (!rpcResponse.ok) {
      const body = rpcResponse.body || '{}';
      return { ok: false, status: rpcResponse.status || 404, headers: jsonHeaders, text: async () => body, json: async () => JSON.parse(body) };
    }
    return { ok: true, status: 200, headers: jsonHeaders, json: async () => (rpcResponse.json ? await rpcResponse.json() : rpcResponse) };
  }
  throw new Error('unexpected fetch: ' + u);
};

const { googleAuthService, googleOAuthRedirectUrl } = await import('../js/services/googleAuthService.js');
const { readPersistedSession } = await import('../js/services/supabaseApi.js');

try {
  /* ====================================================================
   * 1. redirect_to — origin + base path, БЕЗ hash
   * ================================================================== */
  setLocation('https://a1dmitry.github.io/Psihologist-cabinet/');
  const prodRedirect = googleOAuthRedirectUrl();
  check('GitHub Pages: redirect_to = https://a1dmitry.github.io/Psihologist-cabinet/',
    prodRedirect === 'https://a1dmitry.github.io/Psihologist-cabinet/', prodRedirect);
  check('redirect_to не содержит hash (иначе GoTrue допишет ?code= после #)',
    !prodRedirect.includes('#'));

  setLocation('https://a1dmitry.github.io/Psihologist-cabinet/#/cabinet');
  check('redirect_to не зависит от текущего hash-маршрута',
    googleOAuthRedirectUrl() === 'https://a1dmitry.github.io/Psihologist-cabinet/', googleOAuthRedirectUrl());

  setLocation('http://localhost:8765/');
  check('localhost: OAuth возвращается в тот же браузер → redirect_to = http://localhost:8765/',
    googleOAuthRedirectUrl() === 'http://localhost:8765/', googleOAuthRedirectUrl());

  setLocation('https://a1dmitry.github.io/Psihologist-cabinet/');

  /* ====================================================================
   * 2. Старт входа: authorize + PKCE
   * ================================================================== */
  assigned.length = 0;
  await googleAuthService.startGoogleSignIn({ returnTo: '#/cabinet' });
  check('старт входа уходит на внешний OAuth (location.assign)', assigned.length === 1);
  const authorizeUrl = new URL(assigned[0] || 'https://x/');
  check('endpoint = /auth/v1/authorize', authorizeUrl.pathname === '/auth/v1/authorize', authorizeUrl.pathname);
  check('provider = google', authorizeUrl.searchParams.get('provider') === 'google');
  check('redirect_to совпадает с базой приложения',
    authorizeUrl.searchParams.get('redirect_to') === 'https://a1dmitry.github.io/Psihologist-cabinet/');
  check('code_challenge_method = s256', authorizeUrl.searchParams.get('code_challenge_method') === 's256');
  const challenge = authorizeUrl.searchParams.get('code_challenge') || '';
  check('code_challenge передан (43+ символов base64url)',
    challenge.length >= 43 && /^[A-Za-z0-9_-]+$/.test(challenge), `len=${challenge.length}`);

  /* ====================================================================
   * 3. Возврат ?code= → обмен с code_verifier
   * ================================================================== */
  calls.length = 0;
  const callbackLoc = {
    href: 'https://a1dmitry.github.io/Psihologist-cabinet/?code=abc123',
    origin: 'https://a1dmitry.github.io',
    pathname: '/Psihologist-cabinet/',
    search: '?code=abc123',
    hash: ''
  };
  const res = await googleAuthService.consumeGoogleRedirect(callbackLoc);
  check('возврат ?code= → kind=session', res?.kind === 'session', JSON.stringify(res));
  const tokenCall = calls.find(c => c.url.includes('/auth/v1/token'));
  check('обмен выполняется через grant_type=pkce',
    !!tokenCall && tokenCall.url.includes('grant_type=pkce'), tokenCall?.url);
  check('в обмен отправлен auth_code', tokenCall?.body?.auth_code === 'abc123');
  const sentVerifier = tokenCall?.body?.code_verifier || '';
  check('в обмен отправлен code_verifier (иначе PKCE не завершится)', sentVerifier.length >= 43);
  check('code_verifier совпадает с сохранённым до редиректа (проверяем через challenge)',
    await sha256Base64Url(sentVerifier) === challenge);
  check('сессия сохранена', !!readPersistedSession()?.access_token);
  check('URL очищен от ?code= (reload не тратит одноразовый code)',
    replaced.some(u => !u.includes('code=')), replaced.join(' | '));
  check('после очистки сохранён путь GitHub Pages',
    replaced.some(u => u.startsWith('/Psihologist-cabinet/')), replaced.join(' | '));

  /* ====================================================================
   * 4. display-профиль из auth/v1/user (не из локального JWT)
   * ================================================================== */
  const user = googleAuthService.getCurrentUser();
  const userCall = calls.find(c => c.url.includes('/auth/v1/user'));
  check('профиль запрошен у GoTrue (auth/v1/user)', !!userCall);
  check('email для UI взят из ответа Auth, а не из формы', user?.email === 'anna@example.com', user?.email);
  check('имя для UI — из данных провайдера', user?.name === 'Анна Пример', user?.name);
  check('провайдер = google', user?.provider === 'google');

  /* ====================================================================
   * 5. ?error= → понятное сообщение, токен не запрашивается
   * ================================================================== */
  await googleAuthService.startGoogleSignIn({ returnTo: '#/cabinet' });
  calls.length = 0;
  const errLoc = {
    href: 'https://a1dmitry.github.io/Psihologist-cabinet/?error=access_denied&error_description=user+cancelled',
    origin: 'https://a1dmitry.github.io',
    pathname: '/Psihologist-cabinet/',
    search: '?error=access_denied&error_description=user+cancelled',
    hash: ''
  };
  const errRes = await googleAuthService.consumeGoogleRedirect(errLoc);
  check('?error= → kind=error', errRes?.kind === 'error', JSON.stringify(errRes));
  check('сообщение об отказе понятное и на русском',
    /отменён|доступ не выдан/i.test(String(errRes?.message || '')), errRes?.message);
  check('при ошибке обмен кода не выполняется',
    !calls.some(c => c.url.includes('/auth/v1/token')));

  /* ====================================================================
   * 6. Нет code / нет error → kind=none (обычная загрузка страницы)
   * ================================================================== */
  const noneRes = await googleAuthService.consumeGoogleRedirect({
    href: 'https://a1dmitry.github.io/Psihologist-cabinet/#/cabinet',
    pathname: '/Psihologist-cabinet/', search: '', hash: '#/cabinet'
  });
  check('обычная загрузка: kind=none, лишних запросов нет', noneRes?.kind === 'none');

  /* ====================================================================
   * 7. Потерянный verifier / чужой PKCE-код
   * ================================================================== */
  calls.length = 0;
  store.clear();
  store.set('psy_google_oauth_return_v1', '#/cabinet');
  const lostRes = await googleAuthService.consumeGoogleRedirect({
    href: 'https://a1dmitry.github.io/Psihologist-cabinet/?code=zzz',
    pathname: '/Psihologist-cabinet/', search: '?code=zzz', hash: ''
  });
  check('потерянный verifier при начатом Google-входе → missing_verifier',
    lostRes?.kind === 'error' && lostRes?.code === 'missing_verifier', JSON.stringify(lostRes));
  check('потерянный verifier: обмен не отправлен',
    !calls.some(c => c.url.includes('/auth/v1/token')));

  calls.length = 0;
  store.clear();
  const foreign = await googleAuthService.consumeGoogleRedirect({
    href: 'https://a1dmitry.github.io/Psihologist-cabinet/?code=from-email',
    pathname: '/Psihologist-cabinet/', search: '?code=from-email', hash: ''
  });
  check('?code= без начатого Google-входа не перехватывается (чужой PKCE/письмо)',
    foreign?.kind === 'none', JSON.stringify(foreign));
  check('чужой code не отправляется на обмен Google',
    !calls.some(c => c.url.includes('/auth/v1/token')));

  /* ====================================================================
   * 8. Привязка/создание кабинета: из браузера не уходит email
   * ================================================================== */
  calls.length = 0;
  rpcResponse = { ok: true, status: 200, json: async () => ([{ ok: true, code: 'created', id: 'psy_1', profile_completed: false }]) };
  const linked = await googleAuthService.linkOrCreateCabinet();
  check('RPC привязки: ok=true, profileCompleted=false → онбординг',
    linked?.ok === true && linked?.profileCompleted === false, JSON.stringify(linked));
  const linkCall = calls.find(c => c.url.includes('rpc/link_or_create_psychologist_for_google'));
  check('RPC привязки вызвана', !!linkCall);
  check('в RPC НЕ передан email (identity берётся из auth.uid() на сервере)',
    !JSON.stringify(linkCall?.body ?? {}).toLowerCase().includes('email'),
    JSON.stringify(linkCall?.body));
  check('в RPC НЕ передан owner_id',
    !JSON.stringify(linkCall?.body ?? {}).toLowerCase().includes('owner'));
  check('тело запроса пустое (аргументов у функции нет)',
    JSON.stringify(linkCall?.body) === '{}', JSON.stringify(linkCall?.body));

  /* ====================================================================
   * 9. Дули / занятая запись / отключённая → понятная ошибка + resolution
   * ================================================================== */
  const cases = [
    ['duplicate_email', /несколько записей/i],
    ['email_taken', /другой учётной записи/i],
    ['profile_inactive', /отключена/i],
    ['email_unconfirmed', /не подтверждён/i]
  ];
  for (const [code, re] of cases) {
    rpcResponse = { ok: true, status: 200, json: async () => ([{ ok: false, code, error: 'server text', resolution: 'Как разрешить: обратитесь к администратору.' }]) };
    const r = await googleAuthService.linkOrCreateCabinet();
    check(`код ${code}: ok=false и сообщение объясняет ситуацию`,
      r?.ok === false && re.test(String(r?.head || '')), r?.head);
    check(`код ${code}: есть подсказка, как разрешить`, /обратитесь|администратор/i.test(String(r?.resolution || '')));
  }

  /* ====================================================================
   * 10. Миграция не применена (PGRST202) → «не настроено», а не «вошли»
   * ================================================================== */
  rpcError = 'Supabase 404: {"code":"PGRST202","message":"Could not find the function public.link_or_create_psychologist_for_google()"}';
  const missing = await googleAuthService.linkOrCreateCabinet();
  check('PGRST202 → code=migration_missing', missing?.code === 'migration_missing', JSON.stringify(missing));
  check('PGRST202 → сообщение про неприменённую миграцию',
    /миграци/i.test(String(missing?.head || '')), missing?.head);
  rpcError = null;

  /* ====================================================================
   * 11. Онбординг: только поля существующей схемы
   * ================================================================== */
  calls.length = 0;
  rpcResponse = { ok: true, status: 200, json: async () => ([{ ok: true, code: 'completed', id: 'psy_1', profile_completed: true }]) };
  const saved = await googleAuthService.completeProfile({
    fullName: 'Анна Пример', phone: '+375291112233', specialization: 'Психолог',
    city: 'Минск', about: 'Работаю с тревогой'
  });
  check('онбординг: ok=true', saved?.ok === true, JSON.stringify(saved));
  const cpCall = calls.find(c => c.url.includes('rpc/complete_psychologist_profile'));
  check('онбординг: вызван complete_psychologist_profile', !!cpCall);
  const keys = Object.keys(cpCall?.body || {}).sort().join(',');
  check('онбординг: отправлены только 5 полей профиля',
    keys === 'p_about,p_city,p_full_name,p_phone,p_specialization', keys);
  check('онбординг: email/is_active/owner_id не отправляются',
    !/email|is_active|owner/i.test(keys));

  rpcResponse = { ok: true, status: 200, json: async () => ([{ ok: false, code: 'validation', error: 'Заполните поля' }]) };
  const badSave = await googleAuthService.completeProfile({ fullName: '', phone: '', specialization: '', city: '', about: '' });
  check('онбординг: пустая форма отклонена внятным сообщением',
    badSave?.ok === false && /Заполните/i.test(String(badSave?.message || '')), badSave?.message);

  /* ====================================================================
   * 12. Выход и восстановление отображения
   * ================================================================== */
  rpcResponse = { ok: true, status: 200, json: async () => ([{ ok: true, code: 'created', id: 'psy_1', profile_completed: false }]) };
  calls.length = 0;
  await googleAuthService.signOut();
  check('выход: вызван /auth/v1/logout', calls.some(c => c.url.includes('/auth/v1/logout')));
  check('выход: сохранённая сессия удалена', !readPersistedSession());
  check('выход: display-профиль очищен', googleAuthService.getCurrentUser() === null);

  userResponse = { ok: false, status: 401 };
  const after401 = await googleAuthService.refreshUser();
  check('401 от GoTrue → пользователь сбрасывается (нет «вошёл по кэшу»)', after401 === null);

  /* ====================================================================
   * 13. DOM-контракт: разметка и обработчики реально существуют
   *
   * Проверка слабее браузерного E2E, но ловит главную аварию —
   * расхождение id в index.html и селекторов в js/app.js. Браузерный E2E
   * отдельно: см. вывод набора и итоговый отчёт.
   * ================================================================== */
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

  const REQUIRED_IDS = [
    'btn-google-signin', 'btn-google-label', 'auth-google-status', 'auth-google-resolution',
    'page-onboarding', 'onb-form', 'onb-name', 'onb-phone', 'onb-spec', 'onb-city',
    'onb-about', 'onb-submit', 'onb-error', 'onb-email', 'onb-logout',
    'cab-account', 'cab-account-name', 'cab-account-email'
  ];
  const missingIds = REQUIRED_IDS.filter(id => !html.includes(`id="${id}"`));
  check('index.html содержит всю новую разметку (кнопка Google, онбординг, аккаунт)',
    missingIds.length === 0, missingIds.join(', '));

  const UNBOUND = [
    ["$('#btn-google-signin')?.addEventListener('click'", 'кнопка Google'],
    ["$('#onb-form')?.addEventListener('submit'", 'форма онбординга'],
    ["$('#onb-logout')?.addEventListener('click'", 'выход из онбординга']
  ];
  const unbound = UNBOUND.filter(([needle]) => !appSrc.includes(needle)).map(([, label]) => label);
  check('js/app.js навешивает обработчики на новые элементы', unbound.length === 0, unbound.join(', '));

  check('роутер знает маршрут onboarding',
    appSrc.includes("onboarding: () => '/onboarding'") && appSrc.includes("onboarding: 'page-onboarding'"));
  check('#/onboarding защищён: без сессии уводит на #/auth',
    /name === 'onboarding' && !googleAuthService\.hasSession\(\)/.test(appSrc));
  check('#/cabinet при незаполненном профиле уводит на онбординг',
    appSrc.includes('profileCompleted === false'));
  check('возврат Google обрабатывается, email-link психолога в boot отсутствует',
    appSrc.includes('consumeGoogleRedirect()') && !appSrc.includes('consumeAuthRedirect()'));

} catch (e) {
  console.error('FATAL', e);
  check('набор выполнен без исключения', false, String(e?.message || e));
}

/** S256 — та же формула, что в сервисе; нужен, чтобы сверить verifier↔challenge. */
async function sha256Base64Url(verifier) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

const f = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - f.length}/${results.length} проверок пройдено`);
if (f.length) console.log('Провалено:\n' + f.map(([n]) => '  - ' + n).join('\n'));
process.exit(f.length ? 1 : 0);
