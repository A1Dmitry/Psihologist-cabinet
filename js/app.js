/**
 * Application composition root — MVVM wiring
 */
import { db } from './core/dbContext.js';
import { authService } from './services/authService.js';
import { PortalViewModel } from './viewmodels/PortalViewModel.js';
import { AuthViewModel } from './viewmodels/AuthViewModel.js';
import { CabinetViewModel } from './viewmodels/CabinetViewModel.js';
import { BookingViewModel } from './viewmodels/BookingViewModel.js';
import { paymentService } from './services/paymentService.js';
import { PaymentPolicy } from './models/entities.js';
import { reminderService } from './services/reminderService.js';
import { supabaseSync } from './services/supabaseSync.js';
import { cabinetApi } from './services/cabinetApi.js';
import { telegramService } from './services/telegramService.js';
import { NOTIFY_WEBHOOK_URL } from './services/supabaseConfig.js';
import { supabaseApi } from './services/supabaseApi.js';
import { reportClientError } from './services/errorLogService.js';
import { isSupabaseConfigured } from './services/supabaseConfig.js';
import { applyProfileSeo, applyPortalSeo, applyBookingSeo, applyNoIndex } from './services/seoService.js';
// ?v= — cache-busting (та же конвенция, что у entry-скрипта в index.html):
// preview-прокси/браузер кешит URL модуля без query (issue #65, 2026-09-25:
// рядом с новым app.js отдавался старый кэшированный calendarService.js →
// SyntaxError: does not provide an export named 'icsEventBlob').
import { googleAddLink, icsEventBlob, icsEventFileName } from './services/calendarService.js?v=20260925-ics';
import { todayStr, zoneCity } from './services/timezoneService.js';
import { resolveDurationMinutes, DEFAULT_DURATION_MIN } from './domain/duration.js';
import { registration } from './domain/registration.js';
// [Агент 3 · кабинет и клиенты] новые блоки кабинета и страница клиента по ссылке
import { cabinetUi } from './views/cabinetUi.js';
// MX-03 (#64): единственная каноническая замена нативных confirm()/prompt().
import { uiConfirm, uiPrompt, copyText } from './views/uiDialogs.js';
// MX-01/MX-02/MX-04 (#63): bottom tab bar + sheet «Ещё» + меню «…» в строках.
import { bindCabinetMobile, closeMoreSheet, closeAllCabMenus } from './views/cabinetMobile.js';
import { bookingTriageWizard } from './views/bookingTriageWizard.js';
import { googleAuthService } from './services/googleAuthService.js';

const portalVm = new PortalViewModel();
const authVm = new AuthViewModel();
const cabinetVm = new CabinetViewModel();
const bookingVm = new BookingViewModel();

let route = { name: 'portal', params: {} };

// ——— Helpers ———
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function formatDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = (() => { const x = new Date(); x.setDate(x.getDate() + 1); return x.toISOString().slice(0, 10); })();
  if (iso === today) return 'Сегодня';
  if (iso === tomorrow) return 'Завтра';
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
}

function statusLabel(st) {
  return ({
    confirmed: 'Подтверждено', pending: 'Ожидает', held: 'Резерв (ожидает оплаты)',
    paid: 'Оплачено 100%', done: 'Проведено', cancelled: 'Отменено',
    no_show: 'Неявка', expired: 'Истёк резерв'
  })[st] || st;
}
function statusClass(st) {
  return ({
    confirmed: 'bg-emerald-50 text-emerald-700',
    pending: 'bg-amber-50 text-amber-700',
    held: 'bg-orange-50 text-orange-700',
    paid: 'bg-sky-50 text-sky-700',
    done: 'bg-slate-100 text-slate-600',
    cancelled: 'bg-rose-50 text-rose-600',
    no_show: 'bg-rose-50 text-rose-700',
    expired: 'bg-slate-100 text-slate-500'
  })[st] || 'bg-slate-100 text-slate-600';
}
function platformLabel(p) {
  return ({ google_meet: 'Google Meet', zoom: 'Zoom', telegram: 'Telegram', whatsapp: 'WhatsApp', other: 'Видео' })[p] || '';
}

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const PLATFORM_TITLES = {
  skype: 'Skype', whatsapp: 'WhatsApp', viber: 'Viber', telegram: 'Telegram', zoom: 'Zoom'
};

const SOCIAL_TITLES = {
  telegram: 'Telegram', instagram: 'Instagram', skype: 'Skype',
  whatsapp: 'WhatsApp', viber: 'Viber', vk: 'VK', other: 'Ссылка'
};

/**
 * BL-05 (#64): единственная точка переключения кнопки «Записаться» в режим
 * отправки (disabled + «Отправляем…»). Вызывается и рендером, и обработчиком
 * клика — расхождение подписи и disabled исключено.
 */
function renderBookingSubmitState(submitting) {
  const btn = $('#book-submit');
  if (!btn) return;
  const busy = submitting === undefined ? !!bookingVm.submitting : !!submitting;
  btn.disabled = busy;
  btn.classList.toggle('opacity-60', busy);
  btn.classList.toggle('cursor-not-allowed', busy);
  btn.textContent = busy ? 'Отправляем…' : 'Записаться';
}

function showToast(msg, isError) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-full text-sm font-medium shadow-lg ' +
    (isError ? 'bg-rose-600 text-white' : 'bg-slate-900 text-white');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ——— Router: режим Hash History (#/psy/{slug}) ———
// Весь сайт — одна страница index.html: сервер (GitHub Pages и любой статический
// хостинг) игнорирует всё после #, а приложение само считает хвост ссылки и
// рендерит нужный кабинет. Ссылки: .../project/#/psy/{slug}, .../#/book/{slug}.
// Старые ссылки (.../psy/slug, ?book=, /psy/slug#book) при загрузке прозрачно
// нормализуются в hash (replaceState, без перезагрузки).

function computeBasePath() {
  let p = location.pathname;
  if (p.endsWith('/index.html')) p = p.slice(0, -'index.html'.length);
  // legacy-сегменты в пути (ссылки до перехода на hash-роутинг)
  p = p.replace(/\/(psy\/[^/]+|book\/[^/]+|cabinet|auth|onboarding|booking-done|reply)\/?$/i, '');
  return p.endsWith('/') ? p : p + '/';
}
const BASE = computeBasePath();
/** Абсолютная база сайта (https://host/<repo>/) — с текущим pathname:
 *  учитывает подпуть GitHub Pages и legacy-сегменты до нормализации. */
const siteBase = () => location.origin + computeBasePath();

/** Hash-части ссылок (источник истины для маршрутизации) */
const hashPath = {
  home: () => '/',
  psy: slug => `/psy/${encodeURIComponent(slug)}`,
  book: slug => `/book/${encodeURIComponent(slug)}`,
  cabinet: () => '/cabinet',
  onboarding: () => '/onboarding',
  auth: mode => (mode && mode !== 'login') ? `/auth?mode=${encodeURIComponent(mode)}` : '/auth',
  success: () => '/booking-done',
  reply: token => `/reply?reply=${encodeURIComponent(token)}`
};

const urlFor = {
  home: () => `${siteBase()}#/`,
  psy: slug => `${siteBase()}#${hashPath.psy(slug)}`,
  book: slug => `${siteBase()}#${hashPath.book(slug)}`,
  cabinet: () => `${siteBase()}#/cabinet`,
  onboarding: () => `${siteBase()}#/onboarding`,
  auth: () => `${siteBase()}#/auth`,
  success: () => `${siteBase()}#/booking-done`,
  reply: token => `${siteBase()}#${hashPath.reply(token)}`,
  /** Публичная (индексируемая) ссылка записи для клиентов */
  bookingLink: slug => urlFor.book(slug)
};

function routeUrl(r) {
  if (r.name === 'profile' && r.params.slug) return urlFor.psy(r.params.slug);
  if (r.name === 'booking' && r.params.slug) return urlFor.book(r.params.slug);
  if (r.name === 'portal') return urlFor.home();
  if (r.name === 'cabinet') return urlFor.cabinet();
  if (r.name === 'onboarding') return urlFor.onboarding();
  if (r.name === 'auth') return `${siteBase()}#${hashPath.auth(r.params && r.params.mode)}`;
  if (r.name === 'success') return urlFor.success();
  if (r.name === 'clientReply' && r.params.token) return urlFor.reply(r.params.token);
  return null;
}

function safeSlug(name, raw) {
  try { return { name, params: { slug: decodeURIComponent(raw) } }; }
  catch { return { name, params: { slug: raw } }; }
}

/** Legacy-ссылка без hash-хвоста → нормализация в .../#/… (без перезагрузки). */
function normalizeLegacyUrl() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('/')) return; // уже в режиме Hash History
  const r = routeFromUrl();
  if (r.name === 'portal') return;
  const target = routeUrl(r);
  if (!target) return;
  history.replaceState(null, '', target);
}

function sameRoute(a, b) {
  if (!a || !b || a.name !== b.name) return false;
  return JSON.stringify(a.params || {}) === JSON.stringify(b.params || {});
}

/** Маршрут из URL: сначала hash (#/psy/slug…), иначе legacy path/query */
function routeFromUrl() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('/')) {
    const q = h.indexOf('?');
    const path = q === -1 ? h : h.slice(0, q);
    const qs = new URLSearchParams(q === -1 ? '' : h.slice(q + 1));
    let m = path.match(/^\/book\/([^/]+)\/?$/);
    if (m) return safeSlug('booking', m[1]);
    m = path.match(/^\/psy\/([^/]+)\/?$/);
    if (m) return safeSlug('profile', m[1]);
    if (/^\/cabinet\/?$/.test(path)) return { name: 'cabinet', params: {} };
    if (/^\/onboarding\/?$/.test(path)) return { name: 'onboarding', params: {} };
    if (/^\/auth\/?$/.test(path)) return { name: 'auth', params: { mode: qs.get('mode') || 'login' } };
    if (/^\/booking-done\/?$/.test(path)) return { name: 'success', params: {} };
    if (/^\/reply\/?$/.test(path)) {
      const token = qs.get('reply') || qs.get('token');
      if (token) return { name: 'clientReply', params: { token } };
    }
    return { name: 'portal', params: {} };
  }
  // legacy: /psy/{slug}, /book/{slug}, ?book=, /reply?reply=, якорь /psy/{slug}#book
  const qs = new URLSearchParams(location.search);
  const book = qs.get('book');
  if (book) return safeSlug('booking', book);
  const reply = qs.get('reply') || qs.get('token');
  if (reply && /\/reply\/?$/.test(location.pathname)) return { name: 'clientReply', params: { token: reply } };
  let m = location.pathname.match(/\/book\/([^/]+)\/?$/i);
  if (m) return safeSlug('booking', m[1]);
  m = location.pathname.match(/\/psy\/([^/]+)\/?$/i);
  if (m) {
    if (h === 'book') return safeSlug('booking', m[1]); // legacy-якорь #book
    return safeSlug('profile', m[1]);
  }
  if (/\/cabinet\/?$/.test(location.pathname)) return { name: 'cabinet', params: {} };
  if (/\/onboarding\/?$/.test(location.pathname)) return { name: 'onboarding', params: {} };
  if (/\/auth\/?$/.test(location.pathname)) return { name: 'auth', params: { mode: qs.get('mode') || 'login' } };
  if (/\/booking-done\/?$/.test(location.pathname)) return { name: 'success', params: {} };
  return { name: 'portal', params: {} };
}

function navigate(name, params = {}, { push = true } = {}) {
  route = { name, params };
  if (name === 'cabinet' && !authService.isAuthenticated()) {
    route = { name: 'auth', params: { mode: 'login' } };
  }
  // Онбординг доступен только при живой сессии Supabase Auth: без неё RPC
  // complete_psychologist_profile всё равно откажет, а пользователь увидит
  // непонятную ошибку вместо формы входа.
  if (name === 'onboarding' && !googleAuthService.hasSession()) {
    route = { name: 'auth', params: { mode: 'login' } };
  }
  // Нельзя обойти форму заполнения, набрав #/cabinet: публичный каталог
  // такой кабинет всё равно не показывает, а обязательные поля пусты.
  if (name === 'cabinet' && authService.isAuthenticated()
      && cabinetVm.psychologist?.profileCompleted === false) {
    route = { name: 'onboarding', params: {} };
  }
  if (push) {
    // Hash History: запись в location.hash создаёт нативную запись истории;
    // «свой» hashchange не вызывает повторный рендер (проверка sameRoute)
    const url = routeUrl(route);
    if (url) {
      const hash = url.slice(url.indexOf('#') + 1);
      if (location.hash.slice(1) !== hash) location.hash = hash;
    }
  }
  render();
  window.scrollTo(0, 0);
}

// Назад/вперёд браузера и внешнее изменение хвоста ссылки
window.addEventListener('hashchange', () => {
  const r = routeFromUrl();
  if (sameRoute(r, route)) return;
  route = r;
  if (route.name === 'cabinet' && !authService.isAuthenticated()) {
    route = { name: 'auth', params: { mode: 'login' } };
  }
  if (route.name === 'onboarding' && !googleAuthService.hasSession()) {
    route = { name: 'auth', params: { mode: 'login' } };
  }
  if (route.name === 'cabinet' && authService.isAuthenticated()
      && cabinetVm.psychologist?.profileCompleted === false) {
    route = { name: 'onboarding', params: {} };
  }
  render();
  window.scrollTo(0, 0);
});

window.navigate = navigate;
// debug/тесты: доступ к внутренностям роутера (Hash History)
window.__router = { routeFromUrl, routeUrl, normalizeLegacyUrl, hashPath, sameRoute };
// issue #121 (R14): глобального `resetPortalData` больше нет. Он вызывал
// `db.resetToSeed()` с публичной страницы — стирал локальный снапшот целиком,
// включая зашифрованные карточки клиентов (сейф), заметки и задачи владельца.
// Разрушительный сброс личных данных в production UI недопустим; seed-каталог
// остаётся только фикстурой тестов (tools/verify_cabinet.mjs).

// ——— Views ———
function render() {
  // MX-01/MX-04 (#63): смена страницы закрывает sheet «Ещё» и меню «…» —
  // они привязаны к кабинету и не должны переживать навигацию.
  closeMoreSheet();
  closeAllCabMenus();
  $$('.page').forEach(p => p.classList.add('hidden'));
  const map = {
    portal: 'page-portal',
    profile: 'page-profile',
    auth: 'page-auth',
    cabinet: 'page-cabinet',
    onboarding: 'page-onboarding',
    booking: 'page-booking',
    success: 'page-success',
    clientReply: 'page-client-reply'
  };
  const id = map[route.name] || 'page-portal';
  const page = document.getElementById(id);
  if (page) page.classList.remove('hidden');

  if (route.name === 'portal') { renderPortal(); applyPortalSeo(urlFor.home()); }
  if (route.name === 'profile') renderProfile();
  if (route.name === 'auth') renderAuth();
  if (route.name === 'cabinet') renderCabinet();
  if (route.name === 'onboarding') renderOnboarding();
  if (route.name === 'booking') renderBooking();
  if (route.name === 'success') renderSuccess();
  if (route.name === 'clientReply') renderClientReply();

  // Feature-owned views attach their DOM through small afterRender hooks.
  try {
    cabinetUi.afterRender({ route, vm: cabinetVm });
  } catch (e) {
    console.warn('[cabinetUi]', e);
  }

  // Необязательный визард самоописания добавляет результат в заметку заявки.
  try {
    bookingTriageWizard.afterRender({ route, vm: bookingVm });
  } catch (e) {
    console.warn('[bookingTriageWizard]', e);
  }

  // global toast from VMs
  [portalVm, authVm, cabinetVm, bookingVm].forEach(vm => {
    if (vm.toast) {
      showToast(vm.toast);
      vm.toast = '';
    }
  });
}

// ——— Telegram: outbox новых записей + должные напоминания (пока кабинет открыт) ———
let _tgLoop = null;
function startTelegramLoops(psyId) {
  clearInterval(_tgLoop);
  const tick = async () => {
    try {
      const a = await telegramService.notifyNewBookings(psyId);
      if (a.sent) showToast(`Telegram: уведомлений о записях — ${a.sent}`);
      await telegramService.sendDueReminders(psyId);
    } catch (e) { console.warn('[Telegram] loop', e); }
  };
  tick();
  _tgLoop = setInterval(tick, 60 * 1000);
}

// ——— Поделиться ссылкой на специалиста (Telegram/WhatsApp/Viber/системное меню) ———
window.sharePsyLink = async function (slug) {
  const url = `${location.origin}${urlFor.psy(slug)}`;
  const text = 'Запись к специалисту:';
  if (navigator.share) {
    try { await navigator.share({ title: document.title, text, url }); return; } catch (_) { /* отмена */ }
  }
  const copied = await copyText(url, { title: 'Ссылка записи', label: 'Ссылка' });
  showToast(copied.ok ? 'Ссылка скопирована' : 'Скопируйте ссылку вручную', !copied.ok);
};

/** Диагностика сервера: что применено в БД, что нет (показывается в UI) */
window.runServerDiagnostics = async containerId => {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '<div class="text-sm text-slate-400">Проверяем…</div>';
  const rows = await supabaseApi.serverDiagnostics();
  box.innerHTML = `<div class="bg-white rounded-xl border p-4 text-sm space-y-2">
    <div class="font-medium">Состояние сервера БД</div>
    ${rows.map(r => `
      <div class="flex gap-2 items-start">
        <span>${r.ok ? '✅' : '❌'}</span>
        <div>
          <div class="${r.ok ? 'text-slate-700' : 'text-slate-900 font-medium'}">${esc(r.name)}</div>
          ${r.ok ? (r.detail ? `<div class="text-xs text-slate-400">${esc(r.detail)}</div>` : '')
                 : `<div class="text-xs text-rose-500">${esc(r.detail)}</div><div class="text-xs text-slate-500">→ ${esc(r.hint)}</div>`}
        </div>
      </div>`).join('')}
  </div>`;
};

/** Бейдж источника данных в шапке каталога */
function renderSourceBadge() {
  const el = $('#portal-src-badge');
  if (!el) return;
  const map = {
    server: { text: 'Данные: сервер', cls: 'bg-emerald-100 text-emerald-700' },
    none: { text: 'Нет связи с сервером', cls: 'bg-rose-100 text-rose-700' },
    loading: { text: 'Загрузка…', cls: 'bg-slate-100 text-slate-500' }
  };
  const it = map[portalVm.source] || map.loading;
  el.textContent = it.text;
  el.className = 'text-xs px-2.5 py-1 rounded-full font-medium whitespace-nowrap ' + it.cls;
}

