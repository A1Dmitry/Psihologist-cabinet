/**
 * UI-диалоги (issue #64, MX-03/MX-05) — единственная каноническая замена
 * нативных `window.confirm()` / `window.prompt()`.
 *
 * Почему: нативные диалоги на мобильном — крошечное системное окно без
 * многострочности, отмена теряет введённый текст, а Clipboard API в них не
 * участвует (BA-MOBILE-2026-09-25, MX-03). Здесь — те же операции, но в
 * разметке приложения: на мобильном bottom-sheet (`.modal-sheet` +
 * `.modal-panel` в css/tailwind.css: во всю ширину, скролл, safe-area снизу),
 * на десктопе — центрированное окно. Деструктивное действие — красная кнопка
 * (`#ui-confirm-ok`), поэтому «Удалить» нельзя нажать «по инерции» как «ОК».
 *
 * Границы: это presentation-слой. Диалоги не переопределяют бизнес-правила
 * (RULES §6.14) и ничего не пишут в БД — вызывающий код решает, что делать
 * с ответом. При отсутствии разметки диалог возвращает безопасный отказ
 * (confirm → false, prompt → null), а не зовёт нативный `confirm`: молчаливый
 * нативный диалог вернул бы непроверенное поведение в мобильный UI.
 *
 * Тесты: tests/mobile-ux.mjs (сценарии, черновик при отмене, фолбэк копирования).
 */

const CONFIRM_ID = 'modal-confirm';
const PROMPT_ID = 'modal-prompt';

/** Черновики prompt по ключу: отмена не должна терять введённый текст (MX-03). */
const drafts = new Map();

let bound = false;
let pendingConfirm = null;   // { resolve, key }
let pendingPrompt = null;    // { resolve, key }

function $id(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function setOpen(id, open) {
  const m = $id(id);
  if (!m) return;
  m.classList.toggle('hidden', !open);
  m.classList.toggle('flex', !!open);
}

/** Подписки на кнопки — один раз на модуль (повторные open не плодят слушатели). */
function bindOnce() {
  if (bound) return;
  bound = true;

  $id('ui-confirm-ok')?.addEventListener('click', () => settleConfirm(true));
  $id('ui-confirm-cancel')?.addEventListener('click', () => settleConfirm(false));
  $id(PROMPT_ID)?.addEventListener('click', e => {
    if (e.target === $id(PROMPT_ID)) settlePrompt(null);          // клик по подложке = отмена
  });
  $id(CONFIRM_ID)?.addEventListener('click', e => {
    if (e.target === $id(CONFIRM_ID)) settleConfirm(false);
  });

  $id('ui-prompt-ok')?.addEventListener('click', () => {
    const value = $id('ui-prompt-text')?.value ?? '';
    settlePrompt(value);
  });
  $id('ui-prompt-cancel')?.addEventListener('click', () => settlePrompt(null));

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', e => {
      if (e?.key !== 'Escape') return;
      if (pendingConfirm) settleConfirm(false);
      if (pendingPrompt) settlePrompt(null);
    });
  }
}

function settleConfirm(result) {
  const p = pendingConfirm;
  pendingConfirm = null;
  setOpen(CONFIRM_ID, false);
  p?.resolve(!!result);
}

function settlePrompt(result) {
  const p = pendingPrompt;
  pendingPrompt = null;
  const current = $id('ui-prompt-text')?.value ?? '';
  // Отмена сохраняет черновик (если задан ключ), сохранение — очищает:
  // «ничего не теряется при отмене» (DoD #64) без магии в вызывающем коде.
  if (p?.key) {
    if (result === null) drafts.set(p.key, current);
    else drafts.delete(p.key);
  }
  setOpen(PROMPT_ID, false);
  p?.resolve(result === null ? null : String(result));
}

/**
 * Подтверждение действия вместо window.confirm().
 * @returns {Promise<boolean>} true — подтверждено; отмена/закрытие/нет разметки — false.
 */
