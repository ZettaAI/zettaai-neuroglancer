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
 * @file How `SaveTracker` carries a refused save.
 *
 * A stale-baseline refusal is not a failed save: nothing was written and
 * nothing was lost, the paint is still dirty, and the save is waiting on a
 * person. The tracker has to keep that distinct from the failure path, or the
 * topbar paints the layers red and `lastFailureMessage()` starts reporting a
 * loss that did not happen.
 */

import type { EditSession, SaveResult } from "@zettaai/edit-session";
import { layerId } from "@zettaai/edit-session";
import { describe, expect, it, vi } from "vitest";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import type { SaveConflictPolicy } from "#src/editing/reconcile/save_conflict_refusal.js";
import { SaveConflictError } from "#src/editing/reconcile/save_conflict_refusal.js";
import type { StaleBaselineScan } from "#src/editing/reconcile/stale_baseline_scan.js";
import { SaveTracker } from "#src/editing/ui/session_controls/save_tracker.js";

const SUCCESS: SaveResult = { overall: "all-succeeded", outcomes: [] };

function conflictScan(diverged = 1, uncomparable = 0): StaleBaselineScan {
  return {
    diverged: Array.from({ length: diverged }, (_unused, index) => ({
      write: { chunkId: `${index},0,0` },
      baselineHash: "base",
      remoteHash: "moved",
    })),
    uncomparable: Array.from({ length: uncomparable }, () => ({
      write: { chunkId: "9,9,9" },
      reason: "no-retained-baseline" as const,
    })),
    unchangedCount: 0,
    alreadyAppliedCount: 0,
  } as unknown as StaleBaselineScan;
}

/** Records the policy every save was started with. */
function fakeHost(behaviour: {
  failFirstWithConflict?: boolean;
  conflictStrategy?: "warn" | "combine";
  uncomparable?: number;
}): EditSessionHost & { policies: SaveConflictPolicy[] } {
  const policies: SaveConflictPolicy[] = [];
  const host = {
    policies,
    // Overwriting takes a draft first; the default fake just succeeds.
    snapshotDraft: vi.fn(async () => ({})),
    editPreferences: {
      value: {
        value:
          behaviour.conflictStrategy === undefined
            ? null
            : { conflictStrategy: behaviour.conflictStrategy },
      },
    },
    state: { value: { value: { layers: [{ layerId: layerId("L1") }] } } },
    hasUnconfirmedSaves: () => false,
    cancelActiveSave: () => {},
    saveActive: vi.fn(
      async (
        _layerIds?: readonly unknown[],
        _signal?: AbortSignal,
        policy: SaveConflictPolicy = "refuse",
      ): Promise<SaveResult> => {
        policies.push(policy);
        if (behaviour.failFirstWithConflict === true && policies.length === 1) {
          throw new SaveConflictError(
            conflictScan(1, behaviour.uncomparable ?? 0),
          );
        }
        return SUCCESS;
      },
    ),
  };
  return host as unknown as EditSessionHost & {
    policies: SaveConflictPolicy[];
  };
}

function fakeSession(): EditSession {
  return {
    config: { layers: [{ layerId: layerId("L1") }] },
    dirty: { isDirty: () => true },
  } as unknown as EditSession;
}

