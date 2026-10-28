/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import type {
  PaintedVolumeBoundPreview,
  PaintedVolumeHostPort,
} from "#src/editing/painted_volume/painted_volume_host_binding.js";
import { PaintedVolumeHostBinding } from "#src/editing/painted_volume/painted_volume_host_binding.js";
import type { PaintedVolumePreviewStatus } from "#src/editing/painted_volume/painted_volume_preview.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";

const LABELS = "labels" as LayerId;
const SECOND = "second" as LayerId;

function liveStatus(done: number, total: number): PaintedVolumePreviewStatus {
  return {
    kind: "live",
    fill: { done, total, failed: 0 },
    textureBytes: 64,
    factor: [1, 1, 1],
  };
}

class FakePreview implements PaintedVolumeBoundPreview {
  readonly status: WatchableValue<PaintedVolumePreviewStatus>;
  // Unavailable previews have no render layer; nothing to attach.
  readonly renderLayer = undefined;
  disposed = false;

  constructor(initial: PaintedVolumePreviewStatus) {
    this.status = new WatchableValue(initial);
  }
  onDatasourceRefetched() {}
  dispose() {
    this.disposed = true;
  }
}

function setUp(initial: PaintedVolumePreviewStatus = liveStatus(0, 4)) {
  const sessionLayerIds = new Set<LayerId>([LABELS]);
  const previews = new Map<LayerId, FakePreview>();
  let canCreate = true;
  const port: PaintedVolumeHostPort = {
    layersChanged: new NullarySignal(),
    sessionLayerIds: () => sessionLayerIds,
    findUserLayer: () => undefined,
    createPreview: (layerId) => {
      if (!canCreate) return undefined;
      const preview = new FakePreview(initial);
      previews.set(layerId, preview);
      return preview;
    },
  };
  const binding = new PaintedVolumeHostBinding(port);
  return {
    sessionLayerIds,
    previews,
    binding,
    blockCreation: () => {
      canCreate = false;
    },
  };
}

describe("PaintedVolumeHostBinding.summary", () => {
  it("waits until the host syncs it", () => {
    const { binding } = setUp();
    expect(binding.summary.value).toEqual({ kind: "waiting" });
  });

  it("follows the live preview once synced", () => {
    const { binding } = setUp(liveStatus(1, 4));
    binding.sync();
    expect(binding.summary.value).toMatchObject({
      kind: "live",
      fill: { done: 1, total: 4 },
    });
  });

  it("waits while the host cannot build a preview yet", () => {
    const { binding, blockCreation } = setUp();
    blockCreation();
    binding.sync();
    expect(binding.summary.value).toEqual({ kind: "waiting" });
  });

  it("re-summarizes when a preview's status moves, and announces it", () => {
    const { binding, previews } = setUp(liveStatus(0, 4));
    binding.sync();
    let announcements = 0;
    binding.summary.changed.add(() => ++announcements);
    previews.get(LABELS)!.status.value = liveStatus(3, 4);
    expect(announcements).toBe(1);
    expect(binding.summary.value).toMatchObject({ fill: { done: 3 } });
  });

  it("surfaces an unavailable preview", () => {
    const { binding } = setUp({
      kind: "unavailable",
      reason: "region-too-large",
    });
    binding.sync();
    expect(binding.summary.value).toEqual({
      kind: "unavailable",
      reason: "region-too-large",
    });
  });

  it("drops a released layer from the sum and stops listening to it", () => {
    const { binding, sessionLayerIds, previews } = setUp(liveStatus(1, 2));
    sessionLayerIds.add(SECOND);
    binding.sync();
    expect(binding.summary.value).toMatchObject({ fill: { total: 4 } });
    const released = previews.get(SECOND)!;
    binding.release(SECOND);
    expect(released.disposed).toBe(true);
    expect(binding.summary.value).toMatchObject({ fill: { total: 2 } });
    let announcements = 0;
    binding.summary.changed.add(() => ++announcements);
    released.status.value = liveStatus(2, 2);
    expect(announcements).toBe(0);
  });

  it("returns to waiting after the session's previews are released", () => {
    const { binding } = setUp();
    binding.sync();
    binding.releaseAll();
    expect(binding.summary.value).toEqual({ kind: "waiting" });
  });
});
