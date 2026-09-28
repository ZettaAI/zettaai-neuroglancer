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

/** One side of a candidate asked to be a class, at least this share of it. */
export interface ClassFilter {
  wanted: SemanticClass;
  minFraction: number;
}

const ANY_CLASS: ClassFilter = { wanted: "any", minFraction: 0 };

/**
 * The filters the trace and split error detection share. Source is the seed's
 * piece at the contact, target the piece the candidate would merge in — "axons
 * continuing into axons" names both.
 */
export interface CandidateFilter {
  source: ClassFilter;
  target: ClassFilter;
  minScore: number;
}

export type SplitErrorFilter = CandidateFilter;

interface Side {
  classes: PieceClasses;
  hasInfo: boolean;
}

function sideTotal(side: Side): number {
  return side.hasInfo ? classTotal(side.classes) : 0;
}

/**
 * Naming a class admits only pieces known to be that class. On a graph where
 * most pieces carry no breakdown, admitting the unknown ones too is how a
 * filter ends up looking like it does nothing.
 */
export function passesClass(side: Side, filter: ClassFilter): boolean {
  if (filter.wanted === "any") return true;
  return semanticVerdict(side, filter.wanted, filter.minFraction) === "pass";
}

/**
 * The filter as it can actually apply here: a side with no semantics anywhere
 * is not filtered, or naming a class would silently hide everything.
 */
export function applicableFilter(
  filter: CandidateFilter,
  sources: Iterable<Side>,
  targets: Iterable<Side>,
): CandidateFilter {
  const known = (sides: Iterable<Side>) => {
    for (const side of sides) if (sideTotal(side) > 0) return true;
    return false;
  };
  return {
    minScore: filter.minScore,
    source: known(sources) ? filter.source : ANY_CLASS,
    target: known(targets) ? filter.target : ANY_CLASS,
  };
}

/** Whether a queued candidate passes the shared filters. */
export function candidatePasses(
  candidate: EdgeCandidate,
  filter: CandidateFilter,
): boolean {
  return (
    candidate.score >= filter.minScore &&
    passesClass(
      { classes: candidate.selfClasses, hasInfo: candidate.selfHasInfo },
      filter.source,
    ) &&
    passesClass(
      { classes: candidate.partnerClasses, hasInfo: candidate.partnerHasInfo },
      filter.target,
    )
  );
}

/** A trace filter narrowed to what the queued candidates can answer. */
export function applicableToCandidates(
  filter: CandidateFilter,
  candidates: readonly EdgeCandidate[],
): CandidateFilter {
  return applicableFilter(
    filter,
    candidates.map((c) => ({ classes: c.selfClasses, hasInfo: c.selfHasInfo })),
    candidates.map((c) => ({
      classes: c.partnerClasses,
      hasInfo: c.partnerHasInfo,
    })),
  );
}

function partnerTotal(piece: PieceOverview): number {
  return piece.partnerHasInfo ? classTotal(piece.partnerClasses) : 0;
}

/**
 * The score a piece is painted with: its best candidate's, or zero when there
 * is none worth counting. Source is the piece itself, target its best
 * candidate — a dendrite missing a dendrite continuation is the error.
 */
function flaggedScores(
  pieces: readonly PieceOverview[],
  filter: SplitErrorFilter,
): Map<bigint, number> {
  const applied = applicableFilter(
    filter,
    pieces.map((piece) => ({ classes: piece.classes, hasInfo: piece.hasInfo })),
    pieces.map((piece) => ({
      classes: piece.partnerClasses,
      hasInfo: piece.partnerHasInfo,
    })),
  );
  const scores = new Map<bigint, number>();
  for (const piece of pieces) {
    const counts =
      piece.candidateCount > 0 &&
      piece.bestScore >= applied.minScore &&
      passesClass(
        { classes: piece.classes, hasInfo: piece.hasInfo },
        applied.source,
      ) &&
      passesClass(
        { classes: piece.partnerClasses, hasInfo: piece.partnerHasInfo },
        applied.target,
      );
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
