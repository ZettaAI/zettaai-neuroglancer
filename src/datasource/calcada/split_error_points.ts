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
 * @file Split error detection drawn as red points on a segment left in its
 * own colour: one point per flagged candidate, where it touches the segment.
 */

import type { PieceOverview } from "#src/datasource/calcada/candidate_heat.js";

export interface SplitErrorPoint {
  pieceId: bigint;
  position: Float32Array;
  score: number;
  /** The candidate ← / → are on. */
  focused: boolean;
}

export function splitErrorPoints(
  flagged: readonly PieceOverview[],
  focusedRow: PieceOverview | undefined,
): SplitErrorPoint[] {
  const points: SplitErrorPoint[] = [];
  for (const piece of flagged) {
    if (piece.contact === undefined) continue;
    points.push({
      pieceId: piece.pieceId,
      position: Float32Array.from(piece.contact),
      score: piece.bestScore,
      focused: piece === focusedRow,
    });
  }
  return points;
}
