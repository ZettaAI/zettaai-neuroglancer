// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  applyCorrespondences,
  RealignError,
  realignErrorMessage,
} from "#src/datasource/calcada/realign/realign_client.js";

const endpoint = {
  baseUrl: "https://gpu.example",
  authorize: (init: RequestInit) => ({
    ...init,
    headers: { Authorization: "Bearer token" },
  }),
};
const crop = { data: new Uint8Array(4), width: 2, height: 2 };

function emptyFieldBody(): ArrayBuffer {
  const header = new TextEncoder().encode(
    JSON.stringify({ relaxed_field_shape: [2, 1, 1, 1] }),
  );
  const buffer = new ArrayBuffer(4 + header.length + 8);
  new DataView(buffer).setUint32(0, header.length, true);
  new Uint8Array(buffer, 4, header.length).set(header);
  return buffer;
}

describe("applyCorrespondences", () => {
  it("posts to the GPU backend with the authorized headers", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(emptyFieldBody(), { status: 200 }),
    );
    await applyCorrespondences(
      endpoint,
      crop,
      [],
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://gpu.example/alignment/apply_correspondences");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("Accept")).toBe("application/octet-stream");
  });

  it("maps 401, 413 and 503 to user messages", async () => {
    for (const [status, kind] of [
      [401, "unauthorized"],
      [413, "too-large"],
      [503, "busy"],
    ] as const) {
      const fetchImpl = vi.fn(
        async () => new Response('{"detail":"x"}', { status }),
      );
      const error = await applyCorrespondences(
        endpoint,
        crop,
        [],
        fetchImpl as unknown as typeof fetch,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RealignError);
      expect((error as RealignError).kind).toBe(kind);
      expect(realignErrorMessage(error)).not.toMatch(/Error:/);
    }
  });

  it("gives up on a login that never completes once cancelled", async () => {
    const stuckEndpoint = {
      baseUrl: "https://gpu.example",
      authorize: () => new Promise<RequestInit>(() => {}),
    };
    const controller = new AbortController();
    const pending = applyCorrespondences(
      stuckEndpoint,
      crop,
      [],
      vi.fn() as unknown as typeof fetch,
      controller.signal,
    ).catch((caught: unknown) => caught);
    controller.abort();
    const error = await pending;
    expect((error as RealignError).kind).toBe("cancelled");
    expect(realignErrorMessage(error)).toMatch(/cancelled/i);
  });
});
