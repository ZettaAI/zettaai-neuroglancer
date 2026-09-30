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
 * @file The candidate filter, shared by the trace and split error detection:
 * ALL / ANY / NONE groups of measures, neighbour counts and bonds, each about
 * the seed, the candidate or both. The client evaluates it; the server only
 * ever sees `minCandidateVoxels`, and supplies the piece graph that neighbour
 * and bond conditions read.
 */

import { migrateV1 } from "#src/datasource/calcada/candidate_filter_v1.js";
import type {
  PieceClasses,
  SemanticClass,
} from "#src/datasource/calcada/candidate_heat.js";
import {
  classTotal,
  SEMANTIC_CLASSES,
} from "#src/datasource/calcada/candidate_heat.js";

export type Side = "seed" | "candidate";
export type Target = Side | "both";
export type PieceClass = Exclude<SemanticClass, "any">;
export type ConditionField = "size" | "score" | PieceClass;
export type Compare = "<" | "<=" | ">" | ">=" | "between";

// The stored shape is Sergiy's filter format: every node may carry an `id`,
// and a missing (null) target inherits the one above.

export interface ConditionNode {
  id?: string;
  kind: "cond";
  field: ConditionField;
  op: Compare;
  value: number;
  /** The upper end of a `between`, inclusive. */
  value2?: number;
  target?: Target;
}

export interface GroupNode {
  id?: string;
  kind: "group";
  op: "all" | "any" | "none";
  children: FilterNode[];
  target?: Target;
  /** The user's text with its # comments; kept on the root only. */
  note?: string;
}

export interface NeighborsNode {
  id?: string;
  kind: "neighbors";
  quant: "no" | "at_least" | "at_most" | "exactly";
  count: number;
  hops: number;
  /** Checked on each neighbour; everything inside is about the neighbour. */
  where: GroupNode;
  target?: Target;
}

export interface BondNode {
  id?: string;
  kind: "bond";
  maxSize: number;
  edges: number;
  target?: Target;
}

export type FilterNode = ConditionNode | GroupNode | NeighborsNode | BondNode;

export const FILTER_FORMAT = 2;

export interface PieceFacts {
  pieceId: bigint;
  voxels: number;
  classes: PieceClasses;
  hasInfo: boolean;
}

/** What a filter is asked about: a match, seen from both of its ends. */
export interface FilterSubject {
  score: number;
  seed: PieceFacts;
  candidate: PieceFacts;
}

/** Whether any subject on hand carries semantics, per side. */
export interface SemanticsKnown {
  seed: boolean;
  candidate: boolean;
}

/** The piece graph as neighbour and bond conditions read it. */
export interface GraphFacts {
  /** Pieces within `hops` of the piece, itself excluded; undefined if unknown. */
  neighbours(piece: bigint, hops: number): PieceFacts[] | undefined;
  /** Undefined if not asked yet; null if the graph has no such part. */
  part(
    piece: bigint,
    maxSize: number,
  ): { edges: number; voxels: number } | null | undefined;
}

/** Whether a match passes; undefined while it hangs on the unloaded graph. */
export type Verdict = boolean | undefined;

export const NO_GRAPH: GraphFacts = {
  neighbours: () => undefined,
  part: () => undefined,
};

const PERCENT = 100;
const NODE_ID_RADIX = 36;
const NODE_ID_LENGTH = 8;
const SIDES: readonly Side[] = ["seed", "candidate"];
const TARGETS: readonly Target[] = [...SIDES, "both"];
const PIECE_CLASSES = SEMANTIC_CLASSES.filter(
  (name): name is PieceClass => name !== "any",
);
const CONDITION_FIELDS: readonly ConditionField[] = [
  "size",
  "score",
  ...PIECE_CLASSES,
];
const COMPARES: readonly Compare[] = ["<", "<=", ">", ">=", "between"];
const QUANTS: readonly NeighborsNode["quant"][] = [
  "no",
  "at_least",
  "at_most",
  "exactly",
];

export function newNodeId(): string {
  return `n${Math.random()
    .toString(NODE_ID_RADIX)
    .slice(2, 2 + NODE_ID_LENGTH)}`;
}