function renderPortal() {
  const list = portalVm.psychologists;
  const box = $('#portal-list');
  const navAuth = $('#nav-auth-area');
  renderSourceBadge();
  if (navAuth) {
    if (portalVm.isLoggedIn) {
      navAuth.innerHTML = `
        <button onclick="navigate('cabinet')" class="text-sm text-slate-600 hover:text-indigo-700">${portalVm.currentPsychologist.fullName}</button>
        <button onclick="navigate('cabinet')" class="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Кабинет</button>`;
    } else {
      navAuth.innerHTML = `
        <button onclick="navigate('auth',{mode:'login'})" class="text-sm text-slate-600 hover:text-indigo-700">Вход для специалистов</button>
        <button onclick="navigate('auth',{mode:'register'})" class="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Регистрация</button>`;
    }
  }

  // Строго серверный режим (issue #121, R14): каталог, города и карточки
  // рисуются только из подтверждённого серверного каталога. Пока он грузится,
  // локальное зеркало может содержать seed-фикстуру dbContext (пустой кэш
  // первого визита) — раньше она успевала отрисоваться 19 карточками и уходила
  // только после ответа сервера (проба в docs/ISSUE-121-REPORT.md).
  const catalogReady = portalVm.catalogReady;
  const cities = catalogReady ? portalVm.cities : [];
  const citySel = $('#portal-city');
  if (citySel) {
    citySel.innerHTML = '<option value="">Все города</option>' + cities.map(c =>
      `<option value="${c}" ${portalVm.cityFilter === c ? 'selected' : ''}>${c}</option>`
    ).join('');
  }

  if (!box) return;

  if (!catalogReady && portalVm.source !== 'none') {
    box.innerHTML = `
      <div class="bg-white rounded-2xl border p-8 max-w-2xl mx-auto text-center" aria-busy="true">
        <div class="text-4xl mb-3">⏳</div>
        <h3 class="font-bold text-lg mb-1">Загружаем каталог с сервера…</h3>
      </div>`;
    return;
  }

  // без сервера показываем причину, не локальные данные
  if (!catalogReady) {
    box.innerHTML = `
      <div class="bg-white rounded-2xl border p-8 max-w-2xl mx-auto text-center">
        <div class="text-4xl mb-3">🔌</div>
        <h3 class="font-bold text-lg mb-1">Нет связи с сервером данных</h3>
        ${portalVm.serverError ? `<p class="text-sm text-rose-600 mb-4">${esc(portalVm.serverError)}</p>` : ''}
        <div class="text-sm text-slate-600 bg-slate-50 rounded-xl p-4 text-left mb-5">
          <div class="font-medium mb-2">Как подключить серверные данные:</div>
          <ol class="list-decimal list-inside space-y-1">
            <li>Откройте проект в Supabase → <b>SQL Editor</b></li>
            <li>Выполните <code class="text-indigo-600">supabase/schema.sql</code> (таблицы, view, RLS)</li>
            <li>Выполните <code class="text-indigo-600">supabase/seed.sql</code> (данные специалиста)</li>
            <li>Нажмите «Повторить» ниже</li>
          </ol>
        </div>
        <div class="flex flex-wrap gap-3 justify-center">
          <button onclick="retryServerData()" class="px-6 py-2.5 rounded-full bg-indigo-600 text-white text-sm font-medium">Повторить</button>
          <button onclick="runServerDiagnostics('portal-diag')" class="px-6 py-2.5 rounded-full border border-indigo-300 text-indigo-700 text-sm font-medium">Проверить сервер</button>
        </div>
        <div id="portal-diag" class="mt-5 text-left"></div>
      </div>`;
    return;
  }

  if (!list.length) {
    box.innerHTML = '<div class="col-span-full text-center text-slate-400 py-12">Специалисты не найдены</div>';
    return;
  }
  box.innerHTML = list.map(p => {
    const svcs = db.servicesOf(p.id);
    const online = svcs.some(s => s.format === 'online');
    return `
      <article class="bg-white rounded-2xl border border-slate-100 p-6 hover:shadow-lg transition flex flex-col">
        <div class="flex items-start gap-4 mb-4">
          <div class="w-14 h-14 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-lg shrink-0 overflow-hidden">
            ${p.photoUrl
              ? `<img src="${esc(p.photoUrl)}" alt="${esc(p.fullName)}" class="w-full h-full object-cover">`
              : esc(p.fullName.split(' ').map(x => x[0]).slice(0, 2).join(''))}
          </div>
          <div class="min-w-0">
            <h3 class="font-bold text-slate-900 text-lg leading-tight">
              <a href="${urlFor.psy(p.slug)}" data-spa data-slug="${esc(p.slug)}" class="hover:text-indigo-700">${p.fullName}</a>
            </h3>
            <p class="text-sm text-indigo-600 mt-0.5">${p.specialization}</p>
            <p class="text-xs text-slate-400 mt-1">${p.city || 'Онлайн'}${online ? ' · Google Meet' : ''}</p>
          </div>
        </div>
        <p class="text-sm text-slate-600 flex-1 line-clamp-3 mb-4">${p.about || 'Частная практика'}</p>
        <div class="flex flex-wrap gap-2 mb-4">
          ${svcs.slice(0, 3).map(s => `<span class="text-xs px-2 py-1 rounded-full bg-slate-50 text-slate-600">${s.name}</span>`).join('')}
        </div>
        <a href="${urlFor.book(p.slug)}" data-spa-book data-slug="${esc(p.slug)}" class="block w-full text-center py-2.5 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
          Записаться
        </a>
      </article>`;
  }).join('');
}

function renderAuth() {
  const title = $('#auth-title');
  const subtitle = $('#auth-subtitle');
  if (title) title.textContent = 'Вход в кабинет';
  if (subtitle) subtitle.textContent = 'Войдите через Google. Это единственный способ входа специалиста.';

  const err = $('#auth-error');
  if (err) {
    err.textContent = authVm.error || '';
    err.classList.toggle('hidden', !authVm.error);
  }

  // Кнопка Google — единственный вход. Без конфигурации не «успешно нажимается».
  const googleBtn = $('#btn-google-signin');
  const googleLabel = $('#btn-google-label');
  if (googleBtn) {
    googleBtn.disabled = !!authVm.googleBusy;
    if (googleLabel) {
      googleLabel.textContent = authVm.googleBusy ? 'Переходим в Google…' : 'Войти через Google';
    }
  }
  const gStatus = $('#auth-google-status');
  if (gStatus) {
    gStatus.textContent = authVm.googleError || '';
    gStatus.classList.toggle('hidden', !authVm.googleError);
  }
  const gResolution = $('#auth-google-resolution');
  if (gResolution) {
    gResolution.textContent = authVm.googleResolution || '';
    gResolution.classList.toggle('hidden', !authVm.googleResolution);
  }
  const gRef = $('#auth-google-ref');
  if (gRef) {
    gRef.textContent = authVm.googleRef ? `Код обращения: ${authVm.googleRef}` : '';
    gRef.classList.toggle('hidden', !authVm.googleRef);
  }
}

/**
 * Онбординг после первого входа через Google: профиль создан сервером, но
 * обязательные поля ещё пустые, поэтому кабинет не публикуется в каталоге.
 *
 * Сохраняются ТОЛЬКО поля существующей схемы `psychologists`
 * (full_name, phone, specialization, city, about) — через
 * RPC complete_psychologist_profile, который один и выставляет
 * profile_completed. email/is_active/owner_id/slug клиент не трогает.
 */
function renderOnboarding() {
  const user = googleAuthService.getCurrentUser() || googleAuthService.getCachedUser();
  const emailEl = $('#onb-email');
  if (emailEl) emailEl.textContent = user?.email || '';

  const nameEl = $('#onb-name');
  const psy = cabinetVm.psychologist;
  if (nameEl && !nameEl.value && psy?.fullName) nameEl.value = psy.fullName;
  const specEl = $('#onb-spec');
  if (specEl && !specEl.value) specEl.value = psy?.specialization || 'Психолог';

  const err = $('#onb-error');
  if (err) {
    err.textContent = authVm.onboardingError || '';
    err.classList.toggle('hidden', !authVm.onboardingError);
  }
  const submit = $('#onb-submit');
  if (submit) submit.disabled = !!authVm.busy;
}

/** Показать имя/email вошедшего пользователя в сайдбаре кабинета. */
function renderCabinetAccount() {
  const wrap = $('#cab-account');
  if (!wrap) return;
  const user = googleAuthService.getCurrentUser() || googleAuthService.getCachedUser();
  const psy = cabinetVm.psychologist;
  const email = user?.email || psy?.email || '';
  const name = user?.name || psy?.fullName || '';
  wrap.classList.toggle('hidden', !email && !name);
  const nameEl = $('#cab-account-name');
  const mailEl = $('#cab-account-email');
  if (nameEl) nameEl.textContent = name || email;
  if (mailEl) mailEl.textContent = email || '';
}

