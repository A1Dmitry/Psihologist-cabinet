#!/usr/bin/env node
/**
 * Production E2E проверки регистрации — запуск С МАШИНЫ ВЛАДЕЛЬЦА.
 *
 *   node tools/prod-e2e.mjs                    # шаг 1: только диагностика сервера (письма не шлёт)
 *   node tools/prod-e2e.mjs --email test@example.com
 *                                              # шаг 2: полный E2E реальной регистрации.
 *                                              # ТРЕБУЕТСЯ доступ к почтовому ящику этого email:
 *                                              # скрипт попросит ввести код из письма.
 *
 * Зачем: из песочницы агента нет сети до supabase.co (issue #14, п.1–2),
 * поэтому реальный сценарий «новый email → письмо → код → Auth → claim →
 * кабинет → reload» выполняет владелец этой командой. Скрипт использует
 * НАСТОЯЩИЕ модули приложения (js/domain/registration.js → supabaseApi)
 * и настоящий production-контур. Секретов не требует: anon key публичный.
 *
 * Безопасность: код из письма и access token НЕ печатаются; вывод можно
 * целиком вставлять в issue #14 (уберите только email, если он приватный).
 *
 * Требования: Node.js ≥ 18, интернет. Тестовый email лучше одноразовый:
 * сценарий создаёт РЕАЛЬНЫЙ профиль психолога (SQL для очистки печатается
 * в конце; повторный запуск по тому же email дубль не создаёт).
 */

