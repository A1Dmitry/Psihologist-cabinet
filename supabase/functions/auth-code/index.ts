// Edge Function: auth-code — вход специалиста по одноразовому коду (6–8 букв/цифр).
// Заменяет magic-link письма Supabase: код генерируем и проверяем МЫ (таблица
// auth_login_codes), письмо отправляем через Resend — шаблоны Supabase Auth
// не участвуют. Сессию получаем стандартно: admin generate_link (magiclink)
// → hashed_token → клиент POST /auth/v1/verify → JWT в браузере.
//
// Одноразовость (issue #14, п.4): код гасится (used_at) ТОЛЬКО после того, как
// сессия реально создана. Раньше порядок был обратным: used_at ставился до
// admin/generate_link, и временный отказ Auth сжигал верный код — пользователь
// оставался и без кода, и без сессии. Теперь:
//   1) атомарный захват строки кода (условный UPDATE по issued_token_hash) —
//      из двух параллельных verify выигрывает ровно один;
//   2) создание сессии в Supabase Auth;
//   3) успех → used_at + отметка выпущенного токена; отказ Auth → компенсация
//      (строка возвращается в исходное состояние, код можно ввести снова);
//   4) клиент, обменяв токен на JWT, шлёт redeem → consumed_at: после этого
//      перевыпуск (recover) невозможен, replay закрыт окончательно.
//
// Состояния строки auth_login_codes:
//   issued_token_hash = null  → код не выпущен (verify может его захватить);
//   issued_token_hash = claim → идёт выпуск сессии (захвачен одним запросом);
//   issued_token_hash = hash  → токен выпущен, браузер его ещё не обменял
//                               (recover может перевыпустить, пока TTL жив);
//   consumed_at ≠ null        → браузер получил JWT, код израсходован навсегда.
//
// Deploy:
//   supabase functions deploy auth-code
//   supabase secrets set RESEND_API_KEY=re_...          # обязательно
//   supabase secrets set MAIL_FROM="PsyПортал <код@ваш-домен>"   # опционально
//
//   POST /functions/v1/auth-code  { action: 'request', email }
//   POST /functions/v1/auth-code  { action: 'verify',  email, code }        → { hashed_token, code_id }
//   POST /functions/v1/auth-code  { action: 'recover', email, code_id }     → { hashed_token, code_id }
//   POST /functions/v1/auth-code  { action: 'redeem',  email, code_id, hashed_token }
//
// Схема: нужны колонки auth_login_codes.issued_token_hash / issues /
// consumed_at (см. supabase/schema.sql, SR-004). Если в проде их ещё нет,
// функция не падает, а работает по прежнему порядку (код гасится до выдачи
// сессии) с компенсацией при отказе Auth и явной подсказкой переприменить
// schema.sql — без новых колонок атомарный захват и recover недоступны.

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
const MAX_ISSUES = 3;        // сколько раз можно выпустить сессию по одному коду
const MISSING_COLUMN_HINT =
  'Схема БД устарела: нет колонки auth_login_codes.issued_token_hash — ' +
  'перепримените supabase/schema.sql (SR-004), одноразовость кода без неё не гарантируется';

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

