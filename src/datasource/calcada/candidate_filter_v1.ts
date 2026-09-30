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
 * @file Filters written before the v2 model: the v1 AND/OR tree that links and
 * presets still carry, and the fixed form older links carried before that.
 * Both are read and turned into v2; neither is written again.
 */

import type {
  GroupNode,
  ConditionNode,
  PieceClass,
  Target,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import type { SemanticClass } from "#src/datasource/calcada/candidate_heat.js";
import { SEMANTIC_CLASSES } from "#src/datasource/calcada/candidate_heat.js";

const V1_FORMAT = 1;
const PERCENT = 100;
const TARGETS: readonly Target[] = ["seed", "candidate", "both"];
const PIECE_CLASSES = SEMANTIC_CLASSES.filter(
  (name): name is PieceClass => name !== "any",
);

function migrateCondition(
  node: Record<string, unknown>,
): ConditionNode | undefined {
  const field = node.field as Record<string, unknown> | null;
  const cmp = node.cmp;
  const value = node.value;
  if (
    typeof field !== "object" ||
    field === null ||
    (cmp !== ">=" && cmp !== "<=") ||
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return undefined;
  }
  if (field.measure === "score") {
    return { kind: "cond", field: "score", op: cmp, value };
  }
  const target = field.side as Target;
  if (!TARGETS.includes(target)) return undefined;
  if (field.measure === "voxels") {
    return { kind: "cond", field: "size", op: cmp, value, target };
  }
  const cls = field.class as PieceClass;
  if (field.measure === "share" && PIECE_CLASSES.includes(cls)) {
    return {
      kind: "cond",
      field: cls,
      op: cmp,
      value: value * PERCENT,
      target,
    };
  }
  return undefined;
}

function migrateNode(value: unknown): GroupNode | ConditionNode | undefined {
  const node = value as Record<string, unknown> | null;
  if (typeof node !== "object" || node === null) return undefined;
  if (node.kind === "condition") return migrateCondition(node);
  if (
    node.kind !== "group" ||
    (node.op !== "and" && node.op !== "or") ||
    !Array.isArray(node.children)
  ) {
    return undefined;
  }
  const children: (GroupNode | ConditionNode)[] = [];
  for (const child of node.children) {
    const migrated = migrateNode(child);
    if (migrated === undefined) return undefined;
    children.push(migrated);
  }
  return { kind: "group", op: node.op === "and" ? "all" : "any", children };
}

/** A v1 document as v2, or undefined when it is not a valid v1 document. */
export function migrateV1(json: unknown): GroupNode | undefined {
  const doc = json as { v?: unknown; root?: unknown } | null;
  if (typeof doc !== "object" || doc === null || doc.v !== V1_FORMAT) {
    return undefined;
  }
  const root = migrateNode(doc.root);
  return root?.kind === "group" ? root : undefined;
}

/** The fixed form links carried before any tree. */
export interface LegacyFilter {
  minScore: number;
  seedMinVoxels: number;
  candidateMinVoxels: number;
  seedClass: SemanticClass;
  seedMinFraction: number;
  candidateClass: SemanticClass;
  candidateMinFraction: number;
}

export function legacyFilterTree(legacy: LegacyFilter): GroupNode {
  const children: ConditionNode[] = [];
  const atLeast = (
    field: ConditionNode["field"],
    value: number,
    target?: Target,
  ) =>
    children.push({
      kind: "cond",
      field,
      op: ">=",
      value,
      ...(target && { target }),
    });
  if (legacy.minScore > 0) atLeast("score", legacy.minScore);
  if (legacy.seedMinVoxels > 0) atLeast("size", legacy.seedMinVoxels, "seed");
  if (legacy.seedClass !== "any") {
    atLeast(legacy.seedClass, legacy.seedMinFraction * PERCENT, "seed");
  }
  if (legacy.candidateMinVoxels > 0) {
    atLeast("size", legacy.candidateMinVoxels, "candidate");
  }
  if (legacy.candidateClass !== "any") {
    atLeast(
      legacy.candidateClass,
      legacy.candidateMinFraction * PERCENT,
      "candidate",
    );
  }
  return { kind: "group", op: "all", children };
}
