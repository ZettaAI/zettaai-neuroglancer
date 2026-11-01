/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

// @vitest-environment jsdom

import { layerId, Resolution } from "@zettaai/edit-session";
import { afterEach, describe, it, expect, vi } from "vitest";

import { PointerEventBridge } from "#src/editing/pointer_event_bridge.js";
import type { PaintCompute } from "#src/editing/tool_runtimes/paint_types.js";
import { ConsumerPaintingTools } from "#src/editing/tool_runtimes/painting_tools.js";
import { EditScope } from "#src/editing/tooling/edit_scope.js";
import { WatchableValue } from "#src/trackable_value.js";

vi.hoisted(() => {
  (globalThis as any).WebGL2RenderingContext ??= {};
  (globalThis as any).PointerEvent ??= class extends MouseEvent {};
});

const RESOLUTION = Resolution.from([8, 8, 40]);
const TARGET = layerId("target");
const VOLUME = 256;
const METADATA: any = {
  layerId: TARGET,
  voxelDataType: "uint32",
  channels: 1,
  scales: [
    {
      resolution: RESOLUTION,
      voxelSizeNm: [8, 8, 40],
      voxelOffset: [0, 0, 0],
      sizeVoxels: [VOLUME, VOLUME, VOLUME],
      chunkDataSize: [32, 32, 32],
    },
  ],
};

const emptyBatch = () => ({
  targetLayerId: TARGET,
  targetResolution: RESOLUTION,
  chunks: [],
});

/** Let every promise and timer already scheduled run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const openBridges: PointerEventBridge[] = [];

/** The real bridge and tools, with only the viewer and the edit library faked. */
function setup(compute: Partial<PaintCompute>, toolId: string) {
  const edit: any = {
    readChunk: async () => ({
      byteLength: 0,
      asView: () => new Uint32Array(0),
    }),
    beginWrite: async () => ({}),
    commitWrites: () => {},
    writeRegion: async () => {},
    sessionVoxelBoundsFor: () => ({
      loX: 0,
      loY: 0,
      loZ: 0,
      hiX: VOLUME,
      hiY: VOLUME,
      hiZ: VOLUME,
    }),
    withBatch: <R>(fn: () => R) => fn(),
    record: () => true,
    discard: async () => {},
  };
  const scope = new EditScope({ beginEdit: () => edit } as any);
  const tools = new ConsumerPaintingTools({
    scope,
    compute: compute as PaintCompute,
    metadataByLayer: new Map([[TARGET, METADATA]]),
    allowedResolutionsByLayer: new Map([[TARGET, [RESOLUTION]]]),
    readChunkAt: async () => {
      throw new Error("no image in this test");
    },
    initialState: {
      targetLayerId: TARGET,
      targetResolution: RESOLUTION,
      radius: 2,
      radiusCycle: [1],
      activeValue: 7,
      eraseValue: 0,
      mask: undefined,
      fillMode: "2d",
      spacingFraction: 0.1,
      autoSelectPaintedSegment: false,
      fillClosedPaths: false,
    },
  });
  const activeToolId = new WatchableValue<string | undefined>(toolId);
  let pointerMoved = () => {};
  const host: any = {
    activeSession: new WatchableValue<unknown>({}),
    activeToolId,
    painting: tools,
    viewer: {
      mouseState: {
        active: true,
        unsnappedPosition: [10, 10, 5],
        changed: {
          add: (listener: () => void) => {
            pointerMoved = listener;
            return () => {};
          },
        },
        pageX: 0,
        pageY: 0,
      },
    },
    activeToolWorkingResolution: () => undefined,
    globalVoxelSizeNm: () => undefined,
    logger: { debug() {}, error() {}, warn() {} },
  };
  const bridge = new PointerEventBridge(host, {
    panels: [],
    updateStarted: { add: () => () => {} },
  } as any);
  openBridges.push(bridge);
  const element = document.createElement("div");
  document.body.appendChild(element);
  (bridge as any).attachPanel({ element });
  const fire = (target: EventTarget, type: string, buttons: number) =>
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, buttons }),
    );
  const press = () => fire(element, "pointerdown", 1);
  const click = () => {
    press();
    fire(element, "pointerup", 0);
  };
  const switchTool = (nextToolId: string) => {
    tools.brush.onDeactivate();
    activeToolId.value = nextToolId;
  };
  /** The pointer moving to `x`, as the stroke sees it in a non-slice panel. */
  const moveTo = (x: number) => {
    host.viewer.mouseState.unsnappedPosition = [x, 10, 5];
    pointerMoved();
  };
  return { click, press, fire, moveTo, switchTool, scope, element, bridge };
}

