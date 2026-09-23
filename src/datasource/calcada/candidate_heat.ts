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
 * @file Colouring a segment's pieces by the best merge candidate each still
 * offers, so a proofreader can see where in a neuron there is work before
 * committing to a seed point.
 *
 * The scale is absolute: red is a score of zero, green is one, and a colour
 * means the same thing on every segment. A segment whose candidates are all
 * weak therefore comes out uniformly red — which is the honest answer, where a
 * scale normalised to the segment's own best would dress its worst candidate up
 * as its most promising.
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

/** Red at zero through amber to green at one. */
export function heatColor(bestScore: number): bigint {
  const t = Math.max(0, Math.min(1, bestScore));
  return packed(1 - t * 0.84, 0.24 + t * 0.62, 0.24);
}

/** Outside the scale on purpose: a filtered-out piece is not a cold piece. */
export const SEMANTIC_FAIL_COLOR = packed(0.27, 0.27, 0.31);
export const SEMANTIC_UNKNOWN_COLOR = packed(0.43, 0.39, 0.51);

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

/**
 * The pieces the candidates would merge in, coloured by how good the proposal
 * is. These live in other segments and are therefore invisible until something
 * asks for them, which is the whole point of showing them: "where are the
 * candidates" is a question about the neighbours, not about this segment.
 */
export function partnerColors(
  pieces: readonly PieceOverview[],
  wanted: SemanticClass,
  minFraction: number,
): Map<bigint, bigint> {
  const colors = new Map<bigint, bigint>();
  const filtered = pieces.some((piece) => piece.hasInfo) ? wanted : "any";
  for (const piece of pieces) {
    if (piece.bestPartnerPiece === 0n || piece.candidateCount === 0) continue;
    if (semanticVerdict(piece, filtered, minFraction) === "fail") continue;
    colors.set(piece.bestPartnerPiece, heatColor(piece.bestScore));
  }
  return colors;
}

export function totalCandidates(pieces: readonly PieceOverview[]): number {
  return pieces.reduce((sum, piece) => sum + piece.candidateCount, 0);
}

export function overviewColors(
  pieces: readonly PieceOverview[],
  wanted: SemanticClass,
  minFraction: number,
): Map<bigint, bigint> {
  const colors = new Map<bigint, bigint>();
  // A graph with no semantics at all would otherwise answer "unknown" for every
  // piece and flatten the whole map to one colour — the class filter silently
  // taking the heat map with it. Nothing was asked of these pieces, so the
  // filter simply does not apply and the scores stay visible.
  if (!pieces.some((piece) => piece.hasInfo)) wanted = "any";
  for (const piece of pieces) {
    const verdict = semanticVerdict(piece, wanted, minFraction);
    colors.set(
      piece.pieceId,
      verdict === "pass"
        ? heatColor(piece.bestScore)
        : verdict === "fail"
          ? SEMANTIC_FAIL_COLOR
          : SEMANTIC_UNKNOWN_COLOR,
    );
  }
  return colors;
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

/** The segments the candidates live in, which is what has to be loaded. */
export function partnerRoots(pieces: readonly PieceOverview[]): bigint[] {
  const roots = new Set<bigint>();
  for (const piece of pieces) {
    if (piece.bestPartnerRoot !== 0n) roots.add(piece.bestPartnerRoot);
  }
  return [...roots];
}