describe("SaveTracker — refused saves", () => {
  it("records the conflict instead of reporting a failure", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);
    // Crucially NOT `done-partial`, which is what drives the red failure UI.
    expect(tracker.state.kind).toBe("idle");
    expect(tracker.lastFailureMessage()).toBeUndefined();
  });

  it("defaults to refusing, so a plain save is always scanned", async () => {
    const host = fakeHost({});
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(host.policies).toEqual(["refuse"]);
    expect(tracker.pendingConflict()).toBeUndefined();
  });

  it("clears the conflict, and writes nothing, when dismissed", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    tracker.dismissConflict();

    expect(tracker.pendingConflict()).toBeUndefined();
    expect(host.policies).toEqual(["refuse"]);
  });

  it("re-saves with the overwrite policy when the user confirms", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    await tracker.overwriteConflict(host, session);

    expect(host.policies).toEqual(["refuse", "overwrite"]);
    expect(tracker.pendingConflict()).toBeUndefined();
  });

  it("ignores an overwrite with no conflict outstanding", async () => {
    const host = fakeHost({});
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.overwriteConflict(host, session);

    expect(host.policies).toEqual([]);
  });

  it("summarises both diverged and unprovable chunks", () => {
    const error = new SaveConflictError(conflictScan(2, 3));
    expect(error.message).toContain("2 changed");
    expect(error.message).toContain("3 could not be checked");
  });

  it("merges, then saves the combined result with the scan still armed", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    const merged: unknown[] = [];
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async (scan: unknown) => {
        merged.push(scan);
        return { mergedChunks: 1, acceptedFromRemote: 4, unresolved: 0 };
      },
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    const outcome = await tracker.mergeConflict(host, session);

    expect(merged).toHaveLength(1);
    expect(outcome?.acceptedFromRemote).toBe(4);
    // The follow-up save skips the scan — the payload already incorporates
    // the remote — but it is scoped to THIS save only (see the undo test).
    expect(host.policies).toEqual(["refuse", "just-merged"]);
    expect(tracker.pendingConflict()).toBeUndefined();
  });

  it("takes a recoverable draft before overwriting", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    const order: string[] = [];
    (host as unknown as { snapshotDraft: unknown }).snapshotDraft = vi.fn(
      async (reason: string) => {
        order.push(`draft:${reason}`);
        return {};
      },
    );
    const inner = host.saveActive as unknown as (...args: unknown[]) => unknown;
    (host as unknown as { saveActive: unknown }).saveActive = async (
      ...args: unknown[]
    ) => {
      order.push("save");
      return inner(...args);
    };
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    await tracker.overwriteConflict(host, session);

    // The draft has to exist before the write that makes it necessary.
    expect(order).toEqual(["save", "draft:before-overwrite", "save"]);
  });

  it("refuses to overwrite when the draft cannot be written", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { snapshotDraft: unknown }).snapshotDraft = vi.fn(
      async () => {
        throw new Error("quota exceeded");
      },
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    await tracker.overwriteConflict(host, session);

    // No second save: nothing was overwritten without a net.
    expect(host.policies).toEqual(["refuse"]);
    // And the decision is still open, so the user can retry or back out.
    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);
    expect(tracker.lastFailureMessage()).toContain("quota exceeded");
  });

  it("ignores a merge with no conflict outstanding", async () => {
    const host = fakeHost({});
    const mergeConflicts = vi.fn();
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts =
      mergeConflicts;
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    expect(await tracker.mergeConflict(host, session)).toBeUndefined();
    expect(mergeConflicts).not.toHaveBeenCalled();
  });

  it("combines without asking when the user configured combine", async () => {
    const host = fakeHost({
      failFirstWithConflict: true,
      conflictStrategy: "combine",
    });
    const mergeConflicts = vi.fn(async () => ({
      mergedChunks: 1,
      acceptedFromRemote: 2,
      unresolved: 0,
    }));
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts =
      mergeConflicts;
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(mergeConflicts).toHaveBeenCalledTimes(1);
    // No dialog: the user already said how they want this answered.
    expect(tracker.pendingConflict()).toBeUndefined();
    expect(host.policies).toEqual(["refuse", "just-merged"]);
  });

  it("still asks under combine when a chunk cannot be merged", async () => {
    // No baseline means no third input; auto-combining the rest would write
    // over exactly the chunks we were least sure about.
    const host = fakeHost({
      failFirstWithConflict: true,
      conflictStrategy: "combine",
      uncomparable: 1,
    });
    const mergeConflicts = vi.fn();
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts =
      mergeConflicts;
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(mergeConflicts).not.toHaveBeenCalled();
    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);
  });

  it("asks by default, with no strategy configured", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    const mergeConflicts = vi.fn();
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts =
      mergeConflicts;
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(mergeConflicts).not.toHaveBeenCalled();
    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);
  });

  it("keeps the conflict pending when the merge itself fails", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => {
        throw new Error("chunk source went away");
      },
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    expect(await tracker.mergeConflict(host, session)).toBeUndefined();

    // Clearing before the merge landed would close the dialog over dirty
    // paint, and the next Save would raise the same conflict unexplained.
    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);
    expect(host.policies).toEqual(["refuse"]);
    expect(tracker.lastFailureMessage()).toContain("chunk source went away");
  });

  /**
   * The merge is an undo entry, so it need not stand. An earlier version
   * advanced the retained baseline to the merged-against remote as a side
   * effect outside the `Edit`; Ctrl+Z then rolled the overlay back while the
   * baseline still claimed we had reconciled, and the next save sailed past
   * the scan and overwrote a colleague silently. Nothing durable is advanced
   * now, so a later save must still be a scanning one.
   */
  it("leaves no residue that would let a later save skip the scan", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => ({ mergedChunks: 1, acceptedFromRemote: 2, unresolved: 0 }),
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);
    await tracker.mergeConflict(host, session);

    // The user undoes the merge, then saves again.
    await tracker.startSave(host, session);

    expect(host.policies).toEqual(["refuse", "just-merged", "refuse"]);
  });
});
