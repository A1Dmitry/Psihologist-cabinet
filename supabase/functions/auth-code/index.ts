// Edge Function: auth-code — вход специалиста по одноразовому коду (6–8 букв/цифр).
// Заменяет magic-link письма Supabase: код генерируем и проверяем МЫ (таблица
// auth_login_codes), письмо отправляем через Resend — шаблоны Supabase Auth
// не участвуют. Сессию получаем стандартно: admin generate_link (magiclink)
// → hashed_token → клиент POST /auth/v1/verify → JWT в браузере. Код одноразовый:
// после успешной проверки помечается used_at.
//
// Deploy:
//   supabase functions deploy auth-code
//   supabase secrets set RESEND_API_KEY=re_...          # обязательно
//   supabase secrets set MAIL_FROM="PsyПортал <код@ваш-домен>"   # опционально
//
//   POST /functions/v1/auth-code  { action: 'request', email }
//   POST /functions/v1/auth-code  { action: 'verify',  email, code }  → { hashed_token }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих I, O, 0, 1
const CODE_LEN = 8;          // 6–8 символов (требование: не менее 6, не более 8)
const TTL_MS = 2 * 60e3;     // окно ввода кода — 2 минуты
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30e3;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateCode() {
  const arr = crypto.getRandomValues(new Uint32Array(CODE_LEN));
  return [...arr].map(n => ALPHABET[n % ALPHABET.length]).join('');
}

const normEmail = (e) => String(e || '').toLowerCase().trim();
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const rest = (path, init = {}) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  const auth = (path, init = {}) => fetch(`${supabaseUrl}/auth/v1/${path}`, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });

  try {
    const { action, email: rawEmail, code: rawCode } = await req.json();
    const email = normEmail(rawEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ ok: false, error: 'Укажите корректный email' }, 400);

    // ——— Запрос кода: генерируем, храним хеш, шлём письмо ———
    if (action === 'request') {
      const latest = await (await rest(
        `auth_login_codes?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`
      )).json();
      if (latest[0] && Date.now() - new Date(latest[0].created_at).getTime() < RESEND_COOLDOWN_MS) {
        return json({ ok: false, error: 'Слишком часто: подождите около 30 секунд' }, 429);
      }

      const resendKey = Deno.env.get('RESEND_API_KEY');
      if (!resendKey) {
        return json({ ok: false, error: 'Почта не настроена: задайте секрет RESEND_API_KEY (supabase secrets set RESEND_API_KEY=re_...)' }, 500);
      }

      const code = generateCode();
      const codeHash = await sha256Hex(code + '|' + email);
      await rest('auth_login_codes?email=eq.' + encodeURIComponent(email), {
        method: 'DELETE' // старые неиспользованные коды этого email больше не действуют
      });
      const ins = await rest('auth_login_codes', {
        method: 'POST',
        body: JSON.stringify({
          email,
          code_hash: codeHash,
          expires_at: new Date(Date.now() + TTL_MS).toISOString()
        })
      });
      if (!ins.ok) return json({ ok: false, error: 'Не удалось сохранить код' }, 500);

      const from = Deno.env.get('MAIL_FROM') || 'PsyПортал <onboarding@resend.dev>';
      const mail = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: email,
          subject: `Код входа: ${code}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:480px">
            <h2 style="margin-bottom:8px">Код входа в кабинет</h2>
            <p style="font-size:15px;color:#334">Ваш код (действует 2 минуты):</p>
            <p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:12px 0">${code}</p>
            <p style="font-size:13px;color:#667">Введите его на странице входа. Никому не сообщайте код —
            даже поддержке. Если это были не вы, просто проигнорируйте письмо.</p>
          </div>`
        })
      });
      if (!mail.ok) {
        const t = await mail.text();
        return json({ ok: false, error: `Почтовый сервис отказал (${mail.status}). Проверьте RESEND_API_KEY и домен отправителя: ${t.slice(0, 200)}` }, 502);
      }
      return json({ ok: true, ttl_seconds: TTL_MS / 1000 });
    }

    // ——— Проверка кода: одноразовый, окно 2 минуты, max 5 попыток ———
    if (action === 'verify') {
      const code = normCode(rawCode);
      if (!/^[A-Z0-9]{6,8}$/.test(code)) return json({ ok: false, error: 'Код должен быть 6–8 букв и цифр' }, 400);

      const rows = await (await rest(
        `auth_login_codes?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`
      )).json();
      const row = rows[0];
      if (!row) return json({ ok: false, error: 'Код не запрошен — сначала получите письмо' }, 400);
      if (row.used_at) return json({ ok: false, error: 'Код уже использован — запросите новый' }, 400);
      if (row.attempts >= MAX_ATTEMPTS) return json({ ok: false, error: 'Слишком много попыток — запросите новый код' }, 400);
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return json({ ok: false, error: 'Код истёк (2 минуты) — запросите новый' }, 400);
      }

      if (await sha256Hex(code + '|' + email) !== row.code_hash) {
        await rest(`auth_login_codes?id=eq.${row.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ attempts: (row.attempts || 0) + 1 })
        });
        return json({ ok: false, error: 'Неверный код' }, 400);
      }

      // код принят: гасим его (одноразовость) и выдаём hashed_token для сессии
      await rest(`auth_login_codes?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });

      let link = await auth('admin/generate_link', {
        method: 'POST',
        body: JSON.stringify({ type: 'magiclink', email })
      }).then(r => r.json());
      if (link.error || !link.hashed_token) {
        // пользователя ещё нет в auth.users — создаём и повторяем
        await auth('admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) });
        link = await auth('admin/generate_link', {
          method: 'POST',
          body: JSON.stringify({ type: 'magiclink', email })
        }).then(r => r.json());
      }
      const hashedToken = link.hashed_token || /[?&]token_hash=([\w-]+)/.exec(link.action_link || '')?.[1];
      if (link.error || !hashedToken) {
        return json({ ok: false, error: 'Код верный, но сессия не создана: ' + (link.msg || link.error_description || link.error || 'generate_link') }, 500);
      }
      return json({ ok: true, hashed_token: hashedToken });
    }

    return json({ ok: false, error: 'Неизвестное действие' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
