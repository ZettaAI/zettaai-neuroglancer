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
 * @file The sphere of the end being looked for, in a colour of its own: drawn
 * when it is `shown`, which the trace decides.
 */

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { TraceSphereView } from "#src/datasource/calcada/trace_cursor/trace_sphere_state.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { makeCachedDerivedWatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

export interface EndSphere {
  center: Float32Array;
  radiusNm: number;
}

export class EndSphereView extends RefCounted implements TraceSphereView {
  readonly visible: WatchableValueInterface<boolean>;
  readonly center: WatchableValueInterface<Float32Array | undefined>;
  readonly radiusNm: WatchableValueInterface<number>;

  constructor(
    endSphere: WatchableValueInterface<EndSphere | undefined>,
    shown: WatchableValueInterface<boolean>,
    readonly coordinateSpace: WatchableValueInterface<CoordinateSpace>,
  ) {
    super();
    this.visible = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (end, isShown) => end !== undefined && isShown,
        [endSphere, shown],
      ),
    );
    this.center = this.registerDisposer(
      makeCachedDerivedWatchableValue((end) => end?.center, [endSphere]),
    );
    this.radiusNm = this.registerDisposer(
      makeCachedDerivedWatchableValue((end) => end?.radiusNm ?? 0, [endSphere]),
    );
  }
}
