// Telegram Mini App auth. Bot token and service-role key are server-only.
// `login` validates Telegram's signed initData, then issues a one-use Supabase
// magic-link token for the already-linked Auth user. `link` additionally
// requires the existing Supabase session and binds that account to Telegram.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

function reply(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), { status, headers: cors });
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)));
}

async function validateInitData(raw: string, botToken: string) {
  if (!raw || raw.length > 8192) throw new Error('Некорректные данные Telegram.');
  const params = new URLSearchParams(raw);
  const providedHash = (params.get('hash') || '').toLowerCase();
  if (!providedHash || !/^[a-f0-9]{64}$/.test(providedHash)) throw new Error('Некорректные данные Telegram.');
  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(authDate) || authDate > now + 30 || now - authDate > 600) {
    throw new Error('Срок подтверждения Telegram истёк. Закройте и заново откройте Mini App.');
  }

  const checkString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  // Telegram Web Apps: secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secret = await hmac(new TextEncoder().encode('WebAppData'), botToken);
  const expected = hex(await hmac(secret, checkString));
  let mismatch = expected.length ^ providedHash.length;
  for (let i = 0; i < Math.max(expected.length, providedHash.length); i++) {
    mismatch |= (expected.charCodeAt(i) || 0) ^ (providedHash.charCodeAt(i) || 0);
  }
  if (mismatch !== 0) throw new Error('Подпись Telegram не подтверждена.');

  let user: { id?: number; first_name?: string; last_name?: string; username?: string };
  try { user = JSON.parse(params.get('user') || 'null'); }
  catch { throw new Error('Не удалось прочитать пользователя Telegram.'); }
  if (!Number.isSafeInteger(user?.id) || Number(user.id) <= 0) throw new Error('В данных Telegram нет корректного ID пользователя.');
  const firstName = String(user.first_name || '').trim().slice(0, 100);
  const lastName = String(user.last_name || '').trim().slice(0, 100);
  const username = String(user.username || '').trim().slice(0, 64);
  return { id: String(user.id), firstName, lastName, username,
    fullName: [firstName, lastName].filter(Boolean).join(' ') || (username ? `@${username}` : `Telegram ${user.id}`) };
}

function serviceHeaders(serviceKey: string) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}