function renderCabinet() {
  if (!authService.isAuthenticated()) {
    navigate('auth', { mode: 'login' });
    return;
  }
  renderCabinetAccount();
  const p = cabinetVm.psychologist;
  $('#cab-name') && ($('#cab-name').textContent = p.fullName);
  $('#cab-spec') && ($('#cab-spec').textContent = p.specialization + (cabinetVm.vaultUnlocked ? ' · 🔒 сейф открыт' : ' · сейф закрыт'));

  $$('.cab-tab').forEach(t => t.classList.add('hidden'));
  $(`#tab-${cabinetVm.tab}`)?.classList.remove('hidden');

  $$('.cab-nav-btn').forEach(btn => {
    const on = btn.dataset.tab === cabinetVm.tab;
    if (btn.closest('#cab-tabbar')) {
      // MX-02 (#63): активная вкладка таб-бара подсвечена индиго.
      btn.classList.toggle('text-indigo-600', on);
      btn.classList.toggle('text-slate-400', !on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    } else if (btn.closest('aside')) {
      btn.classList.toggle('bg-slate-800', on);
      btn.classList.toggle('font-medium', on);
      btn.classList.toggle('text-slate-300', !on);
    } else {
      btn.classList.toggle('bg-indigo-600', on);
      btn.classList.toggle('text-white', on);
      btn.classList.toggle('bg-slate-100', !on);
    }
  });

  // MX-01 (#63): «Ещё» активно, когда открыта вкладка из sheet — т.е. когда
  // текущей вкладки нет среди кнопок таб-бара (выводится из DOM, без дубля
  // списка разделов в JS).
  const moreBtn = $('#cab-more-btn');
  if (moreBtn) {
    const inBar = $$('#cab-tabbar [data-tab]').some(b => b.dataset.tab === cabinetVm.tab);
    moreBtn.classList.toggle('text-indigo-600', !inBar);
    moreBtn.classList.toggle('text-slate-400', inBar);
    if (!inBar) moreBtn.setAttribute('aria-current', 'page');
    else moreBtn.removeAttribute('aria-current');
  }

  // Бейдж «Ожидание»: сайдбар + таб-бар (класс .wait-badge на обоих).
  const waitCount = cabinetVm.waiting.length;
  $$('.wait-badge').forEach(badge => {
    if (waitCount) { badge.textContent = waitCount; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  });

  if (cabinetVm.tab === 'home') {
    cabinetVm.refreshClients().then(() => renderCabHome());
  }
  if (cabinetVm.tab === 'schedule') {
    cabinetVm.refreshClients().then(() => renderCabSchedule());
  }
  if (cabinetVm.tab === 'clients') {
    cabinetVm.refreshClients().then(() => renderCabClients());
  }
  if (cabinetVm.tab === 'services') renderCabServices();
  if (cabinetVm.tab === 'waiting') renderCabWaiting();
  if (cabinetVm.tab === 'blocks') renderCabBlocks();
  if (cabinetVm.tab === 'journal') renderCabJournal();
  if (cabinetVm.tab === 'tasks') renderCabTasks();
  if (cabinetVm.tab === 'notepad') renderCabNotepad();
  if (cabinetVm.tab === 'telegram') { renderCabTelegram(); bindTelegramTab(); }
  if (cabinetVm.tab === 'stats') renderCabStats();
  if (cabinetVm.tab === 'profile') renderCabProfile();
  if (cabinetVm.tab === 'link') renderCabLink();
  if (cabinetVm.tab === 'payments') renderCabPayments();
  if (cabinetVm.tab === 'reminders') renderCabReminders();
}

function renderCabHome() {
  const box = $('#home-sessions');
  const list = cabinetVm.upcomingSessions;
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">Нет ближайших сессий</div>';
  } else {
    box.innerHTML = list.map(s => {
      const cl = cabinetVm.clientById(s.clientId);
      const sv = cabinetVm.serviceById(s.serviceId);
      // MX-04 (#63): primary — первое действие десктопного порядка (оплата, если
      // требуется, иначе «Изменить»); остальное — в меню «…». На десктопе обёртки
      // display:contents, порядок и тексты кнопок — как раньше.
      const payFirst = s.status === 'held' || (s.requiresPayment && s.paymentStatus === 'unpaid');
      return `<div class="flex items-center gap-4 p-4 border-b border-slate-50 last:border-0">
        <div class="w-1 h-12 rounded-full ${s.status === 'pending' ? 'bg-amber-400' : 'bg-indigo-400'}"></div>
        <div class="flex-1 min-w-0">
          <div class="font-medium">${cl?.name || '—'}</div>
          <div class="text-sm text-slate-500">${formatDate(s.date)} · ${s.time} · ${sv?.name || ''} · ${sv?.priceLabel?.() || ''}
            ${s.videoPlatform === 'google_meet' ? ' · Google Meet' : ''}
            ${s.requiresPayment && s.paymentStatus === 'unpaid' ? ' · к оплате ' + (s.amountDue || 0) : ''}
            ${s.paymentStatus === 'deposit_paid' ? ' · аванс ✓' : ''}
            ${s.paymentStatus === 'fully_paid' ? ' · 100% ✓' : ''}
            ${s.changeConsentStatus === 'pending' ? ' · ⏳ ждём согласие на перенос' : ''}</div>
        </div>
        <span class="text-xs px-2 py-1 rounded-full ${statusClass(s.status)}">${statusLabel(s.status)}</span>
        <div class="cab-actions-inline">
          ${payFirst
            ? `<button data-mark-paid="${s.id}" class="cab-primary text-xs text-emerald-600">Чек/оплата</button>`
            : `<button data-edit-session="${s.id}" class="cab-primary text-xs text-indigo-600">Изменить</button>`}
          <div class="cab-menu-wrap">
            <button type="button" data-cab-menu="cab-menu-home-${s.id}" class="cab-menu-toggle" aria-haspopup="true" aria-expanded="false" aria-label="Другие действия">⋯</button>
            <div id="cab-menu-home-${s.id}" class="cab-menu">
              ${payFirst ? `<button data-edit-session="${s.id}" class="text-xs text-indigo-600">Изменить</button>` : ''}
              <button data-no-show="${s.id}" class="cab-menu-danger text-xs text-slate-400">Неявка</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  }
  $('#stat-today-count') && ($('#stat-today-count').textContent = cabinetVm.todaySessions.length);
  let byn = 0, rub = 0;
  cabinetVm.todaySessions.forEach(s => {
    const sv = cabinetVm.serviceById(s.serviceId);
    if (!sv) return;
    if (sv.currency === 'RUB') rub += sv.price; else byn += sv.price;
  });
  let t = '';
  if (byn) t += byn + ' BYN';
  if (rub) t += (t ? ' / ' : '') + rub + ' ₽';
  $('#stat-today-sum') && ($('#stat-today-sum').textContent = t || '0');
  $('#home-waiting-text') && ($('#home-waiting-text').textContent =
    cabinetVm.waiting.length ? `${cabinetVm.waiting.length} заявок` : 'Нет новых заявок');
}

function renderCabSchedule() {
  const rangeEl = $('#sch-range');
  if (rangeEl) {
    rangeEl.innerHTML = cabinetVm.scheduleRangeOptions.map(o => `
      <button type="button" data-sch-range="${o.id}" class="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${cabinetVm.scheduleRange === o.id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}">${o.label}</button>
    `).join('');
    rangeEl.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => { cabinetVm.setScheduleRange(btn.dataset.schRange); renderCabinet(); };
    });
  }

  const days = $('#sch-days');
  if (days) {
    days.innerHTML = '';
    cabinetVm.scheduleDays.forEach(iso => {
      const btn = document.createElement('button');
      btn.className = 'px-3 py-1.5 rounded-full text-sm whitespace-nowrap ' +
        (iso === cabinetVm.selectedDate ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200');
      btn.textContent = formatDate(iso);
      btn.onclick = () => { cabinetVm.setSelectedDate(iso); renderCabinet(); };
      days.appendChild(btn);
    });
  }
  const list = cabinetVm.sessionsOnSelectedDate;
  const dayBlocks = cabinetVm.blocksOnSelectedDate;
  const box = $('#sch-list');
  if (!box) return;
  if (!list.length && !dayBlocks.length) {
    box.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Нет сессий и блокировок</div>';
    return;
  }
  const blockRows = dayBlocks.map(b => `
    <div class="flex items-center gap-4 p-4 border-b last:border-0 bg-slate-50">
      <div class="font-mono text-sm text-slate-500 w-14">${esc(b.timeFrom || 'день')}</div>
      <div class="flex-1">
        <div class="font-medium">${esc(b.title || 'Личное время')}</div>
        <div class="text-sm text-slate-500">закрыто от записи${b.dateTo && b.dateTo !== b.dateFrom ? ` · до ${esc(b.dateTo)}` : ''}${b.timeFrom ? ` · ${esc(b.timeFrom)}–${esc(b.timeTo || '')}` : ' · весь день'}</div>
      </div>
      <span class="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600">${esc(cabinetVm.blockKindLabels[b.kind] || 'Занят')}</span>
      <button data-del-block="${esc(b.id)}" class="text-sm text-rose-500 min-h-[44px] inline-flex items-center">Снять</button>
    </div>`).join('');
// MX-04 (#63): в строке расписания primary «Изменить» идёт в DOM раньше панели
// «…» (мобильный порядок: primary слева, «…» справа), а визуально на десктопе —
// «В календарь · Изменить · Удалить» как раньше: за это отвечают desktop-only
// классы cab-ord-1/2/3 (см. css/tailwind.src.css). Порядок табов на десктопе
// отличается от визуального на одну перестановку — зафиксировано в отчёте §5.
  box.innerHTML = blockRows + list.map(s => {
    const cl = cabinetVm.clientById(s.clientId);
    const sv = cabinetVm.serviceById(s.serviceId);
    const gcal = googleAddLink({
      title: `Консультация${cl?.name ? ' · ' + cl.name : ''}${sv?.name ? ' · ' + sv.name : ''}`,
      date: s.date,
      time: s.time,
      durationMin: resolveDurationMinutes({ durationMin: s.durationMin, service: sv }),
      location: s.meetLink || '',
      details: '',
      timezone: cabinetVm.settings?.timezone || 'Europe/Minsk'
    });
    return `<div class="flex items-center gap-4 p-4 border-b last:border-0">
      <div class="font-mono text-sm text-slate-500 w-14">${s.time}</div>
      <div class="flex-1"><div class="font-medium">${cl?.name || '—'}</div>
      <div class="text-sm text-slate-500">${sv?.name || ''} ${s.meetLink ? '· <a class="text-blue-600" href="'+s.meetLink+'" target="_blank">Meet</a>' : ''}</div></div>
      <span class="text-xs px-2 py-1 rounded-full ${statusClass(s.status)}">${statusLabel(s.status)}</span>
      <div class="cab-actions-inline">
        <button data-edit-session="${s.id}" class="cab-primary cab-ord-2 text-sm text-indigo-600">Изменить</button>
        <div class="cab-menu-wrap">
          <button type="button" data-cab-menu="cab-menu-sch-${s.id}" class="cab-menu-toggle" aria-haspopup="true" aria-expanded="false" aria-label="Другие действия">⋯</button>
          <div id="cab-menu-sch-${s.id}" class="cab-menu">
            <a href="${esc(gcal)}" target="_blank" rel="noopener" class="cab-ord-1 text-sm text-emerald-600">В календарь</a>
            <button data-del-session="${s.id}" class="cab-menu-danger cab-ord-3 text-sm text-rose-500">Удалить</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}
// ——— Книга записей ———
function renderCabJournal() {
  const filtersBox = $('#journal-filters');
  if (filtersBox) {
    const opts = [
      ['upcoming', 'Предстоящие'],
      ['pending', 'Ждут действия'],
      ['past', 'Прошедшие'],
      ['all', 'Все']
    ];
    filtersBox.innerHTML = opts.map(([id, label]) =>
      `<button type="button" data-jf="${id}" class="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${cabinetVm.journalFilter === id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}">${label}</button>`
    ).join('');
    filtersBox.querySelectorAll('[data-jf]').forEach(btn => {
      btn.onclick = () => { cabinetVm.setJournalFilter(btn.dataset.jf); renderCabJournal(); };
    });
  }
  const box = $('#journal-list');
  if (!box) return;
  const list = cabinetVm.journalSessions;
  if (!list.length) {
    box.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Записей нет</div>';
    return;
  }
  box.innerHTML = list.map(s => {
    const cl = cabinetVm.clientById(s.clientId);
    const sv = cabinetVm.serviceById(s.serviceId);
    const gcal = googleAddLink({
      title: `Консультация${cl?.name ? ' · ' + cl.name : ''}`,
      date: s.date, time: s.time, durationMin: resolveDurationMinutes({ durationMin: s.durationMin, service: sv }),
      location: s.meetLink || '', timezone: cabinetVm.settings?.timezone || 'Europe/Minsk'
    });
    const canConfirm = ['pending', 'held'].includes(s.status);
    return `<div class="p-4 border-b last:border-0">
      <div class="flex items-center gap-3 flex-wrap">
        <div class="font-mono text-sm text-slate-500 w-32 shrink-0">${formatDate(s.date)} · ${s.time}
          ${s.clientTimezone ? `<div class="text-[10px] text-indigo-400 font-sans" title="Часовой пояс клиента (T-03); время выше — в поясе кабинета">пояс клиента: ${esc(zoneCity(s.clientTimezone))}</div>` : ''}</div>
        <div class="flex-1 min-w-[140px]">
          <div class="font-medium">${cl?.name || cl?.nickname || '—'}</div>
          <div class="text-sm text-slate-500">${sv?.name || ''} ${sv ? '· ' + sv.priceLabel() : ''}
            ${s.paymentStatus === 'deposit_paid' ? ' · аванс ✓' : ''}${s.paymentStatus === 'fully_paid' ? ' · оплачено ✓' : ''}
            ${s.changeConsentStatus === 'pending' ? ' · ⏳ ждём согласие на перенос' : ''}</div>
        </div>
        <span class="text-xs px-2 py-1 rounded-full ${statusClass(s.status)}">${statusLabel(s.status)}</span>
      </div>
      ${s.note ? `<div class="text-xs text-slate-400 mt-1 whitespace-pre-line">Комментарий к записи: ${esc(s.note)}</div>` : ''}
      <div class="cab-actions flex flex-wrap gap-3 mt-2 text-sm">
        ${canConfirm
          ? `<button data-j-confirm="${s.id}" class="cab-primary text-emerald-600">Подтвердить</button>`
          : `<button data-edit-session="${s.id}" class="cab-primary text-indigo-600">Перенести/изменить</button>`}
        <div class="cab-menu-wrap">
          <button type="button" data-cab-menu="cab-menu-j-${s.id}" class="cab-menu-toggle" aria-haspopup="true" aria-expanded="false" aria-label="Другие действия">⋯</button>
          <div id="cab-menu-j-${s.id}" class="cab-menu">
            ${canConfirm ? `<button data-edit-session="${s.id}" class="text-indigo-600">Перенести/изменить</button>` : ''}
            <button data-j-note="${s.id}" class="text-indigo-600">+ запись о сессии</button>
            ${s.date >= todayStr() && !['cancelled', 'done', 'no_show'].includes(s.status) ? `<button data-j-noshow="${s.id}" class="cab-menu-danger text-slate-400">Неявка</button>` : ''}
            <a href="${esc(gcal)}" target="_blank" rel="noopener" class="text-emerald-600">В календарь</a>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-j-confirm]').forEach(btn => {
    btn.onclick = () => { cabinetVm.confirmSession(btn.dataset.jConfirm); renderCabJournal(); };
  });
  box.querySelectorAll('[data-j-note]').forEach(btn => {
    btn.onclick = async () => {
      const s = cabinetVm.sessions.find(x => x.id === btn.dataset.jNote);
      if (!s) return;
      const text = await uiPrompt({
        title: 'Запись о сессии',
        label: 'Видна только вам',
        value: '',
        placeholder: 'Что было на сессии, наблюдения, план работы…',
        hint: 'Текст сохраняется в карточке клиента. При отмене введённое не теряется.',
        key: `session-note-${s.id}`,
        rows: 5
      });
      if (text?.trim()) {
        cabinetVm.addClientEntry({ clientId: s.clientId, sessionId: s.id, date: s.date, text: text.trim() });
        showToast('Запись сохранена в карточке клиента');
      }
    };
  });
  box.querySelectorAll('[data-j-noshow]').forEach(btn => {
    btn.onclick = async () => {
      const s = cabinetVm.sessions.find(x => x.id === btn.dataset.jNoshow);
      if (s && (await uiConfirm({
        title: 'Отметить неявку клиента?',
        message: `${s.date} ${s.time}`,
        confirmLabel: 'Отметить неявку'
      }))) {
        s.status = 'no_show';
        db.saveChanges();
        cabinetApi.pushSessionPatch(s.id, { status: 'no_show' });
        renderCabJournal();
      }
    };
  });
}

// ——— Задачи ———
function renderCabTasks() {
  const sel = $('#task-client');
  if (sel) {
    const current = sel.value;
    sel.innerHTML = '<option value="">— не привязывать —</option>' +
      cabinetVm.clients.map(c => `<option value="${c.id}">${esc(c.nickname || c.name)}</option>`).join('');
    sel.value = current;
  }
  const box = $('#tasks-list');
  if (!box) return;
  const list = cabinetVm.tasks;
  if (!list.length) {
    box.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Задач нет</div>';
    return;
  }
  box.innerHTML = list.map(t => {
    const cl = t.clientId ? cabinetVm.clientById(t.clientId) : null;
    const overdue = t.dueDate && !t.done && t.dueDate < todayStr();
    return `<div class="p-4 flex items-start gap-3 border-b last:border-0">
      <input type="checkbox" data-task-toggle="${t.id}" ${t.done ? 'checked' : ''} class="mt-1 accent-indigo-600">
      <div class="flex-1 min-w-0 ${t.done ? 'line-through text-slate-400' : ''}">
        <div class="font-medium">${esc(t.title)}</div>
        ${t.details ? `<div class="text-sm text-slate-500">${esc(t.details)}</div>` : ''}
        <div class="text-xs mt-1 ${overdue ? 'text-rose-500 font-medium' : 'text-slate-400'}">
          ${t.dueDate ? 'Срок: ' + formatDate(t.dueDate) : ''}${cl ? ` · клиент: ${esc(cl.nickname || cl.name)}` : ''}
        </div>
      </div>
      <button data-task-del="${t.id}" class="text-rose-500 text-sm shrink-0">Удалить</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-task-toggle]').forEach(el => {
    el.onchange = () => { cabinetVm.toggleTask(el.dataset.taskToggle); renderCabTasks(); };
  });
  box.querySelectorAll('[data-task-del]').forEach(el => {
    el.onclick = () => { cabinetVm.removeTask(el.dataset.taskDel); renderCabTasks(); };
  });
}

// ——— Блокнот (планировщик) ———
function renderCabNotepad() {
  const box = $('#notes-list');
  if (!box) return;
  const list = cabinetVm.notes;
  if (!list.length) {
    box.innerHTML = '<div class="bg-white rounded-xl border p-8 text-center text-slate-400 text-sm">Заметок нет. Планы на день, идеи, списки — всё сюда.</div>';
    return;
  }
  box.innerHTML = list.map(n => `
    <div class="bg-white rounded-xl border p-4 ${n.pinned ? 'border-amber-300 bg-amber-50/40' : ''}">
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          ${n.title ? `<div class="font-medium">${esc(n.title)}</div>` : ''}
          <div class="text-sm text-slate-700 whitespace-pre-wrap">${esc(n.body)}</div>
          <div class="text-xs text-slate-400 mt-2">${n.date ? formatDate(n.date) + ' · ' : ''}${n.pinned ? '📌 закреплено' : ''}</div>
        </div>
        <div class="flex flex-col gap-1 shrink-0">
          <button data-note-pin="${n.id}" class="text-xs text-amber-600">${n.pinned ? 'Открепить' : '📌'}</button>
          <button data-note-del="${n.id}" class="text-xs text-rose-500">Удалить</button>
        </div>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-note-pin]').forEach(el => {
    el.onclick = () => { cabinetVm.toggleNotePin(el.dataset.notePin); renderCabNotepad(); };
  });
  box.querySelectorAll('[data-note-del]').forEach(el => {
    el.onclick = () => { cabinetVm.removeNote(el.dataset.noteDel); renderCabNotepad(); };
  });
}

function renderCabBlocks() {
  const st = cabinetVm.settings;
  if (st) {
    $('#set-gcal-url') && ($('#set-gcal-url').value = st.googleCalendarIcalUrl || '');
    $('#set-gcal-sync') && ($('#set-gcal-sync').checked = st.googleSyncBusy !== false);
  }
  const box = $('#blocks-list');
  if (!box) return;
  const list = cabinetVm.blocks;
  if (!list.length) {
    box.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">Нет блокировок. Выходные и занятость закрываются формой слева.</div>';
    return;
  }
  box.innerHTML = list.map(b => `
    <div class="p-3 border-b last:border-0 flex items-center gap-3 text-sm">
      <span class="text-xs px-2 py-1 rounded-full bg-slate-100 shrink-0">${esc(cabinetVm.blockKindLabels[b.kind] || b.kind)}</span>
      <div class="flex-1 min-w-0">
        <div class="font-medium">${esc(b.title || 'Занят')}</div>
        <div class="text-slate-500 text-xs">${esc(b.dateFrom)}${b.dateTo && b.dateTo !== b.dateFrom ? ' → ' + esc(b.dateTo) : ''}${b.timeFrom ? ' · ' + esc(b.timeFrom) + '–' + esc(b.timeTo || '') : ' · весь день'}${b.source === 'google' ? ' · Google Calendar' : ''}</div>
        ${b.note ? `<div class="text-slate-400 text-xs">${esc(b.note)} <span class="text-slate-300">(только для вас)</span></div>` : ''}
      </div>
      <button data-del-block="${esc(b.id)}" class="text-rose-500 shrink-0">Снять</button>
    </div>`).join('');
  renderCabOverrides();
}

function renderCabOverrides() {
  const box = $('#overrides-list');
  if (!box) return;
  const list = cabinetVm.overrides;
  if (!list.length) {
    box.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">Нет особых дней.</div>';
    return;
  }
  box.innerHTML = list.map(o => `
    <div class="p-3 border-b last:border-0 flex items-center gap-3 text-sm">
      <span class="text-xs px-2 py-1 rounded-full bg-slate-100 shrink-0">${o.isClosed ? 'Закрыто' : 'Особое окно'}</span>
      <div class="flex-1 min-w-0">
        <div class="font-medium">${esc(o.title || (o.isClosed ? 'Закрыто' : 'Особый день'))}</div>
        <div class="text-slate-500 text-xs">${esc(o.date)}${!o.isClosed && (o.openFrom || o.openTo) ? ' · ' + esc(o.openFrom || '…') + '–' + esc(o.openTo || '…') : ''}</div>
      </div>
      <button data-del-override="${esc(o.id)}" class="text-rose-500 shrink-0">Удалить</button>
    </div>`).join('');
  box.querySelectorAll('[data-del-override]').forEach(btn => {
    btn.onclick = () => { cabinetVm.removeOverride(btn.dataset.delOverride); renderCabinet(); };
  });
}

function renderCabClients() {
  const box = $('#clients-list');
  if (!box) return;
  const list = cabinetVm.clients;
  if (!list.length) {
    box.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Нет клиентов</div>';
  } else {
    box.innerHTML = list.map(c => {
      const n = cabinetVm.sessions.filter(s => s.clientId === c.id && s.status !== 'cancelled').length;
      const entries = db.entriesOf(c.id).length;
      const selected = cabinetVm.selectedClientId === c.id;
      return `<div class="p-4 flex justify-between items-center border-b last:border-0 ${selected ? 'bg-indigo-50/50' : ''}">
        <div><div class="font-medium">${c.nickname || c.name}</div>
        <div class="text-sm text-slate-500">${c.phone || ''} · ${n} сессий${entries ? ` · ${entries} записей` : ''}${c.telegramChat ? ' · <span class="text-emerald-600">✓ Telegram</span>' : ''}</div>
        ${c.note ? `<div class="text-xs text-slate-400 mt-0.5">${c.note}</div>` : ''}</div>
        <div class="flex gap-2">
          <button data-sel-client="${c.id}" class="text-sm text-indigo-600">${selected ? 'Скрыть' : 'Карточка'}</button>
          <button data-edit-client="${c.id}" class="text-sm text-indigo-600">Изменить</button>
          <button data-del-client="${c.id}" class="text-sm text-rose-500">Удалить</button>
        </div></div>`;
    }).join('');
    box.querySelectorAll('[data-sel-client]').forEach(btn => {
      btn.onclick = () => { cabinetVm.selectClient(btn.dataset.selClient); renderCabClients(); };
    });
  }
  renderVaultPanel();
  renderClientDetail();
}

// ——— Сейф клиентов: статус и разблокировка паролем ———
function renderVaultPanel() {
  const box = $('#vault-panel');
  if (!box) return;
  const p = cabinetVm.psychologist;
  if (!p) { box.innerHTML = ''; return; }
  // Пароль сейфа вводится в настоящей <form> (Enter отправляет, нет DOM-ворнинга
  // «Password field is not contained in a form»), novalidate — валидирует сервис.
  if (!p.keyVerifier) {
    box.innerHTML = `<div class="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
      <div class="font-medium text-amber-900 mb-1">Сейф клиентов не настроен</div>
      <p class="text-amber-800 mb-2">Задайте пароль — из него выводится ключ шифрования карточек клиентов (пароль не хранится).</p>
      <form class="flex flex-wrap gap-2" novalidate><input id="vault-pass" type="password" autocomplete="new-password" placeholder="Пароль (мин. 6)" class="flex-1 min-w-[180px] px-3 py-2 rounded-xl border"><button id="btn-vault-init" type="submit" class="px-4 py-2 rounded-full bg-amber-600 text-white text-sm font-medium">Задать и открыть</button></form>
    </div>`;
  } else if (!authService.isVaultUnlocked()) {
    box.innerHTML = `<div class="mb-6 rounded-xl border p-4 text-sm">
      <div class="font-medium mb-1">🔒 Сейф клиентов закрыт</div>
      <form class="flex flex-wrap gap-2" novalidate><input id="vault-pass" type="password" autocomplete="current-password" placeholder="Пароль сейфа" class="flex-1 min-w-[180px] px-3 py-2 rounded-xl border"><button id="btn-vault-unlock" type="submit" class="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-medium">Открыть</button></form>
    </div>`;
  } else {
    box.innerHTML = '<div class="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">🔓 Сейф открыт — карточки клиентов расшифрованы</div>';
    return;
  }
  $('#btn-vault-init')?.closest('form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const r = await authService.initVaultPassword(p.id, $('#vault-pass')?.value);
    showToast(r.message, !r.ok);
    if (r.ok) {
      supabaseSync.pushProfile(p); // профиль → сервер; key_verifier отправляет initVaultPassword (pushKeyVerifier)
      renderCabClients();
    }
  });
  $('#btn-vault-unlock')?.closest('form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const r = await authService.unlockVault(p.id, $('#vault-pass')?.value);
    showToast(r.message, !r.ok);
    if (r.ok) renderCabClients();
  });
}

// ——— Карточка клиента: сессии + записи (журнал работы) ———
// ——— Кабинет: вкладка «Уведомления» (Telegram) ———
function renderCabTelegram() {
  const cfg = telegramService.config();
  const token = $('#tg-token');
  if (!token) return;
  if (cfg.botToken && !token.value) token.value = cfg.botToken;
  const label = $('#tg-chat-label');
  if (label) label.textContent = cfg.chatId ? `Выбран чат: ${cfg.chatId}${cfg.botName ? ` (бот @${cfg.botName})` : ''}` : 'Чат не выбран';
  $('#tg-notify-booking').checked = cfg.notifyBooking;
  $('#tg-notify-reminders').checked = cfg.notifyReminders;
  $('#tg-notify-payments').checked = cfg.notifyPayments;
  renderTgClients();
}

function renderTgClients() {
  const box = $('#tg-clients');
  if (!box) return;
  const cfg = telegramService.config();
  const clients = cabinetVm.clients;
  if (!clients.length) { box.innerHTML = '<div class="p-4 text-sm text-slate-400">Клиентов пока нет</div>'; return; }
  box.innerHTML = clients.map(c => {
    const invite = `https://t.me/${cfg.botName || 'ваш_бот'}?start=${c.id}`;
    return `<div class="p-3 flex justify-between items-center gap-2 border-b last:border-0 text-sm">
      <div><span class="font-medium">${esc(c.nickname || c.name)}</span>
        ${c.telegramChat ? '<span class="text-emerald-600 text-xs"> · ✓ подключен</span>' : '<span class="text-slate-400 text-xs"> · не подключен</span>'}</div>
      ${c.telegramChat
        ? `<button data-tg-unlink="${c.id}" class="text-xs text-rose-500">Отключить</button>`
        : `<button data-tg-copy-invite="${esc(invite)}" class="text-xs text-indigo-600">Скопировать приглашение</button>`}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-tg-copy-invite]').forEach(btn => {
    btn.onclick = async () => {
      const r = await copyText(btn.dataset.tgCopyInvite, { title: 'Ссылка-приглашение', label: 'Ссылка' });
      showToast(r.ok ? 'Ссылка-приглашение скопирована' : 'Скопируйте ссылку вручную', !r.ok);
    };
  });
  box.querySelectorAll('[data-tg-unlink]').forEach(btn => {
    btn.onclick = async () => {
      if (!(await uiConfirm({
        title: 'Отключить Telegram-уведомления?',
        message: 'Клиент перестанет получать уведомления в Telegram.',
        confirmLabel: 'Отключить'
      }))) return;
      cabinetVm.setClientTelegramChat(btn.dataset.tgUnlink, '');
      renderTgClients();
    };
  });
}

function bindTelegramTab() {
  const psy = cabinetVm.psychologist;
  if (!psy) return;

  $('#btn-tg-test')?.addEventListener('click', async () => {
    const token = $('#tg-token')?.value.trim();
    const out = $('#tg-test-result');
    if (!token) { out.textContent = 'Введите токен от @BotFather.'; out.className = 'text-xs mt-1 text-rose-500'; return; }
    out.textContent = 'Проверяем…'; out.className = 'text-xs mt-1 text-slate-400';
    try {
      const name = await telegramService.testToken(token);
      out.innerHTML = `✓ Бот найден: <b>@${esc(name)}</b>`;
      out.className = 'text-xs mt-1 text-emerald-600';
    } catch (e) {
      out.textContent = `✗ ${e.message}. Проверьте токен (формат 1234567890:AA…).`;
      out.className = 'text-xs mt-1 text-rose-500';
    }
  });

  $('#btn-tg-find-chat')?.addEventListener('click', async () => {
    const token = $('#tg-token')?.value.trim();
    const box = $('#tg-chats');
    const label = $('#tg-chat-label');
    if (!token) { showToast('Сначала введите токен бота', true); return; }
    box.innerHTML = '<div class="text-xs text-slate-400">Ищем сообщения…</div>';
    try {
      const chats = await telegramService.recentChats(token);
      if (!chats.length) {
        box.innerHTML = '<div class="text-xs text-slate-400">Пока нет сообщений боту. Откройте бота в Telegram и напишите /start, затем повторите.</div>';
        return;
      }
      box.innerHTML = chats.slice(0, 5).map((ch, i) => `
        <button data-i="${i}" class="w-full text-left px-3 py-2 rounded-xl border hover:bg-indigo-50 text-xs">
          <b>${esc(ch.name || 'Чат ' + ch.chatId)}</b> · chat_id <code>${esc(ch.chatId)}</code>
          ${ch.text ? ` · «${esc(ch.text.slice(0, 30))}»` : ''}
        </button>`).join('');
      box.querySelectorAll('button[data-i]').forEach(b => {
        b.onclick = () => {
          const ch = chats[+b.dataset.i];
          label.textContent = `Выбран чат: ${ch.chatId}${ch.name ? ` (${ch.name})` : ''}`;
          label.dataset.chatId = ch.chatId;
        };
      });
    } catch (e) {
      box.innerHTML = `<div class="text-xs text-rose-500">✗ ${esc(e.message)}</div>`;
    }
  });

  $('#btn-tg-save')?.addEventListener('click', () => {
    const token = $('#tg-token')?.value.trim() || '';
    const chatId = ($('#tg-chat-label')?.dataset.chatId) || telegramService.config().chatId || '';
    if (!token) { showToast('Введите токен бота', true); return; }
    if (!chatId) { showToast('Выберите ваш чат («Найти чат»)', true); return; }
    cabinetVm.saveTelegramSettings({
      botToken: token,
      chatId,
      notifyBooking: $('#tg-notify-booking')?.checked !== false,
      notifyReminders: $('#tg-notify-reminders')?.checked !== false,
      notifyPayments: $('#tg-notify-payments')?.checked !== false
    });
    telegramService.testToken(token).then(name => {
      cabinetVm.saveTelegramSettings({ botName: name });
      renderTgClients();
    }).catch(() => {});
    showToast('Настройки Telegram сохранены');
    renderCabTelegram();
  });

  $('#btn-tg-link-clients')?.addEventListener('click', async () => {
    const out = $('#tg-link-result');
    const token = $('#tg-token')?.value.trim() || telegramService.config().botToken;
    if (!token) { showToast('Сначала настройте токен бота', true); return; }
    out.textContent = 'Проверяем…';
    try {
      const r = await telegramService.linkClientChats(psy.id);
      await cabinetVm.refreshClients();
      out.textContent = `Новых подключений: ${r.linked}`;
      renderTgClients();
      renderCabClients();
      showToast(r.linked ? `Подключено клиентов: ${r.linked}` : 'Новых подключений нет');
    } catch (e) {
      out.textContent = `Ошибка: ${e.message}`;
    }
  });
}

function renderClientTelegramBlock(c) {
  const cfg = telegramService.config();
  if (c.telegramChat) {
    return '<div class="mt-3 flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2"><span class="w-2 h-2 rounded-full bg-emerald-500"></span> Telegram подключен — напоминания о сессиях приходят клиенту.</div>';
  }
  const invite = `https://t.me/${cfg.botName || 'ваш_бот'}?start=${c.id}`;
  return `<div class="mt-3 text-xs">
    <div class="flex flex-wrap items-center gap-2 text-slate-500">
      <span>Telegram не подключен</span>
      <button data-tg-invite class="px-3 py-1 rounded-full border border-indigo-300 text-indigo-700">Как подключить</button>
      <button data-tg-copy="${esc(invite)}" class="px-3 py-1 rounded-full border border-slate-300 text-slate-600">Скопировать ссылку-приглашение</button>
    </div>
    <div data-tg-invite-box class="hidden mt-2 p-3 rounded-xl bg-slate-50 text-slate-600 leading-relaxed">
      1. Настройте бота — вкладка «Уведомления».<br>
      2. Отправьте клиенту ссылку: <code class="select-all break-all">${esc(invite)}</code><br>
      3. Клиент нажимает <b>Start</b> у вашего бота.<br>
      4. На вкладке «Уведомления» нажмите «Проверить подключения (/start)» — чат привяжется автоматически.
    </div>
  </div>`;
}

function bindClientTelegramBlock(box) {
  box.querySelectorAll('[data-tg-invite]').forEach(btn => {
    btn.onclick = () => box.querySelector('[data-tg-invite-box]')?.classList.toggle('hidden');
  });
  box.querySelectorAll('[data-tg-copy]').forEach(btn => {
    btn.onclick = async () => {
      const r = await copyText(btn.dataset.tgCopy, { title: 'Ссылка', label: 'Ссылка' });
      showToast(r.ok ? 'Ссылка скопирована' : 'Скопируйте ссылку вручную', !r.ok);
    };
  });
}
// оставляем ссылку на функции в window: на неё опираются обработчики из разметки
window.bindClientTelegramBlock = bindClientTelegramBlock;

function renderClientDetail() {
  const box = $('#client-detail');
  if (!box) return;
  const c = cabinetVm.selectedClient;
  if (!c) { box.innerHTML = ''; return; }

  const sessions = cabinetVm.sessions.filter(s => s.clientId === c.id)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const entries = cabinetVm.clientEntriesOf(c.id);

  box.innerHTML = `
    <div class="bg-white rounded-xl border p-6">
      <h2 class="text-lg font-bold">${esc(c.nickname || c.name)}</h2>
      <div class="text-sm text-slate-500">${esc(c.name || '')}${c.phone ? ' · ' + esc(c.phone) : ''}${c.contact ? ' · ' + esc(c.contact) : ''}</div>
      ${c.note ? `<div class="text-xs text-slate-400 mt-1">${esc(c.note)}</div>` : ''}
      ${renderClientTelegramBlock(c)}

      <h3 class="font-semibold text-sm mt-5 mb-2">Сессии (${sessions.length})</h3>
      ${sessions.length ? `<div class="divide-y border rounded-xl mb-6 max-h-64 overflow-y-auto">
        ${sessions.map(s => {
          const sv = cabinetVm.serviceById(s.serviceId);
          return `<div class="p-2.5 text-sm flex justify-between gap-2">
            <span class="font-mono text-slate-500 shrink-0">${s.date} ${s.time}</span>
            <span class="flex-1">${sv?.name || ''}</span>
            <span class="text-xs px-2 py-0.5 rounded-full ${statusClass(s.status)} shrink-0">${statusLabel(s.status)}</span>
          </div>`;
        }).join('')}
      </div>` : '<p class="text-sm text-slate-400 mb-6">Сессий пока нет</p>'}

      <h3 class="font-semibold text-sm mb-2">Записи о работе (видны только вам)</h3>
      <div class="flex flex-wrap gap-2 items-end mb-3">
        <div><label class="text-xs text-slate-500 block">Дата</label><input id="ce-date" type="date" value="${todayStr()}" class="px-3 py-1.5 rounded-xl border text-sm"></div>
        <input id="ce-text" placeholder="Что происходило, наблюдения, договорённости…" class="flex-1 min-w-[220px] px-3 py-1.5 rounded-xl border text-sm">
        <button id="btn-add-ce" class="px-4 py-1.5 rounded-full bg-indigo-600 text-white text-sm">Добавить</button>
      </div>
      ${entries.length ? `<div class="space-y-2 max-h-80 overflow-y-auto">
        ${entries.map(e => `
        <div class="rounded-xl border p-3 text-sm">
          <div class="flex justify-between items-center">
            <span class="text-xs text-slate-400">${formatDate(e.date)}${e.sessionId ? ' · по сессии' : ''}</span>
            <button data-del-entry="${e.id}" class="text-xs text-rose-500">Удалить</button>
          </div>
          <div class="whitespace-pre-wrap mt-1">${esc(e.text)}</div>
        </div>`).join('')}
      </div>` : '<p class="text-sm text-slate-400">Записей пока нет</p>'}
    </div>`;

  $('#btn-add-ce')?.addEventListener('click', () => {
    const text = $('#ce-text')?.value;
    if (text?.trim()) {
      cabinetVm.addClientEntry({ clientId: c.id, text, date: $('#ce-date')?.value || todayStr() });
      renderCabClients();
    }
  });
  bindClientTelegramBlock(box);
  box.querySelectorAll('[data-del-entry]').forEach(btn => {
    btn.onclick = async () => {
      if (await uiConfirm({
        title: 'Удалить запись?',
        message: 'Запись журнала клиента будет удалена без восстановления.',
        confirmLabel: 'Удалить'
      })) {
        cabinetVm.removeClientEntry(btn.dataset.delEntry);
        renderCabClients();
      }
    };
  });
}

function renderCabServices() {
  const box = $('#services-list');
  if (!box) return;
  const dayShort = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  box.innerHTML = cabinetVm.services.map(s => {
    const av = s.availability;
    const avLabel = av ? `<div class="text-xs text-slate-400">доступность: ${
      [av.days?.length ? av.days.map(d => dayShort[d] || d).join(',') : null,
       (av.start || av.end) ? `${av.start || '…'}–${av.end || '…'}` : null].filter(Boolean).join(' · ')
    }</div>` : '';
    return `
    <div class="bg-white rounded-xl border p-4 flex justify-between items-center">
      <div><div class="font-medium">${s.name}</div>
      <div class="text-sm text-slate-500">${s.duration} мин · ${s.format === 'online' ? 'онлайн · Google Meet' : 'очно'}</div>${avLabel}</div>
      <div class="flex items-center gap-4">
        <span class="font-semibold text-indigo-700">${s.priceLabel()}</span>
        <button data-del-service="${s.id}" class="text-sm text-rose-500">Удалить</button>
      </div>
    </div>`;
  }).join('');
}

function renderCabWaiting() {
  const box = $('#waiting-list');
  if (!box) return;
  if (!cabinetVm.waiting.length) {
    box.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Пусто</div>';
    return;
  }
  box.innerHTML = cabinetVm.waiting.map(w => `
    <div class="p-4 border-b last:border-0 flex justify-between">
      <div>
        <div class="font-medium">${w.name} ${w.type === 'reschedule' ? '<span class="text-xs text-violet-600">перенос</span>' : ''}</div>
        <div class="text-sm text-slate-500">${w.phone || ''} · ${w.note || ''}</div>
      </div>
      <div class="flex gap-2">
        <button data-accept-wait="${w.id}" class="text-sm text-indigo-600">Записать</button>
        <button data-del-wait="${w.id}" class="text-sm text-rose-500">Удалить</button>
      </div>
    </div>`).join('');
}

function renderCabStats() {
  const st = cabinetVm.weekStats;
  $('#stat-week-count') && ($('#stat-week-count').textContent = st.count);
  let t = '';
  if (st.byn) t += st.byn + ' BYN';
  if (st.rub) t += (t ? ' / ' : '') + st.rub + ' ₽';
  $('#stat-week-sum') && ($('#stat-week-sum').textContent = t || '0');
  $('#stat-clients') && ($('#stat-clients').textContent = st.clients);
}

function renderCabReminders() {
  const list = cabinetVm.reminders;
  const box = $('#reminders-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Пока нет запланированных напоминаний. Они создаются при подтверждённой записи.</div>';
    return;
  }
  const stMap = { scheduled: 'Запланировано', sent: 'Отправлено', confirmed: 'Клиент подтвердил', declined: 'Клиент отказался', skipped: 'Пропущено', failed: 'Ошибка' };
  box.innerHTML = list.slice(0, 40).map(r => {
    const cl = cabinetVm.clientById(r.clientId);
    const s = cabinetVm.sessions.find(x => x.id === r.sessionId);
    return `<div class="p-4 text-sm flex flex-col sm:flex-row sm:justify-between gap-2">
      <div>
        <div class="font-medium">${cl?.name || '—'} · ${s ? s.date + ' ' + s.time : ''}</div>
        <div class="text-slate-500 text-xs mt-1">на ${r.scheduledFor ? new Date(r.scheduledFor).toLocaleString('ru-RU') : '—'} · ${stMap[r.status] || r.status}</div>
        ${r.status === 'sent' ? `<button type="button" data-open-token="${r.responseToken}" class="text-xs text-indigo-600 mt-1">Записать ответ клиента</button>` : ''}
      </div>
      <div class="text-xs text-slate-400 max-w-xs line-clamp-2">${(r.messageBody || '').slice(0, 120)}…</div>
    </div>`;
  }).join('');
}

function renderCabPayments() {
  const st = cabinetVm.settings;
  if (!st) return;
  const policy = $('#set-pay-policy');
  if (policy) policy.value = st.paymentPolicy || 'deposit';
  $('#set-deposit-pct') && ($('#set-deposit-pct').value = st.depositPercent ?? 30);
  $('#set-hold-min') && ($('#set-hold-min').value = st.holdMinutes ?? 60);
  $('#set-max-unpaid') && ($('#set-max-unpaid').value = st.maxActiveUnpaidPerPhone ?? 1);
  $('#set-max-day') && ($('#set-max-day').value = st.maxBookingsPerDayPerPhone ?? 2);
  $('#set-block-noshow') && ($('#set-block-noshow').value = st.blockAfterNoShows ?? 2);
  $('#set-reminder-hours') && ($('#set-reminder-hours').value = st.reminderHoursBefore ?? 24);
  $('#set-reminder-second') && ($('#set-reminder-second').value = st.reminderSecondHoursBefore ?? 12);
  // D1: политика доступности
  $('#set-min-notice') && ($('#set-min-notice').value = st.minNoticeMinutes ?? 0);
  $('#set-max-advance') && ($('#set-max-advance').value = st.maxAdvanceDays ?? '');
  $('#set-buf-before') && ($('#set-buf-before').value = st.bufferBeforeMin ?? 0);
  $('#set-buf-after') && ($('#set-buf-after').value = st.bufferAfterMin ?? 0);
  $('#set-increment') && ($('#set-increment').value = st.slotIncrementMin ?? '');
  $('#set-max-day-cap') && ($('#set-max-day-cap').value = st.maxBookingsPerDay ?? '');
  $('#set-max-week-cap') && ($('#set-max-week-cap').value = st.maxBookingsPerWeek ?? '');
  const held = cabinetVm.heldUnpaid;
  const box = $('#held-list');
  if (box) {
    box.innerHTML = held.length ? held.map(s => {
      const cl = cabinetVm.clientById(s.clientId);
      return `<div class="p-3 border-b flex justify-between text-sm"><span>${cl?.name || '—'} · ${s.date} ${s.time} · ${s.amountDue} ${s.currency}</span>
        <button data-mark-paid="${s.id}" class="text-emerald-600">Подтвердить оплату</button></div>`;
    }).join('') : '<div class="p-4 text-slate-400 text-sm">Нет ожидающих оплаты</div>';
  }
}

// ——— Редактор списков публичного профиля (направления, образование, опыт, ссылки) ———
const PE_FIELDS = {
  'pe-directions': [['title', 'Название'], ['details', 'Детали (в скобках)']],
  'pe-edu-basic': [['title', 'Название / программа'], ['institution', 'Учреждение'], ['details', 'Детали']],
  'pe-edu-extra': [['title', 'Название'], ['institution', 'Учреждение'], ['details', 'Детали']],
  'pe-experience': [['organisation', 'Организация'], ['details', 'Описание'], ['years', 'Лет']],
  'pe-links': [['label', 'Подпись кнопки'], ['url', 'URL'], ['kind', 'Тип: service|donation|other']]
};

function addPeRow(id, values = {}) {
  const box = document.getElementById(id);
  const fields = PE_FIELDS[id];
  if (!box || !fields) return;
  const row = document.createElement('div');
  row.className = 'pe-row flex gap-2 items-center';
  row.innerHTML = fields.map(([key, label]) =>
    `<input data-pe-key="${key}" placeholder="${esc(label)}" class="flex-1 min-w-0 px-3 py-1.5 rounded-lg border text-sm" value="${esc(values[key] ?? '')}">`
  ).join('') + '<button type="button" data-pe-del class="text-rose-500 px-1 shrink-0" title="Удалить">✕</button>';
  row.querySelector('[data-pe-del]').onclick = () => row.remove();
  box.appendChild(row);
}

function renderPeList(id, items) {
  const box = document.getElementById(id);
  if (!box) return;
  box.innerHTML = '';
  (items || []).forEach(it => addPeRow(id, it));
}

function collectPeList(id) {
  const box = document.getElementById(id);
  if (!box) return [];
  return [...box.querySelectorAll('.pe-row')].map(row => {
    const obj = {};
    row.querySelectorAll('[data-pe-key]').forEach(inp => { obj[inp.dataset.peKey] = inp.value.trim(); });
    return obj;
  }).filter(o => Object.values(o).some(Boolean));
}

function renderCabProfile() {
  const p = cabinetVm.psychologist;
  if (!p) return;
  $('#pf-name') && ($('#pf-name').value = p.fullName);
  $('#pf-phone') && ($('#pf-phone').value = p.phone || '');
  $('#pf-spec') && ($('#pf-spec').value = p.specialization || '');
  $('#pf-city') && ($('#pf-city').value = p.city || '');
  $('#pf-greeting') && ($('#pf-greeting').value = p.greeting || '');
  $('#pf-about') && ($('#pf-about').value = p.about || '');
  $('#pf-approach') && ($('#pf-approach').value = p.approach || '');
  $('#pf-photo') && ($('#pf-photo').value = p.photoUrl || '');
  $('#pf-public-email') && ($('#pf-public-email').value = p.publicEmail || '');
  $('#pf-address') && ($('#pf-address').value = p.address || '');
  $('#pf-website') && ($('#pf-website').value = p.website || '');
  const tg = (p.socials || []).find(s => s.kind === 'telegram');
  const ig = (p.socials || []).find(s => s.kind === 'instagram');
  $('#pf-telegram') && ($('#pf-telegram').value = tg?.url || '');
  $('#pf-instagram') && ($('#pf-instagram').value = ig?.url || '');
  $('#pf-email') && ($('#pf-email').textContent = p.email);

  renderPeList('pe-directions', p.directions);
  renderPeList('pe-edu-basic', p.education?.basic);
  renderPeList('pe-edu-extra', p.education?.additional);
  renderPeList('pe-experience', (p.experienceItems || []).map(x => ({
    organisation: x.organisation, details: x.details, years: x.years ?? ''
  })));
  renderPeList('pe-links', p.paymentLinks);

  const req = p.paymentRequisites || {};
  $('#pe-req-recipient') && ($('#pe-req-recipient').value = req.recipient || '');
  $('#pe-req-legal-address') && ($('#pe-req-legal-address').value = req.legalAddress || '');
  $('#pe-req-unp') && ($('#pe-req-unp').value = req.unp || '');
  $('#pe-req-account') && ($('#pe-req-account').value = req.account || '');
  $('#pe-req-bank') && ($('#pe-req-bank').value = req.bankName || '');
  $('#pe-req-bik') && ($('#pe-req-bik').value = req.bik || '');
  $('#pe-req-purpose') && ($('#pe-req-purpose').value = req.purpose || '');
  $('#pe-req-donation') && ($('#pe-req-donation').value = req.donationUrl || '');
}

function renderCabLink() {
  const p = cabinetVm.psychologist;
  const url = urlFor.bookingLink(p.slug);
  $('#pub-link') && ($('#pub-link').value = url);
  $('#pub-slug') && ($('#pub-slug').textContent = p.slug);
}

function serviceMetaLine(s) {
  const format = s.format === 'online'
    ? 'онлайн · ' + ((s.platforms || []).map(x => PLATFORM_TITLES[x] || x).join(', ') || 'Google Meet')
    : 'очно';
  return `${s.duration} мин · ${format}`;
}

/** Публичный профиль психолога на странице записи (модель сайта — без потерь) */
// ——— Страница специалиста /psy/{slug}: SEO-лендинг (профиль без формы записи) ———
function renderProfile() {
  const slug = route.params.slug;
  const p = db.findPsychologistBySlug(slug);
  const body = $('#prof-body');
  if (!body) return;
  if (!p || !p.isActive) {
    // issue #74: та же каноническая правила, что и в renderBooking — «не найдено»
    // показываем только когда каталог точно загружен. Пока он грузится, первый
    // визит по прямой ссылке /psy/{slug} не должен пугать «Страница не найдена».
    const catalogReady = portalVm.catalogReady;
    body.innerHTML = catalogReady
      ? '<div class="text-center py-20 text-slate-400">Страница не найдена. <button class="text-indigo-600" onclick="navigate(\'portal\')">К каталогу</button></div>'
      : (portalVm.source === 'none'
        ? '<div class="text-center py-20 text-slate-400">Нет связи с сервером данных. <button class="text-indigo-600" onclick="retryServerData()">Повторить</button></div>'
        : '<div class="text-center py-20 text-slate-400" aria-busy="true">Загружаем каталог с сервера…</div>');
    // честный ответ для поисковиков: несуществующая карточка не индексируется.
    // Пока каталог ещё грузится, noindex НЕ ставим — иначе валидная страница
    // успела бы попасть под noindex на первой отрисовке.
    try {
      if (catalogReady) applyNoIndex('profile: специалист не найден');
    } catch (e) { console.warn('seo', e); }
    return;
  }
  $('#prof-header-name') && ($('#prof-header-name').textContent = p.fullName);
  const services = db.servicesOf(p.id).filter(x => x.isActive !== false);

  const dirs = p.directions || [];
  const eduBasic = p.education?.basic || [];
  const eduExtra = p.education?.additional || [];
  const exp = p.experienceItems || [];
  const socials = p.socials || [];
  const links = p.paymentLinks || [];
  const req = p.paymentRequisites || {};
  const hasReq = req.recipient || req.account || req.unp || req.purpose;
  const bookUrl = urlFor.book(p.slug);

  const eduList = items => items.length
    ? `<ul class="mt-2 space-y-1.5 text-sm text-slate-700 list-disc list-inside">${items.map(x =>
        `<li>${esc(x.title)}${x.institution ? ` — <span class="text-slate-500">${esc(x.institution)}</span>` : ''}${x.details ? ` <span class="text-slate-500">(${esc(x.details)})</span>` : ''}</li>`).join('')}</ul>`
    : '';

  const expHtml = exp.length
    ? `<ul class="mt-2 space-y-1.5 text-sm text-slate-700 list-disc list-inside">${exp.map(x =>
        `<li><span class="font-medium">${esc(x.organisation || x.details)}</span>${x.details && x.organisation ? ` — ${esc(x.details)}` : ''}${x.years ? ` <span class="text-slate-500">(${esc(x.years)} ${x.isCurrent ? 'лет, по наст. время' : 'лет'})</span>` : ''}</li>`).join('')}</ul>`
    : (p.experience ? `<p class="mt-2 text-sm text-slate-700">${esc(p.experience)}</p>` : '');

  const reqHtml = hasReq ? `
      <h3 class="font-semibold text-slate-900 mt-6">Реквизиты для оплаты</h3>
      <div class="mt-2 text-sm text-slate-700 space-y-0.5">
        ${req.recipient ? `<div>Получатель: ${esc(req.recipient)}</div>` : ''}
        ${req.legalAddress ? `<div>Адрес: ${esc(req.legalAddress)}</div>` : ''}
        ${req.unp ? `<div>УНП: ${esc(req.unp)}</div>` : ''}
        ${req.account ? `<div>Р/с: ${esc(req.account)}</div>` : ''}
        ${req.bankName ? `<div>Банк: ${esc(req.bankName)}</div>` : ''}
        ${req.bik ? `<div>БИК: ${esc(req.bik)}</div>` : ''}
        ${req.purpose ? `<div>Назначение платежа: ${esc(req.purpose)}</div>` : ''}
      </div>` : '';

  // —— Контакты и связь: телефон + мессенджеры + соцсети ——
  const digits = String(p.phone || '').replace(/\D/g, '');
  const tg = socials.find(x => x.kind === 'telegram' && x.url);
  const ig = socials.find(x => x.kind === 'instagram' && x.url);

  const icons = {
    phone: `<svg class="w-5 h-5 fill-current shrink-0" viewBox="0 0 24 24"><path d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>`,
    whatsapp: `<svg class="w-5 h-5 fill-current shrink-0" viewBox="0 0 24 24"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.299.412 2.503 1.112 3.487l-.729 2.661 2.728-.715a5.728 5.728 0 0 0 2.657.66h.002c3.181 0 5.767-2.586 5.768-5.766 0-3.18-2.586-5.767-5.77-5.767zm3.373 8.163c-.144.405-.837.774-1.17.825-.312.046-.72.072-2.132-.513-1.808-.748-2.955-2.593-3.045-2.713-.09-.12-.735-.978-.735-1.865 0-.887.465-1.323.63-1.492.165-.168.36-.21.48-.21.12 0 .24.001.345.006.111.006.261-.042.408.318.15.36.51 1.245.555 1.335.045.09.075.195.015.315-.06.12-.09.195-.18.3-.09.105-.189.235-.27.315-.09.09-.184.188-.079.368.105.18.468.772 1.004 1.238.689.598 1.27.784 1.45.874.18.09.285.075.39-.045.105-.12.45-.525.57-.705.12-.18.24-.15.405-.09.165.06 1.05.495 1.23.585.18.09.3.135.345.21.045.075.045.435-.099.84zm-3.373-10.335c-4.28 0-7.763 3.483-7.765 7.765 0 1.368.358 2.703 1.038 3.882L4 20l4.312-1.131a7.712 7.712 0 0 0 3.719 1.028h.003c4.281 0 7.764-3.483 7.765-7.765 0-4.282-3.483-7.765-7.768-7.765z"/></svg>`,
    viber: `<svg class="w-5 h-5 fill-current shrink-0" viewBox="0 0 24 24"><path d="M19.67 15.74c-.67-.28-3.92-1.92-4.52-2.12-.61-.2-1.06-.28-1.51.28-.45.56-1.74 2.12-2.13 2.56-.39.44-.78.5-1.45.22-.67-.28-2.83-1.04-5.39-3.32-1.99-1.77-3.34-3.96-3.73-4.63-.39-.67-.04-1.03.24-1.31.25-.25.56-.67.84-1 .28-.33.37-.56.56-.95.19-.39.09-.73-.05-1.01-.14-.28-1.28-3.08-1.75-4.22-.46-1.11-.93-.96-1.28-.98-.33-.02-.71-.02-1.09-.02-.38 0-.99.14-1.51.56C.47 5.43 0 7.19 0 9.17c0 2.87.97 5.76 2.75 8.35 2.15 3.14 5.09 5.56 8.56 6.88 1.13.43 2.27.67 3.39.67 1.48 0 2.88-.41 3.99-1.2 1.48-1.05 2.31-2.61 2.31-4.28 0-.58-.11-1.16-.33-1.85z"/></svg>`,
    telegram: `<svg class="w-5 h-5 fill-current shrink-0" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.56 8.16l-2.02 9.51c-.15.7-.56.87-1.13.54l-3.06-2.26-1.48 1.42c-.16.16-.3.3-.61.3l.22-3.11 5.66-5.12c.25-.22-.05-.34-.38-.13l-7 4.41-3.02-.95c-.66-.2-.67-.66.14-.98l11.8-4.55c.55-.2 1.03.14.88.92z"/></svg>`,
    email: `<svg class="w-5 h-5 fill-current shrink-0" viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`,
    instagram: `<svg class="w-5 h-5 fill-current shrink-0" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 2.156 4.919 5.406.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 5.234-4.919 5.383-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-2.199-4.919-5.424-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-5.234 4.919-5.383 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>`,
    website: `<svg class="w-5 h-5 fill-current shrink-0" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`
  };

  const iconBtnActive = (color) => `w-11 h-11 inline-flex items-center justify-center rounded-xl transition-all shadow-sm ${color}`;
  const iconBtnDisabled = `w-11 h-11 inline-flex items-center justify-center rounded-xl bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed opacity-50`;

  const contactBtns = [
    p.phone
      ? `<a href="tel:+${esc(digits)}" title="Телефон: ${esc(p.phone)}" aria-label="Телефон: ${esc(p.phone)}" class="${iconBtnActive('bg-slate-900 text-white hover:bg-slate-800')}">${icons.phone}</a>`
      : `<span class="${iconBtnDisabled}" title="Телефон не указан">${icons.phone}</span>`,

    digits
      ? `<a href="https://wa.me/${esc(digits)}" target="_blank" rel="noopener noreferrer" title="WhatsApp: +${esc(digits)}" aria-label="WhatsApp" class="${iconBtnActive('bg-emerald-600 text-white hover:bg-emerald-700')}">${icons.whatsapp}</a>`
      : `<span class="${iconBtnDisabled}" title="WhatsApp недоступен">${icons.whatsapp}</span>`,

    digits
      ? `<a href="viber://chat?number=%2B${esc(digits)}" title="Viber: +${esc(digits)}" aria-label="Viber" class="${iconBtnActive('bg-purple-600 text-white hover:bg-purple-700')}">${icons.viber}</a>`
      : `<span class="${iconBtnDisabled}" title="Viber недоступен">${icons.viber}</span>`,

    tg
      ? `<a href="${esc(tg.url)}" target="_blank" rel="noopener noreferrer" title="Telegram: ${esc(tg.url)}" aria-label="Telegram" class="${iconBtnActive('bg-sky-500 text-white hover:bg-sky-600')}">${icons.telegram}</a>`
      : `<span class="${iconBtnDisabled}" title="Telegram не указан">${icons.telegram}</span>`,

    p.publicEmail
      ? `<a href="mailto:${esc(p.publicEmail)}" title="Email: ${esc(p.publicEmail)}" aria-label="Email" class="${iconBtnActive('border border-slate-300 text-slate-700 bg-white hover:bg-slate-50')}">${icons.email}</a>`
      : `<span class="${iconBtnDisabled}" title="Email не указан">${icons.email}</span>`,

    ig
      ? `<a href="${esc(ig.url)}" target="_blank" rel="noopener noreferrer" title="Instagram: ${esc(ig.url)}" aria-label="Instagram" class="${iconBtnActive('bg-gradient-to-r from-purple-500 via-pink-500 to-amber-500 text-white hover:opacity-90')}">${icons.instagram}</a>`
      : `<span class="${iconBtnDisabled}" title="Instagram не указан">${icons.instagram}</span>`,

    p.website
      ? `<a href="${esc(p.website)}" target="_blank" rel="noopener noreferrer" title="Сайт: ${esc(p.website)}" aria-label="Сайт" class="${iconBtnActive('border border-slate-300 text-slate-700 bg-white hover:bg-slate-50')}">${icons.website}</a>`
      : `<span class="${iconBtnDisabled}" title="Сайт не указан">${icons.website}</span>`
  ].join('');

  // —— Адрес практики и схема проезда (как на сайте специалиста) ——
  // MX-07: карта НЕ грузится автоматически (Google-embed в целевых сетях часто
  // недоступен и «подвешивает» страницу). По умолчанию — лёгкая заглушка
  // (адрес + кнопка), iframe (Яндекс по умолчанию, Google — альтернативой)
  // подгружается только по тапу — см. bindEvents() [data-map-load].
  const rawAddr = (p.address || '').trim();
  const city = (p.city || '').trim();
  let mapQuery = rawAddr;
  if (!mapQuery) {
    mapQuery = city;
  } else if (city && !rawAddr.toLowerCase().includes(city.toLowerCase())) {
    mapQuery = `${city}, ${rawAddr}`;
  }

  const addressHtml = (p.address || p.city) ? `
      <h3 class="font-semibold text-slate-900 mt-6">Адрес практики и проезд</h3>
      <p class="mt-2 text-sm text-slate-700">${esc(rawAddr || city)}</p>
      ${p.address ? `
      <div class="mt-3 rounded-xl overflow-hidden border bg-slate-50" data-map-box data-map-query="${esc(mapQuery)}">
        <div class="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200">
          <div class="text-sm font-medium text-slate-800 flex items-center gap-1.5">
            <span>📍</span> ${esc(p.address)}${p.city && !p.address.toLowerCase().includes(p.city.toLowerCase()) ? `, ${esc(p.city)}` : ''}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button type="button" data-map-load="yandex" class="h-10 px-4 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-1.5 min-w-[140px]">🗺️ Показать карту</button>
            <button type="button" data-map-load="google" class="h-10 px-4 rounded-xl border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-100 transition-colors inline-flex items-center justify-center gap-1.5 min-w-[100px]">Google</button>
          </div>
        </div>
        <div data-map-frame class="hidden w-full bg-slate-100"></div>
      </div>
      <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapQuery)}" data-route-link target="_blank" rel="noopener noreferrer" class="h-11 inline-flex items-center justify-center gap-2 px-4 rounded-xl border border-slate-300 text-slate-700 bg-white hover:bg-slate-50 text-sm font-medium transition-colors shadow-sm">🚗 Маршрут (Google Maps)</a>
        <a href="https://yandex.ru/maps/?rtext=~${encodeURIComponent(mapQuery)}" data-route-link target="_blank" rel="noopener noreferrer" class="h-11 inline-flex items-center justify-center gap-2 px-4 rounded-xl border border-slate-300 text-slate-700 bg-white hover:bg-slate-50 text-sm font-medium transition-colors shadow-sm">🚕 Маршрут (Яндекс)</a>
      </div>` : ''}` : '';

  // пометка первоисточника (фото/данные — с официального сайта специалиста, через БД портала)
  const srcHost = (() => { try { return new URL(p.sourceUrl).hostname; } catch { return ''; } })();

  // панель для владельца (видна только ему)
  const own = authService.isAuthenticated()
    && authService.currentPsychologist && authService.currentPsychologist.id === p.id;
  const banner = own ? `
    <div class="mb-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 flex flex-wrap items-center gap-3">
      <span class="text-sm font-medium text-emerald-800 flex-1">✓ Это ваша публичная страница — так её видят клиенты</span>
      <button data-cabtab="journal" class="own-page-btn px-4 py-2 rounded-full bg-emerald-600 text-white text-sm font-medium">Книга записей</button>
      <button data-cabtab="tasks" class="own-page-btn px-4 py-2 rounded-full border border-emerald-300 text-emerald-700 text-sm font-medium bg-white">Задачи</button>
      <button data-cabtab="notepad" class="own-page-btn px-4 py-2 rounded-full border border-emerald-300 text-emerald-700 text-sm font-medium bg-white">Блокнот</button>
      <button data-cabtab="home" class="own-page-btn px-4 py-2 rounded-full border border-emerald-300 text-emerald-700 text-sm font-medium bg-white">Кабинет</button>
    </div>` : '';

  body.innerHTML = `${banner}
    <div class="rounded-2xl bg-white border p-6">
      <div class="flex flex-col sm:flex-row gap-5 items-start">
        ${p.photoUrl
          ? `<img src="${esc(p.photoUrl)}" alt="${esc(p.fullName)}" class="w-36 h-36 object-cover rounded-2xl shrink-0">`
          : `<div class="w-36 h-36 rounded-2xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-4xl shrink-0">${esc(p.fullName.split(' ').map(x => x[0]).slice(0, 2).join(''))}</div>`}
        <div class="flex-1">
          <p class="text-slate-600">${esc(p.greeting || '')}</p>
          ${p.about ? `<p class="text-sm text-slate-700 mt-2">${esc(p.about)}</p>` : ''}
          ${p.approach ? `<p class="text-sm text-slate-700 mt-2">${esc(p.approach)}</p>` : ''}
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <a href="${esc(bookUrl)}" data-spa-book data-slug="${esc(p.slug)}" class="px-8 py-3 rounded-full bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700">Записаться на консультацию</a>
            <button onclick="sharePsyLink('${esc(p.slug || p.id)}')" class="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:underline">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>
              Поделиться специалистом
            </button>
          </div>
        </div>
      </div>

      ${dirs.length ? `
      <h3 class="font-semibold text-slate-900 mt-6">С чем могу помочь</h3>
      <ul class="mt-2 space-y-1.5 text-sm text-slate-700 list-disc list-inside">
        ${dirs.map(d => `<li>${esc(d.title)}${d.details ? ` <span class="text-slate-500">(${esc(d.details)})</span>` : ''}</li>`).join('')}
      </ul>` : ''}

      ${services.length ? `
      <h3 class="font-semibold text-slate-900 mt-6">Услуги и стоимость</h3>
      <p class="text-xs text-slate-500 mt-0.5">Нажмите на услугу — покажем её свободные окна и сразу перейдём к записи.</p>
      <div class="mt-2 divide-y border rounded-xl overflow-hidden">
        ${services.map(x => `
        <a href="${esc(urlFor.book(p.slug))}?service=${encodeURIComponent(x.id)}" class="p-3 flex justify-between items-start gap-3 text-sm hover:bg-indigo-50/60 transition-colors">
          <div><div class="font-medium">${esc(x.name)}</div>
          <div class="text-slate-500">${esc(serviceMetaLine(x))}</div>
          ${x.description ? `<div class="text-slate-500">${esc(x.description)}</div>` : ''}</div>
          <div class="text-right shrink-0">
            <div class="font-semibold text-indigo-700 whitespace-nowrap">${esc(x.priceLabel())}</div>
            <div class="text-xs text-indigo-600 mt-0.5 whitespace-nowrap">свободные окна →</div>
          </div>
        </a>`).join('')}
      </div>` : ''}

      ${eduBasic.length ? `<h3 class="font-semibold text-slate-900 mt-6">Образование</h3>${eduList(eduBasic)}` : ''}
      ${eduExtra.length ? `<h3 class="font-semibold text-slate-900 mt-6">Дополнительное образование</h3>${eduList(eduExtra)}` : ''}

      ${expHtml ? `<h3 class="font-semibold text-slate-900 mt-6">Опыт</h3>${expHtml}` : ''}

      ${links.length ? `
      <h3 class="font-semibold text-slate-900 mt-6">Оплата онлайн</h3>
      <div class="mt-2 flex flex-wrap gap-2">
        ${links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">${esc(l.label)}</a>`).join('')}
      </div>` : ''}
      ${reqHtml}

      ${addressHtml}

      ${contactBtns ? `<h3 class="font-semibold text-slate-900 mt-6">Связь и мессенджеры</h3>
      <div class="mt-2.5 flex flex-wrap items-center gap-2">${contactBtns}</div>` : ''}
    </div>
    ${srcHost ? `<p class="mt-4 text-xs text-slate-400 text-center">Профиль из БД портала · фото и данные — с официального сайта: <a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener" class="underline">${esc(srcHost)}</a></p>` : ''}`;

  // SEO-лендинг: canonical/OG/JSON-LD именно здесь
  try { applyProfileSeo(p, services, urlFor.psy(p.slug), { bookUrl: urlFor.book(p.slug) }); } catch (e) { console.warn('seo', e); }
}

/** T-01: сохранить введённые поля формы в VM перед перерисовкой (без потери данных) */
function captureBookingForm() {
  const nick = $('#bk-nickname'); if (nick) bookingVm.nickname = nick.value;
  const phone = $('#bk-phone'); if (phone) bookingVm.phone = phone.value;
  const contact = $('#bk-contact'); if (contact) bookingVm.contact = contact.value;
  const note = $('#bk-note'); if (note) bookingVm.note = note.value;
  const consent = $('#bk-consent'); if (consent) bookingVm.consent = consent.checked;
}

function renderBooking() {
  const slug = route.params.slug;
  captureBookingForm(); // T-01: данные шагов живут в VM и переживают любую перерисовку
  // ==== НОВАЯ ФУНКЦИОНАЛЬНОСТЬ: сохраняем состояние формы записи ====
  // Перерисовка вызывается после выбора услуги, даты и времени. Повторный
  // loadBySlug сбрасывал введённые данные и делал отправку записи невозможной.
  if (slug && bookingVm.psychologist?.slug !== slug) {
    // T-04: ссылка с профиля «услуга → сразу её окна»: /book/{slug}?service=<id>
    const preService = new URLSearchParams(location.search).get('service');
    bookingVm.loadBySlug(slug, { service: preService });
  }
  // ==== КОНЕЦ новой функциональности ====
  if (!bookingVm.psychologist) {
    // issue #74: пока каталог ещё грузится, «не найден» показывать нельзя —
    // специалист придёт вместе с серверными данными, и это будет ТА ЖЕ самая
    // страница (первый визит по прямой ссылке /book/{slug} при пустом кэше).
    // Заглушка рисуется в отдельном контейнере #book-placeholder, а разметка
    // мастера только скрывается: раньше «Специалист не найден» ставился через
    // innerHTML прямо в #book-body и безвозвратно стирал #book-step-*,
    // #book-services и т.д. — после загрузки каталога рисовать было некуда.
    const catalogReady = portalVm.catalogReady;
    const ph = $('#book-placeholder');
    if (ph) {
      ph.innerHTML = catalogReady
        ? '<div class="text-center py-20 text-slate-400">Специалист не найден. <button class="text-indigo-600" onclick="navigate(\'portal\')">К каталогу</button></div>'
        : (portalVm.source === 'none'
          ? '<div class="text-center py-20 text-slate-400">Нет связи с сервером данных. <button class="text-indigo-600" onclick="retryServerData()">Повторить</button></div>'
          : '<div class="text-center py-20 text-slate-400" aria-busy="true">Загружаем каталог с сервера…</div>');
      ph.classList.remove('hidden');
    }
    $('#book-wizard-root')?.classList.add('hidden');
    // честный ответ для поисковиков: пустая страница записи не индексируется
    // (только когда каталог точно загружен — см. комментарий в renderProfile).
    try {
      if (catalogReady) applyNoIndex('booking: специалист не найден');
    } catch (e) { console.warn('seo', e); }
    return;
  }
  // issue #74: специалист нашёлся (каталог догрузился) — вернуть разметку
  // мастера, если до этого её скрывал плейсхолдер «загрузка/не найдено».
  $('#book-placeholder')?.classList.add('hidden');
  $('#book-wizard-root')?.classList.remove('hidden');
  if (bookingVm.done) {
    navigate('success');
    return;
  }
  const p = bookingVm.psychologist;
  // компактная головка: кто, где, ссылка на профиль
  $('#book-psy-name') && ($('#book-psy-name').textContent = p.fullName);
  $('#book-psy-spec') && ($('#book-psy-spec').textContent = p.specialization);
  $('#book-psy-city') && ($('#book-psy-city').textContent = (p.city || 'Онлайн') + ' · при необходимости Google Meet');
  const photo = $('#book-psy-photo');
  if (photo) {
    if (p.photoUrl) { photo.src = p.photoUrl; photo.classList.remove('hidden'); }
    else photo.classList.add('hidden');
  }
  const toProfile = $('#book-to-profile');
  if (toProfile) toProfile.href = urlFor.psy(p.slug);
  // SEO страницы записи (T-04/SEO: заголовок и описание — под выбранную услугу)
  try { applyBookingSeo(p, urlFor.book(p.slug), { service: bookingVm.selectedService }); } catch (e) { console.warn('seo', e); }

  // ——— общие помощники wizard'а (T-01) ———
  const scrollToWizard = () => {
    const el = document.getElementById('book-form-block');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const goStep = n => { bookingVm.goToStep(n); renderBooking(); scrollToWizard(); };

  // ——— индикатор прогресса ———
  const stepsBox = $('#book-steps');
  if (stepsBox) {
    stepsBox.innerHTML = bookingVm.steps.map(s => `
      <li class="flex-1">
        <button type="button" data-step="${s.id}" ${s.reachable ? '' : 'disabled'}
          aria-current="${s.state === 'current' ? 'step' : 'false'}"
          class="w-full flex flex-col items-center gap-1 py-1 ${s.reachable ? 'cursor-pointer' : 'cursor-not-allowed'}">
          <span class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
            s.state === 'done' ? 'bg-emerald-100 text-emerald-700'
              : s.state === 'current' ? 'bg-indigo-600 text-white'
                : 'bg-slate-100 text-slate-400'}">${s.state === 'done' ? '\u2713' : s.id}</span>
          <span class="text-xs font-medium ${
            s.state === 'current' ? 'text-indigo-700'
              : s.state === 'done' ? 'text-emerald-700' : 'text-slate-400'}">${esc(s.label)}</span>
        </button>
      </li>`).join('');
    stepsBox.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => goStep(Number(btn.dataset.step));
    });
  }

  // ——— показываем только активный шаг ———
  $$('.book-step').forEach(el => el.classList.add('hidden'));
  const activeStep = document.getElementById(`book-step-${bookingVm.step}`);
  if (activeStep) activeStep.classList.remove('hidden');

  // ——— ШАГ 1 · услуги (клик = услуга выбрана → сразу её окна) ———
  const svcBox = $('#book-services');
  if (svcBox) {
    svcBox.innerHTML = bookingVm.services.map(s => `
      <label class="flex items-start gap-4 p-4 rounded-xl border-2 cursor-pointer ${bookingVm.serviceId === s.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'}">
        <input type="radio" name="bs" value="${s.id}" ${bookingVm.serviceId === s.id ? 'checked' : ''} class="mt-1 accent-indigo-600">
        <span class="flex-1"><span class="block font-medium">${esc(s.name)}</span>
        <span class="block text-sm text-slate-500">${esc(serviceMetaLine(s))}</span>
        ${s.description ? `<span class="block text-sm text-slate-500 mt-0.5">${esc(s.description)}</span>` : ''}
        ${s.payUrl ? `<a href="${esc(s.payUrl)}" target="_blank" rel="noopener" class="inline-block mt-1 text-sm text-indigo-600 hover:underline" onclick="event.stopPropagation()">Оплатить ↗</a>` : ''}</span>
        <span class="font-semibold text-indigo-700">${esc(s.priceLabel())}</span>
      </label>`).join('');
    svcBox.querySelectorAll('input').forEach(inp => {
      inp.onchange = () => { bookingVm.selectServiceAndContinue(inp.value); renderBooking(); scrollToWizard(); };
    });
  }

  // ——— ШАГ 2 · день и время (сетка под длительность услуги, T-02) ———
  const step2Hint = $('#book-step-2-hint');
  if (step2Hint) {
    const svc = bookingVm.selectedService;
    step2Hint.textContent = svc
      ? `${svc.name} · ${bookingVm.selection?.durationLabel || `${bookingVm.durationMinutes} мин`} · приём ${bookingVm.dayWindowLabel}`
      : 'Выберите услугу на предыдущем шаге';
  }
  const tzNote = $('#book-tz-note');
  if (tzNote) {
    tzNote.textContent = bookingVm.timeZoneNote || '';
    tzNote.classList.toggle('hidden', !bookingVm.timeZoneNote);
  }

  const rangeBox = $('#book-range');
  if (rangeBox) {
    rangeBox.innerHTML = bookingVm.dateRangeOptions.map(o => {
      const free = bookingVm.freeCountInRange(o.days);
      return `<button type="button" data-range="${o.id}" class="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${bookingVm.dateRange === o.id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">${o.label}${free ? ` · ${free}` : ''}</button>`;
    }).join('');
    rangeBox.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => { bookingVm.setDateRange(btn.dataset.range); renderBooking(); };
    });
  }

  const daysBox = $('#book-days');
  if (daysBox) {
    daysBox.innerHTML = bookingVm.availableDays.map(d => {
      const off = bookingVm.dayBlockTitle(d);
      const free = bookingVm.freeCountOnDate(d);
      const label = off ? ` · ${esc(off)}` : (free ? '' : ' · нет окон');
      const dim = off || !free;
      return `<button type="button" data-day="${d}" title="${off ? esc(off) : (free ? `${free} свободных окон` : 'нет свободных окон')}" class="px-4 py-2 rounded-full text-sm whitespace-nowrap ${bookingVm.date === d ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200'} ${dim && bookingVm.date !== d ? 'opacity-50' : ''}">${formatDate(d)}${label}</button>`;
    }).join('');
    daysBox.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => { bookingVm.selectDate(btn.dataset.day); renderBooking(); };
    });
  }

  const slotsBox = $('#book-slots');
  if (slotsBox) {
    const foreign = bookingVm.isForeignTimeZone;
    slotsBox.innerHTML = bookingVm.slots.map(s => `
      <button type="button" data-time="${s.time}" ${s.available ? '' : 'disabled'}
        title="${s.available ? `${s.time}–${s.endTime}` : esc(s.reason || 'занято')}"
        class="py-2.5 px-1 rounded-lg border text-sm font-medium ${s.available ? '' : 'opacity-35 line-through cursor-not-allowed'} ${bookingVm.time === s.time ? 'bg-indigo-600 text-white border-indigo-600' : (s.available ? 'border-slate-200 hover:border-indigo-300' : 'border-slate-200')}">
        <span class="block">${s.time}</span>
        ${foreign ? `<span class="block text-[11px] font-normal opacity-75">${s.clientTime} у вас${s.clientDayShift ? ` (+${s.clientDayShift} д)` : ''}</span>` : ''}
      </button>`).join('');
    slotsBox.querySelectorAll('button:not([disabled])').forEach(btn => {
      btn.onclick = () => { bookingVm.selectTimeAndContinue(btn.dataset.time); renderBooking(); scrollToWizard(); };
    });
  }
  const slotHint = $('#book-slot-hint');
  if (slotHint) {
    const free = bookingVm.slotsAvailableCount;
    const text = free
      ? (bookingVm.isForeignTimeZone
        ? `Верхняя строка — время специалиста, нижняя — ваше. Свободных окон: ${free}.`
        : `Свободных окон: ${free}. Зачёркнутые часы заняты или не помещаются в приём.`)
      : 'На этот день свободных окон нет — выберите другую дату или период выше.';
    slotHint.textContent = text;
    slotHint.classList.remove('hidden');
  }

  // ——— ШАГ 3 · контакт + итог выбора ———
  const recap = $('#book-recap');
  if (recap) {
    const sel = bookingVm.selection;
    const shift = sel?.clientDayShift ? ` (${sel.clientDayShift > 0 ? '+' : '−'}${Math.abs(sel.clientDayShift)} дн)` : '';
    recap.innerHTML = !sel ? '' : `
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="font-medium">${esc(sel.serviceName)}</div>
          <div class="text-slate-500">${esc(sel.durationLabel)} · ${esc(sel.priceLabel)}</div>
        </div>
        <button type="button" data-step-link="1" class="shrink-0 text-xs text-indigo-600 hover:underline">изменить</button>
      </div>
      <div class="mt-2 pt-2 border-t border-slate-200 flex items-start justify-between gap-3">
        <div>
          <div class="font-medium">${formatDate(sel.date)}${sel.time ? ` · ${esc(sel.time)}–${esc(sel.endTime)}` : ''}</div>
          ${sel.isForeignTimeZone && sel.clientTime ? `<div class="text-slate-500">у вас: ${esc(sel.clientTime)}–${esc(sel.clientEndTime)}${shift}</div>` : ''}
          <div class="text-xs text-slate-400">время специалиста · ${esc(sel.psychologistTimeZone)}</div>
        </div>
        <button type="button" data-step-link="2" class="shrink-0 text-xs text-indigo-600 hover:underline">изменить</button>
      </div>`;
    recap.querySelectorAll('[data-step-link]').forEach(btn => {
      btn.onclick = () => goStep(Number(btn.dataset.stepLink));
    });
  }

  // ——— навигация wizard'а ———
  const backBtn = $('#book-back');
  if (backBtn) {
    backBtn.classList.toggle('hidden', bookingVm.step === 1);
    backBtn.onclick = () => goStep(bookingVm.step - 1);
  }
  const nextBtn = $('#book-next');
  const submitBtn = $('#book-submit');
  const canNext = bookingVm.canGoToStep(bookingVm.step + 1);
  if (nextBtn) {
    nextBtn.classList.toggle('hidden', bookingVm.step === 3);
    nextBtn.textContent = bookingVm.step === 1 ? 'Далее — выбрать время' : 'Далее — контакт';
    nextBtn.disabled = !canNext;
    nextBtn.classList.toggle('opacity-50', !canNext);
    nextBtn.onclick = () => goStep(bookingVm.step + 1);
  }
  if (submitBtn) {
    submitBtn.classList.toggle('hidden', bookingVm.step !== 3);
    renderBookingSubmitState();
  }
  const navHint = $('#book-nav-hint');
  if (navHint) {
    navHint.textContent = bookingVm.step === 3
      ? 'Заявка уйдёт специалисту сразу — он подтвердит запись'
      : (canNext ? '' : (bookingVm.step === 2 ? 'Выберите свободное время выше' : 'Выберите услугу'));
  }

  // ——— T-01: навигация между шагами + сводка на шаге 3 ———
  const back2 = $('#book-back-2'); if (back2) back2.onclick = () => bookingVm.prevStep();
  const next2 = $('#book-next-2'); if (next2) next2.onclick = () => bookingVm.nextStep();
  const back3 = $('#book-back-3'); if (back3) back3.onclick = () => bookingVm.prevStep();

  const sumBox = $('#book-contact-summary');
  if (sumBox) {
    const sv = bookingVm.selectedService;
    const parts = [
      sv ? esc(sv.name) : '',
      bookingVm.time ? `${formatDate(bookingVm.date)} в ${bookingVm.time}${bookingVm.tzDiffMin ? bookingVm._clientTimeNote() : ''}` : ''
    ].filter(Boolean);
    if (parts.length) {
      sumBox.classList.remove('hidden');
      sumBox.innerHTML = `
        <div class="text-slate-700 font-medium">${parts.join(' · ')}</div>
        <div class="text-xs mt-1">
          <a href="#" data-goto-step="1" class="text-indigo-600 hover:underline">изменить услугу</a> ·
          <a href="#" data-goto-step="2" class="text-indigo-600 hover:underline">изменить время</a>
        </div>`;
      sumBox.querySelectorAll('[data-goto-step]').forEach(a => {
        a.onclick = e => { e.preventDefault(); bookingVm.goToStep(Number(a.dataset.gotoStep)); renderBooking(); };
      });
    } else {
      sumBox.classList.add('hidden');
    }
  }

  // T-01: восстановление введённых контактов после перерисовки (без потери данных)
  const restoreVal = (id, v) => { const el = $(id); if (el && el.value !== v) el.value = v; };
  restoreVal('#bk-nickname', bookingVm.nickname || '');
  restoreVal('#bk-phone', bookingVm.phone || '');
  restoreVal('#bk-contact', bookingVm.contact || '');
  restoreVal('#bk-note', bookingVm.note || '');
  const consentEl = $('#bk-consent'); if (consentEl) consentEl.checked = bookingVm.consent;

  const err = $('#book-error');
  if (err) {
    err.textContent = bookingVm.error || '';
    err.classList.toggle('hidden', !bookingVm.error);
  }

  const payBox = $('#book-payment-info');
  if (payBox) {
    payBox.innerHTML = bookingVm.paymentSummaryText
      ? `<div class="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4 text-sm text-slate-700">${bookingVm.paymentSummaryText}</div>`
      : '';
  }

  const payActions = $('#book-pay-actions');
  const formBlock = $('#book-form-block');
  if (bookingVm.awaitingPayment) {
    formBlock?.classList.add('hidden');
    if (payActions) {
      payActions.classList.remove('hidden');
      // issue #121 (R14): панель оплаты — только серверный резерв. Демо-кнопок
      // «Оплатить картой (демо)» / «Я перевёл(а)» больше нет ни в каком режиме:
      // эквайринга на сайте нет, оплату подтверждает специалист в кабинете.
      const checkout = bookingVm.paymentCheckout;
      payActions.innerHTML = `
        <div class="rounded-2xl border border-orange-200 bg-orange-50 p-6 space-y-4">
          <h3 class="font-bold text-lg text-orange-900">${checkout.title || 'Ожидание оплаты'}</h3>
          <p class="text-sm text-orange-900/80">${checkout.lead || ''}</p>
          <p class="text-sm">К оплате сейчас: <strong>${checkout.dueLabel || ''}</strong></p>
          <p class="text-xs text-slate-500">${checkout.footnote || ''}</p>
        </div>`;
    }
  } else {
    formBlock?.classList.remove('hidden');
    payActions?.classList.add('hidden');
  }

  // T-04: при смене шага — вверх, чтобы клиент сразу видел окна выбранной услуги
  if (window.__lastBookStep !== undefined && window.__lastBookStep !== bookingVm.step) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  window.__lastBookStep = bookingVm.step;
}

