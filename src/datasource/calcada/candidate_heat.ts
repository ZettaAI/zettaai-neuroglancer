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

import type { FilterSubject } from "#src/datasource/calcada/candidate_filter_tree.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
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

export const SEMANTIC_CLASSES: readonly SemanticClass[] = [
  "any",
  "perikaryon",
  "dendrite",
  "axon",
  "glia",
  "vasculature",
  "nucleus",
  "ecs",
  "other",
];

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

/** A semantic breakdown as the server sends it; absent classes count zero. */
export function parseClassCounts(raw: any): PieceClasses {
  return {
    perikaryon: Number(raw?.perikaryon ?? 0),
    dendrite: Number(raw?.dendrite ?? 0),
    axon: Number(raw?.axon ?? 0),
    glia: Number(raw?.glia ?? 0),
    vasculature: Number(raw?.vasculature ?? 0),
    nucleus: Number(raw?.nucleus ?? 0),
    ecs: Number(raw?.ecs ?? 0),
    other: Number(raw?.other ?? 0),
  };
}

/** A contact point as the server sends it; absent when the piece has none. */
export function parseOverviewPoint(
  raw: unknown,
): [number, number, number] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return [Number(raw[0]), Number(raw[1]), Number(raw[2])];
}

export interface PieceOverview {
  pieceId: bigint;
  bestScore: number;
  /** The piece its best candidate would merge in; 0 when it offers none. */
  bestPartnerPiece: bigint;
  /** The segment holding that piece — what actually has a mesh to load. */
  bestPartnerRoot: bigint;
  /** That piece's size, which a candidate-size filter asks about. */
  bestPartnerVoxels: number;
  /** What that candidate is made of, which is what the class filter asks about. */
  partnerClasses: PieceClasses;
  partnerHasInfo: boolean;
  candidateCount: number;
  voxelCount: number;
  classes: PieceClasses;
  hasInfo: boolean;
  /**
   * Where the best candidate touches this piece, and the partner, in viewer
   * coordinates; only for a piece with candidates.
   */
  contact?: [number, number, number];
  partnerContact?: [number, number, number];
}

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

/** A detection row as the filter tree sees it: the piece and its best candidate. */
export function pieceOverviewSubject(piece: PieceOverview): FilterSubject {
  return {
    score: piece.bestScore,
    seed: {
      pieceId: piece.pieceId,
      voxels: piece.voxelCount,
      classes: piece.classes,
      hasInfo: piece.hasInfo,
    },
    candidate: {
      pieceId: piece.bestPartnerPiece,
      voxels: piece.bestPartnerVoxels,
      classes: piece.partnerClasses,
      hasInfo: piece.partnerHasInfo,
    },
  };
}

export function edgeCandidateSubject(candidate: EdgeCandidate): FilterSubject {
  return {
    score: candidate.score,
    seed: {
      pieceId: candidate.selfPieceId,
      voxels: candidate.selfVoxels,
      classes: candidate.selfClasses,
      hasInfo: candidate.selfHasInfo,
    },
    candidate: {
      pieceId: candidate.partnerPieceId,
      voxels: candidate.partnerVoxels,
      classes: candidate.partnerClasses,
      hasInfo: candidate.partnerHasInfo,
    },
  };
}

/** The score a piece is painted with: its best candidate's, or zero. */
function flaggedScores(
  pieces: readonly PieceOverview[],
  passes: (piece: PieceOverview) => boolean,
): Map<bigint, number> {
  const scores = new Map<bigint, number>();
  for (const piece of pieces) {
    const counts = piece.candidateCount > 0 && passes(piece);
    scores.set(piece.pieceId, counts ? piece.bestScore : 0);
  }
  return scores;
}

export function splitErrorColors(
  pieces: readonly PieceOverview[],
  passes: (piece: PieceOverview) => boolean,
): Map<bigint, bigint> {
  const colors = new Map<bigint, bigint>();
  for (const [pieceId, score] of flaggedScores(pieces, passes)) {
    colors.set(pieceId, heatColor(score));
  }
  return colors;
}

/** How many pieces the current filter paints as a likely split error. */
export function flaggedPieceCount(
  pieces: readonly PieceOverview[],
  passes: (piece: PieceOverview) => boolean,
): number {
  return rankFlaggedPieces(pieces, passes).length;
}

/**
 * The pieces the current filter paints as a likely split error, strongest
 * first — the order a proofreader steps through them in.
 */
export function rankFlaggedPieces(
  pieces: readonly PieceOverview[],
  passes: (piece: PieceOverview) => boolean,
): PieceOverview[] {
  const scores = flaggedScores(pieces, passes);
  return pieces
    .filter((piece) => (scores.get(piece.pieceId) ?? 0) > 0)
    .sort((a, b) => b.bestScore - a.bestScore);
}

/** How many of the candidates on offer carry a semantic breakdown. */
export function partnersWithSemantics(
  pieces: readonly PieceOverview[],
): number {
  return pieces.filter(
    (piece) => piece.partnerHasInfo && classTotal(piece.partnerClasses) > 0,
  ).length;
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
 * One piece as the proofreader reads it: size, then every class it holds, as a
 * share of the piece, largest first. The full breakdown rather than the
 * dominant class alone — tuning a class filter needs to see how mixed a piece
 * is. Says so plainly when the graph carries no semantics, rather than
 * reporting a confident "other".
 */
export function describePiece(piece: {
  voxels: number;
  classes: PieceClasses;
  hasInfo: boolean;
}): string {
  const size = `${piece.voxels.toLocaleString()} vx`;
  const total = classTotal(piece.classes);
  if (!piece.hasInfo || total === 0) return `${size} · no semantics`;
  const shares = (Object.keys(piece.classes) as (keyof PieceClasses)[])
    .map((name) => ({ name, percent: (100 * piece.classes[name]) / total }))
    .filter(({ percent }) => percent >= 1)
    .sort((a, b) => b.percent - a.percent)
    .map(({ name, percent }) => `${name} ${Math.round(percent)}%`);
  return [size, ...shares].join(" · ");
}

/** Both ends of a candidate, the seed's piece first. */
export function describeCandidateSides(candidate: EdgeCandidate): string[] {
  const seed = describePiece({
    voxels: candidate.selfVoxels,
    classes: candidate.selfClasses,
    hasInfo: candidate.selfHasInfo,
  });
  const partner = describePiece({
    voxels: candidate.partnerVoxels,
    classes: candidate.partnerClasses,
    hasInfo: candidate.partnerHasInfo,
  });
  return [`Seed: ${seed}`, `Candidate: ${partner}`];
}
