/**
 * Streaming batch reader for calcada mesh fragments (draco geometry +
 * manifest, per piece). A ~4500-piece neuron otherwise issues ~4500 GET
 * requests; this batches many piece ids into one POST whose response is a
 * stream of fixed-header records, read incrementally as they arrive.
 *
 * Wire format, one record per requested piece, in request order:
 *   uint32 status (0 ok, 1 unavailable), little-endian
 *   uint32 dracoLength, little-endian
 *   uint32 manifestLength, little-endian
 *   dracoLength + manifestLength payload bytes (absent when status=1)
 */

const RECORD_HEADER_BYTES = 12;

export interface FragmentRecord {
  status: number;
  dracoLength: number;
  manifestLength: number;
  payload: Uint8Array<ArrayBuffer>;
}

function concat(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class FragmentRecordParser {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  push(chunk: Uint8Array<ArrayBuffer>): FragmentRecord[] {
    this.buffer = concat(this.buffer, chunk);
    const records: FragmentRecord[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= RECORD_HEADER_BYTES) {
      const header = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + offset,
        RECORD_HEADER_BYTES,
      );
      const status = header.getUint32(0, true);
      const dracoLength = header.getUint32(4, true);
      const manifestLength = header.getUint32(8, true);
      const payloadLength = dracoLength + manifestLength;
      if (this.buffer.length - offset < RECORD_HEADER_BYTES + payloadLength) {
        break;
      }
      const payloadStart = offset + RECORD_HEADER_BYTES;
      records.push({
        status,
        dracoLength,
        manifestLength,
        payload: this.buffer.slice(payloadStart, payloadStart + payloadLength),
      });
      offset = payloadStart + payloadLength;
    }
    this.buffer = this.buffer.slice(offset);
    return records;
  }
}

export class FragmentBatchUnsupportedError extends Error {}

export type FragmentBatchFetch = (
  pieceIds: string[],
  signal: AbortSignal,
) => Promise<Response>;

export const FRAGMENT_BATCH_MAX_PIECES = 2000;
export const FRAGMENT_BATCH_MAX_CONCURRENT = 2;

interface PendingEntry {
  pieceId: string;
  signal: AbortSignal;
  aborted: boolean;
  notifyAbort?: () => void;
  abortHandler?: () => void;
  resolve: (value: { draco: Uint8Array; manifest: Uint8Array }) => void;
  reject: (error: unknown) => void;
}

function unsupportedError(): FragmentBatchUnsupportedError {
  return new FragmentBatchUnsupportedError(
    "calcada batch mesh fragment reads are not supported by this server",
  );
}

/**
 * Batches read(pieceId, signal) calls issued within one tick into POSTs of
 * up to FRAGMENT_BATCH_MAX_PIECES piece ids, with at most
 * FRAGMENT_BATCH_MAX_CONCURRENT batches in flight (extra batches queue).
 *
 * `fetchBatch` may reject (e.g. a fetch wrapper that throws HttpError on a
 * non-2xx status) or resolve with a non-ok Response; both paths are checked
 * for the unsupported condition. On resolve, a 404 or 405 status marks the
 * reader unsupported. On reject, `isUnsupportedError` (default: never) gets
 * the thrown error and decides.
 */
export class FragmentBatchReader {
  private pendingEntries: PendingEntry[] = [];
  private flushScheduled = false;
  private batchQueue: PendingEntry[][] = [];
  private inFlightCount = 0;
  private supportedState: boolean | undefined = undefined;

  constructor(
    private fetchBatch: FragmentBatchFetch,
    private isUnsupportedError: (error: unknown) => boolean = () => false,
  ) {}

  get supported(): boolean | undefined {
    return this.supportedState;
  }

  pendingCount(): number {
    return this.pendingEntries.length;
  }

  read(
    pieceId: string,
    signal: AbortSignal,
  ): Promise<{ draco: Uint8Array; manifest: Uint8Array }> {
    if (this.supportedState === false) {
      return Promise.reject(unsupportedError());
    }
    if (signal.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const entry: PendingEntry = {
        pieceId,
        signal,
        aborted: false,
        resolve: (value) => {
          if (entry.abortHandler) {
            signal.removeEventListener("abort", entry.abortHandler);
          }
          resolve(value);
        },
        reject: (error) => {
          if (entry.abortHandler) {
            signal.removeEventListener("abort", entry.abortHandler);
          }
          reject(error);
        },
      };
      entry.abortHandler = () => {
        entry.aborted = true;
        entry.notifyAbort?.();
      };
      signal.addEventListener("abort", entry.abortHandler);
      this.pendingEntries.push(entry);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        setTimeout(() => this.flush(), 0);
      }
    });
  }

  private flush() {
    this.flushScheduled = false;
    const entries = this.pendingEntries;
    this.pendingEntries = [];
    const live = entries.filter((entry) => {
      if (entry.aborted) {
        entry.reject(new DOMException("aborted", "AbortError"));
        return false;
      }
      return true;
    });
    for (let i = 0; i < live.length; i += FRAGMENT_BATCH_MAX_PIECES) {
      this.batchQueue.push(live.slice(i, i + FRAGMENT_BATCH_MAX_PIECES));
    }
    this.pumpQueue();
  }

  private pumpQueue() {
    while (
      this.inFlightCount < FRAGMENT_BATCH_MAX_CONCURRENT &&
      this.batchQueue.length > 0
    ) {
      const batch = this.batchQueue.shift()!;
      this.inFlightCount++;
      void this.runBatch(batch).finally(() => {
        this.inFlightCount--;
        this.pumpQueue();
      });
    }
  }

  private async runBatch(batch: PendingEntry[]) {
    const controller = new AbortController();
    let liveMembers = batch.length;
    for (const entry of batch) {
      entry.notifyAbort = () => {
        if (--liveMembers === 0) controller.abort();
      };
    }
    let settledCount = 0;
    try {
      let response: Response;
      try {
        response = await this.fetchBatch(
          batch.map((entry) => entry.pieceId),
          controller.signal,
        );
      } catch (error) {
        if (this.isUnsupportedError(error)) {
          this.rejectUnsupported(batch, settledCount);
          return;
        }
        throw error;
      }
      if (!response.ok) {
        if (response.status === 404 || response.status === 405) {
          this.rejectUnsupported(batch, settledCount);
          return;
        }
        throw new Error(
          `calcada batch mesh fragment request failed with status ${response.status}`,
        );
      }
      this.supportedState = true;
      const reader = response.body!.getReader();
      const parser = new FragmentRecordParser();
      while (settledCount < batch.length) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const record of parser.push(value as Uint8Array<ArrayBuffer>)) {
          this.settleEntry(batch[settledCount++], record);
        }
      }
    } catch (error) {
      for (let i = settledCount; i < batch.length; i++) {
        batch[i].reject(error);
      }
    } finally {
      for (const entry of batch) entry.notifyAbort = undefined;
    }
  }

  private settleEntry(entry: PendingEntry, record: FragmentRecord) {
    if (entry.aborted) {
      entry.reject(new DOMException("aborted", "AbortError"));
      return;
    }
    if (record.status !== 0) {
      entry.reject(new Error("calcada mesh fragment unavailable"));
      return;
    }
    entry.resolve({
      draco: record.payload.slice(0, record.dracoLength),
      manifest: record.payload.slice(record.dracoLength),
    });
  }

  private rejectUnsupported(batch: PendingEntry[], fromIndex: number) {
    this.supportedState = false;
    for (let i = fromIndex; i < batch.length; i++) {
      batch[i].reject(unsupportedError());
    }
  }
}