let pendingReplyToken = null;

function renderClientReply() {
  const token = route.params.token || pendingReplyToken;
  pendingReplyToken = token;
  const r = db.reminders.find(x => x.responseToken === token);
  const msg = $('#reply-message');
  const actions = $('#reply-actions');
  const done = $('#reply-done');
  const icsEl = $('#reply-ics');
  if (!r) {
    if (msg) msg.textContent = 'Напоминание не найдено. Сначала отправьте due-напоминание из кабинета.';
    actions?.classList.add('hidden');
    icsEl?.classList.add('hidden');
    return;
  }
  // issue #65: клиент добавляет событие в любой календарь (.ics).
  // В запросе переноса время ещё не подтверждено, в отказе встречи нет —
  // артефакт показываем только для живой, подтверждённой записи.
  const session = db.sessions.find(s => s.id === r.sessionId);
  const psy = session ? db.psychologists.find(x => x.id === session.psychologistId) : null;
  const svc = session ? db.services.find(x => x.id === session.serviceId) : null;
  if (session && psy && r.kind !== 'reschedule_request' && r.status !== 'declined') {
    wireIcsDownload(
      icsEl,
      icsParamsForSession(session, psy, svc, {
        timezone: db.settingsOf(psy.id)?.timezone,
        url: psy.slug ? urlFor.psy(psy.slug) : ''
      }),
      icsEventFileName(psy.fullName, session.date, session.time)
    );
  } else {
    icsEl?.classList.add('hidden');
  }
  if (msg) msg.textContent = r.messageBody || 'Подтвердите или отмените запись.';
  const yesBtn = $('#btn-reply-yes');
  const noBtn = $('#btn-reply-no');
  if (r.kind === 'reschedule_request') {
    if (yesBtn) yesBtn.textContent = 'Согласен на новое время';
    if (noBtn) noBtn.textContent = 'Не согласен / оставить как было';
  } else {
    if (yesBtn) yesBtn.textContent = 'Подтвердить запись';
    if (noBtn) noBtn.textContent = 'Отказаться / отменить';
  }
  if (r.status === 'confirmed' || r.status === 'declined') {
    actions?.classList.add('hidden');
    if (done) {
      done.classList.remove('hidden');
      done.textContent = r.status === 'confirmed' ? 'Вы уже подтвердили запись.' : 'Вы уже отменили запись.';
    }
  } else {
    actions?.classList.remove('hidden');
    done?.classList.add('hidden');
  }
}

