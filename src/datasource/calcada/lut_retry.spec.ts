import { describe, expect, it } from "vitest";
import {
  fetchUntilAvailable,
  LUT_RETRY_BUDGET_MS,
} from "#src/datasource/calcada/lut_retry.js";
import { HttpError } from "#src/util/http_request.js";

function fakeClock() {
  let time = 0;
  const waits: number[] = [];
  return {
    waits,
    clock: {
      now: () => time,
      wait: async (ms: number) => {
        waits.push(ms);
        time += ms;
      },
    },
  };
}

const unavailable = () => new HttpError("lut", 503, "Service Unavailable");

describe("fetchUntilAvailable", () => {
  it("keeps asking while the database wakes up, then answers", async () => {
    const { clock, waits } = fakeClock();
    let calls = 0;
    const answer = await fetchUntilAvailable(
      async () => {
        if (++calls < 4) throw unavailable();
        return "roots";
      },
      new AbortController().signal,
      { clock },
    );
    expect(answer).toBe("roots");
    expect(calls).toBe(4);
    expect(waits.length).toBe(3);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });

  it("retries a request that failed without a status, like a timeout", async () => {
    const { clock } = fakeClock();
    let calls = 0;
    await fetchUntilAvailable(
      async () => {
        if (++calls < 2)
          throw new DOMException("Request timed out", "TimeoutError");
        return "roots";
      },
      new AbortController().signal,
      { clock },
    );
    expect(calls).toBe(2);
  });

  it("gives up once the budget is spent, with the last error", async () => {
    const { clock } = fakeClock();
    await expect(
      fetchUntilAvailable(
        async () => {
          throw unavailable();
        },
        new AbortController().signal,
        { clock },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(clock.now()).toBeGreaterThanOrEqual(LUT_RETRY_BUDGET_MS);
  });

  it("does not retry what waiting cannot fix", async () => {
    const { clock } = fakeClock();
    let calls = 0;
    await expect(
      fetchUntilAvailable(
        async () => {
          calls++;
          throw new HttpError("lut", 400, "Bad Request");
        },
        new AbortController().signal,
        { clock },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it("stops when the chunk is no longer wanted", async () => {
    const { clock } = fakeClock();
    const controller = new AbortController();
    let calls = 0;
    await expect(
      fetchUntilAvailable(
        async () => {
          calls++;
          controller.abort();
          throw unavailable();
        },
        controller.signal,
        { clock },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
