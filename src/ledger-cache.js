// xrpl-sonic — the browser's own store of fetched ledgers (docs/loader.md).
//
// A validated ledger never changes, so one fetched once is kept, keyed by
// network and ledger index, with its hash beside it for the loader to check
// against what a case names. IndexedDB, one object store; without it (an
// old browser, a blocked store, a private window that refuses) there is no
// cache and the loader fetches as before. The four methods are those of
// MemoryCache in src/loader.js: get, put, count, clear.

export const DB_NAME = 'xrpl-sonic-ledgers';
export const DB_VERSION = 1;
export const STORE = 'ledgers';

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

/**
 * Open the store; resolves to the cache, or null when IndexedDB is not there
 * or refuses. Never throws.
 * @param {{ indexedDB?: IDBFactory, name?: string }} [opts]
 */
export async function openLedgerCache({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (!indexedDB) return null;
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const store = d.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('network', 'network', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
  } catch {
    return null;
  }
  const key = (network, index) => `${network}:${Number(index)}`;
  const store = (mode) => db.transaction(STORE, mode).objectStore(STORE);
  return {
    name,
    async get(network, index) {
      try {
        const row = await done(store('readonly').get(key(network, index)));
        return row ? { network: row.network, index: row.index, hash: row.hash, full: row.full, result: row.result, storedAt: row.storedAt } : null;
      } catch {
        return null;
      }
    },
    async put(entry) {
      try {
        await done(store('readwrite').put({ key: key(entry.network, entry.index), network: entry.network, index: Number(entry.index), hash: entry.hash ?? null, full: Boolean(entry.full), result: entry.result, storedAt: entry.storedAt ?? Date.now() }));
        return true;
      } catch {
        return false; // a full quota, a closed store: the loader goes on without the cache
      }
    },
    async count(network = null) {
      try {
        return network ? await done(store('readonly').index('network').count(network)) : await done(store('readonly').count());
      } catch {
        return null;
      }
    },
    async clear(network = null) {
      try {
        if (!network) {
          await done(store('readwrite').clear());
          return;
        }
        const keys = await done(store('readonly').index('network').getAllKeys(network));
        const s = store('readwrite');
        for (const k of keys) s.delete(k);
        await new Promise((resolve, reject) => {
          s.transaction.oncomplete = resolve;
          s.transaction.onerror = () => reject(s.transaction.error);
        });
      } catch {
        /* nothing to clear, or the store refused */
      }
    },
    close() {
      db.close();
    },
  };
}
