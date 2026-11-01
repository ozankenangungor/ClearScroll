/**
 * Persistent store of topic embeddings for the image model, in the extension
 * origin's IndexedDB (offscreen document). A topic's embedding depends only
 * on its text, the model and the prompt templates, so it is computed once
 * and reused across sessions: after a browser restart, a pause or turning
 * images off and on, the text encoder (≈ 0.35 GB while loaded, ~1 s to
 * start) is not needed again unless a new topic is added.
 *
 * Contents: the topic texts the user entered and their 768 numbers each —
 * nothing from web pages. Bounded to MAX_ENTRIES (least recently used are
 * pruned); removed with the extension.
 */

const DB = "clearscroll-vision";
const STORE = "topic-embeddings";
export const MAX_TOPIC_ENTRIES = 128;

export interface TopicStore {
  get(key: string): Promise<Float32Array | null>;
  set(key: string, vector: Float32Array): Promise<void>;
}

interface Row {
  key: string;
  vector: Float32Array;
  used: number;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function indexedDbTopicStore(idb: IDBFactory = indexedDB, now: () => number = Date.now): TopicStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "key" }).createIndex("used", "used");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => {
        db = null;
        reject(r.error);
      };
    }));
  return {
    async get(key) {
      try {
        const tx = (await open()).transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const row = (await request(store.get(key))) as Row | undefined;
        if (!row || !(row.vector instanceof Float32Array)) return null;
        store.put({ ...row, used: now() });
        return row.vector;
      } catch {
        return null; // storage unavailable: compute instead
      }
    },
    async set(key, vector) {
      try {
        const tx = (await open()).transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        store.put({ key, vector, used: now() } satisfies Row);
        const count = await request(store.count());
        if (count > MAX_TOPIC_ENTRIES) {
          // Drop the least recently used rows.
          let excess = count - MAX_TOPIC_ENTRIES;
          const cursor = store.index("used").openCursor();
          await new Promise<void>((resolve, reject) => {
            cursor.onsuccess = () => {
              const c = cursor.result;
              if (!c || excess-- <= 0) return resolve();
              c.delete();
              c.continue();
            };
            cursor.onerror = () => reject(cursor.error);
          });
        }
      } catch {
        /* best effort */
      }
    },
  };
}
