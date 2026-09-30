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
 * @file The session region as plain numbers, decoupled from the session.
 *
 * The save path needs to know a session's edit region, but three of its four
 * entry points can run when that session is gone: `retryUnconfirmedSaves` after
 * exit, `saveCommitted` by construction ("no live session" — it flushes buffers
 * that outlived one), and any upload still in flight when teardown runs.
 *
 * Holding an `EditSession` to answer the question is what made that dangerous.
 * `EditSession.sessionVoxelBoundsFor` is a bare map lookup with no phase check,
 * so a stale reference answers cheerfully for a terminated session — a save
 * would report success against a dead region and the caller would discard the
 * user's buffer. It also pins the session, its overlay and every painted chunk
 * in memory.
 *
 * So the region is captured once, at session open, as six numbers per
 * `(layerId, resolution)`. There is nothing here to go stale in a way that
 * matters and nothing to leak: the snapshot describes a region, and a region
 * does not stop being true when the session ends.
 */

import type {
  EditSession,
  LayerId,
  Resolution,
  SessionId,
  SessionVoxelBounds,
} from "@zettaai/edit-session";
import { ChunkId } from "@zettaai/edit-session";

function scopeKey(layerId: LayerId, resolution: Resolution): string {
  return `${layerId}|${resolution}`;
}

/**
 * The edit region of one session, per `(layerId, resolution)`, frozen at open.
 * Carries its `sessionId` so a consumer can check the payload it is about to
 * clip actually belongs to this session.
 */
export class SessionRegionSnapshot {
  constructor(
    readonly sessionId: SessionId,
    private readonly bounds: ReadonlyMap<string, SessionVoxelBounds>,
  ) {}

  boundsFor(
    layerId: LayerId,
    resolution: Resolution,
  ): SessionVoxelBounds | undefined {
    return this.bounds.get(scopeKey(layerId, resolution));
  }

  /** The scopes this snapshot covers, for diagnostics. */
  get scopeCount(): number {
    return this.bounds.size;
  }
}

/**
 * Read every `(layerId, resolution)` the session permits writes at out of the
 * live session, once, while it is still ACTIVE.
 *
 * `sessionVoxelBoundsFor` ignores the `chunkId` it is given — it is literally a
 * lookup on `(layerId, resolution)` — so the zero coord below is a sentinel,
 * matching every other caller in this repo. The per-chunk part of the clip is
 * `clipToSessionBounds`, not this.
 */
export function captureSessionRegions(
  session: EditSession,
): SessionRegionSnapshot {
  const bounds = new Map<string, SessionVoxelBounds>();
  for (const layer of session.config.layers) {
    for (const resolution of layer.selectedResolutions) {
      const region = session.sessionVoxelBoundsFor({
        layerId: layer.layerId,
        resolution,
        chunkId: ChunkId.fromCoord({ x: 0, y: 0, z: 0 }),
      });
      if (region !== undefined) {
        bounds.set(scopeKey(layer.layerId, resolution), region);
      }
    }
  }
  return new SessionRegionSnapshot(session.sessionId, bounds);
}