export async function uiConfirm({
  title = 'Подтвердите действие',
  message = '',
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  danger = true
} = {}) {
  const modal = $id(CONFIRM_ID);
  if (!modal || pendingConfirm) return false;
  bindOnce();

  $id('ui-confirm-title') && ($id('ui-confirm-title').textContent = title);
  $id('ui-confirm-message') && ($id('ui-confirm-message').textContent = message);
  const okBtn = $id('ui-confirm-ok');
  if (okBtn) {
    okBtn.textContent = confirmLabel;
    okBtn.classList.toggle('bg-rose-600', !!danger);
    okBtn.classList.toggle('hover:bg-rose-700', !!danger);
    okBtn.classList.toggle('bg-indigo-600', !danger);
    okBtn.classList.toggle('hover:bg-indigo-700', !danger);
  }
  $id('ui-confirm-cancel') && ($id('ui-confirm-cancel').textContent = cancelLabel);

  const promise = new Promise(resolve => { pendingConfirm = { resolve }; });
  setOpen(CONFIRM_ID, true);
  return promise;
}

/**
 * Ввод текста вместо window.prompt().
 * @returns {Promise<string|null>} текст при сохранении; null при отмене/закрытии.
 */
export async function uiPrompt({
  title = 'Введите текст',
  label = '',
  value = '',
  placeholder = '',
  hint = '',
  confirmLabel = 'Сохранить',
  cancelLabel = 'Отмена',
  rows = 4,
  key = ''
} = {}) {
  const modal = $id(PROMPT_ID);
  if (!modal || pendingPrompt) return null;
  bindOnce();

  const draft = key && drafts.has(key) ? drafts.get(key) : null;
  const field = $id('ui-prompt-text');
  if (field) {
    field.value = draft !== null ? draft : String(value ?? '');
    field.placeholder = placeholder;
    field.rows = rows;
  }
  $id('ui-prompt-title') && ($id('ui-prompt-title').textContent = title);
  $id('ui-prompt-label') && ($id('ui-prompt-label').textContent = label);
  const hintEl = $id('ui-prompt-hint');
  if (hintEl) {
    hintEl.textContent = hint;
    hintEl.classList.toggle('hidden', !hint);
  }
  $id('ui-prompt-ok') && ($id('ui-prompt-ok').textContent = confirmLabel);
  $id('ui-prompt-cancel') && ($id('ui-prompt-cancel').textContent = cancelLabel);

  const promise = new Promise(resolve => { pendingPrompt = { resolve, key }; });
  setOpen(PROMPT_ID, true);
  // Автофокус/выделение — только если элемент это умеет (в тестовом DOM-стабе
  // эти методы есть, но не обязательны).
  try { field?.focus?.(); field?.select?.(); } catch (_) { /* не критично */ }
  return promise;
}

/**
 * Копирование ссылки: Clipboard API + toast у вызывающего; фолбэк — только
 * для не-secure контекста/запрета разрешения, через sheet с готовым текстом
 * (MX-03: «prompt-фолбэк» перестаёт быть нативным диалогом).
 *
 * @returns {Promise<{ok: boolean, via: 'clipboard'|'sheet'}>}
 */
export async function copyText(text, {
  title = 'Скопируйте ссылку',
  label = 'Ссылка',
  hint = 'Автокопирование недоступно в этом контексте — выделите и скопируйте вручную.',
  key = ''
} = {}) {
  const value = String(text ?? '');
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return { ok: true, via: 'clipboard' };
    }
  } catch (_) { /* не-secure контекст или отказ разрешения → ниже sheet */ }

  await uiPrompt({
    title, label, value, hint, rows: 3,
    confirmLabel: 'Готово', key: key || 'copy-fallback'
  });
  return { ok: false, via: 'sheet' };
}

/** Очистка черновиков — для тестов и полного сброса портала. */
export function resetUiDialogDrafts() {
  drafts.clear();
}
