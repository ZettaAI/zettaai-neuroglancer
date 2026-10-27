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
import { describe, expect, it, vi } from "vitest";

import type {
  PaintedVolumeBoundPreview,
  PaintedVolumeHostPort,
  PaintedVolumeUserLayer,
} from "#src/editing/painted_volume/painted_volume_host_binding.js";
import { PaintedVolumeHostBinding } from "#src/editing/painted_volume/painted_volume_host_binding.js";
import type { PaintedVolumePreviewStatus } from "#src/editing/painted_volume/painted_volume_preview.js";
import type { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";

const LABELS = "labels" as LayerId;
const SECOND = "second" as LayerId;

class FakeRenderLayer {
  references = 1;
  addRef() {
    ++this.references;
    return this;
  }
  dispose() {
    --this.references;
  }
}

class FakePreview implements PaintedVolumeBoundPreview {
  readonly status = new WatchableValue<PaintedVolumePreviewStatus>({
    kind: "unavailable",
    reason: "region-too-large",
  });
  readonly layer = new FakeRenderLayer();
  available = true;
  refetches = 0;
  disposed = false;

  constructor(readonly layerId: LayerId) {}

  get renderLayer() {
    return this.available
      ? (this.layer as unknown as PerspectiveViewRenderLayer)
      : undefined;
  }
  onDatasourceRefetched() {
    ++this.refetches;
  }
  dispose() {
    this.disposed = true;
    this.layer.dispose();
  }
}

/** Mirrors `UserLayer.addRenderLayer`: removal disposes, both announce. */
class FakeUserLayer implements PaintedVolumeUserLayer {
  readonly attached = new Set<FakeRenderLayer>();
  constructor(private readonly layersChanged: NullarySignal) {}

  addRenderLayer(layer: PerspectiveViewRenderLayer): () => void {
    const fake = layer as unknown as FakeRenderLayer;
    this.attached.add(fake);
    this.layersChanged.dispatch();
    return () => {
      this.attached.delete(fake);
      fake.dispose();
      this.layersChanged.dispatch();
    };
  }
}

function makeHost() {
  const enabled = new WatchableValue(false);
  const layersChanged = new NullarySignal();
  const userLayers = new Map<LayerId, FakeUserLayer>([
    [LABELS, new FakeUserLayer(layersChanged)],
  ]);
  const sessionLayers = new Set<LayerId>([LABELS]);
  const created: FakePreview[] = [];
  let ready = true;
  let previewsAvailable = true;
  const port: PaintedVolumeHostPort = {
    enabled,
    layersChanged,
    sessionLayerIds: () => sessionLayers,
    findUserLayer: (layerId) => userLayers.get(layerId),
    createPreview: (layerId) => {
      if (!ready) return undefined;
      const preview = new FakePreview(layerId);
      preview.available = previewsAvailable;
      created.push(preview);
      return preview;
    },
  };
  const binding = new PaintedVolumeHostBinding(port);
  return {
    binding,
    enabled,
    layersChanged,
    userLayers,
    sessionLayers,
    created,
    setReady: (value: boolean) => {
      ready = value;
    },
    setPreviewsAvailable: (value: boolean) => {
      previewsAvailable = value;
    },
  };
}

describe("PaintedVolumeHostBinding", () => {
  it("creates nothing while the preview is off", () => {
    const host = makeHost();
    host.binding.sync();
    expect(host.created).toHaveLength(0);
  });

  it("turning it on creates a preview per session layer and attaches it", () => {
    const host = makeHost();
    host.enabled.value = true;
    expect(host.created.map((preview) => preview.layerId)).toEqual([LABELS]);
    const preview = host.created[0];
    expect(host.userLayers.get(LABELS)!.attached.has(preview.layer)).toBe(true);
    expect(preview.layer.references).toBe(2);
    expect(host.binding.previewFor(LABELS)).toBe(preview);
  });

  it("turning it off detaches and disposes every preview", () => {
    const host = makeHost();
    host.enabled.value = true;
    const preview = host.created[0];
    host.enabled.value = false;
    expect(host.userLayers.get(LABELS)!.attached.size).toBe(0);
    expect(preview.disposed).toBe(true);
    expect(preview.layer.references).toBe(0);
    expect(host.binding.previewFor(LABELS)).toBeUndefined();
  });

  it("waits until the host can build the preview, then a later sync creates it", () => {
    const host = makeHost();
    host.setReady(false);
    host.enabled.value = true;
    expect(host.created).toHaveLength(0);
    host.setReady(true);
    host.binding.sync();
    expect(host.created).toHaveLength(1);
    host.binding.sync();
    expect(host.created).toHaveLength(1);
  });

  it("keeps an unavailable preview without attaching it", () => {
    const host = makeHost();
    host.setPreviewsAvailable(false);
    host.enabled.value = true;
    expect(host.created).toHaveLength(1);
    expect(host.userLayers.get(LABELS)!.attached.size).toBe(0);
    expect(host.binding.previewFor(LABELS)).toBe(host.created[0]);
  });

  it("re-attaches to a layer that was removed and added again", () => {
    const host = makeHost();
    host.enabled.value = true;
    const preview = host.created[0];
    const oldLayer = host.userLayers.get(LABELS)!;

    const newLayer = new FakeUserLayer(host.layersChanged);
    host.userLayers.set(LABELS, newLayer);
    host.layersChanged.dispatch();

    expect(oldLayer.attached.size).toBe(0);
    expect(newLayer.attached.has(preview.layer)).toBe(true);
    expect(preview.layer.references).toBe(2);
    expect(host.created).toHaveLength(1);
  });

  it("detaches while the layer is gone and attaches when it returns", () => {
    const host = makeHost();
    host.enabled.value = true;
    const preview = host.created[0];
    host.userLayers.delete(LABELS);
    host.layersChanged.dispatch();
    expect(preview.layer.references).toBe(1);

    const returned = new FakeUserLayer(host.layersChanged);
    host.userLayers.set(LABELS, returned);
    host.layersChanged.dispatch();
    expect(returned.attached.has(preview.layer)).toBe(true);
  });

  it("release disposes one layer's preview; a later sync builds a new one", () => {
    const host = makeHost();
    host.sessionLayers.add(SECOND);
    host.userLayers.set(SECOND, new FakeUserLayer(host.layersChanged));
    host.enabled.value = true;
    const [labels, second] = host.created;

    host.binding.release(LABELS);
    expect(labels.disposed).toBe(true);
    expect(second.disposed).toBe(false);
    expect(host.userLayers.get(LABELS)!.attached.size).toBe(0);

    host.binding.sync();
    expect(host.created).toHaveLength(3);
    expect(host.binding.previewFor(LABELS)).toBe(host.created[2]);
  });

  it("drops previews of layers no longer in the session on sync", () => {
    const host = makeHost();
    host.enabled.value = true;
    const preview = host.created[0];
    host.sessionLayers.clear();
    host.binding.sync();
    expect(preview.disposed).toBe(true);
  });

  it("forwards a datasource refetch to every preview", () => {
    const host = makeHost();
    host.enabled.value = true;
    host.binding.onDatasourceRefetched();
    expect(host.created[0].refetches).toBe(1);
  });

  it("listens to layer changes only while a preview is bound", () => {
    const host = makeHost();
    const add = vi.spyOn(host.layersChanged, "add");
    const remove = vi.spyOn(host.layersChanged, "remove");
    host.binding.sync();
    expect(add).not.toHaveBeenCalled();
    host.enabled.value = true;
    expect(add).toHaveBeenCalledTimes(1);
    host.enabled.value = false;
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("disposing the binding releases everything and stops listening", () => {
    const host = makeHost();
    host.enabled.value = true;
    const preview = host.created[0];
    host.binding.dispose();
    expect(preview.disposed).toBe(true);
    host.enabled.value = false;
    host.enabled.value = true;
    expect(host.created).toHaveLength(1);
  });
});
