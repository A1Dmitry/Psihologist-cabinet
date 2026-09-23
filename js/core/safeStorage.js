/**
 * SafeStorage — единственная реализация sandbox-safe хранилища проекта.
 *
 * localStorage доступен не всегда (приватный режим, отключённое хранилище,
 * песочница). До этого у `dbContext` и `clientCabinetService` были две
 * независимые копии такой обвязки; теперь она одна.
 *
 * Память — зеркало: значение доступно в текущей загрузке страницы даже когда
 * постоянное хранилище недоступно.
 */
const memory = Object.create(null);
let lsProbe;

function localStorageOrNull() {
  if (lsProbe !== undefined) return lsProbe;
  try {
    const ls = globalThis.localStorage;
    ls.setItem('__psy_probe__', '1');
    ls.removeItem('__psy_probe__');
    lsProbe = ls;
  } catch {
    lsProbe = null;
  }
  return lsProbe;
}

export const safeStorage = {
  get(key) {
    const ls = localStorageOrNull();
    if (ls) {
      try {
        const v = ls.getItem(key);
        if (v !== null) return v;
      } catch { /* хранилище отозвано между проверкой и чтением */ }
    }
    return memory[key] ?? null;
  },

  set(key, value) {
    memory[key] = value;
    const ls = localStorageOrNull();
    if (ls) {
      try { ls.setItem(key, value); } catch { /* приватный режим */ }
    }
  },

  remove(key) {
    delete memory[key];
    const ls = localStorageOrNull();
    if (ls) {
      try { ls.removeItem(key); } catch { /* приватный режим */ }
    }
  },

  /** JSON с защитой от битых данных. */
  getJSON(key, fallback = null) {
    try {
      const raw = this.get(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },

  setJSON(key, value) {
    this.set(key, JSON.stringify(value));
  }
};

export default safeStorage;
