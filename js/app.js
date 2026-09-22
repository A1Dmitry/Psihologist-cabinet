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
import { isSupabaseConfigured } from './services/supabaseConfig.js';

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

function showToast(msg, isError) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-full text-sm font-medium shadow-lg ' +
    (isError ? 'bg-rose-600 text-white' : 'bg-slate-900 text-white');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ——— Router ———
function navigate(name, params = {}) {
  route = { name, params };
  if (name === 'cabinet' && !authService.isAuthenticated()) {
    route = { name: 'auth', params: { mode: 'login' } };
  }
  render();
  window.scrollTo(0, 0);
}

window.navigate = navigate;
window.resetPortalData = () => {
  if (!confirm('Сбросить все данные портала?')) return;
  db.resetToSeed();
  authService.logout();
  navigate('portal');

  // Supabase: подтянуть общие данные (если указан anon key)
  (async () => {
    if (!isSupabaseConfigured()) {
      console.info('[Supabase] anon key не задан — работа из localStorage. Укажите ключ в js/services/supabaseConfig.js');
      return;
    }
    try {
      const r = await supabaseSync.pullAll();
      console.info('[Supabase]', r.message || r);
      if (r.ok) {
        // обновить каталог
        if (typeof renderPortal === 'function') renderPortal();
        showToast?.(r.message || 'Данные с сервера загружены');
      } else {
        console.warn('[Supabase]', r.message);
      }
    } catch (e) {
      console.error('[Supabase] sync failed', e);
      showToast?.('Supabase: ' + (e.message || e), true);
    }
  })();

  showToast('Демо-данные восстановлены');
};

// ——— Views ———
function render() {
  $$('.page').forEach(p => p.classList.add('hidden'));
  const map = {
    portal: 'page-portal',
    auth: 'page-auth',
    cabinet: 'page-cabinet',
    booking: 'page-booking',
    success: 'page-success',
    clientReply: 'page-client-reply'
  };
  const id = map[route.name] || 'page-portal';
  const page = document.getElementById(id);
  if (page) page.classList.remove('hidden');

  if (route.name === 'portal') renderPortal();
  if (route.name === 'auth') renderAuth();
  if (route.name === 'cabinet') renderCabinet();
  if (route.name === 'booking') renderBooking();
  if (route.name === 'success') renderSuccess();
  if (route.name === 'clientReply') renderClientReply();

  // global toast from VMs
  [portalVm, authVm, cabinetVm, bookingVm].forEach(vm => {
    if (vm.toast) {
      showToast(vm.toast);
      vm.toast = '';
    }
  });
}

function renderPortal() {
  const list = portalVm.psychologists;
  const box = $('#portal-list');
  const navAuth = $('#nav-auth-area');
  if (navAuth) {
    if (portalVm.isLoggedIn) {
      navAuth.innerHTML = `
        <button onclick="navigate('cabinet')" class="text-sm text-slate-600 hover:text-indigo-700">${portalVm.currentPsychologist.fullName}</button>
        <button onclick="navigate('cabinet')" class="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Кабинет</button>`;
    } else {
      navAuth.innerHTML = `
        <button onclick="navigate('auth',{mode:'login'})" class="text-sm text-slate-600 hover:text-indigo-700">Вход для психологов</button>
        <button onclick="navigate('auth',{mode:'register'})" class="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Регистрация</button>`;
    }
  }

  const cities = portalVm.cities;
  const citySel = $('#portal-city');
  if (citySel) {
    citySel.innerHTML = '<option value="">Все города</option>' + cities.map(c =>
      `<option value="${c}" ${portalVm.cityFilter === c ? 'selected' : ''}>${c}</option>`
    ).join('');
  }

  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="col-span-full text-center text-slate-400 py-12">Психологи не найдены</div>';
    return;
  }
  box.innerHTML = list.map(p => {
    const svcs = db.servicesOf(p.id);
    const online = svcs.some(s => s.format === 'online');
    return `
      <article class="bg-white rounded-2xl border border-slate-100 p-6 hover:shadow-lg transition flex flex-col">
        <div class="flex items-start gap-4 mb-4">
          <div class="w-14 h-14 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-lg shrink-0">
            ${p.fullName.split(' ').map(x => x[0]).slice(0, 2).join('')}
          </div>
          <div class="min-w-0">
            <h3 class="font-bold text-slate-900 text-lg leading-tight">${p.fullName}</h3>
            <p class="text-sm text-indigo-600 mt-0.5">${p.specialization}</p>
            <p class="text-xs text-slate-400 mt-1">${p.city || 'Онлайн'}${online ? ' · Google Meet' : ''}</p>
          </div>
        </div>
        <p class="text-sm text-slate-600 flex-1 line-clamp-3 mb-4">${p.about || 'Частная практика'}</p>
        <div class="flex flex-wrap gap-2 mb-4">
          ${svcs.slice(0, 3).map(s => `<span class="text-xs px-2 py-1 rounded-full bg-slate-50 text-slate-600">${s.name}</span>`).join('')}
        </div>
        <button onclick="navigate('booking',{slug:'${p.slug}'})" class="w-full py-2.5 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
          Записаться
        </button>
      </article>`;
  }).join('');
}