/* ——— Заглушки браузерного окружения (та же модель, что в tests/*.mjs) ——— */
function fakeEl() {
  const t = function () {};
  return new Proxy(t, {
    get(_, p) {
      if (p === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      if (p === 'style' || p === 'dataset') return {};
      if (['value', 'textContent', 'innerHTML', 'src', 'href', 'id', 'className'].includes(p)) return '';
      if (['querySelectorAll', 'addEventListener', 'removeEventListener', 'appendChild', 'setAttribute', 'scrollIntoView', 'remove'].includes(p)) return () => [];
      if (p === 'querySelector') return () => fakeEl();
      if (p === 'getAttribute') return () => null;
      if (p === 'closest') return () => null;
      if (p === Symbol.toPrimitive) return () => '';
      return fakeEl();
    },
    set() { return true; },
    apply() { return fakeEl(); }
  });
}
const lsMap = new Map();
globalThis.localStorage = {
  getItem: k => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: k => lsMap.delete(k),
  clear: () => lsMap.clear()
};
const loc = { pathname: '/', search: '', hash: '', origin: 'https://prod-e2e' };
globalThis.document = {
  title: '', head: fakeEl(), body: fakeEl(), documentElement: fakeEl(), hidden: false,
  querySelector: () => fakeEl(), querySelectorAll: () => [], getElementById: () => fakeEl(),
  createElement: () => fakeEl(), addEventListener: () => {}, removeEventListener: () => {}
};
globalThis.window = new Proxy(
  { localStorage: globalThis.localStorage, addEventListener: () => {}, scrollTo: () => {}, location: loc },
  { get: (t, p) => (p in t ? t[p] : fakeEl()), set: () => true }
);
globalThis.location = loc;
globalThis.history = { pushState() {}, replaceState() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'prod-e2e', clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.prompt = () => 'x';

if (typeof fetch !== 'function' || typeof crypto === 'undefined') {
  console.error('Нужен Node.js ≥ 18 (global fetch + WebCrypto).');
  process.exit(2);
}

/* ——— Аргументы ——— */
const argv = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const EMAIL = arg('email').toLowerCase().trim();
const PROFILE = {
  fullName: arg('name', 'E2E Smoke Тест'),
  phone: arg('phone', '+375 00 000-00-00'),
  specialization: arg('spec', 'Психолог (E2E-проверка)'),
  city: arg('city', 'Минск'),
  about: arg('about', 'Технический профиль из tools/prod-e2e.mjs — можно удалить.')
};

/* ——— Модули приложения (настоящие) ——— */
const { registration } = await import('../js/domain/registration.js');
const { supabaseApi, setAuthToken, userIdFromToken } = await import('../js/services/supabaseApi.js');
const { db } = await import('../js/core/dbContext.js');
const { SUPABASE_URL } = await import('../js/services/supabaseConfig.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push([name, !!ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : `  → ${extra}`}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const trunc = (s, n = 10) => (s ? `${String(s).slice(0, n)}…` : String(s));

async function printDiagnostics() {
  console.log(`\n── Диагностика production (${new URL(SUPABASE_URL).host}) ──`);
  let allOk = true;
  try {
    for (const d of await supabaseApi.serverDiagnostics()) {
      console.log(`${d.ok ? ' ✅' : ' ⛔'} ${d.name}${d.detail ? ` — ${d.detail}` : ''}${!d.ok && d.hint ? `\n      hint: ${d.hint}` : ''}`);
      if (!d.ok) allOk = false;
    }
  } catch (e) {
    console.log(` ⛔ Диагностика недоступна: ${e.message || e}`);
    allOk = false;
  }
  if (!allOk) {
    console.log('\nДиагностика красная — сначала выполните docs/INFRA.md («Развёртывание продакшена с нуля»):');
    console.log('  1) supabase/schema.sql целиком в SQL Editor;  2) секреты Resend;  3) деплой auth-code.');
  }
  return allOk;
}

/* Ввод кода. Порядок источников:
 *   1) очередь из E2E_CODES («код1,код2») — для неинтерактивных прогонов/CI;
 *   2) интерактивный ввод (TTY).
 * Один readline-интерфейс на весь процесс: повторное открытие stdin после
 * rl.close() теряет буфер, а при пайпе второй вопрос зависал бы молча. */
const codeQueue = String(process.env.E2E_CODES || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
let _rl = null;
async function askCode(prompt) {
  if (codeQueue.length) return codeQueue.shift();
  if (!process.stdin.isTTY) {
    throw new Error('Нет интерактивного ввода: запустите в терминале или задайте E2E_CODES="код1,код2"');
  }
  if (!_rl) {
    const readline = await import('node:readline/promises');
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return _rl.question(prompt);
}

/* ========================================================================== */
async function main() {
  console.log('Production E2E регистрации психолога (issue #14, п.1–2). Реальный контур.\n');
  const diagOk = await printDiagnostics();
  if (!EMAIL) {
    console.log('\nДиагностика завершена (режим по умолчанию, письма не отправлялись).');
    console.log('Полный E2E:  node tools/prod-e2e.mjs --email <тестовый@email>');
    process.exit(diagOk ? 0 : 1);
  }
  if (!diagOk) {
    console.log('\nE2E прерван: критичные элементы конфигурации красные (см. выше).');
    process.exit(1);
  }

  /* —— 1. Регистрация «нового email» —— */
  console.log(`\n── Сценарий 1: новый email ${EMAIL} ──`);
  const req = await registration.requestVerification(EMAIL);
  if (!req.ok) {
    check('запрос кода (production)', false, req.message || '');
    process.exit(1);
  }
  check('код запрошен: основной канал auth-code', req.channel === 'fn',
    req.channel === 'otp'
      ? 'ФУНКЦИЯ НЕ ЗАДЕПЛОЕНА: сработал запасной канал Supabase OTP — п.1 задачи #14 не выполнен'
      : req.message || '');

  console.log('\n  📬 Проверьте почту этого email: придёт письмо с кодом (6–8 символов).\n');
  const code = normalizeCodeInput(await askCode('  Введите код из письма (окно 2 минуты): '));
  const res = await registration.completeVerification(EMAIL, code, PROFILE, { requireProfileFields: false });
  check('код принят, authenticated session получена', res.ok, res.message || '');
  if (!res.ok) process.exit(1);

  const uid = userIdFromToken(registration.currentSession()?.access_token || '');
  check('auth.uid() извлечён из access token (сессия настоящая)', !!uid, trunc(uid));
  check('профиль привязан/создан через claim_psychologist_profile', !!res.psychologist?.id, res.psychologist?.id);
  check('owner_id == auth.uid() (владение не из email)', !!res.ownerId && res.ownerId === uid,
    `${trunc(res.ownerId)} vs ${trunc(uid)}`);

  /* —— 2. Поля профиля реально сохранены на сервере —— */
  const own = await supabaseApi.fetchOwnPsychologist(res.psychologist.id);
  check('профиль читается с сервера по своей сессии', !!own, '');
  check('поле full_name сохранено', own?.full_name === PROFILE.fullName, String(own?.full_name));
  check('поле phone сохранено', own?.phone === PROFILE.phone, String(own?.phone));
  check('поле specialization сохранено', own?.specialization === PROFILE.specialization, String(own?.specialization));
  check('поле city сохранено', own?.city === PROFILE.city, String(own?.city));
  check('поле about сохранено', own?.about === PROFILE.about, String(own?.about).slice(0, 40));

  /* —— 3. «Перезагрузка страницы»: состояние из хранилища —— */
  console.log('\n── Сценарий 2: reload (состояние только из localStorage) ──');
  setAuthToken(null);
  db.clearCurrentPsychologist();
  const restored = await registration.restoreAuthenticatedState();
  check('после reload аутентификация восстановлена', restored.authenticated === true, restored.reason || restored.message || '');
  check('после reload тот же психолог', restored.psychologist?.id === res.psychologist.id,
    `${restored.psychologist?.id} vs ${res.psychologist.id}`);
  check('после reload owner_id совпадает', restored.ownerId === uid, trunc(restored.ownerId));

  /* —— 4. Повторный вход тем же email: без дубля —— */
  console.log('\n── Сценарий 3: повторный вход тем же email (кулдаун ~30 с) ──');
  process.stdout.write('  жду 31 с (кулдаун отправки на сервере) ');
  for (let i = 0; i < 31; i++) { await sleep(1000); process.stdout.write('.'); }
  console.log();
  const req2 = await registration.requestVerification(EMAIL);
  if (!req2.ok) {
    check('повторный запрос кода', false, req2.message || '');
  } else {
    check('повторный запрос кода: канал тот же (fn)', req2.channel === 'fn', `канал: ${req2.channel}`);
    console.log('\n  📬 Второе письмо с кодом.\n');
    const code2 = normalizeCodeInput(await askCode('  Введите новый код из письма: '));
    // сперва заведомо неверная попытка — проверка счётчика попыток (1 из 5)
    const bad = await registration.completeVerification(EMAIL, 'ZZZZ999', PROFILE);
    check('неверный код отклонён (честная ошибка)', bad.ok === false, bad.message || '');
    const res2 = await registration.completeVerification(EMAIL, code2, PROFILE);
    check('повторный вход выполнен', res2.ok, res2.message || '');
    check('дубль психолога НЕ создан (created=false)', res2.created === false, String(res2.created));
    check('повторный вход: тот же id профиля', res2.psychologist?.id === res.psychologist.id,
      `${res2.psychologist?.id} vs ${res.psychologist.id}`);
    const reuse = await registration.verifyVerification(EMAIL, code2);
    check('повторно использованный код отклонён (одноразовость)', reuse.ok === false, reuse.message || '');
  }

  registration.signOut();

  /* —— Итог —— */
  const failed = results.filter(r => !r[1]).length;
  console.log(`\n${'─'.repeat(72)}\nИТОГ: ${results.length - failed} PASS, ${failed} FAIL`);
  if (failed === 0) {
    console.log('Сценарий «новый email → письмо → код → Auth → claim → кабинет → reload» и');
    console.log('повторный вход ПРОЙДЕНЫ на production. Это основание закрыть п.1–2 issue #14');
    console.log('(в комментарии к issue укажите: «E2E пройден tools/prod-e2e.mjs, вывод приложен»).');
  } else {
    console.log('Есть провалы: регистрация на production НЕ подтверждена — не отмечайте п.1–2 #14 выполненными.');
  }
  console.log(`\nОчистка тестовых данных (по желанию, SQL Editor):\n` +
    `  delete from psychologists where email = '${EMAIL}';\n` +
    `  (auth-пользователь: Dashboard → Authentication → Users, либо оставьте — повторный E2E по этому email валиден)`);
  process.exit(failed ? 1 : 0);
}

function normalizeCodeInput(v) {
  return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

main().catch(e => {
  console.error('\nFATAL:', e?.message || e);
  console.error('Если это сетевая ошибка — проверьте, что машина имеет доступ к интернету.');
  process.exit(2);
});
