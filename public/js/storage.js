// Where the app keeps its data: localStorage when the browser allows it, otherwise an
// in-memory stand-in so the app still works for the current visit (you'd just have to
// log in again next time). No cookies, sessionStorage or IndexedDB are used anywhere.

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

function probe() {
  try {
    const s = globalThis.localStorage;
    const key = '__storage_probe__';
    s.setItem(key, '1');
    s.removeItem(key);
    return s;
  } catch {
    return null;
  }
}

const local = probe();

/** True when data survives reloads (localStorage works). */
export const isPersistent = Boolean(local);

export const storage = local || memoryStorage();
