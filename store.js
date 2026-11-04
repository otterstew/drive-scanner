// The outbox: every finished scan is saved on the phone first, then uploaded.
// If there's no signal, or sign-in has lapsed, it waits here until it can go.

let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open("scanner", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("outbox", { keyPath: "id", autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("outbox", mode);
    const result = fn(t.objectStore("outbox"));
    t.oncomplete = () => resolve(result.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const add = (item) => tx("readwrite", (s) => s.add({ ...item, createdAt: Date.now() }));
export const all = () => tx("readonly", (s) => s.getAll());
export const remove = (id) => tx("readwrite", (s) => s.delete(id));
export const put = (item) => tx("readwrite", (s) => s.put(item));

// Recently uploaded, newest first. Only names and links, kept on this phone.
export function recent() {
  try { return JSON.parse(localStorage.getItem("scanner.recent") || "[]"); } catch { return []; }
}
export function addRecent(entry) {
  const list = [entry, ...recent()].slice(0, 15);
  try { localStorage.setItem("scanner.recent", JSON.stringify(list)); } catch { /* fine */ }
}