/**
 * Issue #65: привязка <a> к .ics-артефакту созданной записи
 * (download через Blob; тот же контракт данных, что у gcal-link).
 */
function wireIcsDownload(el, params, filename) {
  if (!el) return;
  try {
    const url = URL.createObjectURL(icsEventBlob(params));
    if (el.dataset.icsUrl) URL.revokeObjectURL(el.dataset.icsUrl);
    el.href = url;
    el.download = filename;
    el.dataset.icsUrl = url;
    el.classList.remove('hidden');
  } catch (e) {
    console.warn('[ics] не удалось сформировать .ics', e);
    el.classList.add('hidden');
  }
}

/** Параметры .ics-артефакта для записи (единая точка — issue #65). */
function icsParamsForSession(s, p, sv, { timezone, url = '' } = {}) {
  return {
    title: `${sv?.name || 'Консультация'} · ${p.fullName}`,
    date: s.date,
    time: s.time,
    durationMin: resolveDurationMinutes({ durationMin: s.durationMin, service: sv }),
    location: s.meetLink || '',
    details: p.greeting || '',
    url,
    timezone: timezone || 'Europe/Minsk',
    uid: `psyportal-session-${s.id}`
  };
}

function renderSuccess() {
  $('#success-text') && ($('#success-text').textContent = bookingVm.successText || 'Заявка принята');
  // «Добавить в Google Calendar» (аналог Calendly/Booksy) + «Добавить в календарь»
  // (.ics — Apple/Outlook/Google/Яндекс, issue #65) — для созданной записи
  const box = $('#success-gcal');
  if (!box) return;
  const s = bookingVm.createdSessionId ? db.sessions.find(x => x.id === bookingVm.createdSessionId) : null;
  const p = bookingVm.psychologist;
  const sv = bookingVm.selectedService;
  if (s && p) {
    const tz = bookingVm.settings?.timezone || 'Europe/Minsk';
    box.href = googleAddLink({
      title: `${sv?.name || 'Консультация'} · ${p.fullName}`,
      date: s.date,
      time: s.time,
      durationMin: resolveDurationMinutes({ durationMin: s.durationMin, service: sv }),
      location: s.meetLink || '',
      details: p.greeting || '',
      timezone: tz
    });
    box.classList.remove('hidden');
    wireIcsDownload(
      $('#success-ics'),
      icsParamsForSession(s, p, sv, { timezone: tz, url: urlFor.psy(p.slug) }),
      icsEventFileName(p.fullName, s.date, s.time)
    );
  } else {
    box.classList.add('hidden');
    $('#success-ics')?.classList.add('hidden');
  }
}

