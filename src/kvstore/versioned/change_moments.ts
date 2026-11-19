/**
 * @license
 * Copyright 2026 Zetta AI.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Writes closer together than this belong to one change: one save writes many
 * chunks over a few seconds.
 */
export const CHANGE_GAP_MS = 10_000;

/**
 * Groups object write/delete times into change moments, newest first. Each
 * moment is the time of the last write of its group, so showing the layer at
 * that time shows the whole change.
 */
export function groupChangeMoments(
  changeTimes: Iterable<number>,
  gapMs = CHANGE_GAP_MS,
): number[] {
  const sorted = [...new Set(changeTimes)].sort(
    (first, second) => first - second,
  );
  const moments: number[] = [];
  for (const time of sorted) {
    const last = moments.length - 1;
    if (last >= 0 && time - moments[last] < gapMs) {
      moments[last] = time;
    } else {
      moments.push(time);
    }
  }
  return moments.reverse();
}

/**
 * The moment next to `current` (`undefined` = latest data) in `moments`
 * (newest first): `"older"` or `"newer"`. Newer than the newest moment is the
 * latest data (`undefined`); `null` when there is nothing in that direction.
 */
export function neighbourMoment(
  moments: readonly number[],
  current: number | undefined,
  direction: "older" | "newer",
): number | undefined | null {
  if (direction === "older") {
    const older = moments.find(
      (moment) => current === undefined || moment < current,
    );
    return older ?? null;
  }
  if (current === undefined) return null;
  const newer = moments.findLast((moment) => moment > current);
  return newer ?? undefined;
}