export function emptyFilterTree(): GroupNode {
  return { id: newNodeId(), kind: "group", op: "all", children: [] };
}

/** A node as stored: ids everywhere, null for no target or no upper bound. */
function storedNode(node: FilterNode): Record<string, unknown> {
  const common = { id: node.id ?? newNodeId(), target: node.target ?? null };
  switch (node.kind) {
    case "group":
      return {
        ...common,
        kind: "group",
        op: node.op,
        children: node.children.map(storedNode),
        ...(node.note !== undefined && { note: node.note }),
      };
    case "cond":
      return {
        ...common,
        kind: "cond",
        field: node.field,
        op: node.op,
        value: node.value,
        value2: node.op === "between" ? (node.value2 ?? node.value) : null,
      };
    case "neighbors":
      return {
        ...common,
        kind: "neighbors",
        quant: node.quant,
        count: node.count,
        hops: node.hops,
        where: storedNode(node.where),
      };
    case "bond":
      return {
        ...common,
        kind: "bond",
        maxSize: node.maxSize,
        edges: node.edges,
      };
  }
}

export function serializeFilterTree(root: GroupNode) {
  return { v: FILTER_FORMAT, root: storedNode(root) };
}

// ---------------------------------------------------------------- parsing

type Fields = Record<string, unknown>;