// ——— Event bindings ———
function bindEvents() {
  // Мобильный кабинет (#63): тогглы «…», sheet «Ещё», закрытие по Escape/подложке.
  bindCabinetMobile();
  // Реальные <a href> (индексируются) + SPA-навигация без перезагрузки
  document.addEventListener('click', e => {
    const bookA = e.target.closest('a[data-spa-book]');
    if (bookA) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate('booking', { slug: bookA.dataset.slug });
      return;
    }
    const a = e.target.closest('a[data-spa]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate('profile', { slug: a.dataset.slug });
  });

  // Portal search
  $('#portal-search')?.addEventListener('input', e => {
    portalVm.setQuery(e.target.value);
    renderPortal();
  });
  $('#portal-city')?.addEventListener('change', e => {
    portalVm.setCity(e.target.value);
    renderPortal();
  });

  // ——— Единственный вход специалиста: Google (Supabase Auth OAuth + PKCE) ———
  $('#btn-google-signin')?.addEventListener('click', async () => {
    if (authVm.googleBusy) return;
    authVm.googleBusy = true;
    authVm.setGoogleError('', '');
    renderAuth();
    try {
      // Успех = переход на accounts.google.com и возврат на callback
      // приложения; продолжение — в boot() через consumeGoogleRedirect().
      await googleAuthService.startGoogleSignIn({ returnTo: '#/cabinet' });
    } catch (ex) {
      authVm.googleBusy = false;
      const fail = googleAuthService.publicAuthFailure('start_failed', ex);
      authVm.setGoogleError(fail.message, fail.resolution || '', fail.correlationId || '');
      renderAuth();
    }
  });

  // ——— Онбординг: заполнение профиля после первого входа через Google ———
  $('#onb-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (authVm.busy) return;
    authVm.onboardingError = '';
    authVm.busy = true;
    renderOnboarding();
    try {
      const res = await googleAuthService.completeProfile({
        fullName: $('#onb-name')?.value || '',
        phone: $('#onb-phone')?.value || '',
        specialization: $('#onb-spec')?.value || '',
        city: $('#onb-city')?.value || '',
        about: $('#onb-about')?.value || ''
      });
      if (!res.ok) {
        authVm.onboardingError = res.message;
        renderOnboarding();
        return;
      }
      // Профиль — с сервера: там же выставлен profile_completed.
      const loaded = await registration.loadOwnedProfile(res.id);
      if (!loaded.ok) {
        authVm.onboardingError = loaded.message || 'Не удалось перечитать профиль';
        renderOnboarding();
        return;
      }
      try { await cabinetApi.refresh(loaded.psychologist.id); }
      catch (e) { console.warn('[onboarding] pull cabinet', e?.message || e); }
      await cabinetVm.refreshClients();
      startTelegramLoops(loaded.psychologist.id);
      showToast('Профиль заполнен, кабинет открыт');
      navigate('cabinet');
    } finally {
      authVm.busy = false;
    }
  });
  $('#onb-logout')?.addEventListener('click', () => { doLogout(); });

  // Cabinet nav
  // async — внутри асинхронные UI-диалоги (#64): удаление сессии/клиента и
  // отмена сессии спрашивают подтверждение через uiConfirm.
  document.addEventListener('click', async e => {
    const nav = e.target.closest('.cab-nav-btn');
    if (nav?.dataset.tab) {
      cabinetVm.switchTab(nav.dataset.tab);
      // MX-01 (#63): выбор раздела в sheet «Ещё» закрывает sheet.
      if (nav.closest('#modal-more')) closeMoreSheet();
      renderCabinet();
    }
    const es = e.target.closest('[data-edit-session]');
    if (es) openSessionModal(es.dataset.editSession);
    const ds = e.target.closest('[data-del-session]');
    if (ds && (await uiConfirm({
      title: 'Удалить сессию?',
      message: 'Сессия будет удалена из журнала и из расписания.',
      confirmLabel: 'Удалить'
    }))) {
      cabinetVm.deleteSession(ds.dataset.delSession);
      renderCabinet();
    }
    const dbk = e.target.closest('[data-del-block]');
    if (dbk) {
      cabinetVm.removeBlock(dbk.dataset.delBlock);
      renderCabinet();
    }
    const ec = e.target.closest('[data-edit-client]');
    if (ec) openClientModal(ec.dataset.editClient);
    const dc = e.target.closest('[data-del-client]');
    if (dc && (await uiConfirm({
      title: 'Удалить клиента?',
      message: 'Карточка клиента, его заметки и записи журнала будут удалены.',
      confirmLabel: 'Удалить'
    }))) {
      cabinetVm.deleteClient(dc.dataset.delClient);
      renderCabinet();
    }
    const dsvc = e.target.closest('[data-del-service]');
    if (dsvc) {
      cabinetVm.deleteService(dsvc.dataset.delService);
      renderCabinet();
    }
    const aw = e.target.closest('[data-accept-wait]');
    if (aw) {
      const client = cabinetVm.acceptWaiting(aw.dataset.acceptWait);
      renderCabinet();
      if (client) openSessionModal(null, client.id);
    }
    const dw = e.target.closest('[data-del-wait]');
    if (dw) {
      cabinetVm.removeWaiting(dw.dataset.delWait);
      renderCabinet();
    }
  });

  $('#btn-add-session')?.addEventListener('click', () => openSessionModal());
  $('#btn-add-client')?.addEventListener('click', () => openClientModal());
  $('#btn-add-service')?.addEventListener('click', () => openServiceModal());
  $('#btn-logout')?.addEventListener('click', () => {
    doLogout();
  });
  $('#btn-save-profile')?.addEventListener('click', () => {
    const p = cabinetVm.psychologist;
    const socials = [...(p?.socials || []).filter(s => !['telegram', 'instagram'].includes(s.kind))];
    const tg = $('#pf-telegram')?.value?.trim();
    const ig = $('#pf-instagram')?.value?.trim();
    if (tg) socials.push({ kind: 'telegram', url: tg, title: 'telegram' });
    if (ig) socials.push({ kind: 'instagram', url: ig, title: 'instagram' });

    const eduItem = x => ({ title: x.title || '', institution: x.institution || '', details: x.details || '' });
    const directions = collectPeList('pe-directions').map(x => ({ title: x.title || '', details: x.details || '' }));
    const eduBasic = collectPeList('pe-edu-basic').map(eduItem);
    const eduExtra = collectPeList('pe-edu-extra').map(eduItem);
    const experienceItems = collectPeList('pe-experience').map(x => ({
      organisation: x.organisation || '',
      details: x.details || '',
      years: x.years !== '' && x.years != null ? Number(x.years) : null,
      isCurrent: (p?.experienceItems || []).find(e => e.organisation === x.organisation)?.isCurrent ?? false
    }));
    const paymentLinks = collectPeList('pe-links').map(x => ({
      label: x.label || '', url: x.url || '', kind: x.kind || 'other'
    }));

    cabinetVm.updateProfile({
      fullName: $('#pf-name')?.value,
      phone: $('#pf-phone')?.value,
      specialization: $('#pf-spec')?.value,
      city: $('#pf-city')?.value,
      greeting: $('#pf-greeting')?.value,
      about: $('#pf-about')?.value,
      approach: $('#pf-approach')?.value,
      photoUrl: $('#pf-photo')?.value,
      publicEmail: $('#pf-public-email')?.value,
      address: $('#pf-address')?.value,
      website: $('#pf-website')?.value,
      socials,
      directions,
      education: { basic: eduBasic, additional: eduExtra },
      experienceItems,
      paymentLinks,
      paymentRequisites: {
        ...(p?.paymentRequisites || {}),
        recipient: $('#pe-req-recipient')?.value?.trim() || '',
        legalAddress: $('#pe-req-legal-address')?.value?.trim() || '',
        unp: $('#pe-req-unp')?.value?.trim() || '',
        account: $('#pe-req-account')?.value?.trim() || '',
        bankName: $('#pe-req-bank')?.value?.trim() || '',
        bik: $('#pe-req-bik')?.value?.trim() || '',
        purpose: $('#pe-req-purpose')?.value?.trim() || '',
        donationUrl: $('#pe-req-donation')?.value?.trim() || ''
      }
    });
    renderCabinet();
  });

  // ——— Задачи ———
  $('#btn-add-task')?.addEventListener('click', () => {
    cabinetVm.addTask({
      title: $('#task-title')?.value,
      details: $('#task-details')?.value,
      dueDate: $('#task-due')?.value,
      clientId: $('#task-client')?.value || null
    });
    ['#task-title', '#task-details', '#task-due'].forEach(s => { const el = $(s); if (el) el.value = ''; });
    renderCabTasks();
  });

  // ——— Блокнот ———
  $('#btn-add-note')?.addEventListener('click', () => {
    cabinetVm.addNote({
      title: $('#note-title')?.value,
      body: $('#note-body')?.value,
      date: $('#note-date')?.value
    });
    ['#note-title', '#note-body', '#note-date'].forEach(s => { const el = $(s); if (el) el.value = ''; });
    renderCabNotepad();
  });

  // ——— Панель владельца на своей странице + скролл к форме записи ———
  document.addEventListener('click', e => {
    const cab = e.target.closest('[data-cabtab]');
    if (cab) {
      e.preventDefault();
      if (!authService.isAuthenticated()) { navigate('auth', { mode: 'login' }); return; }
      cabinetVm.tab = cab.dataset.cabtab;
      navigate('cabinet');
      return;
    }
    const sc = e.target.closest('[data-scroll-book]');
    if (sc) {
      e.preventDefault();
      document.getElementById('book-form-block')?.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // добавление строк в списки профиля
  document.addEventListener('click', e => {
    const add = e.target.closest('[data-pe-add]');
    if (add) addPeRow(add.dataset.peAdd);
  });

  // —— Схема проезда: iframe подгружается по тапу (MX-07, issue #66) ——
  // Яндекс — по умолчанию (целевой рынок), Google — альтернатива.
  // Сохраняется возможность переключения между картами и адресная плашка.
  document.addEventListener('click', e => {
    const btn = e.target.closest('button[data-map-load]');
    if (!btn) return;
    const box = btn.closest('[data-map-box]');
    if (!box) return;
    const q = (box.dataset && box.dataset.mapQuery) || '';
    const provider = (btn.dataset && btn.dataset.mapLoad) || 'yandex';
    const src = provider === 'google'
      ? `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=15&output=embed`
      : `https://yandex.ru/map-widget/v1/?text=${encodeURIComponent(q)}&z=15`;

    // Переключение подсветки кнопок
    const allBtns = box.querySelectorAll ? box.querySelectorAll('button[data-map-load]') : [];
    allBtns.forEach(b => {
      const isAct = b === btn;
      if (isAct) {
        b.className = 'min-h-[44px] px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors';
      } else {
        b.className = 'min-h-[44px] px-4 py-2 rounded-full border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-100 transition-colors';
      }
    });

    const iframeHtml = `<iframe src="${esc(src)}" width="100%" height="260" style="border:0" loading="lazy" title="Схема проезда (${provider === 'google' ? 'Google Maps' : 'Яндекс.Карты'})" referrerpolicy="no-referrer-when-downgrade"></iframe>`;

    const frame = box.querySelector ? box.querySelector('[data-map-frame]') : null;
    if (frame) {
      frame.innerHTML = iframeHtml;
      if (frame.classList) frame.classList.remove('hidden');
    } else {
      box.innerHTML = iframeHtml;
    }
  });

  // Открытие внешних ссылок на маршруты (гарантирует открытие из iframe песочниц)
  document.addEventListener('click', e => {
    const routeA = e.target.closest('a[data-route-link]');
    if (routeA && routeA.href) {
      try {
        window.open(routeA.href, '_blank', 'noopener,noreferrer');
      } catch {
        // fallback to default browser navigation
      }
    }
  });

  // ——— Занятость: блокировки + Google Calendar ———
  $('#btn-add-block')?.addEventListener('click', () => {
    const ok = cabinetVm.addBlock({
      dateFrom: $('#blk-date-from')?.value,
      dateTo: $('#blk-date-to')?.value,
      timeFrom: $('#blk-time-from')?.value,
      timeTo: $('#blk-time-to')?.value,
      kind: $('#blk-kind')?.value,
      title: $('#blk-title')?.value,
      note: $('#blk-note')?.value
    });
    if (ok) {
      ['#blk-date-from', '#blk-date-to', '#blk-time-from', '#blk-time-to', '#blk-title', '#blk-note']
        .forEach(sel => { const el = $(sel); if (el) el.value = ''; });
    }
    renderCabinet();
  });

  // D1: особые дни (override расписания на дату)
  $('#btn-add-override')?.addEventListener('click', () => {
    const ok = cabinetVm.addOverride({
      date: $('#ovr-date')?.value,
      isClosed: $('#ovr-closed')?.checked !== false,
      openFrom: $('#ovr-from')?.value,
      openTo: $('#ovr-to')?.value,
      title: $('#ovr-title')?.value
    });
    if (ok) {
      ['#ovr-date', '#ovr-from', '#ovr-to', '#ovr-title']
        .forEach(sel => { const el = $(sel); if (el) el.value = ''; });
      const closed = $('#ovr-closed');
      if (closed) closed.checked = true;
    }
    renderCabinet();
  });

  $('#btn-save-gcal')?.addEventListener('click', () => {
    cabinetVm.saveCalendarSettings({
      googleCalendarIcalUrl: $('#set-gcal-url')?.value,
      googleSyncBusy: $('#set-gcal-sync')?.checked
    });
    renderCabinet();
  });

  $('#btn-sync-gcal')?.addEventListener('click', async () => {
    cabinetVm.saveCalendarSettings({
      googleCalendarIcalUrl: $('#set-gcal-url')?.value,
      googleSyncBusy: $('#set-gcal-sync')?.checked
    });
    await cabinetVm.syncGoogleCalendar();
    renderCabinet();
  });
  $('#btn-copy-link')?.addEventListener('click', async () => {
    const inp = $('#pub-link');
    if (!inp) return;
    // Копируем через Clipboard API; если контекст не-secure — sheet с готовым
    // текстом (нативного prompt больше нет), тост говорит правду.
    const r = await copyText(inp.value, { title: 'Публичная ссылка записи', label: 'Ссылка' });
    showToast(r.ok ? 'Ссылка скопирована' : 'Скопируйте ссылку вручную', !r.ok);
  });

  // Session modal
  const syncSessPurpose = () => {
    const personal = $('#sess-purpose-personal')?.checked;
    $('#sess-meeting-fields')?.classList.toggle('hidden', !!personal);
    $('#sess-reschedule-block')?.classList.toggle('hidden', !!personal);
    $('#sess-status-wrap')?.classList.toggle('hidden', !!personal);
    $('#sess-video-wrap')?.classList.toggle('hidden', !!personal);
    $('#sess-date-to-wrap')?.classList.toggle('hidden', !personal);
    $('#sess-time-to-wrap')?.classList.toggle('hidden', !personal);
    $('#sess-block-title-wrap')?.classList.toggle('hidden', !personal);
    $('#sess-personal-hint')?.classList.toggle('hidden', !personal);
    const title = $('#sess-modal-title');
    if (title) title.textContent = personal ? 'Личное время' : 'Сессия';
  };
  $('#sess-purpose-meeting')?.addEventListener('change', syncSessPurpose);
  $('#sess-purpose-personal')?.addEventListener('change', syncSessPurpose);

  $('#sess-save')?.addEventListener('click', () => {
    const personal = $('#sess-purpose-personal')?.checked;
    const ok = cabinetVm.saveSession({
      id: $('#sess-id')?.value || null,
      purpose: personal ? 'personal' : 'meeting',
      clientId: personal ? '' : $('#sess-client')?.value,
      serviceId: $('#sess-service')?.value,
      date: $('#sess-date')?.value,
      dateTo: $('#sess-date-to')?.value,
      time: $('#sess-time')?.value,
      timeTo: $('#sess-time-to')?.value,
      blockTitle: $('#sess-block-title')?.value,
      status: $('#sess-status')?.value,
      note: $('#sess-note')?.value,
      videoPlatform: $('#sess-platform')?.value,
      meetLink: $('#sess-meet')?.value,
      changeReason: $('#sess-change-reason')?.value || '',
      notifyClient: $('#sess-notify-client')?.checked !== false
    });
    if (ok && cabinetVm.lastRescheduleToken) {
      showToast('Открыть ответ клиента можно во вкладке Напоминания');
    }
    if (ok) {
      closeModal('modal-session');
      renderCabinet();
    } else if (cabinetVm.error) showToast(cabinetVm.error, true);
  });
  $('#sess-platform')?.addEventListener('change', () => {
    const p = $('#sess-platform').value;
    $('#sess-meet-wrap')?.classList.toggle('hidden', !['google_meet', 'zoom', 'other'].includes(p));
  });

  // Client modal
  $('#cl-save')?.addEventListener('click', async () => {
    const ok = await cabinetVm.saveClient({
      id: $('#cl-id')?.value || null,
      name: $('#cl-name')?.value,
      nickname: $('#cl-nickname')?.value || $('#cl-name')?.value,
      phone: $('#cl-phone')?.value,
      contact: $('#cl-contact')?.value,
      note: $('#cl-note')?.value
    });
    if (ok) {
      closeModal('modal-client');
      renderCabinet();
    } else if (cabinetVm.error) showToast(cabinetVm.error, true);
  });

  // Service modal
  $('#sv-save')?.addEventListener('click', () => {
    cabinetVm.addService({
      name: $('#sv-name')?.value,
      price: parseFloat($('#sv-price')?.value) || 0,
      currency: $('#sv-currency')?.value,
      duration: parseInt($('#sv-duration')?.value, 10) || DEFAULT_DURATION_MIN,
      format: $('#sv-format')?.value,
      days: $('#sv-days')?.value,
      start: $('#sv-start')?.value,
      end: $('#sv-end')?.value
    });
    ['#sv-name', '#sv-price', '#sv-days', '#sv-start', '#sv-end']
      .forEach(sel => { const el = $(sel); if (el) el.value = ''; });
    closeModal('modal-service');
    renderCabinet();
  });

  // Booking submit
  $('#bk-nickname')?.addEventListener('input', e => {
    bookingVm.onNicknameInput(e.target.value);
    const box = $('#bk-nick-suggestions');
    if (box) {
      box.innerHTML = (bookingVm.nicknameSuggestions || []).map(n =>
        `<button type="button" data-nick="${n}" class="text-xs px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100">${n}</button>`
      ).join('');
    }
  });
  document.addEventListener('click', e => {
    const n = e.target.closest('[data-nick]');
    if (n && $('#bk-nickname')) {
      bookingVm.applyNicknameSuggestion(n.dataset.nick);
      $('#bk-nickname').value = n.dataset.nick;
      $('#bk-nick-suggestions').innerHTML = '';
    }
  });

  $('#book-submit')?.addEventListener('click', async () => {
    // BL-05 (#64): повторный тап во время полёта игнорируется (вторая заявка
    // не создаётся); кнопка на время async-шага disabled.
    if (bookingVm.submitting) return;
    bookingVm.nickname = $('#bk-nickname')?.value || '';
    bookingVm.name = bookingVm.nickname;
    bookingVm.phone = $('#bk-phone')?.value || '';
    bookingVm.contact = $('#bk-contact')?.value || '';
    bookingVm.note = $('#bk-note')?.value || '';
    bookingVm.consent = $('#bk-consent')?.checked ?? true;
    bookingVm.honeypot = $('#bk-website')?.value || '';
    (async () => {
      renderBookingSubmitState(true);
      let session = null;
      try {
        session = await bookingVm.submit();
      } finally {
        // Ошибка/отказ сервера возвращают кнопку в рабочее состояние —
        // «залипшая» disabled-кнопка не должна блокировать повторную попытку.
        renderBookingSubmitState(false);
      }
      if (!session) {
        renderBooking();
        if (bookingVm.error) showToast(bookingVm.error, true);
        return;
      }
      if (bookingVm.awaitingPayment) {
        renderBooking();
        showToast('Слот зарезервирован — оплатите для подтверждения');
      } else {
        navigate('success');
      }
      // Запись на сервер выполняется ВНУТРИ bookingVm.submit() и завершается до
      // показа успеха: здесь повторно отправлять её нельзя (была бы вторая копия
      // того же вызова и вторая точка, где решается, успешна ли запись).
    })();
  });

  // async — внутри подтверждение отмены сессии через uiConfirm (#64).
  // issue #121 (R14): обработчика demo pay (`[data-pay-demo]`) больше нет —
  // на публичной странице нет клиентского пути «отметить оплаченным».
  document.addEventListener('click', async e => {
    const markPaid = e.target.closest('[data-mark-paid]');
    if (markPaid) {
      cabinetVm.markSessionPaid(markPaid.dataset.markPaid);
      renderCabinet();
    }
    const noShow = e.target.closest('[data-no-show]');
    if (noShow) {
      cabinetVm.markNoShow(noShow.dataset.noShow);
      renderCabinet();
    }
    const cancelSes = e.target.closest('[data-cancel-session]');
    if (cancelSes && (await uiConfirm({
      title: 'Отменить сессию?',
      message: 'Слот освободится, клиенту уйдёт уведомление об отмене.',
      confirmLabel: 'Отменить сессию'
    }))) {
      cabinetVm.cancelSession(cancelSes.dataset.cancelSession);
      renderCabinet();
    }
  });

  // issue #121: симуляция «Отправить due сейчас» → «Демо-исходящие сообщения» /
  // «Симулировать ответ клиента» снята: она помечала напоминания `sent` без
  // доставки. Реальная отправка — telegramService.sendDueReminders (startTelegramLoops).
  // Ниже — специалист записывает ответ клиента, полученный по телефону/в мессенджере.
  document.addEventListener('click', e => {
    const tok = e.target.closest('[data-open-token]');
    if (tok) {
      pendingReplyToken = tok.dataset.openToken;
      navigate('clientReply', { token: pendingReplyToken });
    }
  });

  $('#btn-reply-yes')?.addEventListener('click', () => {
    const res = reminderService.respond(pendingReplyToken || route.params.token, 'confirmed');
    showToast(res.message, !res.ok);
    renderClientReply();
  });
  $('#btn-reply-no')?.addEventListener('click', async () => {
    if (!(await uiConfirm({
      title: 'Отменить запись?',
      message: 'Специалист получит отказ, слот освободится.',
      confirmLabel: 'Отменить запись'
    }))) return;
    const res = reminderService.respond(pendingReplyToken || route.params.token, 'declined');
    showToast(res.message, !res.ok);
    renderClientReply();
  });
  // issue #121 (R14): демо-вход «ответ на напоминание» с публичной страницы
  // (#btn-open-reply-demo) снят — он переводил напоминание в `sent` без
  // доставки. Страница /reply?reply={token} по настоящей ссылке сохранена
  // (жизненный цикл напоминаний — R09, #116).

  $('#btn-save-pay-settings')?.addEventListener('click', () => {
    cabinetVm.savePaymentSettings({
      paymentPolicy: $('#set-pay-policy')?.value,
      depositPercent: $('#set-deposit-pct')?.value,
      holdMinutes: $('#set-hold-min')?.value,
      maxActiveUnpaidPerPhone: $('#set-max-unpaid')?.value,
      maxBookingsPerDayPerPhone: $('#set-max-day')?.value,
      blockAfterNoShows: $('#set-block-noshow')?.value,
      reminderEnabled: true,
      reminderHoursBefore: $('#set-reminder-hours')?.value,
      reminderSecondHoursBefore: $('#set-reminder-second')?.value,
      // D1: политика доступности
      minNoticeMinutes: $('#set-min-notice')?.value,
      maxAdvanceDays: $('#set-max-advance')?.value,
      bufferBeforeMin: $('#set-buf-before')?.value,
      bufferAfterMin: $('#set-buf-after')?.value,
      slotIncrementMin: $('#set-increment')?.value,
      maxBookingsPerDay: $('#set-max-day-cap')?.value,
      maxBookingsPerWeek: $('#set-max-week-cap')?.value
    });
    renderCabinet();
  });

  // Modal backdrop
  // Диалоги #modal-confirm/#modal-prompt закрывает сам uiDialogs (иначе промис
  // остался бы вечно неразрешённым и вызывающий код ждал бы ответа).
  const DIALOG_IDS = new Set(['modal-confirm', 'modal-prompt']);
  $$('[id^="modal-"]').filter(m => !DIALOG_IDS.has(m.id)).forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); });
  });
}

