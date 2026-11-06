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
 * @file One sphere for the trace: while the end prompt is open it marks the
 * end being asked about, in either scope, and then goes back to the trace's.
 */

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { TraceSphereView } from "#src/datasource/calcada/trace_cursor/trace_sphere_state.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { makeCachedDerivedWatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

export interface EndPromptSphere {
  center: Float32Array;
  radiusNm: number;
}

export class SphereShowingEndPrompt
  extends RefCounted
  implements TraceSphereView
{
  readonly visible: WatchableValueInterface<boolean>;
  readonly center: WatchableValueInterface<Float32Array | undefined>;
  readonly radiusNm: WatchableValueInterface<number>;
  readonly coordinateSpace: WatchableValueInterface<CoordinateSpace>;

  constructor(
    trace: TraceSphereView,
    endSphere: WatchableValueInterface<EndPromptSphere | undefined>,
  ) {
    super();
    this.coordinateSpace = trace.coordinateSpace;
    this.visible = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (traceVisible, end) => end !== undefined || traceVisible,
        [trace.visible, endSphere],
      ),
    );
    this.center = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (traceCenter, end) => end?.center ?? traceCenter,
        [trace.center, endSphere],
      ),
    );
    this.radiusNm = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (traceRadiusNm, end) => end?.radiusNm ?? traceRadiusNm,
        [trace.radiusNm, endSphere],
      ),
    );
  }
}