async function serviceRequest(baseUrl: string, serviceKey: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...serviceHeaders(serviceKey), ...(init.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  return payload;
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return reply(405, { ok: false, error: 'Метод не поддерживается.' });

  const baseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
  if (!baseUrl || !serviceKey || !botToken) {
    return reply(503, { ok: false, error: 'Telegram-вход не настроен на сервере.' });
  }

  try {
    const body = await request.json();
    const action = String(body?.action || '');
    if (!['login', 'link'].includes(action)) return reply(400, { ok: false, error: 'Неизвестное действие.' });
    const initData = String(body?.init_data || '');
    const telegram = await validateInitData(initData, botToken);

    let email = '';
    let isNewTelegramUser = false;

    if (action === 'link') {
      const bearer = request.headers.get('Authorization') || '';
      if (!bearer.startsWith('Bearer ')) return reply(401, { ok: false, error: 'Сначала войдите в свой кабинет.' });
      const currentUser = await fetch(`${baseUrl}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: bearer }
      }).then(async r => r.ok ? r.json() : null);
      if (!currentUser?.id) return reply(401, { ok: false, error: 'Сессия кабинета истекла. Войдите снова.' });

      const owners = await serviceRequest(baseUrl, serviceKey,
        `/rest/v1/psychologists?owner_id=eq.${encodeURIComponent(currentUser.id)}&select=id,is_active&limit=2`);
      if (!Array.isArray(owners) || owners.length !== 1 || owners[0].is_active !== true) {
        return reply(403, { ok: false, error: 'Для этой учётной записи не найден активный кабинет специалиста.' });
      }
      const byTelegram = await serviceRequest(baseUrl, serviceKey,
        `/rest/v1/psychologist_telegram_accounts?telegram_user_id=eq.${encodeURIComponent(telegram.id)}&select=auth_user_id&limit=2`);
      if (Array.isArray(byTelegram) && byTelegram.length) {
        return String(byTelegram[0].auth_user_id) === String(currentUser.id)
          ? reply(200, { ok: true, linked: true })
          : reply(409, { ok: false, error: 'Этот Telegram уже привязан к другой учётной записи.' });
      }
      const byOwner = await serviceRequest(baseUrl, serviceKey,
        `/rest/v1/psychologist_telegram_accounts?auth_user_id=eq.${encodeURIComponent(currentUser.id)}&select=telegram_user_id&limit=2`);
      if (Array.isArray(byOwner) && byOwner.length) {
        return reply(409, { ok: false, error: 'К этой учётной записи уже привязан другой Telegram.' });
      }
      const inserted = await fetch(`${baseUrl}/rest/v1/psychologist_telegram_accounts`, {
        method: 'POST',
        headers: { ...serviceHeaders(serviceKey), Prefer: 'return=minimal' },
        body: JSON.stringify({ telegram_user_id: telegram.id, auth_user_id: currentUser.id })
      });
      if (!inserted.ok) return reply(409, { ok: false, error: 'Не удалось привязать Telegram: связь уже может быть создана.' });
      return reply(200, { ok: true, linked: true });
    }

    const links = await serviceRequest(baseUrl, serviceKey,
      `/rest/v1/psychologist_telegram_accounts?telegram_user_id=eq.${encodeURIComponent(telegram.id)}&select=auth_user_id&limit=2`);
    let authUserId = Array.isArray(links) && links.length === 1 ? String(links[0].auth_user_id || '') : '';
    let authUser: Record<string, any> | null = null;

    if (!authUserId) {
      if (!body?.create_if_missing) return reply(200, { ok: true, needs_signup: true });
      // Self-registration is Telegram-only: no email is invented from a user
      // supplied field, and this reserved address can never receive mail.
      email = `telegram-${telegram.id}@telegram.invalid`;
      const created = await serviceRequest(baseUrl, serviceKey, '/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password: randomPassword(),
          email_confirm: true,
          user_metadata: {
            provider: 'telegram',
            telegram_user_id: telegram.id,
            full_name: telegram.fullName,
            name: telegram.fullName,
            given_name: telegram.firstName,
            family_name: telegram.lastName,
            telegram_username: telegram.username
          }
        })
      });
      authUser = created?.user || created;
      authUserId = String(authUser?.id || '');
      if (!authUserId) throw new Error('Supabase Auth did not return the new Telegram user.');
      isNewTelegramUser = true;

      const inserted = await fetch(`${baseUrl}/rest/v1/psychologist_telegram_accounts`, {
        method: 'POST',
        headers: { ...serviceHeaders(serviceKey), Prefer: 'return=minimal' },
        body: JSON.stringify({ telegram_user_id: telegram.id, auth_user_id: authUserId })
      });
      if (!inserted.ok) {
        // Concurrent launches: use the winner's mapping only; the unused Auth
        // account is not granted a cabinet and cannot take over that identity.
        const winner = await serviceRequest(baseUrl, serviceKey,
          `/rest/v1/psychologist_telegram_accounts?telegram_user_id=eq.${encodeURIComponent(telegram.id)}&select=auth_user_id&limit=1`);
        if (!Array.isArray(winner) || winner.length !== 1) throw new Error('Не удалось сохранить Telegram-привязку. Повторите запуск Mini App.');
        authUserId = String(winner[0].auth_user_id);
        isNewTelegramUser = authUserId === String(authUser?.id || '');
      }
    }

    if (!authUser) {
      const loaded = await serviceRequest(baseUrl, serviceKey, `/auth/v1/admin/users/${encodeURIComponent(authUserId)}`);
      authUser = loaded?.user || loaded;
    }
    email = String(authUser?.email || '').trim().toLowerCase();
    if (!email) return reply(403, { ok: false, error: 'У связанной учётной записи не найден email Supabase Auth.' });

    const profiles = await serviceRequest(baseUrl, serviceKey,
      `/rest/v1/psychologists?owner_id=eq.${encodeURIComponent(authUserId)}&select=id,is_active&limit=2`);
    if (Array.isArray(profiles) && profiles.length > 1) return reply(403, { ok: false, error: 'У аккаунта несколько кабинетов. Обратитесь к администратору.' });
    if (Array.isArray(profiles) && profiles.length === 1 && profiles[0].is_active !== true) {
      return reply(403, { ok: false, error: 'Доступ к кабинету отключён. Обратитесь к администратору.' });
    }
    if ((!Array.isArray(profiles) || profiles.length === 0)
        && String(authUser?.user_metadata?.telegram_user_id || '') !== telegram.id) {
      return reply(403, { ok: false, error: 'Для Telegram не найден кабинет. Войдите через его прежний способ и привяжите Telegram в профиле.' });
    }

    // InitData itself is a bearer credential until auth_date expires. Consume a
    // digest once so a captured payload cannot mint multiple Supabase sessions.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(initData)));
    const initDataHash = hex(digest);
    // Opportunistic retention cleanup; rows are short-lived and service-only.
    await serviceRequest(baseUrl, serviceKey,
      `/rest/v1/telegram_auth_replays?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
      { method: 'DELETE' });
    const replay = await fetch(`${baseUrl}/rest/v1/telegram_auth_replays`, {
      method: 'POST',
      headers: { ...serviceHeaders(serviceKey), Prefer: 'return=minimal' },
      body: JSON.stringify({ init_data_hash: initDataHash, expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() })
    });
    if (replay.status === 409) return reply(409, { ok: false, error: 'Эти данные Telegram уже использованы. Закройте и заново откройте Mini App.' });
    if (!replay.ok) throw new Error(`Could not consume Telegram initData (${replay.status})`);

    // Создаём одноразовый magic-link token, но не отправляем письмо. Его выдача
    // защищена проверенной подписью Telegram initData и одноразовым replay guard.
    const generated = await serviceRequest(baseUrl, serviceKey, '/auth/v1/admin/generate_link', {
      method: 'POST', body: JSON.stringify({ type: 'magiclink', email })
    });
    const tokenHash = String(generated?.properties?.hashed_token || generated?.hashed_token || '');
    if (!tokenHash) return reply(502, { ok: false, error: 'Не удалось выпустить одноразовый токен Supabase.' });
    return reply(200, { ok: true, token_hash: tokenHash, created: isNewTelegramUser });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ошибка Telegram-входа.';
    const expected = /Telegram|срок|подпись|пользователя|данных/.test(message);
    return reply(expected ? 401 : 500, { ok: false, error: message });
  }
});
