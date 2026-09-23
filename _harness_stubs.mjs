// Общие DOM-заглушки для node-тестов (та же модель, что в verify_app.mjs).
export function fakeEl() {
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
