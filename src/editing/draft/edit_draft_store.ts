/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Where drafts live between tabs: one IndexedDB object store.
 *
 * IndexedDB rather than `localStorage` because a draft is voxel bytes — a
 * modest region runs to megabytes, past what `localStorage` accepts, and it
 * would have to be base64'd to fit a string store at a third again the size.
 * IndexedDB takes typed arrays through the structured clone algorithm as they
 * are, so a draft round-trips without a copy or an encoding.
 *
 * Every call can legitimately fail and the caller has to care: private
 * windows, a denied storage permission, and an exhausted quota all surface
 * here as a rejection. A draft that silently failed to write would be worse
 * than none, because the whole point is that somebody is about to rely on it
 * before doing something irreversible.
 */

import type {
  EditDraft,
  EditDraftSummary,
} from "#src/editing/draft/edit_draft.js";
import { summarizeDraft } from "#src/editing/draft/edit_draft.js";

const DATABASE_NAME = "zetta-edit-drafts";
const DATABASE_VERSION = 1;
const OBJECT_STORE = "drafts";

/**
 * Persistent store of unsaved paint, keyed by {@link EditDraft.draftId}.
 *
 * One open connection per host. `put` replaces any draft for the same region,
 * so a session keeps exactly one draft rather than accumulating a history —
 * the recoverable thing is "what I had", not every intermediate state.
 */
export class EditDraftStore {
  private constructor(private readonly database: IDBDatabase) {}

  /**
   * Open (creating on first use) the drafts database.
   *
   * Rejects when storage is unavailable — the caller decides whether the
   * operation it was protecting may still go ahead.
   */
  static async open(): Promise<EditDraftStore> {
    if (typeof indexedDB === "undefined") {
      throw new Error("edit drafts unavailable: no IndexedDB in this context");
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OBJECT_STORE)) {
        database.createObjectStore(OBJECT_STORE, { keyPath: "draftId" });
      }
    };
    return new EditDraftStore(await requestResult(request));
  }

  /** Write a draft, replacing any previous one for the same region. */
  async put(draft: EditDraft): Promise<void> {
    await this.inTransaction("readwrite", (store) => store.put(draft));
  }

  async get(draftId: string): Promise<EditDraft | undefined> {
    const found = await this.inTransaction("readonly", (store) =>
      store.get(draftId),
    );
    return found as EditDraft | undefined;
  }

  /** Every draft's metadata, newest first. Bytes are not loaded. */
  async list(): Promise<readonly EditDraftSummary[]> {
    const all = (await this.inTransaction("readonly", (store) =>
      store.getAll(),
    )) as EditDraft[];
    return all
      .map(summarizeDraft)
      .sort((left, right) => right.savedAt - left.savedAt);
  }

  async delete(draftId: string): Promise<void> {
    await this.inTransaction("readwrite", (store) => store.delete(draftId));
  }

  close(): void {
    this.database.close();
  }

  /**
   * Run one request in its own transaction.
   *
   * Both the request and the transaction are awaited: a `put` whose request
   * succeeds can still be rolled back when the transaction aborts (quota is
   * the usual reason), and reporting success before the transaction commits
   * would promise durability the store has not yet given.
   */
  private async inTransaction(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<unknown> {
    const transaction = this.database.transaction(OBJECT_STORE, mode);
    const request = run(transaction.objectStore(OBJECT_STORE));
    const [result] = await Promise.all([
      requestResult(request),
      transactionDone(transaction),
    ]);
    return result;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}
