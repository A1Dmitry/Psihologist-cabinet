/**
 * Мобильный кабинет 1.0 (issue #63, MX-01/MX-02/MX-04, F1) — контроллер
 * presentation-слоя: bottom tab bar + sheet «Ещё» + меню «…» в строках.
 *
 * Что делает:
 *  - `«Ещё»` открывает sheet `#modal-more` (канонный `.modal-sheet` /
 *    `.modal-panel`, как модалки кабинета и uiConfirm): все разделы, которых
 *    нет в таб-баре, доступны со смартфона (MX-01);
 *  - `data-cab-menu="<id панели>"` переключает панель «…» в строке
 *    (журнал/расписание/главная): primary-действие видно сразу, остальные —
 *    в меню; деструктивные визуально отделены классом `.cab-menu-danger`
 *    (MX-04). Подтверждения — каноном `uiConfirm` в вызывающем коде, здесь
 *    их нет;
 *  - закрытие: повторный тап по тогглу, тап по пункту меню (действие может не
 *    перерисовывать список), тап вне панели, Escape, выбор раздела в sheet,
 *    клик по подложке sheet.
 *
 * Границы (RULES §6.14): только показ/скрытие. Переключение вкладок,
 * бизнес-действия и запись в БД — в вызывающем коде (`js/app.js`).
 * Модуль не трогает схему/RPC/Edge (граница #63) и не дублирует uiDialogs.
 *
 * DOM-доступ — через guarded-хелперы в стиле uiDialogs: модуль безопасно
 * импортируется в node (тесты tests/mobile-cabinet.mjs), без документа все
 * функции — no-op, возвращающий безопасное значение.
 */

const MORE_ID = 'modal-more';
const MORE_BTN_ID = 'cab-more-btn';
const MORE_CLOSE_ID = 'cab-more-close';
const MENU_OPEN_CLASS = 'cab-menu-open';

let bound = false;

function $id(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function setSheet(open) {
  const m = $id(MORE_ID);
  if (!m) return;
  m.classList.toggle('hidden', !open);
  m.classList.toggle('flex', !!open);
}

/** Открыть sheet «Ещё». @returns {boolean} открыт ли sheet после вызова. */
export function openMoreSheet() {
  if (!$id(MORE_ID)) return false;
  closeAllCabMenus();
  setSheet(true);
  return true;
}

/** Закрыть sheet «Ещё». @returns {boolean} false — sheet и так закрыт/нет. */
export function closeMoreSheet() {
  const m = $id(MORE_ID);
  if (!m || m.classList.contains('hidden')) return false;
  setSheet(false);
  return true;
}

/** @returns {boolean} открыт ли sheet «Ещё» прямо сейчас. */
export function isMoreSheetOpen() {
  const m = $id(MORE_ID);
  return !!m && !m.classList.contains('hidden');
}

/**
 * Переключить панель «…» в строке.
 * Открытие одной панели закрывает остальные (два открытых меню — мёртвый тап).
 * @returns {boolean} открыта ли панель после вызова.
 */
export function toggleCabMenu(panelId) {
  const panel = panelId ? $id(panelId) : null;
  if (!panel) return false;
  const willOpen = !panel.classList.contains(MENU_OPEN_CLASS);
  closeAllCabMenus(willOpen ? panelId : '');
  panel.classList.toggle(MENU_OPEN_CLASS, willOpen);
  // Связанный тоггл (если есть) отражает состояние для скринридеров.
  // panelId собран в шаблонах строк из id записи, а id генерируются как
  // `${prefix}_${Date.now().toString(36)}_${random}` (js/core/dbContext.js) —
  // символов, ломающих селектор, там не бывает. try/catch оставлен как вторая
  // линия защиты: aria-синхронизация не должна ронять переключение панели,
  // которое к этому моменту уже выполнено.
  if (typeof document !== 'undefined' && document.querySelector) {
    let toggle = null;
    try { toggle = document.querySelector(`[data-cab-menu="${panelId}"]`); } catch (_) { /* aria-only */ }
    try { toggle?.setAttribute?.('aria-expanded', willOpen ? 'true' : 'false'); } catch (_) { /* aria-only */ }
  }
  return willOpen;
}

/** Закрыть все панели «…», кроме `exceptId` ('' — все). */
export function closeAllCabMenus(exceptId = '') {
  if (typeof document === 'undefined' || !document.querySelectorAll) return 0;
  let closed = 0;
  document.querySelectorAll(`.${MENU_OPEN_CLASS}`).forEach(p => {
    if (p.id && p.id === exceptId) return;
    p.classList.remove(MENU_OPEN_CLASS);
    closed++;
  });
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    document.querySelectorAll('[data-cab-menu]').forEach(t => {
      if (t?.setAttribute) t.setAttribute('aria-expanded', 'false');
    });
  }
  return closed;
}

/**
 * Единоразовая привязка: тогглы меню, sheet «Ещё», закрытие по подложке,
 * тапу вне панели и Escape. Повторные вызовы — no-op (не плодят слушатели).
 */
export function bindCabinetMobile() {
  if (bound || typeof document === 'undefined' || !document.addEventListener) return false;
  bound = true;

  $id(MORE_BTN_ID)?.addEventListener('click', () => openMoreSheet());
  $id(MORE_CLOSE_ID)?.addEventListener('click', () => closeMoreSheet());
  $id(MORE_ID)?.addEventListener('click', e => {
    if (e.target === $id(MORE_ID)) closeMoreSheet();   // клик по подложке
  });

  document.addEventListener('click', e => {
    const toggle = e.target?.closest?.('[data-cab-menu]');
    if (toggle?.dataset?.cabMenu) {
      toggleCabMenu(toggle.dataset.cabMenu);
      return;
    }
    // Выбор раздела в sheet закрывает sheet (переключает вкладку app.js).
    const sheetNav = e.target?.closest?.(`#${MORE_ID} .cab-nav-btn`);
    if (sheetNav) {
      closeMoreSheet();
      return;
    }
    // Любой тап, который не переключает панель «…» и не выбирает раздел в sheet,
    // закрывает открытые панели. Действие пункта меню может НЕ вызывать перерендер
    // списка (ссылка «В календарь» открывает новую вкладку) или закончиться
    // отменой диалога (uiConfirm/uiPrompt) — в обоих случаях разметка строки
    // остаётся прежней, и панель с деструктивным пунктом висела бы поверх списка
    // до следующего тапа (MX-04, #63). Закрытие не мешает обработчикам действия:
    // событие уже разослано, снятие класса его не отменяет.
    closeAllCabMenus();
  });

  document.addEventListener('keydown', e => {
    if (e?.key !== 'Escape') return;
    closeAllCabMenus();
    closeMoreSheet();
  });
  return true;
}

/** Сброс флага привязки — только для тестов. */
export function resetCabinetMobileBinding() {
  bound = false;
}