function renderAuth() {
  if (route.params.mode) authVm.setMode(route.params.mode);
  const title = $('#auth-title');
  const subtitle = $('#auth-subtitle');
  const emailStep = $('#auth-step-email');
  const codeStep = $('#auth-step-code');
  const regFields = $('#auth-reg-fields');
  const err = $('#auth-error');
  const demo = $('#auth-demo-code');

  if (title) title.textContent = authVm.mode === 'register' ? 'Регистрация психолога' : 'Вход в кабинет';
  if (subtitle) {
    subtitle.textContent = authVm.mode === 'register'
      ? 'Создайте кабинет: код придёт на email'
      : 'Войдите по коду, отправленному на email';
  }

  emailStep?.classList.toggle('hidden', authVm.step !== 'email');
  codeStep?.classList.toggle('hidden', authVm.step !== 'code');
  regFields?.classList.toggle('hidden', authVm.mode !== 'register' || authVm.step !== 'code');

  $('#auth-email') && ($('#auth-email').value = authVm.email);
  $('#auth-code') && ($('#auth-code').value = authVm.code);
  if (err) {
    err.textContent = authVm.error || '';
    err.classList.toggle('hidden', !authVm.error);
  }
  if (demo) {
    if (authVm.demoCode) {
      demo.classList.remove('hidden');
      demo.innerHTML = `<strong>Демо-код:</strong> <span class="font-mono text-lg">${authVm.demoCode}</span> <span class="text-slate-400">(в продакшене уходит на email)</span>`;
    } else {
      demo.classList.add('hidden');
    }
  }

  // mode tabs
  $$('[data-auth-mode]').forEach(btn => {
    const on = btn.dataset.authMode === authVm.mode;
    btn.classList.toggle('bg-indigo-600', on);
    btn.classList.toggle('text-white', on);
    btn.classList.toggle('bg-slate-100', !on);
  });
}

