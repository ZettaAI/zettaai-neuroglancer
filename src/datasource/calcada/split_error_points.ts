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
 * own colour: one point per flagged piece, at the piece's centre.
 */

import type { PieceOverview } from "#src/datasource/calcada/candidate_heat.js";
import type { PieceSphere } from "#src/datasource/calcada/piece_centers.js";

export interface SplitErrorPoint {
  pieceId: bigint;
  position: Float32Array;
  score: number;
  /** The piece ← / → are on. */
  focused: boolean;
}

export function splitErrorPoints(
  flagged: readonly PieceOverview[],
  focusedPiece: bigint | undefined,
  spheres: ReadonlyMap<bigint, PieceSphere>,
  toViewer: (nanometres: readonly number[]) => Float32Array | undefined,
): SplitErrorPoint[] {
  const points: SplitErrorPoint[] = [];
  for (const piece of flagged) {
    const sphere = spheres.get(piece.pieceId);
    const position = sphere && toViewer(sphere.center);
    if (position === undefined) continue;
    points.push({
      pieceId: piece.pieceId,
      position,
      score: piece.bestScore,
      focused: piece.pieceId === focusedPiece,
    });
  }
  return points;
}
