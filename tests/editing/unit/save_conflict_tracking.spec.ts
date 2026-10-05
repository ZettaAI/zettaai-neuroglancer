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

/** What `mergeConflicts` resolves to. Conflicted voxels are the lossy half. */
function mergeOutcome(over: { merged?: number; conflicted?: number } = {}) {
  return {
    mergedChunks: over.merged ?? 1,
    acceptedFromRemote: 2,
    conflicted: over.conflicted ?? 0,
  };
}

/** Records the policy every save was started with. */
function fakeHost(behaviour: {
  failFirstWithConflict?: boolean;
  automerge?: boolean;
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
          behaviour.automerge === undefined
            ? null
            : { automerge: behaviour.automerge },
      },
    },
    state: { value: { value: { layers: [{ layerId: layerId("L1") }] } } },
    hasUnconfirmedSaves: () => false,
    cancelActiveSave: () => {},
    reloadConflictedChunks: vi.fn(async () => ({
      reloadedChunks: 1,
      unreadableChunks: 0,
    })),
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
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
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
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    tracker.dismissConflict();

    expect(tracker.pendingConflict()).toBeUndefined();
    expect(host.policies).toEqual(["refuse"]);
  });

  it("re-saves with the overwrite policy when the user confirms", async () => {
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
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
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
    const merged: unknown[] = [];
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async (scan: unknown) => {
        merged.push(scan);
        return mergeOutcome();
      },
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    const outcome = await tracker.mergeConflict(host, session);

    expect(merged).toHaveLength(1);
    expect(outcome?.acceptedFromRemote).toBe(2);
    // The follow-up save skips the scan — the payload already incorporates
    // the remote — but it is scoped to THIS save only (see the undo test).
    expect(host.policies).toEqual(["refuse", "just-merged"]);
    expect(tracker.pendingConflict()).toBeUndefined();
  });

  it("takes a recoverable draft before overwriting", async () => {
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
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

  it("combines without asking, which is the default", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    const mergeConflicts = vi.fn(async () => mergeOutcome());
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

  it("still asks when a chunk cannot be merged, automerge or not", async () => {
    // No baseline means no third input; auto-combining the rest would write
    // over exactly the chunks we were least sure about.
    const host = fakeHost({ failFirstWithConflict: true, uncomparable: 1 });
    const mergeConflicts = vi.fn();
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts =
      mergeConflicts;
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(mergeConflicts).not.toHaveBeenCalled();
    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);
  });

  /**
   * The toggle decides whether the user is ASKED, never what combining does.
   * Both answers share `reconcileAndSave`, which is what makes that true; this
   * pins it from the outside, so routing either path around that shared call —
   * or making any part of the reconcile read the setting — is caught.
   */
  it("combines identically whether it was asked for or automatic", async () => {
    async function combineWith(automerge: boolean) {
      const host = fakeHost({ failFirstWithConflict: true, automerge });
      const mergeConflicts = vi.fn(async () => mergeOutcome({ conflicted: 4 }));
      (host as unknown as { mergeConflicts: unknown }).mergeConflicts =
        mergeConflicts;
      const session = fakeSession();
      const tracker = new SaveTracker(host, session);
      await tracker.startSave(host, session);
      // With automerge off the save stops at the dialog, so the user's click
      // is what carries on from here; with it on this is already done.
      if (!automerge) await tracker.mergeConflict(host, session);
      return { host, tracker, mergeConflicts };
    }

    const automatic = await combineWith(true);
    const asked = await combineWith(false);

    expect(asked.mergeConflicts.mock.calls).toEqual(
      automatic.mergeConflicts.mock.calls,
    );
    expect(asked.host.policies).toEqual(automatic.host.policies);
    expect(asked.tracker.conflictedVoxelCount()).toBe(
      automatic.tracker.conflictedVoxelCount(),
    );
  });

  it("asks when the user turned automerge off", async () => {
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
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
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
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
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => mergeOutcome(),
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);
    await tracker.mergeConflict(host, session);

    // The user undoes the merge, then saves again.
    await tracker.startSave(host, session);

    expect(host.policies).toEqual(["refuse", "just-merged", "refuse"]);
  });
  /**
   * The bug this whole branch of `startSave` is shaped around. Publishing the
   * conflict and dispatching BEFORE deciding whether to answer it
   * automatically made the dialog mount and unmount within a couple of frames
   * — a pop-up that appears and vanishes, which reads as a glitch.
   *
   * Asserting the FINAL state cannot catch it: the flash is an intermediate
   * state, and the final state is identical either way. So this samples every
   * dispatch instead.
   */
  it("never opens the dialog on a conflict it answers itself", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => mergeOutcome(),
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    const dialogOpenAt: boolean[] = [];
    tracker.changed.add(() => {
      dialogOpenAt.push(tracker.pendingConflict() !== undefined);
    });

    await tracker.startSave(host, session);

    expect(dialogOpenAt.length).toBeGreaterThan(0);
    expect(dialogOpenAt).not.toContain(true);
  });

  /**
   * An automerge that cannot finish has to become the dialog. Silence would
   * leave dirty paint, no explanation, and a Save button that keeps refusing.
   */
  it("falls back to the dialog when an automatic merge fails", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => {
        throw new Error("chunk source went away");
      },
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);
    expect(tracker.lastFailureMessage()).toContain("chunk source went away");
    expect(host.policies).toEqual(["refuse"]);
  });

  it("reports the voxels a combine gave to the remote", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => mergeOutcome({ merged: 2, conflicted: 7 }),
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(tracker.conflictedVoxelCount()).toBe(7);
  });

  /**
   * A combine no longer costs whole chunks, so it must not report any. The
   * chunk count belongs to Take theirs alone.
   */
  it("reports no discarded chunks for a combine that resolved voxels", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => mergeOutcome({ merged: 2, conflicted: 7 }),
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(tracker.reloadedChunkCount()).toBe(0);
  });

  it("reports nothing when every voxel combined cleanly", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => mergeOutcome(),
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(tracker.conflictedVoxelCount()).toBe(0);
  });

  /**
   * Reload needs only the remote's bytes, never a baseline — which is why it
   * is offered for chunks the scan could NOT prove, where a merge cannot be.
   */
  it("reloads, then finishes the save with the scan still armed", async () => {
    const host = fakeHost({
      failFirstWithConflict: true,
      automerge: false,
      uncomparable: 1,
    });
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    await tracker.reloadConflict(host, session);

    expect(
      (host as unknown as { reloadConflictedChunks: { mock: { calls: [] } } })
        .reloadConflictedChunks.mock.calls,
    ).toHaveLength(1);
    expect(tracker.pendingConflict()).toBeUndefined();
    // "refuse", NOT "just-merged": a chunk whose remote could not be read
    // still carries our stale bytes, and skipping the scan would write it
    // blind. After a successful reload the rest classify `already-applied`.
    expect(host.policies).toEqual(["refuse", "refuse"]);
    expect(tracker.reloadedChunkCount()).toBe(1);
  });

  it("keeps the conflict pending when the reload itself fails", async () => {
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
    (
      host as unknown as { reloadConflictedChunks: unknown }
    ).reloadConflictedChunks = vi.fn(async () => {
      throw new Error("storage unreachable");
    });
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    await tracker.reloadConflict(host, session);

    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);
    expect(host.policies).toEqual(["refuse"]);
    expect(tracker.lastFailureMessage()).toContain("storage unreachable");
  });

  it("ignores a reload with no conflict outstanding", async () => {
    const host = fakeHost({});
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.reloadConflict(host, session);

    expect(host.policies).toEqual([]);
  });

  /**
   * The reconcile promises the save that follows it that the payload now
   * incorporates the remote, which is what lets that save skip the scan. If
   * the reconcile could not finish, that promise is void — so no scan-skipping
   * save may be issued, or this session's pre-merge bytes go over a
   * colleague's newer ones with no dialog and no way back.
   */
  it("issues no unscanned save when the reconcile could not finish", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => {
        throw new Error("couldn't re-read L1 chunk 1,0,0 to merge it");
      },
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(host.policies).toEqual(["refuse"]);
    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);
    expect(tracker.conflictedVoxelCount()).toBe(0);
  });

  /**
   * The notice says "everything else was saved". After a save that failed,
   * that sentence is false, and the failure — not the discard — is the news.
   */
  it("reports no discard when the save it paid for never landed", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => mergeOutcome({ merged: 1, conflicted: 2 }),
    );
    const inner = host.saveActive as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    (host as unknown as { saveActive: unknown }).saveActive = async (
      ...args: unknown[]
    ) => {
      const result = await inner(...args);
      if (host.policies.length > 1) throw new Error("network went away");
      return result;
    };
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(tracker.lastFailureMessage()).toContain("network went away");
    expect(tracker.conflictedVoxelCount()).toBe(0);
  });

  /**
   * The reconcile is network I/O the user can paint through. Reporting idle
   * across it left the Save button enabled, so a second click could start a
   * whole save from the pre-reconcile overlay.
   */
  it("blocks a second save for the whole reconcile window", async () => {
    const host = fakeHost({ failFirstWithConflict: true });
    let releaseMerge: () => void = () => {};
    const merging = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => {
        await merging;
        return mergeOutcome();
      },
    );
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);

    const first = tracker.startSave(host, session);
    await Promise.resolve();
    // Mid-reconcile: the tracker must not look idle, and a second Save must
    // be refused rather than racing the one in progress.
    expect(tracker.state.kind).toBe("reconciling");
    await tracker.startSave(host, session);
    expect(host.policies).toEqual(["refuse"]);

    releaseMerge();
    await first;

    expect(host.policies).toEqual(["refuse", "just-merged"]);
  });

  /**
   * Clearing the conflict without dispatching left the dialog rendered
   * against a conflict that no longer existed — every button a no-op, and
   * nothing overwritten despite the user confirming an irreversible action.
   */
  it("publishes the cleared conflict even when the save cannot start", async () => {
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
    let releaseSave: () => void = () => {};
    const saving = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);
    expect(tracker.pendingConflict()).toBeInstanceOf(SaveConflictError);

    // A save is in flight, so the overwrite's own save will early-return.
    const inner = host.saveActive as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    (host as unknown as { saveActive: unknown }).saveActive = async (
      ...args: unknown[]
    ) => {
      await saving;
      return inner(...args);
    };
    const inFlight = tracker.startSave(host, session);
    await Promise.resolve();

    const seen: boolean[] = [];
    tracker.changed.add(() =>
      seen.push(tracker.pendingConflict() !== undefined),
    );
    await tracker.overwriteConflict(host, session);

    expect(tracker.pendingConflict()).toBeUndefined();
    // Without the dispatch the UI never learns the dialog should close.
    expect(seen).toContain(false);

    releaseSave();
    await inFlight;
  });

  /**
   * One answer can cost both ways: Take theirs drops whole boxes, and the save
   * it triggers can itself refuse and be combined. Each loss is reported in
   * its own unit — collapsing them into one number would have said "5 areas"
   * about 2 voxels, or the reverse.
   */
  it("reports a reload's chunks and a follow-up combine's voxels apart", async () => {
    const host = fakeHost({ failFirstWithConflict: true, automerge: false });
    (host as unknown as { mergeConflicts: unknown }).mergeConflicts = vi.fn(
      async () => mergeOutcome({ merged: 1, conflicted: 2 }),
    );
    (
      host as unknown as { reloadConflictedChunks: unknown }
    ).reloadConflictedChunks = vi.fn(async () => ({
      reloadedChunks: 5,
      unreadableChunks: 0,
    }));
    const session = fakeSession();
    const tracker = new SaveTracker(host, session);
    await tracker.startSave(host, session);

    // The reload's own save refuses again, and automerge answers that one.
    (host as unknown as { editPreferences: unknown }).editPreferences = {
      value: { value: { automerge: true } },
    };
    const inner = host.saveActive as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    (host as unknown as { saveActive: unknown }).saveActive = async (
      ...args: unknown[]
    ) => {
      if (host.policies.length === 1) {
        host.policies.push("refuse");
        throw new SaveConflictError(conflictScan(1, 0));
      }
      return inner(...args);
    };

    await tracker.reloadConflict(host, session);

    expect(tracker.reloadedChunkCount()).toBe(5);
    expect(tracker.conflictedVoxelCount()).toBe(2);
  });
});
