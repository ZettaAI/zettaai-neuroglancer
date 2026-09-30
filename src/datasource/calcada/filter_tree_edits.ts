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
 * @file What the filter editor's tree can do to a filter, as the prototype
 * does it. Every edit works on the copy `FilterLibrary.edit` hands it, by
 * node id, and leaves target clean-up to `normalizeTargets`.
 */

import {
  formatNumber,
  isPercent,
  MAX_COUNT,
  MAX_HOPS,
  MAX_PERCENT,
  MAX_SCORE,
  MAX_SIZE,
} from "#src/datasource/calcada/candidate_filter_text.js";
import type {
  BondNode,
  Compare,
  ConditionField,
  ConditionNode,
  FilterNode,
  GroupNode,
  NeighborsNode,
  Target,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import { newNodeId } from "#src/datasource/calcada/candidate_filter_tree.js";

export type AddKind = "cond" | "group" | "neighbors" | "bond";
export const ADD_KINDS: ReadonlyArray<[AddKind, string]> = [
  ["cond", "Measure (size, axon %, …)"],
  ["group", "Group (ALL / ANY / NONE)"],
  ["neighbors", "Neighbors"],
  ["bond", "Bond (small attached part)"],
];

export type NumberField =
  | "value"
  | "value2"
  | "maxSize"
  | "count"
  | "hops"
  | "edges";

const DEFAULT_SIZE = 20_000;
const DEFAULT_SIZE_UPPER = 60_000;
const BIG_DENDRITE_SIZE = 200_000;
const BIG_DENDRITE_SHARE = 80;
const DEFAULT_NEIGHBOR_HOPS = 2;
const DEFAULT_BOND_EDGES = 2;
const DEFAULT_BOND_SIZE = 40_000;
const DEFAULT_PERCENT = 50;
const PERCENT_RANGE_STEP = 20;
const SIZE_RANGE_FACTOR = 3;
const DEFAULT_SCORE = 0.5;

const condition = (
  field: ConditionField,
  op: Compare,
  value: number,
): ConditionNode => ({ id: newNodeId(), kind: "cond", field, op, value });

const bigDendrite = (): GroupNode => ({
  id: newNodeId(),
  kind: "group",
  op: "all",
  children: [
    condition("size", ">", BIG_DENDRITE_SIZE),
    condition("dendrite", ">", BIG_DENDRITE_SHARE),
  ],
});

/** A new row of each kind, as the prototype's "+ Add" makes it. */
export function newRow(kind: AddKind): FilterNode {
  switch (kind) {
    case "cond":
      return condition("size", ">", DEFAULT_SIZE);
    case "group":
      return {
        id: newNodeId(),
        kind: "group",
        op: "all",
        children: [condition("size", ">", DEFAULT_SIZE)],
      };
    case "neighbors":
      return {
        id: newNodeId(),
        kind: "neighbors",
        quant: "no",
        count: 1,
        hops: DEFAULT_NEIGHBOR_HOPS,
        where: bigDendrite(),
      } satisfies NeighborsNode;
    case "bond":
      return {
        id: newNodeId(),
        kind: "bond",
        edges: DEFAULT_BOND_EDGES,
        maxSize: DEFAULT_BOND_SIZE,
      } satisfies BondNode;
  }
}

function childrenOf(node: FilterNode): FilterNode[] {
  if (node.kind === "group") return node.children;
  if (node.kind === "neighbors") return [node.where];
  return [];
}

function walk(
  node: FilterNode,
  visit: (node: FilterNode, parent: FilterNode | undefined) => void,
  parent?: FilterNode,
) {
  visit(node, parent);
  for (const child of childrenOf(node)) walk(child, visit, node);
}

export function findNode(
  root: GroupNode,
  id: string,
): { node: FilterNode; parent: FilterNode | undefined } | undefined {
  let found: { node: FilterNode; parent: FilterNode | undefined } | undefined;
  walk(root, (node, parent) => {
    if (found === undefined && node.id === id) found = { node, parent };
  });
  return found;
}

function contains(outer: FilterNode, inner: FilterNode): boolean {
  let hit = false;
  walk(outer, (node) => {
    if (node === inner) hit = true;
  });
  return hit;
}

/** Whether this group is a neighbor condition's body. */
export function isNeighborBody(root: GroupNode, group: FilterNode): boolean {
  let hit = false;
  walk(root, (node) => {
    if (node.kind === "neighbors" && node.where === group) hit = true;
  });
  return hit;
}

// Empty groups a removal leaves behind go too, up to the root; a neighbor
// body stays, empty meaning "every neighbor".
function pruneEmpty(root: GroupNode, group: FilterNode | undefined) {
  let current = group;
  while (
    current !== undefined &&
    current !== root &&
    current.kind === "group" &&
    current.children.length === 0 &&
    !isNeighborBody(root, current)
  ) {
    const parent = findNode(root, current.id!)?.parent;
    if (parent?.kind !== "group") break;
    const empty = current;
    parent.children = parent.children.filter((child) => child !== empty);
    current = parent;
  }
}

export function addRow(
  root: GroupNode,
  groupId: string,
  kind: AddKind,
): FilterNode {
  const group = findNode(root, groupId)?.node;
  const row = newRow(kind);
  if (group?.kind === "group") group.children.push(row);
  return row;
}

export function removeRow(root: GroupNode, id: string) {
  const found = findNode(root, id);
  if (found?.parent?.kind !== "group") return;
  const { node, parent } = found;
  parent.children = parent.children.filter((child) => child !== node);
  pruneEmpty(root, parent);
}

export function duplicateRow(root: GroupNode, id: string) {
  const found = findNode(root, id);
  if (found?.parent?.kind !== "group") return;
  const copy = structuredClone(found.node);
  walk(copy, (node) => {
    node.id = newNodeId();
  });
  const siblings = found.parent.children;
  siblings.splice(siblings.indexOf(found.node) + 1, 0, copy);
}

export function moveRow(
  root: GroupNode,
  id: string,
  direction: -1 | 1,
): "moved" | "first" | "last" {
  const found = findNode(root, id);
  if (found?.parent?.kind !== "group") return direction < 0 ? "first" : "last";
  const siblings = found.parent.children;
  const from = siblings.indexOf(found.node);
  const to = from + direction;
  if (to < 0) return "first";
  if (to >= siblings.length) return "last";
  siblings.splice(from, 1);
  siblings.splice(to, 0, found.node);
  return "moved";
}

/** The target a row is checked under, or undefined inside a neighbor body. */
function effectiveTarget(root: GroupNode, row: FilterNode): Target | undefined {
  let found: Target | undefined;
  const search = (
    node: FilterNode,
    inherited: Target | undefined,
    inNeighbors: boolean,
  ): boolean => {
    if (node === row) {
      found = inNeighbors ? undefined : (node.target ?? inherited);
      return true;
    }
    const here = node.target ?? inherited;
    if (node.kind === "group") {
      return node.children.some((child) => search(child, here, inNeighbors));
    }
    if (node.kind === "neighbors") return search(node.where, undefined, true);
    return false;
  };
  search(root, undefined, false);
  return found;
}

/**
 * Moves a row into a group, before `beforeId` or last. A moved row keeps whose
 * piece it was about; normalizing drops that again where the new place has
 * one. False when the drop makes no sense (a group into itself).
 */
export function dropRow(
  root: GroupNode,
  id: string,
  intoId: string,
  beforeId: string | undefined,
): boolean {
  const dragged = findNode(root, id);
  const into = findNode(root, intoId)?.node;
  if (dragged?.parent?.kind !== "group" || into?.kind !== "group") return false;
  if (contains(dragged.node, into)) return false;
  const before =
    beforeId === undefined ? undefined : findNode(root, beforeId)?.node;
  if (before === dragged.node) return false;
  const { node, parent: from } = dragged;
  const target = effectiveTarget(root, node);
  from.children = from.children.filter((child) => child !== node);
  const at = before === undefined ? -1 : into.children.indexOf(before);
  into.children.splice(at < 0 ? into.children.length : at, 0, node);
  if (!node.target && target) node.target = target;
  if (from !== into) pruneEmpty(root, from);
  return true;
}

/**
 * Sets whose piece a row is about. A group given a target takes it for all
 * its rows (their own choices are replaced — reported so the editor can say
 * so); a group handed back to "each row picks" gives each row its old target.
 */
export function setTarget(
  root: GroupNode,
  id: string,
  target: Target | undefined,
): { replaced: boolean } {
  const node = findNode(root, id)?.node;
  if (node === undefined || (node.kind !== "group" && target === undefined)) {
    return { replaced: false };
  }
  const old = node.target;
  node.target = target;
  let replaced = false;
  if (node.kind === "group" && target !== undefined) {
    walk(node, (inner) => {
      if (inner === node) return;
      if (inner.target && inner.target !== target) replaced = true;
      inner.target = undefined;
    });
  }
  if (node.kind === "group" && target === undefined && old) {
    for (const child of node.children) child.target = old;
  }
  return { replaced };
}

/** Changes a dropdown value, keeping the numbers sensible for it. */
export function setChoice(
  root: GroupNode,
  id: string,
  choice: "field" | "op" | "quant",
  value: string,
) {
  const node = findNode(root, id)?.node;
  if (node === undefined) return;
  if (node.kind === "group" && choice === "op") {
    node.op = value as GroupNode["op"];
  } else if (node.kind === "neighbors" && choice === "quant") {
    node.quant = value as NeighborsNode["quant"];
  } else if (node.kind === "cond" && choice === "op") {
    node.op = value as Compare;
    if (
      node.op === "between" &&
      (node.value2 === undefined || node.value2 <= node.value)
    ) {
      node.value2 = isPercent(node.field)
        ? Math.min(MAX_PERCENT, node.value + PERCENT_RANGE_STEP)
        : node.field === "score"
          ? MAX_SCORE
          : node.value * SIZE_RANGE_FACTOR;
    }
  } else if (node.kind === "cond" && choice === "field") {
    setField(node, value as ConditionField);
  }
}

function setField(node: ConditionNode, field: ConditionField) {
  node.field = field;
  if (isPercent(field)) {
    if (node.value > MAX_PERCENT) node.value = DEFAULT_PERCENT;
    if (node.value2 !== undefined && node.value2 > MAX_PERCENT)
      node.value2 = MAX_PERCENT;
  } else if (field === "score") {
    if (node.value > MAX_SCORE) node.value = DEFAULT_SCORE;
    if (node.value2 !== undefined && node.value2 > MAX_SCORE) {
      node.value2 = MAX_SCORE;
    }
  } else if (node.value <= MAX_PERCENT) {
    node.value = DEFAULT_SIZE;
    if (node.value2 !== undefined) node.value2 = DEFAULT_SIZE_UPPER;
  }
  if (node.value2 !== undefined && node.value2 < node.value) {
    node.value2 = node.value;
  }
}

export function setNumber(
  root: GroupNode,
  id: string,
  field: NumberField,
  value: number,
) {
  const node = findNode(root, id)?.node as Record<string, unknown> | undefined;
  if (node !== undefined) node[field] = value;
}

/**
 * A typed number box: its value, or what is wrong with it, in the prototype's
 * words.
 */
export function checkNumber(
  node: FilterNode,
  field: NumberField,
  raw: string,
): { value: number } | { message: string } {
  const numberField = field === "value" || field === "value2";
  const isSize =
    (node.kind === "cond" && node.field === "size" && numberField) ||
    (node.kind === "bond" && field === "maxSize");
  const isShare = node.kind === "cond" && isPercent(node.field) && numberField;
  const isScore = node.kind === "cond" && node.field === "score" && numberField;
  const clean = raw.trim().replace(/[,_\s]/g, "");
  const match = clean.match(/^(\d*\.?\d+)([kKM]?)(%?)$/);
  if (!match && /^\d*\.?\d+m%?$/.test(clean)) {
    return { message: "Use a capital M for million, like 1.5M" };
  }
  if (!match && clean.startsWith("-"))
    return { message: "Numbers can’t be negative" };
  if (!match) {
    return {
      message: isSize
        ? "Enter a size in voxels, like 20k or 20000"
        : isShare
          ? "Enter a percentage from 0 to 100"
          : isScore
            ? "Enter a score from 0 to 1"
            : "Enter a whole number",
    };
  }
  const [, digits, suffix, percent] = match;
  if (percent && !isShare) {
    return {
      message: isSize
        ? "Size is in voxels, so it takes no %"
        : "Enter a whole number",
    };
  }
  if (suffix && isShare) return { message: "A percentage takes no k or M" };
  if (suffix && !isSize) {
    return { message: "A plain whole number here, without k or M" };
  }
  const exponent = suffix ? (suffix.toLowerCase() === "k" ? "e3" : "e6") : "";
  const value = Number(digits + exponent);
  if (isShare && value > MAX_PERCENT) {
    return { message: "A percentage must be 0 to 100" };
  }
  if (isScore && value > MAX_SCORE)
    return { message: "Enter a score from 0 to 1" };
  if (isSize && !Number.isInteger(value)) {
    return { message: "Size is a whole number of voxels" };
  }
  if (!isSize && !isShare && !isScore && !Number.isInteger(value)) {
    return { message: "Enter a whole number" };
  }
  if (field === "hops" && value < 1)
    return { message: "Hops must be at least 1" };
  if (field === "hops" && value > MAX_HOPS) {
    return { message: "Hops can be at most 1000" };
  }
  if ((field === "count" || field === "edges") && value > MAX_COUNT) {
    return { message: "That is more than a million; use a smaller number" };
  }
  if (isSize && value > MAX_SIZE) {
    return { message: "Size can be at most 1000000000M" };
  }
  if (node.kind === "cond" && node.op === "between" && numberField) {
    const low = field === "value" ? value : node.value;
    const high = field === "value2" ? value : (node.value2 ?? node.value);
    if (low > high) {
      return {
        message: `${formatNumber(low)} to ${formatNumber(high)} is backwards. ${
          field === "value"
            ? "Raise the upper end first"
            : "Lower the lower end first"
        }, or swap the numbers.`,
      };
    }
  }
  return { value };
}
