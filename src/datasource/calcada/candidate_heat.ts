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
 * @file Split error detection: colouring a segment's pieces by the best merge
 * candidate each still offers. A strong candidate is a continuation the
 * segment is probably missing, so the pieces that carry one are where it was
 * split.
 *
 * The scale is absolute: green is a score of zero, red is one, and a colour
 * means the same thing on every segment. A scale normalised to the segment's
 * own best would dress its weakest candidate up as a likely error.
 */

import { packColor } from "#src/util/color.js";
import { vec4 } from "#src/util/geom.js";

export type SemanticClass =
  | "any"
  | "perikaryon"
  | "dendrite"
  | "axon"
  | "glia"
  | "vasculature"
  | "nucleus"
  | "ecs"
  | "other";

export interface PieceClasses {
  perikaryon: number;
  dendrite: number;
  axon: number;
  glia: number;
  vasculature: number;
  nucleus: number;
  ecs: number;
  other: number;
}

export interface PieceOverview {
  pieceId: bigint;
  bestScore: number;
  /** The piece its best candidate would merge in; 0 when it offers none. */
  bestPartnerPiece: bigint;
  /** The segment holding that piece — what actually has a mesh to load. */
  bestPartnerRoot: bigint;
  /** What that candidate is made of, which is what the class filter asks about. */
  partnerClasses: PieceClasses;
  partnerHasInfo: boolean;
  candidateCount: number;
  voxelCount: number;
  classes: PieceClasses;
  hasInfo: boolean;
}

/**
 * Three outcomes, not two. A piece nobody ingested semantics for has not failed
 * the filter — nothing was asked of it. Painting it as rejected would state
 * something about the data that is not known, and on a graph ingested before
 * the class counts existed that is every piece on screen.
 */
export type SemanticVerdict = "pass" | "fail" | "unknown";

// The shared packer, not a local one: the mesh reads these as (a<<24)|(b<<16)|
// (g<<8)|r, and a hand-rolled version that packs red into the high byte instead
// renders the whole scale as its own mirror image.
function packed(red: number, green: number, blue: number): bigint {
  return BigInt(packColor(vec4.fromValues(red, green, blue, 1)));
}

/**
 * Green at zero through amber to red at one. A piece with no candidate is
 * where nothing is missing, so it reads as fine; a strong candidate is a
 * continuation the segment is probably lacking, which is a split error.
 */
export function heatColor(bestScore: number): bigint {
  const t = Math.max(0, Math.min(1, bestScore));
  return packed(0.16 + t * 0.84, 0.86 - t * 0.62, 0.24);
}

export function classTotal(classes: PieceClasses): number {
  return (
    classes.perikaryon +
    classes.dendrite +
    classes.axon +
    classes.glia +
    classes.vasculature +
    classes.nucleus +
    classes.ecs +
    classes.other
  );
}

export function semanticVerdict(
  piece: Pick<PieceOverview, "classes" | "hasInfo">,
  wanted: SemanticClass,
  minFraction: number,
): SemanticVerdict {
  if (wanted === "any") return "pass";
  const total = classTotal(piece.classes);
  // A row that exists but sums to zero says as little as no row at all.
  if (!piece.hasInfo || total === 0) return "unknown";
  return piece.classes[wanted] / total >= minFraction ? "pass" : "fail";
}

export interface SplitErrorFilter {
  wanted: SemanticClass;
  minFraction: number;
  /** Shared with the trace: a piece is flagged by the candidates it would offer. */
  minScore: number;
}

function partnerTotal(piece: PieceOverview): number {
  return piece.partnerHasInfo ? classTotal(piece.partnerClasses) : 0;
}

/**
 * The score a piece is painted with: its best candidate's, or zero when there
 * is none worth counting.
 *
 * The class is judged on the candidate, not on the piece: a dendrite missing a
 * dendrite continuation is the error being looked for. Naming a class counts
 * only candidates known to be that class — on a graph where most carry no
 * breakdown, counting the unknown ones as well is how a filter ends up looking
 * like it does nothing. A graph with no semantics at all is not filtered, so the
 * class filter cannot silently paint everything green.
 */
function flaggedScores(
  pieces: readonly PieceOverview[],
  filter: SplitErrorFilter,
): Map<bigint, number> {
  const wanted = pieces.some((piece) => partnerTotal(piece) > 0)
    ? filter.wanted
    : "any";
  const scores = new Map<bigint, number>();
  for (const piece of pieces) {
    const counts =
      piece.candidateCount > 0 &&
      piece.bestScore >= filter.minScore &&
      semanticVerdict(
        { classes: piece.partnerClasses, hasInfo: piece.partnerHasInfo },
        wanted,
        filter.minFraction,
      ) === "pass";
    scores.set(piece.pieceId, counts ? piece.bestScore : 0);
  }
  return scores;
}

export function splitErrorColors(
  pieces: readonly PieceOverview[],
  filter: SplitErrorFilter,
): Map<bigint, bigint> {
  const colors = new Map<bigint, bigint>();
  for (const [pieceId, score] of flaggedScores(pieces, filter)) {
    colors.set(pieceId, heatColor(score));
  }
  return colors;
}

/** How many pieces the current filter paints as a likely split error. */
export function flaggedPieceCount(
  pieces: readonly PieceOverview[],
  filter: SplitErrorFilter,
): number {
  let count = 0;
  for (const score of flaggedScores(pieces, filter).values()) {
    if (score > 0) count++;
  }
  return count;
}

/** How many of the candidates on offer carry a semantic breakdown. */
export function partnersWithSemantics(
  pieces: readonly PieceOverview[],
): number {
  return pieces.filter((piece) => partnerTotal(piece) > 0).length;
}

/** The dominant class of a piece, and how much of it that class accounts for. */
export function dominantClass(
  classes: PieceClasses,
): { name: SemanticClass; fraction: number } | undefined {
  const total = classTotal(classes);
  if (total === 0) return undefined;
  let name: SemanticClass = "other";
  let best = -1;
  for (const key of Object.keys(classes) as (keyof PieceClasses)[]) {
    if (classes[key] > best) {
      best = classes[key];
      name = key;
    }
  }
  return { name, fraction: best / total };
}

/**
 * How the piece a candidate would merge in reads at a glance: its size, what it
 * mostly is, and how sure that is. Says so plainly when the graph carries no
 * semantics, rather than reporting a confident "other".
 */
export function describePartner(piece: {
  partnerVoxels: number;
  partnerClasses: PieceClasses;
  partnerHasInfo: boolean;
}): string {
  const size = `${piece.partnerVoxels.toLocaleString()} vx`;
  if (!piece.partnerHasInfo) return `${size} · no semantics`;
  const dominant = dominantClass(piece.partnerClasses);
  if (dominant === undefined) return `${size} · no semantics`;
  const axonTotal = classTotal(piece.partnerClasses);
  const axonPct = Math.round((100 * piece.partnerClasses.axon) / axonTotal);
  return (
    `${size} · ${dominant.name} ${Math.round(dominant.fraction * 100)}%` +
    (dominant.name === "axon" ? "" : ` · axon ${axonPct}%`)
  );
}