function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.remove('hidden');
  m.classList.add('flex');
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.add('hidden');
  m.classList.remove('flex');
}
window.closeModal = closeModal;

function openSessionModal(sessionId, preselectClientId) {
  const s = sessionId ? cabinetVm.sessions.find(x => x.id === sessionId) : null;
  $('#sess-id').value = s?.id || '';
  const clSel = $('#sess-client');
  const svSel = $('#sess-service');
  clSel.innerHTML = '<option value="">— без клиента (личное время) —</option>' +
    cabinetVm.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  svSel.innerHTML = '<option value="">— без услуги —</option>' +
    cabinetVm.services.map(x => `<option value="${x.id}">${esc(x.name)} (${esc(x.priceLabel())})</option>`).join('');
  const meetingRadio = $('#sess-purpose-meeting');
  const personalRadio = $('#sess-purpose-personal');
  if (s) {
    if (meetingRadio) meetingRadio.checked = true;
    if (personalRadio) personalRadio.checked = false;
    clSel.value = s.clientId || '';
    svSel.value = s.serviceId || '';
    $('#sess-date').value = s.date;
    $('#sess-time').value = s.time;
    $('#sess-status').value = s.status;
    $('#sess-note').value = s.note || '';
    $('#sess-platform').value = s.videoPlatform || '';
    $('#sess-meet').value = s.meetLink || '';
  } else {
    const startPersonal = !preselectClientId && !cabinetVm.clients.length;
    if (meetingRadio) meetingRadio.checked = !startPersonal;
    if (personalRadio) personalRadio.checked = !!startPersonal;
    $('#sess-date').value = cabinetVm.selectedDate || new Date().toISOString().slice(0, 10);
    $('#sess-date-to') && ($('#sess-date-to').value = '');
    $('#sess-time').value = '10:00';
    $('#sess-time-to') && ($('#sess-time-to').value = '');
    $('#sess-block-title') && ($('#sess-block-title').value = '');
    $('#sess-status').value = 'confirmed';
    $('#sess-note').value = '';
    $('#sess-platform').value = '';
    $('#sess-meet').value = '';
    if (preselectClientId) clSel.value = preselectClientId;
    const online = cabinetVm.services.find(x => x.id === svSel.value);
    if (online?.format === 'online') $('#sess-platform').value = 'google_meet';
  }
  const plat = $('#sess-platform').value;
  $('#sess-meet-wrap')?.classList.toggle('hidden', !['google_meet', 'zoom', 'other'].includes(plat));
  const personal = $('#sess-purpose-personal')?.checked;
  $('#sess-meeting-fields')?.classList.toggle('hidden', !!personal);
  $('#sess-reschedule-block')?.classList.toggle('hidden', !!personal);
  $('#sess-status-wrap')?.classList.toggle('hidden', !!personal);
  $('#sess-video-wrap')?.classList.toggle('hidden', !!personal);
  $('#sess-date-to-wrap')?.classList.toggle('hidden', !personal);
  $('#sess-time-to-wrap')?.classList.toggle('hidden', !personal);
  $('#sess-block-title-wrap')?.classList.toggle('hidden', !personal);
  $('#sess-personal-hint')?.classList.toggle('hidden', !personal);
  const title = $('#sess-modal-title');
  if (title) title.textContent = personal ? 'Личное время' : 'Сессия';
  openModal('modal-session');
}

