/**
 * Serialising undo requests.
 *
 * Every keybinding invokes undo fire-and-forget, so two quick presses would
 * otherwise run two reverts at once. That is not merely wasteful: a stepped
 * split's operations share roots, so the second revert cannot take the server's
 * lock and comes back 409 — and whichever call fails puts its entry back on a
 * stack the other has already moved past, leaving the order wrong.
 *
 * Requests are queued rather than dropped: two presses should undo two edits,
 * just one after the other.
 */
export function createSerialRunner() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    // A failed task must not poison the queue for the ones behind it, so the
    // chain is built on a settled tail while the caller still sees the rejection.
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
}
