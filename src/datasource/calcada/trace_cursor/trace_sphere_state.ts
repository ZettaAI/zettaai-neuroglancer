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
 * @file Where the trace cursor sphere is drawn, and whether it is drawn at all.
 *
 * Two different things share this state. While the proofreader is aiming, the
 * sphere rides the cursor and goes out over empty space — it is a sight, and a
 * sight over nothing means nothing. Once placed, it is pinned to its point and
 * stays lit wherever the cursor wanders, because it now marks the region the
 * candidate list was drawn from.
 */

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { ZettaTraceState } from "#src/datasource/calcada/trace_state.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import type { SegmentSelectionState } from "#src/segmentation_display_state/frontend.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

export class TraceSphereState extends RefCounted {
  readonly visible = new WatchableValue<boolean>(false);
  readonly center = new WatchableValue<Float32Array | undefined>(undefined);
  readonly radiusNm: WatchableValue<number>;

  constructor(
    private readonly trace: ZettaTraceState,
    private readonly mouseState: MouseSelectionState,
    private readonly selection: SegmentSelectionState,
    readonly coordinateSpace: WatchableValueInterface<CoordinateSpace>,
  ) {
    super();
    this.radiusNm = trace.sphereRadiusNm;
    const refresh = () => this.refresh();
    this.registerDisposer(mouseState.changed.add(refresh));
    this.registerDisposer(selection.changed.add(refresh));
    this.registerDisposer(trace.aiming.changed.add(refresh));
    this.registerDisposer(trace.scope.changed.add(refresh));
    this.registerDisposer(trace.active.changed.add(refresh));
    this.registerDisposer(trace.sphereCenter.changed.add(refresh));
    this.refresh();
  }

  private refresh() {
    const { trace, mouseState, selection } = this;
    if (trace.scope.value === "segment") {
      this.set(false, undefined);
      return;
    }
    if (trace.aiming.value) {
      const position = mouseState.unsnappedPosition;
      const over =
        mouseState.active &&
        selection.hasSelectedSegment &&
        position !== undefined &&
        position.length >= 3;
      this.set(
        over,
        over
          ? Float32Array.of(position[0], position[1], position[2])
          : undefined,
      );
      return;
    }
    const placed = trace.active.value ? trace.sphereCenter.value : undefined;
    this.set(placed !== undefined, placed);
  }

  private set(visible: boolean, center: Float32Array | undefined) {
    const previous = this.center.value;
    const same =
      previous !== undefined &&
      center !== undefined &&
      previous[0] === center[0] &&
      previous[1] === center[1] &&
      previous[2] === center[2];
    if (!same) this.center.value = center;
    if (this.visible.value !== visible) this.visible.value = visible;
  }
}