function openClientModal(clientId) {
  const c = clientId ? cabinetVm.clientById(clientId) : null;
  $('#cl-id').value = c?.id || '';
  $('#cl-name').value = c?.name || '';
  if ($('#cl-nickname')) $('#cl-nickname').value = c?.nickname || c?.name || '';
  $('#cl-phone').value = c?.phone || '';
  $('#cl-contact').value = c?.contact || '';
  $('#cl-note').value = c?.note || '';
  openModal('modal-client');
}

function openServiceModal() {
  $('#sv-name').value = '';
  $('#sv-price').value = '';
  $('#sv-currency').value = 'BYN';
  $('#sv-duration').value = '60';
  $('#sv-format').value = 'offline';
  openModal('modal-service');
}

// ——— Boot ———
// —— Источник данных каталога: 'loading' | 'server' | 'none' (строго серверный
// режим; состояние объявлено в PortalViewModel, предикат готовности —
// portalVm.catalogReady). Состояния 'demo' нет (issue #121, R14). ——

/** Жёстко серверная загрузка каталога. Никаких локальных подмен:
 *  ошибка/пусто → честный экран с причиной (см. renderPortal). */
async function loadServerCatalog() {
  portalVm.source = 'loading';
  portalVm.serverError = '';
  render();  // перерисовать ТЕКУЩИЙ маршрут: глубокие ссылки /psy|/book ждут каталог
  if (!isSupabaseConfigured()) {
    db.psychologists = [];
    db.services = [];
    db.settings = [];
    portalVm.source = 'none';
    portalVm.serverError = 'SUPABASE_URL / SUPABASE_ANON_KEY не заданы (js/services/supabaseConfig.js)';
    render();  // перерисовать ТЕКУЩИЙ маршрут: глубокие ссылки /psy|/book ждут каталог
    return false;
  }
  try {
    const result = await supabaseSync.pullAll();
    if (!result.ok) throw new Error(result.message || 'Сервер не вернул данные');
    portalVm.source = 'server';
    showToast('Каталог загружен с сервера');
    console.info('[Supabase] server catalog loaded:', result.message);
    render();  // перерисовать ТЕКУЩИЙ маршрут: глубокие ссылки /psy|/book ждут каталог
    return true;
  } catch (e) {
    // не показываем локальный seed как «настоящий» — только честная ошибка
    db.psychologists = [];
    db.services = [];
    db.settings = [];
    db.scheduleBlocks = [];
    portalVm.source = 'none';
    portalVm.serverError = String(e.message || e);
    console.error('[Supabase] catalog load failed:', e);
    // фиксируем на сервере: падение загрузки каталога — критичный инфра-инцидент
    reportClientError('catalog', {
      message: `catalog load failed: ${e.message || e}`,
      stack: e.stack,
      extra: { configured: isSupabaseConfigured() }
    });
    render();  // перерисовать ТЕКУЩИЙ маршрут: глубокие ссылки /psy|/book ждут каталог
    return false;
  }
}

window.retryServerData = () => { loadServerCatalog(); };
// issue #121 (R14): `enableDemoData` («Показать демо-данные») снят. Он подставлял
// seed-каталог из dbContext в публичный UI при сетевой ошибке/ненастроенном
// сервере, и через него была достижима «запись» без сервера. Ненастроенный или
// недоступный сервер = честная недоступность (экран выше), а не демо.

/**
 * Завершить вход через Google: сессия уже получена (PKCE обменян), дальше —
 * атомарная привязка/создание кабинета на сервере (RPC
 * link_or_create_psychologist_for_google) и загрузка профиля.
 *
 * @returns {Promise<{name:string, params:object}>} маршрут, куда идти дальше:
 *   onboarding — профиль ещё не заполнен; cabinet — всё готово;
 *   auth — привязка не удалась, причина показана рядом с кнопкой Google.
 */
async function finishGoogleLogin() {
  const linked = await googleAuthService.linkOrCreateCabinet();
  if (!linked.ok) {
    // Сессия GoTrue без кабинета бесполезна и мешает войти другим аккаунтом.
    try { await googleAuthService.signOut(); } catch { /* сеть необязательна */ }
    authVm.setGoogleError(linked.head, linked.resolution);
    return { name: 'auth', params: { mode: 'login' } };
  }
  const loaded = await registration.loadOwnedProfile(linked.id);
  if (!loaded.ok) {
    authVm.setGoogleError(loaded.message || linked.head, linked.resolution);
    return { name: 'auth', params: { mode: 'login' } };
  }
  if (!linked.profileCompleted) {
    return { name: 'onboarding', params: {} };
  }
  try { await cabinetApi.refresh(loaded.psychologist.id); }
  catch (e) { console.warn('[boot] pull cabinet after google', e?.message || e); }
  await cabinetVm.refreshClients();
  startTelegramLoops(loaded.psychologist.id);
  showToast('Вход через Google выполнен');
  return { name: 'cabinet', params: {} };
}

/**
 * Выход из аккаунта.
 *
 * Порядок важен: сначала гасим сессию Supabase Auth на сервере (для этого
 * нужен ещё живой access token), затем чистим локальное состояние. Сессия
 * одна и та же для входа по коду из письма и для входа через Google, поэтому
 * выход гасит обе.
 */
async function doLogout() {
  try { await googleAuthService.signOut(); }
  catch (e) { console.warn('[logout] supabase', e?.message || e); }
  authVm.logout();
  authVm.setGoogleError('', '');
  authVm.onboardingError = '';
  navigate('portal');
}

function boot() {
  bindEvents();
  (async () => {
    // стартовый маршрут — из hash (Hash History: #/psy/{slug}, #/book/{slug});
    // legacy-ссылки без # нормализуются в hash без перезагрузки
    bookingVm.onAvailability = () => { if (route.name === 'booking') renderBooking(); };

    // ——— Возврат после OAuth Google (`?code=…`, PKCE). Email/OTP redirect
    // психолога больше не обрабатывается (issue #88).
    let googleReturn = null;
    try {
      googleReturn = await googleAuthService.consumeGoogleRedirect();
    } catch (e) {
      googleReturn = googleAuthService.publicAuthFailure('exception', e);
    }
    if (googleReturn?.kind === 'session') {
      const target = await finishGoogleLogin();
      normalizeLegacyUrl();
      navigate(target.name, target.params || {}, { push: true });
      await loadServerCatalog();
      return;
    }
    if (googleReturn?.kind === 'error') {
      authVm.setGoogleError(googleReturn.message, googleReturn.resolution || '', googleReturn.correlationId || '');
      normalizeLegacyUrl();
      route = { name: 'auth', params: { mode: 'login' } };
      navigate('auth', { mode: 'login' }, { push: false });
      await loadServerCatalog();
      return;
    }

    normalizeLegacyUrl();

    // Восстановление аутентификации — ПЕРЕД роут-гардом и до загрузки каталога.
    // Без этого после перезагрузки страницы токен терялся: кабинет открывался
    // (роут-гард смотрел в localStorage), но hasSession() был false, и все
    // записи кабинета молча не уходили на сервер.
    const restored = await registration.restoreAuthenticatedState();
    if (restored.authenticated && restored.psychologist) {
      // Имя/email вошедшего — из GoTrue (auth/v1/user), а не из локального
      // JWT: отображение обязано совпадать с тем, что знает сервер.
      await googleAuthService.refreshUser().catch(() => {});
      try { await cabinetApi.refresh(restored.psychologist.id); }
      catch (e) { console.warn('[boot] pull cabinet', e?.message || e); }
      startTelegramLoops(restored.psychologist.id);
    } else if (restored.message) {
      // Кабинет не открыт по внятной причине (отключённый аккаунт, сессия
      // старше месяца, профиль не привязан). Без этого пользователь видел бы
      // пустую форму входа и не понимал, что произошло (issue #40/#46).
      authVm.error = restored.message;
      authVm.step = 'email';
    }

    route = routeFromUrl();
    if (route.name === 'cabinet' && !authService.isAuthenticated()) {
      route = { name: 'auth', params: { mode: 'login' } };
    }
    // Профиль не заполнен (первый вход через Google) → онбординг, а не
    // полупустой кабинет, который к тому же не публикуется в каталоге.
    if (route.name === 'cabinet' && authService.isAuthenticated()
        && cabinetVm.psychologist?.profileCompleted === false) {
      route = { name: 'onboarding', params: {} };
    }
    if (route.name === 'onboarding' && !googleAuthService.hasSession()) {
      route = { name: 'auth', params: { mode: 'login' } };
    }
    navigate(route.name, route.params, { push: false });
    await loadServerCatalog();
  })();
}

boot();

// экспорт для смоук-тестов (verify_app / auth-flow)
export { portalVm, authVm, cabinetVm, bookingVm };