function renderCabinet() {
  if (!authService.isAuthenticated()) {
    navigate('auth', { mode: 'login' });
    return;
  }
  const p = cabinetVm.psychologist;
  $('#cab-name') && ($('#cab-name').textContent = p.fullName);
  $('#cab-spec') && ($('#cab-spec').textContent = p.specialization + (cabinetVm.vaultUnlocked ? ' · 🔒 сейф открыт' : ' · сейф закрыт'));

  $$('.cab-tab').forEach(t => t.classList.add('hidden'));
  $(`#tab-${cabinetVm.tab}`)?.classList.remove('hidden');

  $$('.cab-nav-btn').forEach(btn => {
    const on = btn.dataset.tab === cabinetVm.tab;
    if (btn.closest('aside')) {
      btn.classList.toggle('bg-slate-800', on);
      btn.classList.toggle('font-medium', on);
      btn.classList.toggle('text-slate-300', !on);
    } else {
      btn.classList.toggle('bg-indigo-600', on);
      btn.classList.toggle('text-white', on);
      btn.classList.toggle('bg-slate-100', !on);
    }
  });

  const badge = $('#wait-badge');
  if (badge) {
    const n = cabinetVm.waiting.length;
    if (n) { badge.textContent = n; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }

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
        ${s.status === 'held' || (s.requiresPayment && s.paymentStatus === 'unpaid') ? `<button data-mark-paid="${s.id}" class="text-xs text-emerald-600">Чек/оплата</button>` : ''}
        <button data-edit-session="${s.id}" class="text-xs text-indigo-600">Изменить</button>
        <button data-no-show="${s.id}" class="text-xs text-slate-400">Неявка</button>
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
  const box = $('#sch-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Нет сессий</div>';
    return;
  }
  box.innerHTML = list.map(s => {
    const cl = cabinetVm.clientById(s.clientId);
    const sv = cabinetVm.serviceById(s.serviceId);
    return `<div class="flex items-center gap-4 p-4 border-b last:border-0">
      <div class="font-mono text-sm text-slate-500 w-14">${s.time}</div>
      <div class="flex-1"><div class="font-medium">${cl?.name || '—'}</div>
      <div class="text-sm text-slate-500">${sv?.name || ''} ${s.meetLink ? '· <a class="text-blue-600" href="'+s.meetLink+'" target="_blank">Meet</a>' : ''}</div></div>
      <span class="text-xs px-2 py-1 rounded-full ${statusClass(s.status)}">${statusLabel(s.status)}</span>
      <button data-edit-session="${s.id}" class="text-sm text-indigo-600">Изменить</button>
      <button data-del-session="${s.id}" class="text-sm text-rose-500">Удалить</button>
    </div>`;
  }).join('');
}

function renderCabClients() {
  const box = $('#clients-list');
  if (!box) return;
  const list = cabinetVm.clients;
  if (!list.length) {
    box.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Нет клиентов</div>';
    return;
  }
  box.innerHTML = list.map(c => {
    const n = cabinetVm.sessions.filter(s => s.clientId === c.id && s.status !== 'cancelled').length;
    return `<div class="p-4 flex justify-between items-center border-b last:border-0">
      <div><div class="font-medium">${c.nickname || c.name}</div>
      <div class="text-sm text-slate-500">${c.phone || ''} · ${n} сессий</div>
      ${c.note ? `<div class="text-xs text-slate-400 mt-0.5">${c.note}</div>` : ''}</div>
      <div class="flex gap-2">
        <button data-edit-client="${c.id}" class="text-sm text-indigo-600">Изменить</button>
        <button data-del-client="${c.id}" class="text-sm text-rose-500">Удалить</button>
      </div></div>`;
  }).join('');
}

function renderCabServices() {
  const box = $('#services-list');
  if (!box) return;
  box.innerHTML = cabinetVm.services.map(s => `
    <div class="bg-white rounded-xl border p-4 flex justify-between items-center">
      <div><div class="font-medium">${s.name}</div>
      <div class="text-sm text-slate-500">${s.duration} мин · ${s.format === 'online' ? 'онлайн · Google Meet' : 'очно'}</div></div>
      <div class="flex items-center gap-4">
        <span class="font-semibold text-indigo-700">${s.priceLabel()}</span>
        <button data-del-service="${s.id}" class="text-sm text-rose-500">Удалить</button>
      </div>
    </div>`).join('');
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
        ${r.status === 'sent' ? `<button type="button" data-open-token="${r.responseToken}" class="text-xs text-indigo-600 mt-1">Открыть ответ клиента (демо)</button>` : ''}
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

function renderCabProfile() {
  const p = cabinetVm.psychologist;
  if (!p) return;
  $('#pf-name') && ($('#pf-name').value = p.fullName);
  $('#pf-phone') && ($('#pf-phone').value = p.phone || '');
  $('#pf-spec') && ($('#pf-spec').value = p.specialization || '');
  $('#pf-city') && ($('#pf-city').value = p.city || '');
  $('#pf-about') && ($('#pf-about').value = p.about || '');
  $('#pf-email') && ($('#pf-email').textContent = p.email);
}

function renderCabLink() {
  const p = cabinetVm.psychologist;
  const url = `${location.origin}${location.pathname}?book=${p.slug}`;
  $('#pub-link') && ($('#pub-link').value = url);
  $('#pub-slug') && ($('#pub-slug').textContent = p.slug);
}

function renderBooking() {
  const slug = route.params.slug;
  if (slug) bookingVm.loadBySlug(slug);
  if (!bookingVm.psychologist) {
    $('#book-body').innerHTML = '<div class="text-center py-20 text-slate-400">Психолог не найден. <button class="text-indigo-600" onclick="navigate(\'portal\')">К каталогу</button></div>';
    return;
  }
  if (bookingVm.done) {
    navigate('success');
    return;
  }
  const p = bookingVm.psychologist;
  $('#book-psy-name') && ($('#book-psy-name').textContent = p.fullName);
  $('#book-psy-spec') && ($('#book-psy-spec').textContent = p.specialization);
  $('#book-psy-city') && ($('#book-psy-city').textContent = (p.city || 'Онлайн') + ' · при необходимости Google Meet');

  const svcBox = $('#book-services');
  if (svcBox) {
    svcBox.innerHTML = bookingVm.services.map(s => `
      <label class="flex items-start gap-4 p-4 rounded-xl border-2 cursor-pointer ${bookingVm.serviceId === s.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200'}">
        <input type="radio" name="bs" value="${s.id}" ${bookingVm.serviceId === s.id ? 'checked' : ''} class="mt-1 accent-indigo-600">
        <div class="flex-1"><div class="font-medium">${s.name}</div>
        <div class="text-sm text-slate-500">${s.duration} мин · ${s.format === 'online' ? 'онлайн · Google Meet' : 'очно'}</div></div>
        <div class="font-semibold text-indigo-700">${s.priceLabel()}</div>
      </label>`).join('');
    svcBox.querySelectorAll('input').forEach(inp => {
      inp.onchange = () => { bookingVm.selectService(inp.value); renderBooking(); };
    });
  }

  const rangeBox = $('#book-range');
  if (rangeBox) {
    rangeBox.innerHTML = bookingVm.dateRangeOptions.map(o => `
      <button type="button" data-range="${o.id}" class="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${bookingVm.dateRange === o.id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">${o.label}</button>
    `).join('');
    rangeBox.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => { bookingVm.setDateRange(btn.dataset.range); renderBooking(); };
    });
  }

  const daysBox = $('#book-days');
  if (daysBox) {
    daysBox.innerHTML = bookingVm.availableDays.map(d => `
      <button type="button" data-day="${d}" class="px-4 py-2 rounded-full text-sm whitespace-nowrap ${bookingVm.date === d ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200'}">${formatDate(d)}</button>
    `).join('');
    daysBox.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => { bookingVm.selectDate(btn.dataset.day); renderBooking(); };
    });
  }

  const slotsBox = $('#book-slots');
  if (slotsBox) {
    slotsBox.innerHTML = bookingVm.slots.map(s => `
      <button type="button" data-time="${s.time}" ${s.busy ? 'disabled' : ''}
        class="py-2.5 rounded-lg border text-sm font-medium ${s.busy ? 'opacity-35 line-through' : ''} ${bookingVm.time === s.time ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 hover:border-indigo-300'}">
        ${s.time}
      </button>`).join('');
    slotsBox.querySelectorAll('button:not([disabled])').forEach(btn => {
      btn.onclick = () => { bookingVm.selectTime(btn.dataset.time); renderBooking(); };
    });
  }

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
      const due = bookingVm.paymentInfo?.amountDueNow ?? 0;
      const cur = bookingVm.paymentInfo?.currency || 'BYN';
      payActions.innerHTML = `
        <div class="rounded-2xl border border-orange-200 bg-orange-50 p-6 space-y-4">
          <h3 class="font-bold text-lg text-orange-900">Подтверждение оплаты</h3>
          <p class="text-sm text-orange-900/80">${bookingVm.successText}</p>
          <p class="text-sm">К оплате сейчас: <strong>${paymentService.formatAmount(due, cur)}</strong></p>
          <div class="flex flex-col sm:flex-row gap-2">
            <button type="button" data-pay-demo="card_demo" class="px-5 py-2.5 rounded-full bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Оплатить картой (демо)</button>
            <button type="button" data-pay-demo="transfer" class="px-5 py-2.5 rounded-full border border-indigo-300 text-indigo-700 text-sm font-medium">Я перевёл(а) / чек</button>
          </div>
          <p class="text-xs text-slate-500">После оплаты запись считается подтверждённой. Неоплаченный резерв снимается автоматически.</p>
        </div>`;
    }
  } else {
    formBlock?.classList.remove('hidden');
    payActions?.classList.add('hidden');
  }
}

