import { describe, expect, it, vi } from "vitest";
import {
  FRAGMENT_BATCH_MAX_CONCURRENT,
  FRAGMENT_BATCH_MAX_PIECES,
  FragmentBatchReader,
  FragmentBatchUnsupportedError,
  FragmentRecordParser,
} from "#src/datasource/calcada/fragment_batch.js";

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

function encodeRecord(
  status: number,
  draco: Uint8Array,
  manifest: Uint8Array,
): Uint8Array {
  const dracoLength = status === 0 ? draco.length : 0;
  const manifestLength = status === 0 ? manifest.length : 0;
  const out = new Uint8Array(12 + dracoLength + manifestLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, status, true);
  view.setUint32(4, dracoLength, true);
  view.setUint32(8, manifestLength, true);
  if (status === 0) {
    out.set(draco, 12);
    out.set(manifest, 12 + dracoLength);
  }
  return out;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("FragmentRecordParser", () => {
  it("reassembles records across arbitrary chunk splits", () => {
    const draco1 = new Uint8Array([1, 2, 3]);
    const manifest1 = new Uint8Array([4, 5]);
    const draco2 = new Uint8Array([6]);
    const manifest2 = new Uint8Array([7, 8, 9, 10]);
    const bytes = new Uint8Array([
      ...encodeRecord(0, draco1, manifest1),
      ...encodeRecord(0, draco2, manifest2),
    ]);
    const parser = new FragmentRecordParser();
    const records = [];
    for (let i = 0; i < bytes.length; i++) {
      records.push(...parser.push(bytes.subarray(i, i + 1)));
    }
    expect(records).toHaveLength(2);
    expect(records[0].status).toBe(0);
    expect(records[0].dracoLength).toBe(3);
    expect(records[0].manifestLength).toBe(2);
    expect([...records[0].payload]).toEqual([1, 2, 3, 4, 5]);
    expect(records[1].status).toBe(0);
    expect(records[1].dracoLength).toBe(1);
    expect(records[1].manifestLength).toBe(4);
    expect([...records[1].payload]).toEqual([6, 7, 8, 9, 10]);
  });
});

describe("FragmentBatchReader", () => {
  it("batches two read() calls into one fetch and resolves each with the right split", async () => {
    const calls: string[][] = [];
    const fetchBatch = vi.fn(async (pieceIds: string[]) => {
      calls.push(pieceIds);
      const body = new Uint8Array([
        ...encodeRecord(0, new Uint8Array([1, 2]), new Uint8Array([3])),
        ...encodeRecord(0, new Uint8Array([4]), new Uint8Array([5, 6])),
      ]);
      return new Response(streamOf([body]), { status: 200 });
    });
    const reader = new FragmentBatchReader(fetchBatch);
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([
      reader.read("piece-a", signal),
      reader.read("piece-b", signal),
    ]);
    expect(calls).toEqual([["piece-a", "piece-b"]]);
    expect([...a.draco]).toEqual([1, 2]);
    expect([...a.manifest]).toEqual([3]);
    expect([...b.draco]).toEqual([4]);
    expect([...b.manifest]).toEqual([5, 6]);
    expect(reader.supported).toBe(true);
  });

  it("returns separate buffer copies for draco and manifest", async () => {
    const fetchBatch = vi.fn(async () => {
      const body = encodeRecord(0, new Uint8Array([1, 2]), new Uint8Array([3, 4]));
      return new Response(streamOf([body]), { status: 200 });
    });
    const reader = new FragmentBatchReader(fetchBatch);
    const signal = new AbortController().signal;
    const { draco, manifest } = await reader.read("piece-a", signal);
    expect(draco.buffer).not.toBe(manifest.buffer);
  });

  it("rejects only the entry whose record has status=1", async () => {
    const fetchBatch = vi.fn(async () => {
      const body = new Uint8Array([
        ...encodeRecord(1, new Uint8Array(), new Uint8Array()),
        ...encodeRecord(0, new Uint8Array([9]), new Uint8Array([])),
      ]);
      return new Response(streamOf([body]), { status: 200 });
    });
    const reader = new FragmentBatchReader(fetchBatch);
    const signal = new AbortController().signal;
    const failing = reader.read("piece-fail", signal);
    const ok = reader.read("piece-ok", signal);
    await expect(failing).rejects.toThrow();
    const okResult = await ok;
    expect([...okResult.draco]).toEqual([9]);
  });

  it("sets supported=false on 404, rejects with FragmentBatchUnsupportedError, and short-circuits subsequent reads", async () => {
    const fetchBatch = vi.fn(async () => new Response(null, { status: 404 }));
    const reader = new FragmentBatchReader(fetchBatch);
    const signal = new AbortController().signal;
    await expect(reader.read("piece-a", signal)).rejects.toBeInstanceOf(
      FragmentBatchUnsupportedError,
    );
    expect(reader.supported).toBe(false);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    await expect(reader.read("piece-b", signal)).rejects.toBeInstanceOf(
      FragmentBatchUnsupportedError,
    );
    expect(fetchBatch).toHaveBeenCalledTimes(1);
  });

  it("sets supported=false on 405 via a rejecting fetchBatch classified by isUnsupportedError", async () => {
    class HttpError extends Error {
      response: { status: number };
      constructor(status: number) {
        super(`http ${status}`);
        this.response = { status };
      }
    }
    const fetchBatch = vi.fn(async () => {
      throw new HttpError(405);
    });
    const isUnsupportedError = (error: unknown) =>
      error instanceof HttpError &&
      (error.response.status === 404 || error.response.status === 405);
    const reader = new FragmentBatchReader(fetchBatch, isUnsupportedError);
    const signal = new AbortController().signal;
    await expect(reader.read("piece-a", signal)).rejects.toBeInstanceOf(
      FragmentBatchUnsupportedError,
    );
    expect(reader.supported).toBe(false);
  });

  it("stays usable after a non-404/405 batch failure, rejecting only that batch's entries", async () => {
    let call = 0;
    const fetchBatch = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("network blip");
      const body = encodeRecord(0, new Uint8Array([1]), new Uint8Array([2]));
      return new Response(streamOf([body]), { status: 200 });
    });
    const reader = new FragmentBatchReader(fetchBatch);
    const signal = new AbortController().signal;
    await expect(reader.read("piece-a", signal)).rejects.toThrow(
      "network blip",
    );
    expect(reader.supported).toBeUndefined();
    const result = await reader.read("piece-b", signal);
    expect([...result.draco]).toEqual([1]);
    expect(reader.supported).toBe(true);
  });

  it("rejects entries orphaned by a stream that ends before every record arrives", async () => {
    let call = 0;
    const fetchBatch = vi.fn(async () => {
      call++;
      if (call === 1) {
        const body = encodeRecord(0, new Uint8Array([1]), new Uint8Array([]));
        return new Response(streamOf([body]), { status: 200 });
      }
      const body = encodeRecord(0, new Uint8Array([2]), new Uint8Array([]));
      return new Response(streamOf([body]), { status: 200 });
    });
    const reader = new FragmentBatchReader(fetchBatch);
    const signal = new AbortController().signal;
    const p1 = reader.read("piece-a", signal);
    const p2 = reader.read("piece-b", signal);
    const a = await p1;
    expect([...a.draco]).toEqual([1]);
    await expect(p2).rejects.toThrow(/ended after 1 of 2/);

    const b = await reader.read("piece-c", signal);
    expect([...b.draco]).toEqual([2]);
    expect(fetchBatch).toHaveBeenCalledTimes(2);
  });

  it("never enqueues a read called with a pre-aborted signal", async () => {
    const fetchBatch = vi.fn(async () => new Response(streamOf([]), { status: 200 }));
    const reader = new FragmentBatchReader(fetchBatch);
    const controller = new AbortController();
    controller.abort();
    await expect(reader.read("piece-a", controller.signal)).rejects.toThrow();
    expect(reader.pendingCount()).toBe(0);
    await tick();
    expect(fetchBatch).not.toHaveBeenCalled();
  });

  it("excludes an entry aborted before flush from the POST", async () => {
    const fetchBatch = vi.fn(async () => {
      const body = encodeRecord(0, new Uint8Array([1]), new Uint8Array([]));
      return new Response(streamOf([body]), { status: 200 });
    });
    const reader = new FragmentBatchReader(fetchBatch);
    const okSignal = new AbortController().signal;
    const abortController = new AbortController();
    const doomed = reader.read("piece-doomed", abortController.signal);
    const kept = reader.read("piece-kept", okSignal);
    abortController.abort();
    await expect(doomed).rejects.toThrow();
    await kept;
    expect(fetchBatch).toHaveBeenCalledWith(["piece-kept"], expect.anything());
  });

  it("produces two fetches for more than FRAGMENT_BATCH_MAX_PIECES pending entries", async () => {
    const fetchBatch = vi.fn(async (pieceIds: string[]) => {
      const parts: Uint8Array[] = [];
      for (const _ of pieceIds) {
        parts.push(encodeRecord(0, new Uint8Array([1]), new Uint8Array([])));
      }
      const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const p of parts) {
        body.set(p, offset);
        offset += p.length;
      }
      return new Response(streamOf([body]), { status: 200 });
    });
    const reader = new FragmentBatchReader(fetchBatch);
    const signal = new AbortController().signal;
    const total = FRAGMENT_BATCH_MAX_PIECES + 1;
    const promises = [];
    for (let i = 0; i < total; i++) {
      promises.push(reader.read(`piece-${i}`, signal));
    }
    await Promise.all(promises);
    expect(fetchBatch).toHaveBeenCalledTimes(2);
    expect(fetchBatch.mock.calls[0][0].length).toBe(FRAGMENT_BATCH_MAX_PIECES);
    expect(fetchBatch.mock.calls[1][0].length).toBe(1);
  });

  it("merges entries from a later tick with earlier undispatched entries into one POST once a slot frees", async () => {
    const posts: string[][] = [];
    const held: ((response: Response) => void)[] = [];
    const fetchBatch = vi.fn((pieceIds: string[]) => {
      posts.push(pieceIds);
      return new Promise<Response>((resolve) => held.push(resolve));
    });
    const reader = new FragmentBatchReader(fetchBatch);
    const signal = new AbortController().signal;

    for (let i = 0; i < FRAGMENT_BATCH_MAX_CONCURRENT; i++) {
      reader.read(`saturate-${i}`, signal).catch(() => {});
      await tick();
    }
    expect(fetchBatch).toHaveBeenCalledTimes(FRAGMENT_BATCH_MAX_CONCURRENT);

    const a = reader.read("piece-a", signal);
    await tick();
    expect(fetchBatch).toHaveBeenCalledTimes(FRAGMENT_BATCH_MAX_CONCURRENT);

    const b1 = reader.read("piece-b1", signal);
    const b2 = reader.read("piece-b2", signal);
    await tick();
    expect(fetchBatch).toHaveBeenCalledTimes(FRAGMENT_BATCH_MAX_CONCURRENT);

    const freedBody = encodeRecord(0, new Uint8Array([9]), new Uint8Array([]));
    held[0](new Response(streamOf([freedBody]), { status: 200 }));
    await tick();

    expect(fetchBatch).toHaveBeenCalledTimes(FRAGMENT_BATCH_MAX_CONCURRENT + 1);
    expect(posts[FRAGMENT_BATCH_MAX_CONCURRENT]).toEqual([
      "piece-a",
      "piece-b1",
      "piece-b2",
    ]);

    const mergedBody = new Uint8Array([
      ...encodeRecord(0, new Uint8Array([1]), new Uint8Array([])),
      ...encodeRecord(0, new Uint8Array([2]), new Uint8Array([])),
      ...encodeRecord(0, new Uint8Array([3]), new Uint8Array([])),
    ]);
    held[FRAGMENT_BATCH_MAX_CONCURRENT](
      new Response(streamOf([mergedBody]), { status: 200 }),
    );
    const [ra, rb1, rb2] = await Promise.all([a, b1, b2]);
    expect([...ra.draco]).toEqual([1]);
    expect([...rb1.draco]).toEqual([2]);
    expect([...rb2.draco]).toEqual([3]);

    for (let i = 1; i < FRAGMENT_BATCH_MAX_CONCURRENT; i++) {
      held[i](new Response(streamOf([]), { status: 200 }));
    }
  });

  it("dispatches pieces in comparator order when more than FRAGMENT_BATCH_MAX_PIECES are pooled in one tick", async () => {
    const fetchBatch = vi.fn(async (pieceIds: string[]) => {
      const parts: Uint8Array[] = [];
      for (const _ of pieceIds) {
        parts.push(encodeRecord(0, new Uint8Array([1]), new Uint8Array([])));
      }
      const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const p of parts) {
        body.set(p, offset);
        offset += p.length;
      }
      return new Response(streamOf([body]), { status: 200 });
    });
    const descending = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
    const reader = new FragmentBatchReader(fetchBatch, () => false, descending);
    const signal = new AbortController().signal;
    const total = FRAGMENT_BATCH_MAX_PIECES + 1;
    const pieceId = (i: number) => `piece-${i.toString().padStart(4, "0")}`;
    const promises = [];
    for (let i = 0; i < total; i++) {
      promises.push(reader.read(pieceId(i), signal));
    }
    await Promise.all(promises);
    expect(fetchBatch).toHaveBeenCalledTimes(2);
    const expectedFirst = [];
    for (let i = FRAGMENT_BATCH_MAX_PIECES; i >= 1; i--) {
      expectedFirst.push(pieceId(i));
    }
    expect(fetchBatch.mock.calls[0][0]).toEqual(expectedFirst);
    expect(fetchBatch.mock.calls[1][0]).toEqual([pieceId(0)]);
  });

  it("re-sorts pieces from an earlier pooled wave together with a newly enqueued wave at dispatch time", async () => {
    const posts: string[][] = [];
    const held: ((response: Response) => void)[] = [];
    const fetchBatch = vi.fn((pieceIds: string[]) => {
      posts.push(pieceIds);
      return new Promise<Response>((resolve) => held.push(resolve));
    });
    const descending = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
    const reader = new FragmentBatchReader(fetchBatch, () => false, descending);
    const signal = new AbortController().signal;

    for (let i = 0; i < FRAGMENT_BATCH_MAX_CONCURRENT; i++) {
      reader.read(`saturate-${i}`, signal).catch(() => {});
      await tick();
    }
    expect(fetchBatch).toHaveBeenCalledTimes(FRAGMENT_BATCH_MAX_CONCURRENT);

    reader.read("piece-b", signal).catch(() => {});
    reader.read("piece-y", signal).catch(() => {});
    await tick();
    expect(fetchBatch).toHaveBeenCalledTimes(FRAGMENT_BATCH_MAX_CONCURRENT);

    reader.read("piece-c", signal).catch(() => {});
    reader.read("piece-x", signal).catch(() => {});
    await tick();
    expect(fetchBatch).toHaveBeenCalledTimes(FRAGMENT_BATCH_MAX_CONCURRENT);

    held[0](new Response(streamOf([]), { status: 200 }));
    await tick();

    expect(fetchBatch).toHaveBeenCalledTimes(FRAGMENT_BATCH_MAX_CONCURRENT + 1);
    expect(posts[FRAGMENT_BATCH_MAX_CONCURRENT]).toEqual([
      "piece-y",
      "piece-x",
      "piece-c",
      "piece-b",
    ]);

    for (let i = 1; i < FRAGMENT_BATCH_MAX_CONCURRENT; i++) {
      held[i](new Response(streamOf([]), { status: 200 }));
    }
  });

  it("preserves FIFO dispatch order across pooled waves when no sortPool comparator is given", async () => {
    const posts: string[][] = [];
    const held: ((response: Response) => void)[] = [];
    const fetchBatch = vi.fn((pieceIds: string[]) => {
      posts.push(pieceIds);
      return new Promise<Response>((resolve) => held.push(resolve));
    });
    const reader = new FragmentBatchReader(fetchBatch);
    const signal = new AbortController().signal;

    for (let i = 0; i < FRAGMENT_BATCH_MAX_CONCURRENT; i++) {
      reader.read(`saturate-${i}`, signal).catch(() => {});
      await tick();
    }

    reader.read("piece-m", signal).catch(() => {});
    reader.read("piece-z", signal).catch(() => {});
    await tick();

    reader.read("piece-a", signal).catch(() => {});
    reader.read("piece-k", signal).catch(() => {});
    await tick();

    held[0](new Response(streamOf([]), { status: 200 }));
    await tick();

    expect(posts[FRAGMENT_BATCH_MAX_CONCURRENT]).toEqual([
      "piece-m",
      "piece-z",
      "piece-a",
      "piece-k",
    ]);

    for (let i = 1; i < FRAGMENT_BATCH_MAX_CONCURRENT; i++) {
      held[i](new Response(streamOf([]), { status: 200 }));
    }
  });
});
