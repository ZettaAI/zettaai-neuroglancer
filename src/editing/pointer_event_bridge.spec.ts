/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, it, expect, vi } from "vitest";

import { PointerEventBridge } from "#src/editing/pointer_event_bridge.js";
import { paintScheduler } from "#src/editing/tool_runtimes/paint_scheduler_config.js";

vi.hoisted(() => {
  (globalThis as any).WebGL2RenderingContext ??= {};
});

type Position = readonly [number, number, number];
const FIRST: Position = [1, 1, 1];
const SECOND: Position = [2, 2, 1];
const LAST: Position = [3, 3, 1];

function drain() {
  const dispatchStrokeMove = vi.fn();
  (PointerEventBridge.prototype as any).drainStroke.call(
    { dispatchStrokeMove },
    { inFlight: false, samples: [FIRST, SECOND, LAST], onDrained: [] },
  );
  return dispatchStrokeMove.mock.calls[0].slice(1);
}

const PANEL = {};

interface FakeStroke {
  panel: unknown;
  lastVoxel?: Position;
  inFlight: boolean;
  toolEpoch: number;
  samples: Position[];
  finish?: { event: { kind: string; voxelPosition?: Position } };
  onDrained: (() => void)[];
  unsubscribeMouseState: () => void;
}

function liveStroke(overrides: Partial<FakeStroke> = {}): FakeStroke {
  return {
    panel: PANEL,
    inFlight: true,
    toolEpoch: 0,
    samples: [],
    onDrained: [],
    unsubscribeMouseState: () => {},
    ...overrides,
  };
}

/** The bridge's stroke-finish logic over a fake host, with no DOM panels. */
function fakeBridge(
  stroke: FakeStroke | undefined,
  options: { cameraLocked?: boolean; panels?: { element: Node }[] } = {},
) {
  const prototype = PointerEventBridge.prototype as any;
  const translated = { kind: "pointer-up", voxelPosition: LAST };
  return {
    activeStroke: stroke,
    attached: new Map((options.panels ?? []).map((panel) => [panel, () => {}])),
    isCameraLockedForEvent: () => options.cameraLocked ?? true,
    translatePointer: vi.fn(() => translated),
    consume: vi.fn(),
    drainStroke: vi.fn(),
    endActiveStroke(this: { activeStroke: unknown }) {
      this.activeStroke = undefined;
    },
    toolEpoch: 0,
    activeTool: () => ({ id: "painting.brush" }),
    isStrokeTool: prototype.isStrokeTool,
    queueStrokeFinish: prototype.queueStrokeFinish,
    strokeHasWork: prototype.strokeHasWork,
    strokeToChainBehind: prototype.strokeToChainBehind,
    requestStrokeFinish: prototype.requestStrokeFinish,
    finishStrokeReleasedOffPanels: prototype.finishStrokeReleasedOffPanels,
    finishStrokeIfPrimaryReleased: prototype.finishStrokeIfPrimaryReleased,
  } as any;
}

const pointerEvent = (fields: object = {}) =>
  ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...fields,
  }) as any;

