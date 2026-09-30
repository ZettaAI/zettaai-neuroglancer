import { describe, expect, it } from "vitest";
import { createSerialRunner } from "#src/datasource/calcada/undo_serialization.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSerialRunner", () => {
  it("does not start the second task until the first settles", async () => {
    const run = createSerialRunner();
    const first = deferred<string>();
    const started: string[] = [];

    const a = run(() => {
      started.push("a");
      return first.promise;
    });
    const b = run(async () => {
      started.push("b");
      return "b";
    });

    await Promise.resolve();
    expect(started).toEqual(["a"]);

    first.resolve("a");
    await Promise.all([a, b]);
    expect(started).toEqual(["a", "b"]);
  });

  it("runs queued tasks in the order they were submitted", async () => {
    const run = createSerialRunner();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        run(async () => {
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  // A revert that the server refuses is ordinary — the queue behind it has to
  // keep working, and the caller still has to see the failure.
  it("keeps running after a task rejects, and still rejects that caller", async () => {
    const run = createSerialRunner();
    const failing = run(async () => {
      throw new Error("409");
    });
    await expect(failing).rejects.toThrow("409");

    await expect(run(async () => "ok")).resolves.toBe("ok");
  });

  it("does not lose a task queued behind a rejecting one", async () => {
    const run = createSerialRunner();
    const failing = run(async () => {
      throw new Error("boom");
    });
    const after = run(async () => "after");
    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("after");
  });
});
