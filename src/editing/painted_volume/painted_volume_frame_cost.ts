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
 * @file Feeds the resolution governor the GPU time of the frames the 3D
 * preview drew in.
 *
 * Neuroglancer already times every frame on the GPU with a `TIME_ELAPSED`
 * query (`DisplayContext`, `FramerateMonitor`). Only one such query can run
 * at a time, so the preview cannot time its own draw inside a frame; it reads
 * the frame's time instead. Results arrive a few frames late, so each draw is
 * remembered by frame number with the resolution it used, and finished
 * results are collected on a timer — between frames too, so a still scene
 * that draws once still gets its measurement.
 */

import type {
  PaintedVolumeResolution,
  PaintedVolumeResolutionGovernor,
} from "#src/editing/painted_volume/painted_volume_resolution_governor.js";

/** What the preview reads of `DisplayContext`'s frame timer. */
export interface PaintedVolumeFrameTimings {
  /** The number of the frame being drawn. */
  readonly frameNumber: number;
  /** False when the browser has no GPU timer: nothing will be measured. */
  readonly measuresFrameTimes: boolean;
  getLastFrameTimings(numberOfFrames: number): ReadonlyArray<{
    readonly frameNumber: number;
    readonly frameDelta: number;
  }>;
}

interface DrawnFrame {
  readonly resolution: PaintedVolumeResolution;
  readonly uncappedStepFactor: number;
}

const POLL_INTERVAL_MS = 16;
/** Timings looked at per poll; the monitor keeps about this many. */
const TIMINGS_PER_POLL = 10;
/** Frames whose time never arrived (disjoint, lost context) are forgotten. */
const FORGET_AFTER_FRAMES = 30;
const GIVE_UP_AFTER_MS = 10_000;

export class PaintedVolumeFrameCost {
  private readonly drawnFrames = new Map<number, DrawnFrame>();
  private pollHandle: ReturnType<typeof setTimeout> | undefined;
  private lastDrawAt = 0;
  private lastFrameMilliseconds_: number | undefined;

  constructor(
    private readonly timings: PaintedVolumeFrameTimings,
    private readonly governor: PaintedVolumeResolutionGovernor,
    private readonly onResolutionChanged: () => void,
  ) {}

  /** The latest frame time recorded; for diagnostics. */
  get lastFrameMilliseconds(): number | undefined {
    return this.lastFrameMilliseconds_;
  }

  /** The preview drew in the current frame at `resolution`. */
  noteDraw(resolution: PaintedVolumeResolution, uncappedStepFactor: number) {
    const { frameNumber } = this.timings;
    this.drawnFrames.set(frameNumber, { resolution, uncappedStepFactor });
    for (const drawn of this.drawnFrames.keys()) {
      if (drawn < frameNumber - FORGET_AFTER_FRAMES) {
        this.drawnFrames.delete(drawn);
      }
    }
    this.lastDrawAt = performance.now();
    if (this.pollHandle === undefined) this.schedulePoll();
  }

  dispose(): void {
    if (this.pollHandle !== undefined) clearTimeout(this.pollHandle);
    this.pollHandle = undefined;
    this.drawnFrames.clear();
  }

  private schedulePoll(): void {
    this.pollHandle = setTimeout(() => {
      this.pollHandle = undefined;
      this.poll();
    }, POLL_INTERVAL_MS);
  }

  private poll(): void {
    let changed = false;
    for (const { frameNumber, frameDelta } of this.timings.getLastFrameTimings(
      TIMINGS_PER_POLL,
    )) {
      const drawn = this.drawnFrames.get(frameNumber);
      if (drawn === undefined) continue;
      this.drawnFrames.delete(frameNumber);
      this.lastFrameMilliseconds_ = frameDelta;
      changed =
        this.governor.record(
          frameDelta,
          drawn.resolution,
          drawn.uncappedStepFactor,
          performance.now(),
        ) || changed;
    }
    if (changed) this.onResolutionChanged();
    const waiting = this.drawnFrames.size > 0;
    const stale = performance.now() - this.lastDrawAt > GIVE_UP_AFTER_MS;
    if (waiting && !stale) this.schedulePoll();
    else this.drawnFrames.clear();
  }
}