describe("PointerEventBridge stroke finish", () => {
  it("delivers a finish when the release has Ctrl held, without consuming the event", () => {
    const stroke = liveStroke();
    const bridge = fakeBridge(stroke, { cameraLocked: false });
    expect(
      bridge.requestStrokeFinish(PANEL, pointerEvent(), "pointer-up"),
    ).toBe(true);
    expect(stroke.finish?.event.kind).toBe("pointer-up");
    expect(bridge.activeStroke).toBeUndefined();
    expect(bridge.consume).not.toHaveBeenCalled();
  });

  it("finishes an idle stroke through the drain, not only a busy one", () => {
    const stroke = liveStroke({ inFlight: false });
    const bridge = fakeBridge(stroke);
    bridge.requestStrokeFinish(PANEL, pointerEvent(), "pointer-up");
    expect(bridge.drainStroke).toHaveBeenCalledWith(stroke);
    expect(bridge.consume).toHaveBeenCalledTimes(1);
  });

  it("finishes at the last known position when no voxel is under the pointer", () => {
    const stroke = liveStroke({ lastVoxel: SECOND });
    const bridge = fakeBridge(stroke);
    bridge.translatePointer.mockReturnValue(undefined);
    bridge.requestStrokeFinish(PANEL, pointerEvent(), "pointer-up");
    expect(stroke.finish?.event).toMatchObject({
      kind: "pointer-up",
      voxelPosition: SECOND,
    });
  });

  it("finishes on a release that landed on another panel", () => {
    const stroke = liveStroke();
    const bridge = fakeBridge(stroke);
    expect(bridge.requestStrokeFinish({}, pointerEvent(), "pointer-up")).toBe(
      true,
    );
    expect(stroke.finish?.event.kind).toBe("pointer-up");
  });

  it("makes the next stroke wait for a released stroke that is still draining", () => {
    const stroke = liveStroke();
    const bridge = fakeBridge(stroke);
    bridge.requestStrokeFinish(PANEL, pointerEvent(), "pointer-up");
    expect(bridge.activeStroke).toBeUndefined();
    expect(bridge.strokeToChainBehind()).toBe(stroke);
  });

  it("stops waiting once the released stroke has drained", () => {
    const stroke = liveStroke({ inFlight: false });
    const released = () => () => {};
    const onDrained = vi.fn(released());
    stroke.onDrained.push(onDrained);
    const bridge = fakeBridge(undefined);
    bridge.drainingStroke = stroke;
    (PointerEventBridge.prototype as any).drainStroke.call(bridge, stroke);
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(bridge.drainingStroke).toBeUndefined();
    expect(bridge.strokeToChainBehind()).toBeUndefined();
  });

  it("reports no active stroke, so the caller dispatches directly", () => {
    const bridge = fakeBridge(undefined);
    expect(
      bridge.requestStrokeFinish(PANEL, pointerEvent(), "pointer-up"),
    ).toBe(false);
  });

  it("a canceled stroke drops its pending samples, a released one keeps them", () => {
    const canceled = liveStroke({ samples: [FIRST] });
    fakeBridge(canceled).requestStrokeFinish(
      PANEL,
      pointerEvent(),
      "pointer-cancel",
    );
    expect(canceled.samples).toEqual([]);

    const released = liveStroke({ samples: [FIRST] });
    fakeBridge(released).requestStrokeFinish(
      PANEL,
      pointerEvent(),
      "pointer-up",
    );
    expect(released.samples).toEqual([FIRST]);
  });

  it("finishes on a hover move with the primary button up, adding no sample", () => {
    const stroke = liveStroke();
    const bridge = fakeBridge(stroke);
    bridge.finishStrokeIfPrimaryReleased(pointerEvent({ buttons: 0 }));
    expect(stroke.finish?.event.kind).toBe("pointer-up");
    expect(stroke.samples).toEqual([]);
    expect(bridge.consume).not.toHaveBeenCalled();
  });

  it("keeps the stroke on a move with the primary button down", () => {
    const stroke = liveStroke();
    const bridge = fakeBridge(stroke);
    bridge.finishStrokeIfPrimaryReleased(pointerEvent({ buttons: 1 }));
    expect(stroke.finish).toBeUndefined();
    expect(bridge.activeStroke).toBe(stroke);
  });

  describe("release reaching only the window", () => {
    const panelElement = { contains: (node: unknown) => node === inside };
    const inside = new EventTarget();
    const elsewhere = new EventTarget();
    const nodeGlobal = globalThis as { Node?: unknown };
    const initialNode = nodeGlobal.Node;
    afterEach(() => {
      nodeGlobal.Node = initialNode;
    });

    it("finishes without consuming the event when released off every panel", () => {
      nodeGlobal.Node = EventTarget;
      const stroke = liveStroke();
      const bridge = fakeBridge(stroke, {
        panels: [{ element: panelElement as any }],
      });
      bridge.finishStrokeReleasedOffPanels(
        pointerEvent({ target: elsewhere }),
        "pointer-up",
      );
      expect(stroke.finish?.event.kind).toBe("pointer-up");
      expect(bridge.consume).not.toHaveBeenCalled();
    });

    it("leaves a release over a panel to that panel's listener", () => {
      nodeGlobal.Node = EventTarget;
      const stroke = liveStroke();
      const bridge = fakeBridge(stroke, {
        panels: [{ element: panelElement as any }],
      });
      bridge.finishStrokeReleasedOffPanels(
        pointerEvent({ target: inside }),
        "pointer-up",
      );
      expect(stroke.finish).toBeUndefined();
      expect(bridge.activeStroke).toBe(stroke);
    });
  });
});

describe("PointerEventBridge stroke draining", () => {
  const initialMode = paintScheduler.mode;
  afterEach(() => {
    paintScheduler.mode = initialMode;
  });

  it("under latestWins paints only the latest sample and hands over the rest for the outline", () => {
    paintScheduler.mode = "latestWins";
    expect(drain()).toEqual([LAST, [], [FIRST, SECOND]]);
  });

  it("under coalesce paints every sample, so the outline needs nothing extra", () => {
    paintScheduler.mode = "coalesce";
    expect(drain()).toEqual([LAST, [FIRST, SECOND], []]);
  });
});