/** Случайный id (uuid, если доступен; иначе криптостойкая замена той же длины). */
function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
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

  /**
   * Условный UPDATE с Prefer: return=representation.
   * Возвращает обновлённую строку либо null, если ни одна строка не подошла
   * под условие — на этом и держится атомарность захвата кода.
   */
  const patchCode = async (query, body) => {
    const res = await rest(`auth_login_codes?${query}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { error: data?.message || data?.hint || `HTTP ${res.status}`, code: data?.code || '' };
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    return { row: rows[0] || null };
  };

  const latestCodeFor = async (email) => {
    const res = await rest(`auth_login_codes?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`);
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows[0] : null;
  };

  /** Общий входной контроль кода: существует, не использован, попытки, TTL. */
  const checkCodeUsable = (row) => {
    if (!row) return { ok: false, error: 'Код не запрошен — сначала получите письмо' };
    if (row.used_at) return { ok: false, error: 'Код уже использован — запросите новый' };
    if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Слишком много попыток — запросите новый код' };
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { ok: false, error: 'Код истёк (2 минуты) — запросите новый' };
    }
    return { ok: true };
  };

  /** Отказ PostgREST из-за отсутствующей колонки (схема БД не переприменена). */
  const isMissingColumnError = (msg = '') => /issued_token_hash|consumed_at|column|42703|PGRST204/i.test(msg);

  /**
   * Атомарно захватить код под выпуск сессии (условный UPDATE = compare-and-swap).
   *
   * `expect` — значение issued_token_hash, которое мы ожидаем увидеть:
   *   null            → код ещё не выпускался (первый verify);
   *   '<хеш токена>'  → токен выпущен, но браузер его не обменял (recover).
   * Пока строка захвачена (в колонке лежит наш claimId), параллельный запрос
   * условие не выполнит и сессию не получит; компенсация снимается только
   * по своему claimId, поэтому чужой захват не отбирается.
   */
  const claimCodeForIssue = async (row, expect = null) => {
    const claimId = randomId();
    const expectFilter = expect === null
      ? 'issued_token_hash=is.null'
      : `issued_token_hash=eq.${expect}`;
    const claimed = await patchCode(
      `id=eq.${row.id}&${expectFilter}&expires_at=gt.${new Date().toISOString()}`,
      { issued_token_hash: claimId }
    );
    if (claimed.error) return { error: claimed.error, missingColumn: isMissingColumnError(claimed.error) };
    if (!claimed.row) return { error: 'Код уже используется другим запросом или истёк — запросите новый' };
    // claimed.row — строка ПОСЛЕ захвата: счётчик выпусков берём из неё,
    // иначе параллельные запросы писали бы issues из устаревшего снимка.
    return { claimId, row: claimed.row };
  };

  /** Создать пользователя (если нужно) и получить hashed_token magic-link. */
  const issueSessionToken = async (email) => {
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
      return { error: link.msg || link.error_description || link.error || 'generate_link' };
    }
    return { hashedToken };
  };

  /** Компенсация: вернуть код в состояние «не выпущен» (только по своему claimId). */
  const releaseClaim = (id, claimId) =>
    patchCode(`id=eq.${id}&issued_token_hash=eq.${claimId}`, { issued_token_hash: null });

  /**
   * Выпустить сессию по уже захваченному коду и погасить код атомарно.
   * Используется и первым verify, и recover — одна реализация на оба пути.
   */
  const issueAndConsume = async (claimedRow, claimId, email) => {
    const issued = await issueSessionToken(email);
    if (issued.error) {
      // Временный отказ Auth: код НЕ сожжён, пользователь может ввести его снова.
      await releaseClaim(claimedRow.id, claimId);
      return {
        ok: false,
        status: 502,
        error: 'Код верный, но сессия не создана: ' + issued.error
          + '. Код не израсходован — попробуйте ещё раз или запросите новый.'
      };
    }
    const tokenHash = await sha256Hex(issued.hashedToken);
    const consumed = await patchCode(
      `id=eq.${claimedRow.id}&issued_token_hash=eq.${claimId}`,
      {
        used_at: new Date().toISOString(),
        issued_token_hash: tokenHash,
        issues: (claimedRow.issues || 1) + 1
      }
    );
    if (consumed.error) return { ok: false, status: 500, error: consumed.error };
    if (!consumed.row) {
      // Кто-то успел погасить код раньше нас: токен не отдаём (replay protection).
      return { ok: false, status: 409, error: 'Код уже использован — запросите новый' };
    }
    return { ok: true, hashedToken: issued.hashedToken };
  };

  /**
   * Запасной путь для БД без колонок SR-004 (схема не переприменена).
   * Атомарного захвата нет, поэтому одноразовость обеспечивается прежним
   * способом — used_at до выдачи сессии, — но с компенсацией: если Auth
   * отказал, отметка снимается и код не потерян. Ответ содержит явную
   * подсказку переприменить schema.sql и не содержит code_id (recover
   * без новых колонок невозможен).
   */
  const legacyIssueSession = async (row, email) => {
    const marked = await patchCode(`id=eq.${row.id}&used_at=is.null`, { used_at: new Date().toISOString() });
    if (marked.error) return { ok: false, status: 500, error: 'Не удалось сохранить код: ' + marked.error };
    if (!marked.row) return { ok: false, status: 409, error: 'Код уже использован — запросите новый' };

    const issued = await issueSessionToken(email);
    if (issued.error) {
      await patchCode(`id=eq.${row.id}`, { used_at: null }); // компенсация: код не сожжён
      return {
        ok: false,
        status: 502,
        error: 'Код верный, но сессия не создана: ' + issued.error
          + '. Код не израсходован — попробуйте ещё раз. ' + MISSING_COLUMN_HINT
      };
    }
    return { ok: true, hashedToken: issued.hashedToken };
  };

  try {
    const { action, email: rawEmail, code: rawCode, code_id: rawCodeId, hashed_token: rawToken } = await req.json();
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

      const row = await latestCodeFor(email);
      const usable = checkCodeUsable(row);
      if (!usable.ok) return json({ ok: false, error: usable.error }, 400);

      if (await sha256Hex(code + '|' + email) !== row.code_hash) {
        await rest(`auth_login_codes?id=eq.${row.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ attempts: (row.attempts || 0) + 1 })
        });
        return json({ ok: false, error: 'Неверный код' }, 400);
      }

      // Код верный. Сначала атомарный захват, потом сессия, потом погашение.
      const claim = await claimCodeForIssue(row);
      if (claim.missingColumn) {
        // В БД нет колонок SR-004 — работаем по прежней схеме, но честно об этом говорим.
        const legacy = await legacyIssueSession(row, email);
        if (!legacy.ok) return json({ ok: false, error: legacy.error }, legacy.status);
        return json({ ok: true, hashed_token: legacy.hashedToken, legacy_schema: true });
      }
      if (claim.error) return json({ ok: false, error: claim.error }, 409);

      const issued = await issueAndConsume(claim.row, claim.claimId, email);
      if (!issued.ok) return json({ ok: false, error: issued.error }, issued.status);
      return json({ ok: true, hashed_token: issued.hashedToken, code_id: row.id });
    }

    // ——— Восстановление сессии по уже подтверждённому коду ———
    // Сценарий: код погашен, но hashed_token не дошёл до браузера (обрыв сети,
    // перезагрузка) или GoTrue отказал в момент обмена. Секрет здесь — code_id:
    // он выдаётся только тому, кто код подтвердил, и работает лишь внутри TTL.
    if (action === 'recover') {
      const codeId = String(rawCodeId || '').trim();
      // id кода — uuid из БД; формат жёстко не фиксируем, важнее совпадение со строкой
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(codeId)) return json({ ok: false, error: 'Не указан идентификатор подтверждения' }, 400);

      const row = await latestCodeFor(email);
      if (!row || String(row.id) !== codeId) return json({ ok: false, error: 'Подтверждение не найдено — запросите новый код' }, 400);
      if (row.consumed_at) return json({ ok: false, error: 'Код уже использован — запросите новый' }, 400);
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return json({ ok: false, error: 'Окно ввода кода истекло (2 минуты) — запросите новый код' }, 400);
      }
      if (!row.issued_token_hash) {
        return json({ ok: false, error: 'Код ещё не подтверждён — введите код из письма' }, 400);
      }
      if (row.issues >= MAX_ISSUES) {
        return json({ ok: false, error: 'Слишком много попыток получить сессию — запросите новый код' }, 400);
      }

      // Захватываем по текущему хешу: токен уже выпускался, но браузер его
      // не обменял (consumed_at пуст) — значит сессии ещё ни у кого нет.
      const claim = await claimCodeForIssue(row, row.issued_token_hash);
      if (claim.missingColumn) return json({ ok: false, error: MISSING_COLUMN_HINT }, 500);
      if (claim.error) return json({ ok: false, error: claim.error }, 409);

      const issued = await issueAndConsume(claim.row, claim.claimId, email);
      if (!issued.ok) return json({ ok: false, error: issued.error }, issued.status);
      return json({ ok: true, hashed_token: issued.hashedToken, code_id: row.id });
    }

    // ——— Подтверждение получения сессии браузером ———
    // Клиент вызывает redeem сразу после успешного обмена hashed_token на JWT.
    // consumed_at закрывает перевыпуск (recover) — без этого в пределах TTL
    // токен можно было бы запросить повторно, то есть получить вторую сессию
    // на один код. Проверка по хешу токена: отметить израсходованным может
    // только тот, кто токен действительно получил.
    if (action === 'redeem') {
      const codeId = String(rawCodeId || '').trim();
      const token = String(rawToken || '').trim();
      if (!codeId || !token) return json({ ok: false, error: 'Не указаны данные подтверждения' }, 400);

      const row = await latestCodeFor(email);
      if (!row || String(row.id) !== codeId) return json({ ok: false, error: 'Подтверждение не найдено' }, 400);
      if (row.consumed_at) return json({ ok: true, already: true });
      if (!row.issued_token_hash || row.issued_token_hash !== await sha256Hex(token)) {
        return json({ ok: false, error: 'Токен не соответствует выпущенному' }, 400);
      }
      const redeemed = await patchCode(
        `id=eq.${row.id}&consumed_at=is.null`,
        { consumed_at: new Date().toISOString() }
      );
      if (redeemed.error) {
        if (isMissingColumnError(redeemed.error)) {
          return json({ ok: false, error: MISSING_COLUMN_HINT }, 500);
        }
        return json({ ok: false, error: redeemed.error }, 500);
      }
      return json({ ok: true, consumed: !!redeemed.row });
    }

    return json({ ok: false, error: 'Неизвестное действие' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
