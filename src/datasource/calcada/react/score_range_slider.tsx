/** @jsxImportSource react */
/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/** The range of candidate scores Trace and detection keep, as a two-sided slider. */

import { Slider } from "@base-ui/react/slider";
import { useEffect, useState } from "react";

import type { ScoreRange } from "#src/datasource/calcada/trace_state.js";
import { FULL_SCORE_RANGE } from "#src/datasource/calcada/trace_state.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";

const SCORE_STEP = 0.01;
const SCORE_DIGITS = 2;

export function ScoreRangeSlider({
  range,
}: {
  range: WatchableValueInterface<ScoreRange>;
}) {
  const committed = useWatchable(range);
  // Dragging redraws only the slider; the queue and the painted pieces follow
  // when the thumb is let go.
  const [shown, setShown] = useState<readonly number[]>(committed);
  useEffect(() => setShown(committed), [committed]);
  const [low, high] = shown;
  return (
    <div className="calcada-trace-score-range">
      <span className="calcada-trace-score-range-label">Score</span>
      <Slider.Root
        className="calcada-trace-score-range-root"
        value={shown as number[]}
        min={FULL_SCORE_RANGE[0]}
        max={FULL_SCORE_RANGE[1]}
        step={SCORE_STEP}
        onValueChange={(value) => setShown(value as number[])}
        onValueCommitted={(value) => {
          const [from, to] = value as number[];
          range.value = [from, to];
        }}
      >
        <Slider.Control className="calcada-trace-score-range-control">
          <Slider.Track className="calcada-trace-score-range-track">
            <Slider.Indicator className="calcada-trace-score-range-indicator" />
            <Slider.Thumb
              index={0}
              className="calcada-trace-score-range-thumb"
              aria-label="Lowest score"
            />
            <Slider.Thumb
              index={1}
              className="calcada-trace-score-range-thumb"
              aria-label="Highest score"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span className="calcada-trace-score-range-values">
        {low.toFixed(SCORE_DIGITS)} – {high.toFixed(SCORE_DIGITS)}
      </span>
    </div>
  );
}
