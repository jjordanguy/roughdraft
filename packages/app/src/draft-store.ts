// Unsaved drafts kept in the browser (batch 5, assumption 5): the draft and
// the disk snapshot it was built on, per document, until the draft reaches
// disk. A crash, a force quit or a discarded tab then loses nothing; the
// next load rebases the stored draft onto the file as it is now.

import type { Snapshot } from "./document-sync";

export interface StoredDraft {
  // The document's absolute path (the key).
  key: string;
  draft: string;
  base: Snapshot;
  tabId: string;
  savedAt: number;
}

export interface DraftStore {
  get(key: string): Promise<StoredDraft | null>;
  put(record: StoredDraft): Promise<void>;
  // Removes the record, but only when `onlyIf` (when given) says so about
  // the record currently stored: another tab may have written a newer one.
  delete(key: string, onlyIf?: (stored: StoredDraft) => boolean): Promise<void>;
}

const DATABASE_NAME = "roughdraft-drafts";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function isStoredDraft(value: unknown): value is StoredDraft {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredDraft>;
  return (
    typeof record.key === "string" &&
    typeof record.draft === "string" &&
    typeof record.tabId === "string" &&
    typeof record.savedAt === "number" &&
    !!record.base &&
    typeof record.base.content === "string" &&
    typeof record.base.contentHash === "string"
  );
}

// IndexedDB, one record per document. Every failure (private mode, blocked
// storage, quota) is reported to the caller, which keeps working without it.
export function createIndexedDbDraftStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  databaseName = DATABASE_NAME,
): DraftStore | null {
  if (!factory) return null;
  let opening: Promise<IDBDatabase> | null = null;

  const open = () => {
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("The draft database is blocked by another tab."));
    }).catch((error) => {
      opening = null;
      throw error;
    });
    return opening;
  };

  return {
    async get(key) {
      const database = await open();
      const transaction = database.transaction(STORE_NAME, "readonly");
      const value = await requestResult(
        transaction.objectStore(STORE_NAME).get(key),
      );
      return isStoredDraft(value) ? value : null;
    },
    async put(record) {
      const database = await open();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(record);
      await transactionDone(transaction);
    },
    async delete(key, onlyIf) {
      const database = await open();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      if (onlyIf) {
        const value = await requestResult(store.get(key));
        if (isStoredDraft(value) && onlyIf(value)) store.delete(key);
      } else {
        store.delete(key);
      }
      await transactionDone(transaction);
    },
  };
}

// For tests and the in-memory preview.
export function createMemoryDraftStore(): DraftStore & {
  records: Map<string, StoredDraft>;
} {
  const records = new Map<string, StoredDraft>();
  return {
    records,
    async get(key) {
      const record = records.get(key);
      return record ? structuredClone(record) : null;
    },
    async put(record) {
      records.set(record.key, structuredClone(record));
    },
    async delete(key, onlyIf) {
      const record = records.get(key);
      if (!record) return;
      if (!onlyIf || onlyIf(record)) records.delete(key);
    },
  };
}
