const DATABASE = 'ideation-workbench';
const STORE = 'drafts';

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createDraftJournal(key) {
  const fallbackKey = `ideation-workbench:draft:${key}`;
  const transact = async (mode, operation) => {
    const database = await openDatabase().catch(() => null);
    if (!database) return operation(null);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => database.close();
    });
  };
  return {
    async read() {
      try {
        const value = await transact('readonly', (store) => store ? store.get(key) : JSON.parse(localStorage.getItem(fallbackKey) || 'null'));
        return value || null;
      } catch {
        return JSON.parse(localStorage.getItem(fallbackKey) || 'null');
      }
    },
    async write(value) {
      try {
        await transact('readwrite', (store) => store ? store.put(value, key) : localStorage.setItem(fallbackKey, JSON.stringify(value)));
      } catch {
        localStorage.setItem(fallbackKey, JSON.stringify(value));
      }
    },
    async clear() {
      try {
        await transact('readwrite', (store) => store ? store.delete(key) : localStorage.removeItem(fallbackKey));
      } catch {
        localStorage.removeItem(fallbackKey);
      }
    },
  };
}