describe("PointerEventBridge with real listeners and tools", () => {
  afterEach(() => {
    for (const bridge of openBridges.splice(0)) bridge.dispose();
  });

  it("clicks during a running flood fill do not queue more fills", async () => {
    const first = gate();
    let fills = 0;
    const { click } = setup(
      {
        fill: async () => {
          fills++;
          if (fills === 1) await first.promise;
          return emptyBatch();
        },
      } as any,
      "painting.fill",
    );
    click();
    await settle();
    click();
    await settle();
    click();
    await settle();
    first.open();
    await settle();
    expect(fills).toBe(1);
  });

  it("a brush click queued behind a draining stroke does not reach the next tool", async () => {
    const first = gate();
    let stamps = 0;
    let fills = 0;
    const { click, switchTool } = setup(
      {
        applyBrush: async () => {
          stamps++;
          if (stamps === 1) await first.promise;
          return emptyBatch();
        },
        fill: async () => {
          fills++;
          return emptyBatch();
        },
      } as any,
      "painting.brush",
    );
    click();
    await settle();
    click();
    await settle();
    switchTool("painting.fill");
    first.open();
    await settle();
    expect(fills).toBe(0);
    expect(stamps).toBe(1);
  });

  it("a released brush stroke's queue does not end or paint into the eraser's stroke", async () => {
    const first = gate();
    let stamps = 0;
    const applyBrushStroke = vi.fn(async () => emptyBatch());
    const { press, fire, moveTo, element, switchTool, scope } = setup(
      {
        applyBrush: async () => {
          stamps++;
          if (stamps === 1) await first.promise;
          return emptyBatch();
        },
        applyBrushStroke,
      } as any,
      "painting.brush",
    );
    press();
    await settle();
    moveTo(100);
    fire(element, "pointerup", 0);
    await settle();
    switchTool("painting.erase");
    press();
    await settle();
    expect(scope.hasLiveEdit).toBe(true);
    first.open();
    await settle();
    // The eraser's stroke is still open: its button is held.
    expect(scope.hasLiveEdit).toBe(true);
    expect(applyBrushStroke).not.toHaveBeenCalled();
  });

  it("a queued move of the same stroke does reach the tool", async () => {
    const first = gate();
    const applyBrushStroke = vi.fn(async () => emptyBatch());
    const { press, fire, moveTo, element, scope } = setup(
      {
        applyBrush: async () => {
          await first.promise;
          return emptyBatch();
        },
        applyBrushStroke,
      } as any,
      "painting.brush",
    );
    press();
    await settle();
    moveTo(100);
    fire(element, "pointerup", 0);
    await settle();
    first.open();
    await settle();
    expect(applyBrushStroke).toHaveBeenCalled();
    expect(scope.hasLiveEdit).toBe(false);
  });

  it("the real release after a focus loss does not overtake the running stroke", async () => {
    const first = gate();
    const { press, fire, element, scope } = setup(
      {
        applyBrush: async () => {
          await first.promise;
          return emptyBatch();
        },
      } as any,
      "painting.brush",
    );
    press();
    await settle();
    window.dispatchEvent(new Event("blur"));
    fire(element, "pointerup", 0);
    await settle();
    expect(scope.hasLiveEdit).toBe(true);
    first.open();
    await settle();
    expect(scope.hasLiveEdit).toBe(false);
  });

  it("a brush stroke that never settles does not block strokes after a tool switch", async () => {
    let stamps = 0;
    const { click, switchTool, scope } = setup(
      {
        applyBrush: async () => {
          stamps++;
          if (stamps === 1) await new Promise(() => {});
          return emptyBatch();
        },
      } as any,
      "painting.brush",
    );
    click();
    await settle();
    switchTool("painting.erase");
    await settle();
    switchTool("painting.brush");
    await settle();
    expect(scope.hasLiveEdit).toBe(false);
    click();
    await settle();
    expect(stamps).toBe(2);
    expect(scope.hasLiveEdit).toBe(false);
  });

  it("a second brush click queues behind a draining stroke and runs after it", async () => {
    const first = gate();
    let stamps = 0;
    const { click, scope } = setup(
      {
        applyBrush: async () => {
          stamps++;
          if (stamps === 1) await first.promise;
          return emptyBatch();
        },
      } as any,
      "painting.brush",
    );
    click();
    await settle();
    click();
    await settle();
    expect(stamps).toBe(1);
    first.open();
    await settle();
    expect(stamps).toBe(2);
    expect(scope.hasLiveEdit).toBe(false);
  });

  it("a move with the button up anywhere on the page ends the stroke", async () => {
    const { press, fire, scope } = setup(
      { applyBrush: async () => emptyBatch() } as any,
      "painting.brush",
    );
    press();
    await settle();
    expect(scope.hasLiveEdit).toBe(true);
    fire(document.body, "pointermove", 0);
    await settle();
    expect(scope.hasLiveEdit).toBe(false);
  });

  it("losing window focus ends the stroke", async () => {
    const { press, scope } = setup(
      { applyBrush: async () => emptyBatch() } as any,
      "painting.brush",
    );
    press();
    await settle();
    expect(scope.hasLiveEdit).toBe(true);
    window.dispatchEvent(new Event("blur"));
    await settle();
    expect(scope.hasLiveEdit).toBe(false);
  });
});
