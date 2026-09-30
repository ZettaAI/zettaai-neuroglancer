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
 * @file The candidate filter as an AND/OR tree of conditions, shared by the
 * trace and split error detection. The client evaluates it; the server only
 * ever sees the one bound it can safely apply, `minCandidateVoxels`.
 */

import type {
  PieceClasses,
  SemanticClass,
} from "#src/datasource/calcada/candidate_heat.js";
import {
  classTotal,
  SEMANTIC_CLASSES,
} from "#src/datasource/calcada/candidate_heat.js";

export type TreeSide = "seed" | "candidate";
/** Which end a condition asks about; "both" holds only when each end does. */
export type ConditionSide = TreeSide | "both";
export type PieceClass = Exclude<SemanticClass, "any">;

export type FilterField =
  | { measure: "score" }
  | { side: ConditionSide; measure: "voxels" }
  | { side: ConditionSide; measure: "share"; class: PieceClass };

export interface FilterCondition {
  kind: "condition";
  field: FilterField;
  cmp: ">=" | "<=";
  value: number;
}

export interface FilterGroup {
  kind: "group";
  op: "and" | "or";
  children: FilterNode[];
}

export type FilterNode = FilterGroup | FilterCondition;

/** Child indexes from the root; `[]` is the root itself. */
export type FilterPath = readonly number[];

export const FILTER_TREE_FORMAT = 1;

export interface FilterSubjectSide {
  voxels: number;
  classes: PieceClasses;
  hasInfo: boolean;
}

/** What a filter is asked about: a candidate, seen from both of its ends. */
export interface FilterSubject {
  score: number;
  seed: FilterSubjectSide;
  candidate: FilterSubjectSide;
}

/** Whether any subject on hand carries semantics, per side. */
export interface SemanticsKnown {
  seed: boolean;
  candidate: boolean;
}

const SIDES: readonly TreeSide[] = ["seed", "candidate"];
const CONDITION_SIDES: readonly ConditionSide[] = [...SIDES, "both"];
const PIECE_CLASSES = SEMANTIC_CLASSES.filter(
  (name): name is PieceClass => name !== "any",
);

export function emptyFilterTree(): FilterGroup {
  return { kind: "group", op: "and", children: [] };
}

export function defaultCondition(): FilterCondition {
  return {
    kind: "condition",
    field: { measure: "score" },
    cmp: ">=",
    value: 0,
  };
}

export function serializeFilterTree(root: FilterGroup) {
  return { v: FILTER_TREE_FORMAT, root };
}

function parseField(value: unknown): FilterField | undefined {
  const field = value as Record<string, unknown> | null;
  if (typeof field !== "object" || field === null) return undefined;
  if (field.measure === "score") return { measure: "score" };
  const side = field.side as ConditionSide;
  if (!CONDITION_SIDES.includes(side)) return undefined;
  if (field.measure === "voxels") return { side, measure: "voxels" };
  if (
    field.measure === "share" &&
    PIECE_CLASSES.includes(field.class as PieceClass)
  ) {
    return { side, measure: "share", class: field.class as PieceClass };
  }
  return undefined;
}

function parseNode(value: unknown): FilterNode | undefined {
  const node = value as Record<string, unknown> | null;
  if (typeof node !== "object" || node === null) return undefined;
  if (node.kind === "group") {
    if (
      (node.op !== "and" && node.op !== "or") ||
      !Array.isArray(node.children)
    ) {
      return undefined;
    }
    const children: FilterNode[] = [];
    for (const child of node.children) {
      const parsed = parseNode(child);
      if (parsed === undefined) return undefined;
      children.push(parsed);
    }
    return { kind: "group", op: node.op, children };
  }
  if (node.kind === "condition") {
    const field = parseField(node.field);
    if (
      field === undefined ||
      (node.cmp !== ">=" && node.cmp !== "<=") ||
      typeof node.value !== "number" ||
      !Number.isFinite(node.value)
    ) {
      return undefined;
    }
    return { kind: "condition", field, cmp: node.cmp, value: node.value };
  }
  return undefined;
}

/**
 * A stored or linked tree, or undefined when it cannot be used as is — a
 * later format, or anything malformed. Never a partial tree: a filter missing
 * a condition silently shows what the proofreader meant to hide.
 */
export function parseFilterTree(json: unknown): FilterGroup | undefined {
  const doc = json as { v?: unknown; root?: unknown } | null;
  if (typeof doc !== "object" || doc === null || doc.v !== FILTER_TREE_FORMAT) {
    return undefined;
  }
  const root = parseNode(doc.root);
  return root?.kind === "group" ? root : undefined;
}

export function filterTreesEqual(a: FilterGroup, b: FilterGroup): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function semanticsKnown(
  subjects: Iterable<FilterSubject>,
): SemanticsKnown {
  const known = { seed: false, candidate: false };
  for (const subject of subjects) {
    for (const side of SIDES) {
      const { hasInfo, classes } = subject[side];
      if (hasInfo && classTotal(classes) > 0) known[side] = true;
    }
    if (known.seed && known.candidate) break;
  }
  return known;
}

function sideMeasure(
  side: FilterSubjectSide,
  field: Exclude<FilterField, { measure: "score" }>,
): number {
  if (field.measure === "voxels") return side.voxels;
  const total = side.hasInfo ? classTotal(side.classes) : 0;
  return total > 0 ? side.classes[field.class] / total : Number.NaN;
}

