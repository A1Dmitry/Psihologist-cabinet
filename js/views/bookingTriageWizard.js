/**
 * Необязательный визард самоописания, встроенный в поле комментария записи.
 * Ответы держатся только в памяти формы до отправки заявки. Клиент видит
 * нейтральное подтверждение; служебная карточка добавляется в sessions.note.
 */
import {
  TRIAGE_QUESTIONS,
  TRIAGE_CHILD_QUESTION,
  buildTriageAssessment
} from '../domain/triage.js';
import { supabaseSync } from '../services/supabaseSync.js';
import { googleClientAuthService } from '../services/googleClientAuthService.js';

const MODAL_ID = 'booking-triage-modal';
/**
 * issue #121 (R14): без настроенного сервера заявки не отправляются вовсе
 * (BookingViewModel._persistBooking → отказ), поэтому и опрос прикрепить
 * нельзя. Раньше здесь был «демо-режим» с кнопкой «Добавить в демо-заявку»,
 * который выдавал локальную подмену за отправку. Текст — один на все экраны.
 */
const SERVER_UNAVAILABLE_NOTICE = 'Отправка заявок сейчас недоступна: сервер данных не настроен. Опрос можно пройти для себя, но прикрепить его к заявке нельзя.';
let activeWizard = null;

function findControls(note) {
  const host = note?.parentElement;
  if (!host) return null;
  let controls = host.querySelector('[data-booking-triage-controls]');
  if (!controls) {
    controls = document.createElement('div');
    controls.setAttribute('data-booking-triage-controls', '');
    controls.className = 'mt-2 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3';
    controls.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-triage-open class="px-4 py-2 rounded-full border border-indigo-200 bg-white text-indigo-700 text-sm font-medium hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-300">
          Пройти короткий опрос
        </button>
        <button type="button" data-triage-clear class="hidden px-3 py-2 rounded-full text-slate-500 text-xs underline hover:text-rose-600">
          Удалить ответы
        </button>
      </div>
      <p data-triage-status class="text-xs leading-relaxed text-slate-600 mt-2">Необязательно. Опрос поможет сформулировать запрос; без него можно продолжить запись.</p>`;
    if (typeof note.insertAdjacentElement === 'function') note.insertAdjacentElement('afterend', controls);
    else host.appendChild(controls);
  }
  return controls;
}

function updateControls(controls, vm) {
  if (!controls || !vm) return;
  const hasAssessment = !!vm.triageAssessment;
  const open = controls.querySelector('[data-triage-open]');
  const clear = controls.querySelector('[data-triage-clear]');
  const status = controls.querySelector('[data-triage-status]');
  if (open) open.textContent = hasAssessment ? 'Изменить ответы опроса' : 'Пройти короткий опрос';
  if (clear) clear.classList.toggle('hidden', !hasAssessment);
  if (status) {
    status.textContent = hasAssessment
      ? 'Опрос пройден. Краткий результат и Google-подтверждённый контакт будут добавлены к заявке только после согласия и отправки.'
      : 'Необязательно. Опрос поможет сформулировать запрос; без него можно продолжить запись.';
  }
  controls.classList.toggle('hidden', !!vm.awaitingPayment || !!vm.done);
  if (open) open.onclick = () => openWizard(vm, controls);
  if (clear) {
    clear.onclick = () => {
      vm.triageAssessment = null;
      vm.clientAuthSession = null;
      vm.clientGoogleUser = null;
      updateControls(controls, vm);
    };
  }
}

function buildSteps(state) {
  const steps = [];
  TRIAGE_QUESTIONS.forEach(question => {
    steps.push(question);
    if (question.id === 'B3' && state.answers.B3 === '1') steps.push(TRIAGE_CHILD_QUESTION);
  });
  return steps;
}

function closeWizard({ restoreFocus = true } = {}) {
  if (!activeWizard) return;
  const { modal, keydownHandler, returnFocus } = activeWizard;
  googleClientAuthService.cancelPendingSignIn();
  document.removeEventListener('keydown', keydownHandler);
  modal?.remove();
  activeWizard = null;
  if (restoreFocus) returnFocus?.focus?.();
}

function answerOptions(step, state) {
  if (step.id === TRIAGE_CHILD_QUESTION.id) {
    return TRIAGE_CHILD_QUESTION.options.map(option => ({
      value: option.value,
      label: option.label,
      checked: state.childStatus === option.value
    }));
  }
  return step.options.map(option => ({
    value: option.value,
    label: option.label,
    checked: state.answers[step.id] === option.value
  }));
}

function isAnswered(step, state) {
  if (step.id === TRIAGE_CHILD_QUESTION.id) return true; // follow-up is optional
  return state.answers[step.id] === '0' || state.answers[step.id] === '1';
}

function styleChoiceLabels(content) {
  content.querySelectorAll('[data-triage-option]').forEach(label => {
    const selected = !!label.querySelector('input')?.checked;
    label.classList.toggle('border-indigo-500', selected);
    label.classList.toggle('bg-indigo-50', selected);
  });
}

function renderIntro(wizard) {
  const { content, state } = wizard;
  const deliveryNotice = supabaseSync.enabled()
    ? 'Чтобы прикрепить результат, нужно будет отдельно подтвердить Google email. Только после этого и явного согласия ответы, служебная подсказка и подтверждённые имя/email будут добавлены к заявке выбранному специалисту. До отправки заявки ответы не сохраняются.'
    : SERVER_UNAVAILABLE_NOTICE;
  content.innerHTML = `
    <p class="text-sm leading-relaxed text-slate-600 mb-3">
      Ответьте на восемь необязательных вопросов, чтобы было проще описать ваш запрос.
      Опрос не ставит диагноз, не оценивает непосредственную безопасность, не заменяет беседу со специалистом и не предназначен для экстренной помощи.
    </p>
    <p class="text-sm leading-relaxed text-slate-600 mb-4">
      ${deliveryNotice} Можно закрыть опрос и записаться без него.
    </p>
    <p class="text-xs leading-relaxed text-amber-800 bg-amber-50 border border-amber-100 rounded-xl p-3 mb-4">
      Если вам или кому-то рядом угрожает непосредственная опасность, не ждите ответа на заявку — обратитесь в местную экстренную службу.
    </p>
    <label class="flex gap-3 items-start text-sm text-slate-700 mb-5">
      <input data-triage-share-consent type="checkbox" class="mt-1 accent-indigo-600">
      <span>Я хочу пройти опрос и согласен(на), что его краткий результат будет добавлен к сообщению выбранному специалисту вместе с заявкой.</span>
    </label>
    <div class="flex justify-end gap-3">
      <button type="button" data-triage-cancel class="px-5 py-2.5 rounded-full border border-slate-300 text-slate-600 hover:bg-slate-50">Не сейчас</button>
      <button type="button" data-triage-start disabled class="px-5 py-2.5 rounded-full bg-indigo-600 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed">Начать</button>
    </div>`;

  const consent = content.querySelector('[data-triage-share-consent]');
  const start = content.querySelector('[data-triage-start]');
  consent?.addEventListener('change', () => {
    state.accepted = !!consent.checked;
    if (start) start.disabled = !state.accepted;
  });
  start?.addEventListener('click', () => {
    if (!state.accepted) return;
    state.page = 'question';
    state.stepIndex = 0;
    renderWizard(wizard);
  });
  content.querySelector('[data-triage-cancel]')?.addEventListener('click', () => closeWizard());
}

function renderQuestion(wizard) {
  const { content, state } = wizard;
  const steps = buildSteps(state);
  const step = steps[state.stepIndex];
  if (!step) {
    state.page = 'complete';
    state.assessment = buildTriageAssessment(state.answers, state.childStatus);
    renderWizard(wizard);
    return;
  }

  const isChildQuestion = step.id === TRIAGE_CHILD_QUESTION.id;
  const options = answerOptions(step, state);
  const groupName = `booking-triage-${step.id}`;
  const progressLabel = isChildQuestion
    ? `Дополнительный вопрос после B3 · шаг ${state.stepIndex + 1} из ${steps.length}`
    : `Вопрос ${state.stepIndex + 1} из ${steps.length}`;

  content.innerHTML = `
    <p class="text-xs font-semibold uppercase tracking-wide text-indigo-600 mb-2" aria-live="polite">${progressLabel}</p>
    <fieldset class="min-w-0">
      <legend class="text-lg font-semibold leading-snug text-slate-900 mb-4">${step.question}</legend>
      <div class="space-y-3">
        ${options.map(option => `
          <label data-triage-option class="flex items-start gap-3 p-4 rounded-xl border border-slate-200 bg-white cursor-pointer hover:border-indigo-300">
            <input type="radio" name="${groupName}" value="${option.value}" data-triage-answer class="mt-1 accent-indigo-600" ${option.checked ? 'checked' : ''}>
            <span class="text-sm leading-relaxed text-slate-700">${option.label}</span>
          </label>`).join('')}
      </div>
    </fieldset>
    <p class="text-xs text-slate-400 mt-4">Опрос добровольный. Его можно закрыть в любой момент и продолжить запись без ответов.</p>
    <div class="flex flex-wrap items-center justify-between gap-3 mt-5">
      <button type="button" data-triage-back class="px-4 py-2.5 rounded-full border border-slate-300 text-slate-600 hover:bg-slate-50">Назад</button>
      <div class="flex flex-wrap gap-2">
        ${isChildQuestion ? '<button type="button" data-triage-skip class="px-4 py-2.5 rounded-full border border-slate-300 text-slate-600 hover:bg-slate-50">Пропустить</button>' : ''}
        <button type="button" data-triage-cancel class="px-4 py-2.5 rounded-full text-slate-500 hover:bg-slate-50">Закрыть</button>
        <button type="button" data-triage-next ${isAnswered(step, state) ? '' : 'disabled'} class="px-5 py-2.5 rounded-full bg-indigo-600 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed">
          ${state.stepIndex === steps.length - 1 ? 'Завершить опрос' : 'Далее'}
        </button>
      </div>
    </div>`;

  const next = content.querySelector('[data-triage-next]');
  styleChoiceLabels(content);
  content.querySelectorAll('[data-triage-answer]').forEach(input => {
    input.addEventListener('change', () => {
      styleChoiceLabels(content);
      if (isChildQuestion) {
        state.childStatus = input.value;
      } else {
        state.answers[step.id] = input.value;
        if (step.id === 'B3') {
          state.childStatus = input.value === '1' ? 'not_reported' : 'not_applicable';
        }
      }
      if (next) next.disabled = !isAnswered(step, state);
    });
  });
  content.querySelector('[data-triage-back]')?.addEventListener('click', () => {
    if (state.stepIndex <= 0) {
      state.page = 'intro';
      renderWizard(wizard);
      return;
    }
    state.stepIndex--;
    renderWizard(wizard);
  });
  content.querySelector('[data-triage-skip]')?.addEventListener('click', () => {
    state.childStatus = 'not_reported';
    advance(wizard);
  });
  content.querySelector('[data-triage-next]')?.addEventListener('click', () => {
    if (!isAnswered(step, state)) return;
    advance(wizard);
  });
  content.querySelector('[data-triage-cancel]')?.addEventListener('click', () => closeWizard());
}

function advance(wizard) {
  const steps = buildSteps(wizard.state);
  if (wizard.state.stepIndex < steps.length - 1) {
    wizard.state.stepIndex++;
    renderWizard(wizard);
    return;
  }
  wizard.state.assessment = buildTriageAssessment(wizard.state.answers, wizard.state.childStatus);
  wizard.state.page = 'complete';
  renderWizard(wizard);
}

function renderGoogleAuthState(wizard) {
  const { content, state } = wizard;
  const status = content.querySelector('[data-triage-auth-status]');
  const buttonHost = content.querySelector('[data-google-button]');
  const oneTap = content.querySelector('[data-google-one-tap]');
  const changeAccount = content.querySelector('[data-google-change-account]');
  const save = content.querySelector('[data-triage-save]');
  const consent = content.querySelector('[data-triage-final-consent]');
  const configured = googleClientAuthService.isConfigured();
  const accepted = !!consent?.checked;

  if (!supabaseSync.enabled()) {
    if (status) status.textContent = SERVER_UNAVAILABLE_NOTICE;
    buttonHost?.classList.add('hidden');
    oneTap?.classList.add('hidden');
    changeAccount?.classList.add('hidden');
    if (save) {
      save.disabled = true;
      save.textContent = 'Отправка недоступна';
    }
    return;
  }

  if (!configured) {
    if (status) status.textContent = 'Прикрепить опрос пока нельзя: владелец ещё не настроил Google Web Client ID и провайдера Supabase. Запись без опроса доступна.';
    buttonHost?.classList.add('hidden');
    oneTap?.classList.add('hidden');
    changeAccount?.classList.add('hidden');
    if (save) {
      save.disabled = true;
      save.textContent = 'Google пока не настроен';
    }
    return;
  }

  if (state.googleSession && state.googleUser) {
    if (status) status.textContent = `Google подтвердил контакт: ${state.googleUser.name} · ${state.googleUser.email}. Дополнительный контакт из формы также сохранится; прикрепление произойдёт только после отдельного согласия.`;
    buttonHost?.classList.add('hidden');
    oneTap?.classList.add('hidden');
    changeAccount?.classList.remove('hidden');
    if (save) {
      save.disabled = !accepted;
      save.textContent = 'Прикрепить опрос к заявке';
    }
    return;
  }

  if (status) status.textContent = 'Чтобы прикрепить результат, подтвердите Google email кнопкой ниже. Google-вход не требуется для обычной записи.';
  buttonHost?.classList.remove('hidden');
  oneTap?.classList.remove('hidden');
  changeAccount?.classList.add('hidden');
  if (save) {
    save.disabled = true;
    save.textContent = 'Сначала подтвердите Google';
  }
}

function mountGoogleButton(wizard) {
  const buttonHost = wizard.content.querySelector('[data-google-button]');
  if (!buttonHost || !googleClientAuthService.isConfigured()) return;
  buttonHost.innerHTML = '';
  googleClientAuthService.renderGoogleButton(buttonHost, {
    onSuccess: result => {
      if (activeWizard !== wizard) return;
      wizard.state.googleSession = result.session;
      wizard.state.googleUser = result.user;
      renderGoogleAuthState(wizard);
    },
    onError: error => {
      if (activeWizard !== wizard) return;
      const status = wizard.content.querySelector('[data-triage-auth-status]');
      if (status) status.textContent = `Вход Google не выполнен. ${error?.message || 'Попробуйте ещё раз.'}`;
      mountGoogleButton(wizard);
    }
  }).catch(error => {
    if (activeWizard !== wizard) return;
    const status = wizard.content.querySelector('[data-triage-auth-status]');
    if (status) status.textContent = `Не удалось подготовить Google-вход. ${error?.message || ''}`;
  });
}

function renderComplete(wizard) {
  const { content, state } = wizard;
  const saveNotice = supabaseSync.enabled()
    ? 'После отправки заявки выбранный специалист получит краткий результат и Google-подтверждённые имя/email. Результат не ставит диагноз и не назначает формат помощи автоматически.'
    : SERVER_UNAVAILABLE_NOTICE;
  content.innerHTML = `
    <div class="rounded-xl bg-emerald-50 border border-emerald-100 p-4 mb-4">
      <h3 class="font-semibold text-emerald-900 mb-1">Спасибо</h3>
      <p class="text-sm leading-relaxed text-emerald-900">Спасибо, ваши ответы помогут специалисту подобрать подходящий формат работы.</p>
    </div>
    <p class="text-sm leading-relaxed text-slate-600 mb-4">${saveNotice}</p>
    <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 mb-4">
      <p data-triage-auth-status role="status" aria-live="polite" class="text-sm leading-relaxed text-slate-700 mb-3"></p>
      <div data-google-button class="mb-2"></div>
      <button type="button" data-google-one-tap class="hidden text-sm text-indigo-700 underline hover:text-indigo-900">Использовать Google One Tap</button>
      <button type="button" data-google-change-account class="hidden text-sm text-indigo-700 underline hover:text-indigo-900">Сменить Google-аккаунт</button>
    </div>
    <label class="flex gap-3 items-start text-sm text-slate-700 mb-5">
      <input data-triage-final-consent type="checkbox" class="mt-1 accent-indigo-600">
      <span>Я согласен(на), чтобы результат опроса и моё подтверждённое Google имя/email были отправлены выбранному специалисту вместе с заявкой. Указанный мной дополнительный контакт также сохранится.</span>
    </label>
    <div class="flex flex-wrap justify-end gap-3">
      <button type="button" data-triage-cancel class="px-4 py-2.5 rounded-full border border-slate-300 text-slate-600 hover:bg-slate-50">Не прикреплять</button>
      <button type="button" data-triage-save disabled class="px-5 py-2.5 rounded-full bg-indigo-600 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed">Прикрепить опрос к заявке</button>
    </div>`;

  const consent = content.querySelector('[data-triage-final-consent]');
  consent?.addEventListener('change', () => {
    state.finalConsent = !!consent.checked;
    renderGoogleAuthState(wizard);
  });
  content.querySelector('[data-google-one-tap]')?.addEventListener('click', async () => {
    const status = content.querySelector('[data-triage-auth-status]');
    if (status) status.textContent = 'Ожидаем подтверждение Google One Tap…';
    try {
      await googleClientAuthService.promptOneTap();
    } catch (error) {
      if (status) status.textContent = error?.message || 'Google One Tap недоступен. Используйте кнопку входа.';
    }
  });
  content.querySelector('[data-google-change-account]')?.addEventListener('click', async () => {
    await googleClientAuthService.logout();
    state.googleSession = null;
    state.googleUser = null;
    wizard.vm.clientAuthSession = null;
    wizard.vm.clientGoogleUser = null;
    renderGoogleAuthState(wizard);
    mountGoogleButton(wizard);
  });
  content.querySelector('[data-triage-save]')?.addEventListener('click', async event => {
    const save = event.currentTarget || content.querySelector('[data-triage-save]');
    if (!state.finalConsent) return;
    // Poka-Yoke (issue #121): даже принудительный клик по disabled-кнопке
    // не прикрепляет опрос к заявке, которую всё равно нельзя отправить.
    if (!supabaseSync.enabled()) {
      renderGoogleAuthState(wizard);
      return;
    }
    save.disabled = true;
    try {
      const verified = await googleClientAuthService.getVerifiedSession();
      if (!verified) throw new Error('Сессия Google истекла. Войдите ещё раз.');
      state.googleSession = verified.session;
      state.googleUser = verified.user;
      wizard.vm.clientAuthSession = verified.session;
      wizard.vm.clientGoogleUser = verified.user;
    } catch (error) {
      const status = content.querySelector('[data-triage-auth-status]');
      if (status) status.textContent = `Не удалось проверить сессию Google. ${error?.message || 'Войдите ещё раз.'}`;
      state.googleSession = null;
      state.googleUser = null;
      wizard.vm.clientAuthSession = null;
      wizard.vm.clientGoogleUser = null;
      renderGoogleAuthState(wizard);
      mountGoogleButton(wizard);
      return;
    }
    wizard.vm.triageAssessment = state.assessment;
    closeWizard();
    updateControls(wizard.controls, wizard.vm);
  });
  content.querySelector('[data-triage-cancel]')?.addEventListener('click', () => closeWizard());

  state.googleSession = null;
  state.googleUser = null;
  renderGoogleAuthState(wizard);
  if (supabaseSync.enabled() && googleClientAuthService.isConfigured()) {
    googleClientAuthService.getVerifiedSession().then(verified => {
      if (activeWizard !== wizard || state.page !== 'complete' || !verified) return;
      state.googleSession = verified.session;
      state.googleUser = verified.user;
      renderGoogleAuthState(wizard);
    }).catch(error => {
      if (activeWizard !== wizard || state.page !== 'complete') return;
      const status = content.querySelector('[data-triage-auth-status]');
      if (status) status.textContent = `Не удалось проверить сохранённый Google-вход. ${error?.message || ''}`;
      mountGoogleButton(wizard);
    });
    if (!state.googleUser) mountGoogleButton(wizard);
  }
}

function renderWizard(wizard) {
  const { content, state } = wizard;
  if (state.page === 'intro') renderIntro(wizard);
  else if (state.page === 'complete') renderComplete(wizard);
  else renderQuestion(wizard);
  content.querySelector('button:not([disabled]), input:not([disabled])')?.focus?.();
}

function openWizard(vm, controls) {
  closeWizard({ restoreFocus: false });
  const previous = vm.triageAssessment;
  const answers = {};
  if (previous?.raw_vector) {
    previous.raw_vector.split('-').forEach((value, index) => {
      const question = TRIAGE_QUESTIONS[index];
      if (question) answers[question.id] = value;
    });
  }

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 z-[80] flex items-center justify-center modal-bg p-4';
  modal.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="booking-triage-title" class="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white p-5 sm:p-7 shadow-2xl">
      <div class="flex items-start justify-between gap-4 mb-5">
        <div>
          <p class="text-xs font-semibold uppercase tracking-wide text-indigo-600 mb-1">Опрос перед записью</p>
          <h2 id="booking-triage-title" class="text-xl sm:text-2xl font-bold text-slate-900">Помочь сформулировать запрос</h2>
        </div>
        <button type="button" data-triage-close aria-label="Закрыть опрос" class="shrink-0 w-9 h-9 rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 text-2xl leading-none">&times;</button>
      </div>
      <div data-triage-content></div>
    </div>`;
  document.body.appendChild(modal);

  const state = {
    page: 'intro',
    stepIndex: 0,
    answers,
    childStatus: previous?.child_triangulation_status || 'not_reported',
    accepted: false,
    assessment: null
  };
  const content = modal.querySelector('[data-triage-content]');
  const returnFocus = controls.querySelector('[data-triage-open]');
  const keydownHandler = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeWizard();
    }
  };
  const wizard = { modal, content, state, vm, controls, keydownHandler, returnFocus };
  activeWizard = wizard;
  modal.addEventListener('click', event => {
    if (event.target === modal) closeWizard();
  });
  modal.querySelector('[data-triage-close]')?.addEventListener('click', () => closeWizard());
  document.addEventListener('keydown', keydownHandler);
  renderWizard(wizard);
}

export const bookingTriageWizard = {
  /** Called from the application composition root after each route render. */
  afterRender({ route, vm } = {}) {
    if (route?.name !== 'booking') {
      closeWizard({ restoreFocus: false });
      return;
    }
    const note = document.getElementById('bk-note');
    const controls = findControls(note);
    if (!controls) return;
    updateControls(controls, vm);
  },
  close: closeWizard
};