let pendingReplyToken = null;

function renderClientReply() {
  const token = route.params.token || pendingReplyToken;
  pendingReplyToken = token;
  const r = db.reminders.find(x => x.responseToken === token);
  const msg = $('#reply-message');
  const actions = $('#reply-actions');
  const done = $('#reply-done');
  if (!r) {
    if (msg) msg.textContent = 'Напоминание не найдено. Сначала отправьте due-напоминание из кабинета.';
    actions?.classList.add('hidden');
    return;
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

function renderSuccess() {
  $('#success-text') && ($('#success-text').textContent = bookingVm.successText || 'Заявка принята');
}

// ——— Event bindings ———
function bindEvents() {
  // Portal search
  $('#portal-search')?.addEventListener('input', e => {
    portalVm.setQuery(e.target.value);
    renderPortal();
  });
  $('#portal-city')?.addEventListener('change', e => {
    portalVm.setCity(e.target.value);
    renderPortal();
  });

  // Auth
  $$('[data-auth-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      authVm.setMode(btn.dataset.authMode);
      renderAuth();
    });
  });
  $('#auth-send')?.addEventListener('click', async () => {
    authVm.email = $('#auth-email')?.value || '';
    await authVm.requestCode();
    renderAuth();
    if (authVm.demoCode) showToast('Код: ' + authVm.demoCode);
  });
  $('#auth-confirm')?.addEventListener('click', async () => {
    authVm.email = $('#auth-email')?.value || authVm.email;
    authVm.code = $('#auth-code')?.value || '';
    authVm.password = $('#auth-password')?.value || '';
    if (authVm.mode === 'register') {
      authVm.fullName = $('#auth-fullname')?.value || '';
      authVm.phone = $('#auth-phone')?.value || '';
      authVm.specialization = $('#auth-spec')?.value || 'Психолог';
      authVm.city = $('#auth-city')?.value || '';
    }
    const psy = await authVm.confirmCode();
    renderAuth();
    if (psy) {
      await cabinetVm.refreshClients();
      navigate('cabinet');
    }
  });
  $('#auth-back-email')?.addEventListener('click', () => {
    authVm.step = 'email';
    authVm.demoCode = '';
    authVm.error = '';
    authVm.notify();
    renderAuth();
  });

  // Cabinet nav
  document.addEventListener('click', e => {
    const nav = e.target.closest('.cab-nav-btn');
    if (nav?.dataset.tab) {
      cabinetVm.switchTab(nav.dataset.tab);
      renderCabinet();
    }
    const es = e.target.closest('[data-edit-session]');
    if (es) openSessionModal(es.dataset.editSession);
    const ds = e.target.closest('[data-del-session]');
    if (ds && confirm('Удалить сессию?')) {
      cabinetVm.deleteSession(ds.dataset.delSession);
      renderCabinet();
    }
    const ec = e.target.closest('[data-edit-client]');
    if (ec) openClientModal(ec.dataset.editClient);
    const dc = e.target.closest('[data-del-client]');
    if (dc && confirm('Удалить клиента?')) {
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
    authVm.logout();
    navigate('portal');
  });
  $('#btn-save-profile')?.addEventListener('click', () => {
    cabinetVm.updateProfile({
      fullName: $('#pf-name')?.value,
      phone: $('#pf-phone')?.value,
      specialization: $('#pf-spec')?.value,
      city: $('#pf-city')?.value,
      about: $('#pf-about')?.value
    });
    renderCabinet();
  });
  $('#btn-copy-link')?.addEventListener('click', () => {
    const inp = $('#pub-link');
    if (inp) {
      inp.select();
      try { navigator.clipboard.writeText(inp.value); } catch { /* */ }
      showToast('Ссылка скопирована');
    }
  });

  // Session modal
  $('#sess-save')?.addEventListener('click', () => {
    const ok = cabinetVm.saveSession({
      id: $('#sess-id')?.value || null,
      clientId: $('#sess-client')?.value,
      serviceId: $('#sess-service')?.value,
      date: $('#sess-date')?.value,
      time: $('#sess-time')?.value,
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
      duration: parseInt($('#sv-duration')?.value, 10) || 60,
      format: $('#sv-format')?.value
    });
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

  $('#book-submit')?.addEventListener('click', () => {
    bookingVm.nickname = $('#bk-nickname')?.value || '';
    bookingVm.name = bookingVm.nickname;
    bookingVm.phone = $('#bk-phone')?.value || '';
    bookingVm.contact = $('#bk-contact')?.value || '';
    bookingVm.note = $('#bk-note')?.value || '';
    bookingVm.consent = $('#bk-consent')?.checked ?? true;
    bookingVm.honeypot = $('#bk-website')?.value || '';
    (async () => {
      const session = await bookingVm.submit();
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
      // отправить запись в Supabase (общая БД)
      if (session && supabaseSync.enabled()) {
        const client = db.clients.find(c => c.id === session.clientId);
        supabaseSync.pushBooking({
          psychologistId: session.psychologistId,
          client: client || { id: session.clientId, name: '', nickname: '', phone: '' },
          session
        }).then(r => {
          if (r.ok) console.info('[Supabase] booking saved', r.sessionId);
          else console.warn('[Supabase] booking', r);
        }).catch(e => console.error('[Supabase] push', e));
      }
    })();
  });

  document.addEventListener('click', e => {
    const payBtn = e.target.closest('[data-pay-demo]');
    if (payBtn) {
      const method = payBtn.dataset.payDemo;
      if (bookingVm.completePayment(method)) navigate('success');
      else {
        renderBooking();
        if (bookingVm.error) showToast(bookingVm.error, true);
      }
    }
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
    if (cancelSes && confirm('Отменить сессию?')) {
      cabinetVm.cancelSession(cancelSes.dataset.cancelSession);
      renderCabinet();
    }
  });

  $('#btn-process-reminders')?.addEventListener('click', () => {
    const res = cabinetVm.processReminders();
    const box = $('#reminder-outbox');
    if (box && res.outbox?.length) {
      box.classList.remove('hidden');
      box.innerHTML = '<div class="font-medium mb-2">Демо-исходящие сообщения:</div>' + res.outbox.map(o =>
        `<div class="mb-3 border-b border-amber-100 pb-2"><div class="text-xs text-slate-500">→ ${o.to}</div><pre class="whitespace-pre-wrap text-xs mt-1">${o.body}</pre>
         <button type="button" data-open-token="${o.token}" class="text-indigo-600 text-xs mt-1">Симулировать ответ клиента</button></div>`
      ).join('');
    }
    renderCabinet();
  });

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
  $('#btn-reply-no')?.addEventListener('click', () => {
    if (!confirm('Отменить запись?')) return;
    const res = reminderService.respond(pendingReplyToken || route.params.token, 'declined');
    showToast(res.message, !res.ok);
    renderClientReply();
  });
  $('#btn-open-reply-demo')?.addEventListener('click', () => {
    const sent = db.reminders.find(r => r.status === 'sent') || db.reminders.find(r => r.status === 'scheduled');
    if (!sent) {
      showToast('Сначала создайте сессию и нажмите «Отправить due» в кабинете', true);
      return;
    }
    if (sent.status === 'scheduled') {
      sent.status = 'sent';
      sent.sentAt = new Date().toISOString();
      db.saveChanges();
    }
    pendingReplyToken = sent.responseToken;
    navigate('clientReply', { token: sent.responseToken });
  });

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
      reminderSecondHoursBefore: $('#set-reminder-second')?.value
    });
    renderCabinet();
  });

  // Modal backdrop
  $$('[id^="modal-"]').forEach(m => {
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
  clSel.innerHTML = cabinetVm.clients.map(c => `<option value="${c.id}">${c.name}</option>`).join('') || '<option value="">Нет клиентов</option>';
  svSel.innerHTML = cabinetVm.services.map(x => `<option value="${x.id}">${x.name} (${x.priceLabel()})</option>`).join('');
  if (s) {
    clSel.value = s.clientId;
    svSel.value = s.serviceId;
    $('#sess-date').value = s.date;
    $('#sess-time').value = s.time;
    $('#sess-status').value = s.status;
    $('#sess-note').value = s.note || '';
    $('#sess-platform').value = s.videoPlatform || '';
    $('#sess-meet').value = s.meetLink || '';
  } else {
    $('#sess-date').value = new Date().toISOString().slice(0, 10);
    $('#sess-time').value = '10:00';
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
function boot() {
  bindEvents();
  const params = new URLSearchParams(location.search);
  const book = params.get('book');
  if (book) {
    navigate('booking', { slug: book });
  } else if (authService.isAuthenticated() && params.get('cabinet') === '1') {
    navigate('cabinet');
  } else {
    navigate('portal');
  }
}

boot();