function compares(value: number, condition: FilterCondition): boolean {
  if (Number.isNaN(value)) return false;
  return condition.cmp === ">="
    ? value >= condition.value
    : value <= condition.value;
}

function conditionPasses(
  subject: FilterSubject,
  condition: FilterCondition,
  known: SemanticsKnown,
): boolean {
  const { field } = condition;
  if (field.measure === "score") return compares(subject.score, condition);
  const sides = field.side === "both" ? SIDES : [field.side];
  return sides.every(
    (side) =>
      // A graph with no semantics on a side cannot answer a class question
      // there; failing it would hide every candidate once a class is named.
      (field.measure === "share" && !known[side]) ||
      compares(sideMeasure(subject[side], field), condition),
  );
}

function nodePasses(
  subject: FilterSubject,
  node: FilterNode,
  known: SemanticsKnown,
): boolean {
  if (node.kind === "condition") return conditionPasses(subject, node, known);
  if (node.children.length === 0) return true;
  return node.op === "and"
    ? node.children.every((child) => nodePasses(subject, child, known))
    : node.children.some((child) => nodePasses(subject, child, known));
}

export function subjectPasses(
  subject: FilterSubject,
  root: FilterGroup,
  known: SemanticsKnown,
): boolean {
  return nodePasses(subject, root, known);
}

/**
 * The smallest candidate every passing subject must have — the one part of the
 * tree the server can apply without seeing it. Anything it cannot bound from
 * below contributes 0, so the bound only ever lets through more than the tree.
 */
export function minCandidateVoxels(node: FilterNode): number {
  if (node.kind === "condition") {
    const { field } = node;
    return field.measure === "voxels" &&
      field.side !== "seed" &&
      node.cmp === ">="
      ? Math.max(0, node.value)
      : 0;
  }
  if (node.children.length === 0) return 0;
  const bounds = node.children.map(minCandidateVoxels);
  return node.op === "and" ? Math.max(...bounds) : Math.min(...bounds);
}

/** The fixed form links carried before the tree. */
export interface LegacyFilter {
  minScore: number;
  seedMinVoxels: number;
  candidateMinVoxels: number;
  seedClass: SemanticClass;
  seedMinFraction: number;
  candidateClass: SemanticClass;
  candidateMinFraction: number;
}

export function legacyFilterTree(legacy: LegacyFilter): FilterGroup {
  const children: FilterNode[] = [];
  const atLeast = (field: FilterField, value: number) =>
    children.push({ kind: "condition", field, cmp: ">=", value });
  if (legacy.minScore > 0) atLeast({ measure: "score" }, legacy.minScore);
  if (legacy.seedMinVoxels > 0)
    atLeast({ side: "seed", measure: "voxels" }, legacy.seedMinVoxels);
  if (legacy.seedClass !== "any") {
    atLeast(
      { side: "seed", measure: "share", class: legacy.seedClass },
      legacy.seedMinFraction,
    );
  }
  if (legacy.candidateMinVoxels > 0) {
    atLeast(
      { side: "candidate", measure: "voxels" },
      legacy.candidateMinVoxels,
    );
  }
  if (legacy.candidateClass !== "any") {
    atLeast(
      { side: "candidate", measure: "share", class: legacy.candidateClass },
      legacy.candidateMinFraction,
    );
  }
  return { kind: "group", op: "and", children };
}

function updateAt(
  node: FilterNode,
  path: FilterPath,
  update: (target: FilterNode) => FilterNode | undefined,
): FilterNode | undefined {
  if (path.length === 0) return update(node);
  if (node.kind !== "group") return node;
  const [index, ...rest] = path;
  const children: FilterNode[] = [];
  node.children.forEach((child, i) => {
    const next = i === index ? updateAt(child, rest, update) : child;
    if (next !== undefined) children.push(next);
  });
  return { ...node, children };
}

function asGroup(
  node: FilterNode | undefined,
  fallback: FilterGroup,
): FilterGroup {
  return node?.kind === "group" ? node : fallback;
}

export function addChild(
  root: FilterGroup,
  groupPath: FilterPath,
  child: FilterNode,
): FilterGroup {
  return asGroup(
    updateAt(root, groupPath, (target) =>
      target.kind === "group"
        ? { ...target, children: [...target.children, child] }
        : target,
    ),
    root,
  );
}

export function replaceNode(
  root: FilterGroup,
  path: FilterPath,
  node: FilterNode,
): FilterGroup {
  if (path.length === 0) return node.kind === "group" ? node : root;
  return asGroup(
    updateAt(root, path, () => node),
    root,
  );
}

/** Removes a node; the root itself is never removed, only emptied. */
export function removeNode(root: FilterGroup, path: FilterPath): FilterGroup {
  if (path.length === 0) return emptyFilterTree();
  return asGroup(
    updateAt(root, path, () => undefined),
    root,
  );
}

export function toggleGroupOp(
  root: FilterGroup,
  groupPath: FilterPath,
): FilterGroup {
  return asGroup(
    updateAt(root, groupPath, (target) =>
      target.kind === "group"
        ? { ...target, op: target.op === "and" ? "or" : "and" }
        : target,
    ),
    root,
  );
}
