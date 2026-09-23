#!/usr/bin/env node
// Смоук: импорт всего графа модулей + boot с DOM-заглушками (ловит синтаксис/линк-ошибки ESM, которые node --check пропускает).
// Запуск: node verify_app.mjs
function fakeEl() {
  const t = function(){};
  return new Proxy(t, {
    get(_, prop) {
      if (prop === 'classList') return { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
      if (prop === 'style') return {};
      if (prop === 'dataset') return {};
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML' || prop === 'src' || prop === 'href') return '';
      if (prop === 'checked') return false;
      if (prop === 'querySelectorAll') return () => [];
      if (prop === 'querySelector') return () => fakeEl();
      if (prop === 'addEventListener') return () => {};
      if (prop === 'removeEventListener') return () => {};
      if (prop === 'appendChild') return () => fakeEl();
      if (prop === 'setAttribute') return () => {};
      if (prop === 'getAttribute') return () => null;
      if (prop === 'closest') return () => null;
      if (prop === 'scrollIntoView') return () => {};
      if (prop === 'then') return undefined; // не thenable!
      if (prop === Symbol.toPrimitive) return () => '';
      return fakeEl();
    },
    set() { return true; },
    apply() { return fakeEl(); }
  });
}
const listeners = {};
globalThis.document = {
  title: '',
  head: fakeEl(),
  body: fakeEl(),
  documentElement: fakeEl(),
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  getElementById: () => fakeEl(),
  createElement: () => fakeEl(),
  addEventListener: (n, fn) => { (listeners[n] ||= []).push(fn); },
  removeEventListener: () => {},
  hidden: false
};
const lsMap = new Map();
globalThis.localStorage = {
  get: k => (lsMap.has(k) ? lsMap.get(k) : null),
  set: (k, v) => lsMap.set(k, String(v)),
  remove: k => lsMap.delete(k),
  clear: () => lsMap.clear()
};
globalThis.window = new Proxy({
  localStorage: globalThis.localStorage,
  addEventListener: (n, fn) => { (listeners['w:' + n] ||= []).push(fn); },
  scrollTo: () => {},
  location: { pathname: '/', search: '', hash: '', origin: 'http://x' }
}, { get(t, p) { return p in t ? t[p] : fakeEl(); }, set() { return true; } });
globalThis.location = globalThis.window.location;
globalThis.history = { pushState(){}, replaceState(){} };
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-harness", clipboard: { writeText: async () => {} } } });
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.prompt = () => 'x';
globalThis.FileReader = class {};
globalThis.fetch = async () => ({ ok: false, status: 0, text: async () => '', json: async () => ({}) });

try {
  await import(new URL('./js/app.js', import.meta.url));
  console.log('IMPORT OK');
  // вызвать DOMContentLoaded-обработчики (boot)
  for (const fn of listeners['DOMContentLoaded'] || []) { try { fn(); } catch (e) { console.log('BOOT ERROR:', e.constructor.name, e.message, e.stack?.split('\n')[1]); } }
  for (const fn of listeners['w:load'] || []) { try { fn(); } catch (e) { console.log('LOAD ERROR:', e.constructor.name, e.message); } }
  console.log('BOOT RAN');
} catch (e) {
  console.log('IMPORT/LINK ERROR:', e.constructor.name + ':', e.message);
}