const isCount = (value: unknown, least: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= least;
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function parseCommon(
  node: Fields,
): { ok: false } | { ok: true; id: string; target?: Target } {
  const id = typeof node.id === "string" ? node.id : newNodeId();
  if (node.target === undefined || node.target === null)
    return { ok: true, id };
  const target = node.target as Target;
  return TARGETS.includes(target) ? { ok: true, id, target } : { ok: false };
}

function parseGroup(node: Fields): Omit<GroupNode, "id"> | undefined {
  if (
    (node.op !== "all" && node.op !== "any" && node.op !== "none") ||
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
  return {
    kind: "group",
    op: node.op,
    children,
    ...(typeof node.note === "string" && { note: node.note }),
  };
}

function parseCondition(node: Fields): Omit<ConditionNode, "id"> | undefined {
  const field = node.field as ConditionField;
  const op = node.op as Compare;
  if (
    !CONDITION_FIELDS.includes(field) ||
    !COMPARES.includes(op) ||
    !isNumber(node.value) ||
    (op === "between" && !isNumber(node.value2))
  ) {
    return undefined;
  }
  return {
    kind: "cond",
    field,
    op,
    value: node.value,
    ...(op === "between" && { value2: node.value2 as number }),
  };
}

function parseNeighbors(node: Fields): Omit<NeighborsNode, "id"> | undefined {
  const quant = node.quant as NeighborsNode["quant"];
  const where = parseNode(node.where);
  if (
    !QUANTS.includes(quant) ||
    !(quant === "no" || isCount(node.count, 0)) ||
    !isCount(node.hops, 1) ||
    where?.kind !== "group"
  ) {
    return undefined;
  }
  return {
    kind: "neighbors",
    quant,
    count: quant === "no" ? 0 : (node.count as number),
    hops: node.hops as number,
    where,
  };
}

function parseBond(node: Fields): Omit<BondNode, "id"> | undefined {
  if (!isCount(node.maxSize, 0) || !isCount(node.edges, 0)) return undefined;
  return {
    kind: "bond",
    maxSize: node.maxSize as number,
    edges: node.edges as number,
  };
}

function parseNode(value: unknown): FilterNode | undefined {
  const node = value as Fields | null;
  if (typeof node !== "object" || node === null) return undefined;
  const common = parseCommon(node);
  if (!common.ok) return undefined;
  const parsed =
    node.kind === "group"
      ? parseGroup(node)
      : node.kind === "cond"
        ? parseCondition(node)
        : node.kind === "neighbors"
          ? parseNeighbors(node)
          : node.kind === "bond"
            ? parseBond(node)
            : undefined;
  if (parsed === undefined) return undefined;
  const { id, target } = common;
  return { id, ...parsed, ...(target && { target }) } as FilterNode;
}

/** Gives every node without an id one: the editor finds rows by id. */
export function withNodeIds<T extends FilterNode | undefined>(node: T): T {
  if (node === undefined) return node;
  node.id ??= newNodeId();
  if (node.kind === "group") node.children.forEach(withNodeIds);
  if (node.kind === "neighbors") withNodeIds(node.where);
  return node;
}

/**
 * A stored or linked filter, or undefined when it cannot be used as is: a
 * later format, or anything malformed. Takes the versioned document, a bare
 * tree as Sergiy's editor stores it, or a v1 document, which is migrated.
 * Never a partial tree — a filter missing a condition silently shows what the
 * proofreader meant to hide.
 */
export function parseFilterDocument(json: unknown): GroupNode | undefined {
  const doc = json as { v?: unknown; root?: unknown; kind?: unknown } | null;
  if (typeof doc !== "object" || doc === null) return undefined;
  let root: FilterNode | undefined;
  if (doc.kind === "group") root = parseNode(doc);
  else if (doc.v === FILTER_FORMAT) root = parseNode(doc.root);
  else return withNodeIds(migrateV1(json));
  if (root?.kind !== "group" || validationError(root) !== undefined) {
    return undefined;
  }
  return root;
}

/**
 * Why the tree cannot be evaluated, or undefined when it can: a condition
 * about a piece must be under a seed, candidate or both somewhere above it.
 * Targets below one are about that piece already, and everything inside a
 * neighbour condition is about the neighbour, so neither needs one.
 */
export function validationError(root: GroupNode): string | undefined {
  const check = (node: FilterNode): string | undefined => {
    if (node.target !== undefined) return undefined;
    if (node.kind === "group") {
      for (const child of node.children) {
        const error = check(child);
        if (error) return error;
      }
      return undefined;
    }
    if (node.kind === "cond" && node.field === "score") return undefined;
    return "Say whose piece this is about: seed, candidate or both";
  };
  return check(root);
}

// ------------------------------------------------------------- evaluation

function compare(value: number, node: ConditionNode): boolean {
  if (Number.isNaN(value)) return false;
  switch (node.op) {
    case "<":
      return value < node.value;
    case "<=":
      return value <= node.value;
    case ">":
      return value > node.value;
    case ">=":
      return value >= node.value;
    case "between":
      return value >= node.value && value <= (node.value2 ?? node.value);
  }
}

function sharePercent(facts: PieceFacts, field: PieceClass): number {
  const total = facts.hasInfo ? classTotal(facts.classes) : 0;
  return total > 0 ? (facts.classes[field] / total) * PERCENT : Number.NaN;
}

interface PieceScope {
  subject: FilterSubject;
  facts: PieceFacts;
  /** A class share on a side nobody has semantics for is not filtered. */
  semanticsKnown: boolean;
  graph: GraphFacts;
}

const graphReaders = new WeakMap<FilterNode, boolean>();

function readsGraph(node: FilterNode): boolean {
  let reads = graphReaders.get(node);
  if (reads === undefined) {
    reads =
      node.kind === "neighbors" ||
      node.kind === "bond" ||
      (node.kind === "group" && node.children.some(readsGraph));
    graphReaders.set(node, reads);
  }
  return reads;
}

/** Stops at the first false; unknown only if nothing is false. */
function allOf(verdicts: Iterable<Verdict>): Verdict {
  let unknown = false;
  for (const verdict of verdicts) {
    if (verdict === false) return false;
    if (verdict === undefined) unknown = true;
  }
  return unknown ? undefined : true;
}

/** Stops at the first true; unknown only if nothing is true. */
function anyOf(verdicts: Iterable<Verdict>): Verdict {
  let unknown = false;
  for (const verdict of verdicts) {
    if (verdict === true) return true;
    if (verdict === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

/**
 * ALL / ANY / NONE over verdicts that may be unknown, taken lazily. Rows that
 * do not read the graph go first: when they settle the group, the graph is
 * never asked for, and so never fetched.
 */
function combine(
  op: GroupNode["op"],
  children: FilterNode[],
  verdict: (node: FilterNode) => Verdict,
): Verdict {
  const ordered = [
    ...children.filter((child) => !readsGraph(child)),
    ...children.filter(readsGraph),
  ];
  const verdicts = (function* () {
    for (const child of ordered) yield verdict(child);
  })();
  if (op === "all") return allOf(verdicts);
  const any = anyOf(verdicts);
  if (op === "any") return any;
  return any === undefined ? undefined : !any;
}

/** How many neighbours pass, when that many is enough to answer. */
function countVerdict(
  node: NeighborsNode,
  sure: number,
  possible: number,
): Verdict {
  switch (node.quant) {
    case "no":
      return sure > 0 ? false : possible === 0 ? true : undefined;
    case "at_least":
      return sure >= node.count
        ? true
        : possible < node.count
          ? false
          : undefined;
    case "at_most":
      return possible <= node.count
        ? true
        : sure > node.count
          ? false
          : undefined;
    case "exactly":
      if (sure > node.count || possible < node.count) return false;
      return sure === possible ? true : undefined;
  }
}

function piecePasses(node: FilterNode, scope: PieceScope): Verdict {
  switch (node.kind) {
    case "group":
      return combine(node.op, node.children, (child) =>
        piecePasses(child, scope),
      );
    case "cond":
      if (node.field === "score") return compare(scope.subject.score, node);
      if (node.field === "size") return compare(scope.facts.voxels, node);
      if (!scope.semanticsKnown) return true;
      return compare(sharePercent(scope.facts, node.field), node);
    case "neighbors": {
      const around = scope.graph.neighbours(scope.facts.pieceId, node.hops);
      if (around === undefined) return undefined;
      let sure = 0;
      let possible = 0;
      for (const facts of around) {
        const result = piecePasses(node.where, {
          ...scope,
          facts,
          semanticsKnown: true,
        });
        if (result === true) sure++;
        if (result !== false) possible++;
      }
      return countVerdict(node, sure, possible);
    }
    case "bond": {
      const part = scope.graph.part(scope.facts.pieceId, node.maxSize);
      if (part === undefined) return undefined;
      return (
        part !== null && part.voxels <= node.maxSize && part.edges <= node.edges
      );
    }
  }
}

function matchPasses(
  node: FilterNode,
  subject: FilterSubject,
  known: SemanticsKnown,
  graph: GraphFacts,
): Verdict {
  if (node.target !== undefined) {
    const sides = node.target === "both" ? SIDES : [node.target];
    return allOf(
      (function* () {
        for (const side of sides) {
          yield piecePasses(node, {
            subject,
            facts: subject[side],
            semanticsKnown: known[side],
            graph,
          });
        }
      })(),
    );
  }
  if (node.kind === "group") {
    return combine(node.op, node.children, (child) =>
      matchPasses(child, subject, known, graph),
    );
  }
  if (node.kind === "cond" && node.field === "score") {
    return compare(subject.score, node);
  }
  return false;
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

export function subjectVerdict(
  subject: FilterSubject,
  root: GroupNode,
  known: SemanticsKnown,
  graph: GraphFacts,
): Verdict {
  if (validationError(root) !== undefined) return false;
  return matchPasses(root, subject, known, graph);
}

export function subjectPasses(
  subject: FilterSubject,
  root: GroupNode,
  known: SemanticsKnown,
  graph: GraphFacts,
): boolean {
  return subjectVerdict(subject, root, known, graph) === true;
}

/**
 * The smallest candidate every passing match must have — the one part of the
 * tree the server can apply without seeing it. Anything it cannot bound from
 * below contributes 0, so the bound only ever lets through more than the tree.
 * The outermost target wins, as in evaluation.
 */
export function minCandidateVoxels(
  node: FilterNode,
  inherited?: Target,
): number {
  const target = inherited ?? node.target;
  switch (node.kind) {
    case "cond":
      return node.field === "size" &&
        (target === "candidate" || target === "both") &&
        (node.op === ">=" || node.op === ">" || node.op === "between")
        ? Math.max(0, node.value)
        : 0;
    case "group": {
      if (node.children.length === 0 || node.op === "none") return 0;
      const bounds = node.children.map((child) =>
        minCandidateVoxels(child, target),
      );
      return node.op === "all" ? Math.max(...bounds) : Math.min(...bounds);
    }
    default:
      return 0;
  }
}
