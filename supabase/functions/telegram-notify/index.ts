// Edge Function: telegram-notify — мгновенные Telegram-уведомления с публичной
// страницы записи. Токен бота НИКОГДА не попадает на клиент: функция читает его
// из session_settings сервисным ключом (service_role), отправляет сообщение и
// двигает watermark last_notified_session_at, чтобы outbox в кабинете
// не продублировал уведомление.
//
// Deploy:
//   supabase functions deploy telegram-notify --project-ref <ref>
//   (env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — выставляются автоматически)
//
// Вызов с сайта (см. js/services/supabaseConfig.js → NOTIFY_WEBHOOK_URL):
//   POST /functions/v1/telegram-notify
//   { "psychologist_id": "...", "event": "booking" | "payment",
//     "text": "<html-текст>", "session_created_at": "ISO..." | null }

// CORS-контракт — тот же канонический список Supabase, что и в auth-code
// (https://supabase.com/docs/guides/functions/cors). Расхождение между
// функциями дало бы «работает вход, но не работает уведомление» (или наоборот)
// с одинаковой консольной ошибкой; равенство списков запинировано в
// tests/cors-contract.mjs.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors });
  }

  try {
    const { psychologist_id, event, text, session_created_at } = await req.json();
    if (!psychologist_id || !text) {
      return new Response(JSON.stringify({ error: 'psychologist_id and text required' }), { status: 400, headers: cors });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const headers = {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json'
    };

    // настройки психолога: токен бота, чат, переключатели событий
    const stRes = await fetch(
      `${supabaseUrl}/rest/v1/session_settings?psychologist_id=eq.${encodeURIComponent(psychologist_id)}&select=*`,
      { headers }
    );
    const settings = (await stRes.json())[0];
    if (!settings?.telegram_bot_token || !settings?.telegram_chat_id) {
      return new Response(JSON.stringify({ ok: false, reason: 'not-configured' }), { headers: cors });
    }
    const flagByEvent = { booking: settings.telegram_notify_booking, payment: settings.telegram_notify_payments };
    if (event in flagByEvent && flagByEvent[event] === false) {
      return new Response(JSON.stringify({ ok: false, reason: 'disabled' }), { headers: cors });
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.telegram_chat_id,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const tg = await tgRes.json();

    // watermark: outbox в кабинете не пришлёт это уведомление повторно
    if (tg?.ok && session_created_at) {
      await fetch(`${supabaseUrl}/rest/v1/session_settings?psychologist_id=eq.${encodeURIComponent(psychologist_id)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ last_notified_session_at: session_created_at })
      });
    }

    return new Response(JSON.stringify({ ok: !!tg?.ok, description: tg?.description }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
  }
});
