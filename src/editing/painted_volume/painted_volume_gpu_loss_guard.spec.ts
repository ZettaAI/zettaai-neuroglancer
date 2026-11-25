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
 * A GPU lost under the 3D preview keeps the preview off in that tab, across
 * the reload neuroglancer does once the context is back.
 */

import { describe, expect, it } from "vitest";

import type { PaintedVolumeGpuLossStorage } from "#src/editing/painted_volume/painted_volume_gpu_loss_guard.js";
import {
  PAINTED_VOLUME_GPU_LOSS_KEY,
  PaintedVolumeGpuLossGuard,
} from "#src/editing/painted_volume/painted_volume_gpu_loss_guard.js";
import { FakeLogger } from "#tests/editing/fakes/fake_logger.js";

class MemoryStorage implements PaintedVolumeGpuLossStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

class ThrowingStorage implements PaintedVolumeGpuLossStorage {
  getItem(): string | null {
    throw new Error("storage blocked");
  }
  setItem(): void {
    throw new Error("storage blocked");
  }
}

function makeGuard(
  options: {
    storage?: PaintedVolumeGpuLossStorage;
    previewExists?: () => boolean;
  } = {},
) {
  const canvas = new EventTarget();
  const logger = new FakeLogger();
  const storage = "storage" in options ? options.storage : new MemoryStorage();
  const guard = new PaintedVolumeGpuLossGuard({
    canvas,
    storage,
    logger,
    previewExists: options.previewExists ?? (() => true),
  });
  const loseContext = () => canvas.dispatchEvent(new Event("webglcontextlost"));
  return { guard, canvas, logger, storage, loseContext };
}

describe("PaintedVolumeGpuLossGuard", () => {
  it("allows the preview while no context was lost", () => {
    const { guard } = makeGuard();
    expect(guard.previewAllowed()).toBe(true);
  });

  it("turns the preview off after a context lost under a preview", () => {
    const { guard, loseContext, storage } = makeGuard();
    loseContext();
    expect(guard.previewAllowed()).toBe(false);
    expect(
      (storage as MemoryStorage).items.get(PAINTED_VOLUME_GPU_LOSS_KEY),
    ).toBe("1");
  });

  it("keeps it off after the reload: a new guard over the same tab storage", () => {
    const storage = new MemoryStorage();
    const before = makeGuard({ storage });
    before.loseContext();
    before.guard.dispose();
    const afterReload = makeGuard({ storage });
    expect(afterReload.guard.previewAllowed()).toBe(false);
  });

  it("leaves the preview on when the context was lost with no preview", () => {
    const { guard, loseContext, storage } = makeGuard({
      previewExists: () => false,
    });
    loseContext();
    expect(guard.previewAllowed()).toBe(true);
    expect((storage as MemoryStorage).items.size).toBe(0);
  });

  it("a new tab (empty storage) starts with the preview on", () => {
    const lostTab = makeGuard();
    lostTab.loseContext();
    const newTab = makeGuard({ storage: new MemoryStorage() });
    expect(newTab.guard.previewAllowed()).toBe(true);
  });

  it("still turns it off on this page when storage throws", () => {
    const { guard, loseContext } = makeGuard({
      storage: new ThrowingStorage(),
    });
    expect(guard.previewAllowed()).toBe(true);
    loseContext();
    expect(guard.previewAllowed()).toBe(false);
  });

  it("still turns it off on this page without storage", () => {
    const { guard, loseContext } = makeGuard({ storage: undefined });
    loseContext();
    expect(guard.previewAllowed()).toBe(false);
  });

  it("stops listening once disposed", () => {
    const { guard, loseContext, storage } = makeGuard();
    guard.dispose();
    loseContext();
    expect((storage as MemoryStorage).items.size).toBe(0);
  });

  it("warns once when it turns the preview off, and once when it refuses one", () => {
    const { guard, loseContext, logger } = makeGuard();
    loseContext();
    guard.previewAllowed();
    guard.previewAllowed();
    expect(
      logger.logs.filter((record) => record.level === "warn"),
    ).toHaveLength(2);
  });
});
