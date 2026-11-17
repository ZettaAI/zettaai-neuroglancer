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
 * @file Picks the resolution the 3D preview ray-marches at, from what frames
 * cost on this GPU.
 *
 * The input is the GPU time of a whole viewer frame in which the preview drew
 * (neuroglancer's own frame timer). The governor counts all of it as march,
 * which overestimates the march, and so errs towards a coarser preview, never
 * towards a longer frame. The march costs about the same per pixel at every
 * resolution, so a frame drawn at a reduction of `r` (every `r`th pixel along
 * x and y) predicts the full-resolution cost as `time × r²`.
 *
 * - **Coarser** as soon as the current resolution is predicted over the
 *   frame budget: to the finest reduction predicted within it.
 * - **Finer** when that is predicted well within the budget (half of it), so
 *   a frame near the budget does not flip back and forth.
 * - **One step finer as a trial** every couple of seconds when the finer
 *   step is predicted within twice the budget. Because the prediction counts
 *   the rest of the frame `r²` times over, a capable GPU would otherwise stay
 *   coarse after one heavy moment; the trial frame's own time then decides.
 *   A trial costs at most about twice the budget, far from the seconds that
 *   make a system reset the GPU.
 *
 * Until the first measurement arrives the preview draws at half resolution:
 * nothing is known about the GPU, and the first frame is the one most likely
 * to be too slow. The first measurement may go finer like a trial.
 *
 * When even the coarsest reduction is predicted far over the budget, the
 * governor also asks for the emergency step cap: rays stop early, so distant
 * parts of the surface can be missing, but the frame stays short. A capped
 * frame under-reports the uncapped cost, so its time is scaled by how many
 * more steps an uncapped ray could take; the cap comes off only when that
 * bound is safe.
 */

/** Pixels per marched pixel along x and y, finest first. */
export const PAINTED_VOLUME_REDUCTIONS = [1, 2, 4] as const;
export type PaintedVolumeReduction = (typeof PAINTED_VOLUME_REDUCTIONS)[number];

/**
 * Frame time past which the preview gets coarser. Generous (about 20 frames
 * per second) so a capable GPU keeps the full picture; a frame that resets
 * the GPU takes seconds, forty times this.
 */
export const PAINTED_VOLUME_FRAME_BUDGET_MS = 50;
/** Going finer outright needs the prediction under this share of the budget. */
const REFINE_FRACTION = 0.5;
/** A trial step finer is allowed up to this multiple of the budget. */
const TRIAL_FACTOR = 2;
/** At most one trial step this often. */
export const PAINTED_VOLUME_TRIAL_INTERVAL_MS = 2000;
/** At the coarsest reduction, a prediction past this also caps the steps. */
export const PAINTED_VOLUME_EMERGENCY_MS = 4 * PAINTED_VOLUME_FRAME_BUDGET_MS;

const FINEST: PaintedVolumeReduction = PAINTED_VOLUME_REDUCTIONS[0];
const COARSEST: PaintedVolumeReduction =
  PAINTED_VOLUME_REDUCTIONS[PAINTED_VOLUME_REDUCTIONS.length - 1];
const FIRST_GUESS: PaintedVolumeReduction = 2;

export interface PaintedVolumeResolution {
  readonly reduction: PaintedVolumeReduction;
  /** Cap the steps per ray (missing far surfaces) to bound the frame. */
  readonly capSteps: boolean;
}

export const PAINTED_VOLUME_FULL_RESOLUTION: PaintedVolumeResolution = {
  reduction: FINEST,
  capSteps: false,
};

function predictedAt(fullCost: number, reduction: number): number {
  return fullCost / (reduction * reduction);
}

export class PaintedVolumeResolutionGovernor {
  private resolution_: PaintedVolumeResolution = {
    reduction: FIRST_GUESS,
    capSteps: false,
  };
  private measured = false;
  private lastTrialAt = Number.NEGATIVE_INFINITY;

  get resolution(): PaintedVolumeResolution {
    return this.resolution_;
  }

  /** Whether a measurement has arrived since construction. */
  get hasMeasurement(): boolean {
    return this.measured;
  }

  /**
   * Take the GPU time of a frame drawn at `resolution`; returns true when the
   * resolution to draw at changed. `uncappedStepFactor` is how many times
   * more steps an uncapped ray could take than the frame allowed (1 when not
   * capped). `now` is any monotonic clock in milliseconds.
   */
  record(
    milliseconds: number,
    resolution: PaintedVolumeResolution,
    uncappedStepFactor: number,
    now: number,
  ): boolean {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return false;
    const firstMeasurement = !this.measured;
    this.measured = true;
    const frameMilliseconds = resolution.capSteps
      ? milliseconds * Math.max(1, uncappedStepFactor)
      : milliseconds;
    const fullCost =
      frameMilliseconds * resolution.reduction * resolution.reduction;
    const next = this.choose(fullCost, firstMeasurement, now);
    const changed =
      next.reduction !== this.resolution_.reduction ||
      next.capSteps !== this.resolution_.capSteps;
    this.resolution_ = next;
    return changed;
  }

  private choose(
    fullCost: number,
    firstMeasurement: boolean,
    now: number,
  ): PaintedVolumeResolution {
    const current = this.resolution_.reduction;
    const withinBudget = PAINTED_VOLUME_REDUCTIONS.find(
      (reduction) =>
        predictedAt(fullCost, reduction) <= PAINTED_VOLUME_FRAME_BUDGET_MS,
    );
    if (withinBudget === undefined) {
      return {
        reduction: COARSEST,
        capSteps: predictedAt(fullCost, COARSEST) > PAINTED_VOLUME_EMERGENCY_MS,
      };
    }
    // Over budget now: coarser at once.
    if (withinBudget > current) {
      return { reduction: withinBudget, capSteps: false };
    }
    const surelyWithin = PAINTED_VOLUME_REDUCTIONS.find(
      (reduction) =>
        predictedAt(fullCost, reduction) <=
        PAINTED_VOLUME_FRAME_BUDGET_MS * REFINE_FRACTION,
    );
    if (surelyWithin !== undefined && surelyWithin < current) {
      return { reduction: surelyWithin, capSteps: false };
    }
    const trialAllowed =
      firstMeasurement ||
      now - this.lastTrialAt >= PAINTED_VOLUME_TRIAL_INTERVAL_MS;
    if (trialAllowed) {
      const trial = PAINTED_VOLUME_REDUCTIONS.find(
        (reduction) =>
          reduction < current &&
          predictedAt(fullCost, reduction) <=
            PAINTED_VOLUME_FRAME_BUDGET_MS * TRIAL_FACTOR,
      );
      if (trial !== undefined) {
        this.lastTrialAt = now;
        // First measurement: as fine as the trial limit allows; later, one
        // step at a time.
        const step = firstMeasurement
          ? trial
          : PAINTED_VOLUME_REDUCTIONS[
              PAINTED_VOLUME_REDUCTIONS.indexOf(current) - 1
            ];
        return { reduction: step, capSteps: false };
      }
    }
    return { reduction: current, capSteps: false };
  }
}
