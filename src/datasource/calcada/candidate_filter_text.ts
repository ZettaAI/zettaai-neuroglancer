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
 * @file The filter as text: lexer, parser, printer and the canonical form that
 * decides whether two trees are the same filter. A port of the language in
 * Sergiy's filter editor prototype (v11); its messages are kept word for word.
 */

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

export const DEFAULT_PRINT_WIDTH = 84;
export const MIN_PRINT_WIDTH = 40;

export const MAX_COUNT = 1e6;
export const MAX_SIZE = 1e15;
export const MAX_HOPS = 1000;
const MAX_DEPTH = 100;
export const MAX_PERCENT = 100;
export const MAX_SCORE = 1;
const MILLION = 1e6;
const THOUSAND = 1000;

// ---------------------------------------------------------------- model

const condition = (
  field: ConditionField,
  op: Compare,
  value: number,
  value2?: number,
): ConditionNode => ({
  id: newNodeId(),
  kind: "cond",
  field,
  op,
  value,
  ...(value2 !== undefined && { value2 }),
});
const group = (op: GroupNode["op"], children: FilterNode[]): GroupNode => ({
  id: newNodeId(),
  kind: "group",
  op,
  children,
});
const neighborsNode = (
  quant: NeighborsNode["quant"],
  count: number,
  hops: number,
  where: GroupNode,
): NeighborsNode => ({
  id: newNodeId(),
  kind: "neighbors",
  quant,
  count,
  hops,
  where,
});
const bondNode = (edges: number, maxSize: number): BondNode => ({
  id: newNodeId(),
  kind: "bond",
  edges,
  maxSize,
});

const isLeaf = (node: FilterNode) => node.kind !== "group";
const isScore = (node: FilterNode) =>
  node.kind === "cond" && node.field === "score";

function childrenOf(node: FilterNode): FilterNode[] {
  if (node.kind === "group") return node.children;
  if (node.kind === "neighbors") return [node.where];
  return [];
}

function walk(node: FilterNode, visit: (node: FilterNode) => void) {
  visit(node);
  for (const child of childrenOf(node)) walk(child, visit);
}

/**
 * Rows directly under the filter's top group choose Seed / Candidate / Both. A
 * group may say "each row", handing the choice to its rows. Everything under a
 * chosen target inherits it; neighbor bodies are about the neighbor. Only
 * targets are fixed — nothing the user built is restructured.
 */
export function normalizeTargets(root: GroupNode) {
  root.target = undefined;
  if (root.op === "none") root.op = "all";
  for (const child of root.children) normalizeNode(child, true);
}

function normalizeNode(node: FilterNode, eligible: boolean) {
  if (!eligible || isScore(node)) node.target = undefined;
  else if (isLeaf(node) && !node.target) node.target = "both";
  if (node.kind === "group") {
    const childrenEligible = eligible && !node.target;
    for (const child of node.children) normalizeNode(child, childrenEligible);
  }
  if (node.kind === "neighbors") {
    node.where.target = undefined;
    for (const child of node.where.children) normalizeNode(child, false);
  }
}

// ----------------------------------------------------- canonical form

// Groupings that do not change the meaning are dropped, so equivalent trees
// print the same text and compare equal. The editor keeps the tree as built.
function simplify(node: FilterNode): FilterNode {
  if (node.kind === "cond" || node.kind === "bond") return { ...node };
  if (node.kind === "neighbors") {
    return { ...node, where: simplifyBody(node.where, true) };
  }
  const simplified = simplifyChildren(node);
  if (simplified.op !== "none" && simplified.children.length === 1) {
    const only = simplified.children[0];
    if (!simplified.target) return only;
    if (!only.target) return { ...only, target: simplified.target };
  }
  return simplified;
}

function simplifyChildren(node: GroupNode): GroupNode {
  let children = node.children.map(simplify);
  // A group with no rows passes whatever its op.
  const op =
    (node.op === "any" && children.length <= 1) || !children.length
      ? "all"
      : node.op;
  const only = children[0];
  if (
    op === "none" &&
    children.length === 1 &&
    only.kind === "group" &&
    only.op === "any" &&
    !only.target
  ) {
    children = only.children;
  }
  return { ...node, op, children };
}

function simplifyBody(node: GroupNode, allowNone: boolean): GroupNode {
  const simplified = simplifyChildren(node);
  if (simplified.op !== "none" && simplified.children.length === 1) {
    const only = simplified.children[0];
    if (
      only.kind === "group" &&
      !only.target &&
      (only.op !== "none" || allowNone)
    ) {
      return { ...only, id: simplified.id };
    }
  }
  return simplified;
}

function strip(node: FilterNode): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: node.kind };
  if (node.target) out.target = node.target;
  switch (node.kind) {
    case "group":
      out.op = node.op;
      out.children = node.children.map(strip);
      break;
    case "cond":
      out.field = node.field;
      out.op = node.op;
      out.value = node.value;
      if (node.op === "between") out.value2 = node.value2;
      break;
    case "neighbors":
      out.quant = node.quant;
      if (node.quant !== "no") out.count = node.count;
      out.hops = node.hops;
      out.where = strip(node.where);
      break;
    case "bond":
      out.edges = node.edges;
      out.maxSize = node.maxSize;
      break;
  }
  return out;
}

const canonical = (root: GroupNode) => strip(simplifyBody(root, false));

/** Whether two trees are the same filter, however they are grouped. */
export function sameFilter(a: GroupNode, b: GroupNode): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// ---------------------------------------------------------------- printer

/** Whether a measure is a class share, written with %. */
export const isPercent = (field: ConditionField) =>
  field !== "size" && field !== "score";

/** 20k, 1.5M: shortened only when that loses nothing. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= MILLION && Math.round(value / 1e4) * 1e4 === value) {
    return `${+(value / MILLION).toFixed(2)}M`;
  }
  if (Math.abs(value) >= THOUSAND && Math.round(value / 10) * 10 === value) {
    return `${+(value / THOUSAND).toFixed(2)}k`;
  }
  return String(value);
}

const valueText = (field: ConditionField, value: number) =>
  formatNumber(value) + (isPercent(field) ? "%" : "");

function neighborsHead(node: NeighborsNode): string {
  const how =
    node.quant === "no"
      ? "no"
      : node.quant === "at_least"
        ? `at least ${node.count}`
        : node.quant === "at_most"
          ? `at most ${node.count}`
          : `exactly ${node.count}`;
  const plural = node.quant === "no" || node.count !== 1;
  return `${how} neighbor${plural ? "s" : ""} within ${node.hops} hop${node.hops === 1 ? "" : "s"} with`;
}

function leafText(node: FilterNode): string {
  if (node.kind === "cond") {
    if (node.op === "between") {
      return `${node.field} from ${valueText(node.field, node.value)} to ${valueText(node.field, node.value2 ?? node.value)}`;
    }
    return `${node.field} ${node.op} ${valueText(node.field, node.value)}`;
  }
  if (node.kind === "bond") {
    return `in a part <= ${formatNumber(node.maxSize)} attached by <= ${node.edges} edge${node.edges === 1 ? "" : "s"}`;
  }
  if (node.kind === "neighbors") {
    return `${neighborsHead(node)} (${bodyText(node.where)})`;
  }
  return "";
}

const joinWord = (op: GroupNode["op"]) =>
  op === "any" || op === "none" ? "or" : "and";

function noneText(node: GroupNode): string {
  const only = node.children[0];
  if (
    node.children.length === 1 &&
    only.kind === "group" &&
    !only.target &&
    only.op === "all"
  ) {
    return `not (${innerText(only)})`;
  }
  return `not (${node.children.map(atom).join(" or ")})`;
}

function bodyText(node: GroupNode): string {
  if (node.op === "none") return noneText(node);
  if (!node.children.length) return "true";
  return node.children.map(atom).join(` ${joinWord(node.op)} `);
}

function innerText(node: GroupNode): string {
  if (node.op === "none") return noneText(node);
  if (node.children.length === 1) return `(${atom(node.children[0])})`;
  return node.children.map(atom).join(` ${joinWord(node.op)} `);
}

function atom(node: FilterNode): string {
  if (node.kind !== "group") {
    const text = leafText(node);
    return node.target ? `${node.target} ${text}` : text;
  }
  if (node.target) return `${node.target}(${innerText(node)})`;
  if (node.op === "none") return noneText(node);
  if (node.children.length === 1) return `(${atom(node.children[0])})`;
  return `(${innerText(node)})`;
}

/** One node on one line, as the text language writes it. */
export function describeFilterNode(node: FilterNode): string {
  return atom(node);
}

// Rows joined by and/or: short rows share a line, long ones get their own.
function joinLines(
  children: FilterNode[],
  word: string,
  indent: string,
  width: number,
): string[] {
  const out: string[] = [];
  const pad = " ".repeat(word.length + 1);
  let packable = false;
  const optionsList =
    word === "or" && children.some((child) => child.kind === "group");
  children.forEach((child, i) => {
    let lines = prettyAtom(child, indent + (i ? pad : ""), width);
    if (
      i &&
      lines.length > 1 &&
      ((child.kind === "group" && child.target) || child.kind === "neighbors")
    ) {
      const alternative = prettyAtom(child, indent, width);
      if (alternative.length > 1) lines = alternative;
    }
    const first = lines[0].trimStart();
    if (
      i &&
      packable &&
      !optionsList &&
      lines.length === 1 &&
      `${out[out.length - 1]} ${word} ${first}`.length <= width
    ) {
      out[out.length - 1] += ` ${word} ${first}`;
      return;
    }
    lines[0] = indent + (i ? `${word} ` : "") + first;
    out.push(...lines);
    packable = lines.length === 1;
  });
  return out;
}

function hang(open: string, lines: string[], indent: string): string[] {
  lines[0] = indent + open + lines[0].trimStart();
  lines[lines.length - 1] += ")";
  return lines;
}

// not (a and b): a NONE group whose only row is an ALL group prints that
// group's rows joined by "and".
function noneOfAll(node: GroupNode): boolean {
  const only = node.children[0];
  return (
    node.children.length === 1 &&
    only.kind === "group" &&
    !only.target &&
    only.op === "all" &&
    only.children.length > 1
  );
}
const noneChildren = (node: GroupNode) =>
  noneOfAll(node) ? (node.children[0] as GroupNode).children : node.children;
const noneWord = (node: GroupNode) => (noneOfAll(node) ? "and" : "or");

function prettyAtom(node: FilterNode, indent: string, width: number): string[] {
  const text = atom(node);
  if (
    indent.length + text.length <= width ||
    node.kind === "cond" ||
    node.kind === "bond"
  ) {
    return [indent + text];
  }
  if (node.kind === "neighbors") {
    return [
      `${indent}${node.target ? `${node.target} ` : ""}${neighborsHead(node)} (`,
      ...prettyBody(node.where, `${indent}  `, width),
      `${indent})`,
    ];
  }
  if (node.target) {
    let open = `${node.target}(`;
    let close = ")";
    if (node.op === "none") {
      open = `${node.target}(not (`;
      close = "))";
    } else if (node.children.length === 1) {
      open = `${node.target}((`;
      close = "))";
    }
    const children = node.op === "none" ? noneChildren(node) : node.children;
    const word = node.op === "none" ? noneWord(node) : joinWord(node.op);
    return [
      indent + open,
      ...joinLines(children, word, `${indent}  `, width),
      indent + close,
    ];
  }
  // The closing ")" goes on the last line, so the inside is one column narrower.
  const inner = width - 1;
  if (node.op === "none") {
    return hang(
      "not (",
      joinLines(noneChildren(node), noneWord(node), `${indent}     `, inner),
      indent,
    );
  }
  if (node.children.length === 1) {
    return hang("(", prettyAtom(node.children[0], `${indent} `, inner), indent);
  }
  return hang(
    "(",
    joinLines(node.children, joinWord(node.op), `${indent} `, inner),
    indent,
  );
}

function prettyBody(node: GroupNode, indent: string, width: number): string[] {
  if (node.op === "none") return prettyAtom(node, indent, width);
  if (!node.children.length) return [`${indent}true`];
  return joinLines(node.children, joinWord(node.op), indent, width);
}

/** The filter as text, wrapped to `width` columns; "" when it is empty. */
export function printFilter(
  root: GroupNode,
  width = DEFAULT_PRINT_WIDTH,
): string {
  if (!root.children.length) return "";
  return prettyBody(
    simplifyBody(root, false),
    "",
    Math.max(MIN_PRINT_WIDTH, width),
  ).join("\n");
}

// ------------------------------------------------------------------ lexer

const DOC_FIELDS = ["size", "axon", "dendrite", "perikaryon", "nucleus"];
const EXTRA_FIELDS = ["glia", "vasculature", "ecs", "other", "score"];
const FIELDS = [...DOC_FIELDS, ...EXTRA_FIELDS];
const TARGET_WORDS = ["seed", "candidate", "both"];
const LOGIC = ["and", "or", "not"];
const NEIGHBOR_WORDS = [
  "no",
  "at",
  "least",
  "most",
  "exactly",
  "neighbor",
  "neighbors",
  "neighbour",
  "neighbours",
  "within",
  "hop",
  "hops",
  "with",
  "is",
  "are",
  "has",
  "have",
  "cut",
  "off",
  "by",
  "edge",
  "edges",
  "in",
  "a",
  "part",
  "attached",
  "between",
  "from",
  "to",
  "vx",
  "voxels",
  "true",
];
const VOCABULARY = [...FIELDS, ...TARGET_WORDS, ...LOGIC, ...NEIGHBOR_WORDS];

type Token =
  | {
      type: "space" | "comment" | "bad";
      text: string;
      start: number;
      end: number;
    }
  | {
      type: "number";
      text: string;
      start: number;
      end: number;
      value: number;
      whole: boolean;
      percent: boolean;
      suffix: boolean;
    }
  | { type: "word"; text: string; start: number; end: number; word: string }
  | {
      type: "symbol";
      text: string;
      start: number;
      end: number;
      symbol: string;
    };

const TOKEN_PATTERN =
  /(\s+)|(#[^\n]*)|((?:\d{1,3}(?:,\d{3})+|\d+(?:_\d+)*)(?:\.\d+)?)([kKM](?![A-Za-z_\d]))?(%)?|([A-Za-z_]+)|(<=|>=|≤|≥|\.\.|[()<>])|([\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S])/y;

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  const pattern = new RegExp(TOKEN_PATTERN.source, "y");
  let match: RegExpExecArray | null;
  while (pattern.lastIndex < src.length && (match = pattern.exec(src))) {
    const start = match.index;
    const end = pattern.lastIndex;
    const text = match[0];
    if (match[1]) tokens.push({ type: "space", text, start, end });
    else if (match[2]) tokens.push({ type: "comment", text, start, end });
    else if (match[3]) {
      const digits = match[3].replace(/[,_]/g, "");
      const exponent = match[4]
        ? match[4].toLowerCase() === "k"
          ? "e3"
          : "e6"
        : "";
      tokens.push({
        type: "number",
        text,
        start,
        end,
        value: Number(digits + exponent),
        whole: !match[4] && !match[5] && !digits.includes("."),
        percent: !!match[5],
        suffix: !!match[4],
      });
    } else if (match[6]) {
      tokens.push({
        type: "word",
        text,
        start,
        end,
        word: match[6].toLowerCase(),
      });
    } else if (match[7]) {
      const symbol =
        match[7] === "≤" ? "<=" : match[7] === "≥" ? ">=" : match[7];
      tokens.push({ type: "symbol", text, start, end, symbol });
    } else tokens.push({ type: "bad", text, start, end });
  }
  return tokens;
}

export class FilterParseError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
  }
}

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

function suggest(word: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const known of VOCABULARY) {
    const distance = editDistance(word, known);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = known;
    }
  }
  return best !== undefined && bestDistance <= (word.length > 4 ? 2 : 1)
    ? best
    : undefined;
}

function badCharMessage(char: string, src: string, at: number): string {
  if (char === "-") return "Numbers can’t be negative";
  if (char === "%" && /\d\s+$/.test(src.slice(0, at))) {
    return "Write the % right after the number, like 10%";
  }
  if (char === "=") {
    return src[at + 1] === "="
      ? "There is no ==; use <, <=, > or >="
      : "There is no =; use <, <=, > or >=";
  }
  if (char === "&") return "Write “and” instead of &";
  if (char === "|") return "Write “or” instead of |";
  if (char === "!") return "Write “not ( … )” instead of !";
  if (char === "." && /\d/.test(src[at + 1] || "")) {
    return "Write a leading zero, like 0.5";
  }
  if (char === ",") return "Commas only go inside numbers, like 20,000";
  return `Unexpected character “${char}”`;
}

// ------------------------------------------------------------------ parser

type Span = [number, number];
export interface FilterSpans {
  whole?: Span;
  field?: Span;
  op?: Span;
  value?: Span;
  value2?: Span;
  maxSize?: Span;
  edges?: Span;
  count?: Span;
  hops?: Span;
  head?: Span;
  tgt?: Span;
  joins?: Span[];
}

interface Parsed {
  node: FilterNode;
  chain?: boolean;
  paren?: boolean;
  wrapped?: boolean;
  fromNot?: boolean;
  targeted?: boolean;
}

type NumberToken = Extract<Token, { type: "number" }>;
type WordToken = Extract<Token, { type: "word" }>;
type SymbolToken = Extract<Token, { type: "symbol" }>;
type Significant = NumberToken | WordToken | SymbolToken;

const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);

function parse(src: string): {
  root: GroupNode;
  spans: Map<FilterNode, FilterSpans>;
} {
  const all = lex(src);
  const bad = all.find((token) => token.type === "bad");
  if (bad) {
    throw new FilterParseError(
      badCharMessage(bad.text, src, bad.start),
      bad.start,
      bad.end,
    );
  }
  const tokens = all.filter(
    (token): token is Significant =>
      token.type !== "space" && token.type !== "comment",
  );
  let i = 0;
  let depth = 0;
  const endOfText = src.replace(/\s+$/, "").length;
  const peek = (ahead = 0): Significant | undefined => tokens[i + ahead];
  const show = (token: Significant | undefined) =>
    token ? `“${token.text}”` : "the end of the text";
  const fail = (
    message: string,
    at: Significant | null = peek() ?? null,
  ): never => {
    throw new FilterParseError(
      message,
      at ? at.start : endOfText,
      at ? at.end : endOfText,
    );
  };
  const failSpan = (
    message: string,
    from: Significant,
    to: Significant,
  ): never => {
    throw new FilterParseError(message, from.start, to.end);
  };
  // Not a type guard: a token that is not one of these words may still be a word.
  const isWord = (
    token: Significant | undefined,
    ...words: string[]
  ): boolean =>
    token !== undefined && token.type === "word" && words.includes(token.word);
  const isSymbol = (
    token: Significant | undefined,
    symbol: string,
  ): token is SymbolToken =>
    token !== undefined && token.type === "symbol" && token.symbol === symbol;
  const list = (words: string[]) =>
    words.length === 1
      ? `“${words[0]}”`
      : `${words
          .slice(0, -1)
          .map((word) => `“${word}”`)
          .join(", ")} or “${words[words.length - 1]}”`;
  const expectWord = (words: string[], shown?: string[]): WordToken => {
    const token = peek();
    if (!isWord(token, ...words)) {
      const hint = token?.type === "word" ? suggest(token.word) : undefined;
      const didYouMean =
        hint &&
        token?.type === "word" &&
        hint !== token.word &&
        words.includes(hint)
          ? ` (did you mean “${hint}”?)`
          : "";
      return fail(
        `Expected ${list(shown ?? words)} but found ${show(token)}${didYouMean}`,
      );
    }
    i++;
    return token as WordToken;
  };
  const expectClose = (open: Significant, what?: string): Significant => {
    const token = peek();
    if (isSymbol(token, ")")) {
      i++;
      return token;
    }
    if (!token) {
      fail(`This “(” is never closed${what ? ` (${what})` : ""}`, open);
    }
    const hint = token?.type === "word" ? suggest(token.word) : undefined;
    return fail(
      `Expected “)” to close ${what || "the group"} but found ${show(token)}. ${
        hint &&
        ["and", "or"].includes(hint) &&
        token?.type === "word" &&
        hint !== token.word
          ? `Did you mean “${hint}”?`
          : "Join conditions with “and” or “or”"
      }`,
    );
  };
  const deeper = (token: Significant) => {
    if (++depth > MAX_DEPTH) fail("This is nested too deeply", token);
  };
  const positions = new WeakMap<FilterNode, Significant>();
  const spans = new Map<FilterNode, FilterSpans>();
  const at = (token: Significant): Span => [token.start, token.end];
  const mark = <T extends FilterNode>(node: T, token: Significant): T => {
    positions.set(node, token);
    return node;
  };
  const addSpan = (node: FilterNode, extra: FilterSpans) =>
    spans.set(node, { ...spans.get(node), ...extra });
  const numberNeighborHint = (token: NumberToken) => {
    const next = tokens[tokens.indexOf(token) + 1];
    if (
      next?.type === "word" &&
      /^[km]$/i.test(next.word) &&
      next.start === token.end + 1
    ) {
      fail(
        `Write ${token.text}${next.text === "m" ? "M" : next.text} without a space`,
        next,
      );
    }
    // 1e5: the lexer splits it into 1, e, 5
    if (
      next?.type === "word" &&
      next.start === token.end &&
      /^e\d*$/i.test(next.word)
    ) {
      fail("Write the number out, like 20000 or 20k", next);
    }
    if (
      next?.type === "word" &&
      next.start === token.end &&
      next.word === "m"
    ) {
      fail("Use a capital M for million, like 1.5M", next);
    }
  };
  const wholeNumber = (what: string, max = MAX_COUNT): NumberToken => {
    const token = peek();
    if (token?.type !== "number") {
      return fail(`Expected ${what} (a whole number) but found ${show(token)}`);
    }
    if (token.suffix || token.percent) {
      fail(`${capitalize(what)} is a plain number, without k, M or %`, token);
    }
    if (!token.whole) fail(`${capitalize(what)} must be a whole number`, token);
    if (token.value > max) {
      fail(`${capitalize(what)} can be at most ${formatNumber(max)}`, token);
    }
    numberNeighborHint(token);
    i++;
    return token;
  };
  const skipVoxels = () => {
    if (isWord(peek(), "vx", "voxels")) i++;
  };
  // "<=", "≤" or the words "at most"
  const atMost = (what: string) => {
    if (isSymbol(peek(), "<=")) {
      i++;
      return;
    }
    if (isWord(peek(), "at") && isWord(peek(1), "most")) {
      i += 2;
      return;
    }
    if (isSymbol(peek(), "<")) {
      fail("Use “<=” here: the limit includes the value");
    }
    fail(`Expected “<=” or “at most” ${what}`);
  };
  const valueToken = (field: ConditionField): NumberToken => {
    const token = peek();
    if (token?.type !== "number") {
      return fail(`Expected a number for ${field} but found ${show(token)}`);
    }
    numberNeighborHint(token);
    if (field === "size") {
      if (token.percent) fail("Size is in voxels, so it takes no %", token);
      if (!Number.isInteger(token.value)) {
        fail("Size is a whole number of voxels", token);
      }
      if (token.value > MAX_SIZE) {
        fail(`Size can be at most ${formatNumber(MAX_SIZE)}`, token);
      }
    } else if (field === "score") {
      if (token.percent || token.suffix) {
        fail("score is a plain number between 0 and 1", token);
      }
      if (token.value > MAX_SCORE) fail("score is between 0 and 1", token);
    } else {
      if (token.suffix) {
        fail(
          `${field} is a percentage; write a plain number with %, like 30%`,
          token,
        );
      }
      if (!token.percent) {
        fail(
          `Write ${token.text}% — ${field} is a percentage, so it needs the % sign`,
          token,
        );
      }
      if (token.value > MAX_PERCENT) {
        fail(`${field} must be between 0% and 100%`, token);
      }
    }
    i++;
    return token;
  };

  function parseOr(): Parsed {
    const first = parseAnd();
    const items = [first];
    const joins: Span[] = [];
    while (isWord(peek(), "or")) {
      joins.push(at(peek()!));
      i++;
      items.push(parseAnd());
    }
    if (items.length === 1) return first;
    const node = group(
      "any",
      items.map((item) => item.node),
    );
    addSpan(node, { joins });
    return { node, chain: true };
  }

  function parseAnd(): Parsed {
    const first = parseUnary();
    const items = [first];
    const joins: Span[] = [];
    while (isWord(peek(), "and")) {
      joins.push(at(peek()!));
      i++;
      items.push(parseUnary());
    }
    if (items.length === 1) return first;
    const node = group(
      "all",
      items.map((item) => item.node),
    );
    addSpan(node, { joins });
    return { node, chain: true };
  }

  function parseUnary(): Parsed {
    const token = peek();
    if (token !== undefined && isWord(token, "not")) {
      i++;
      deeper(token);
      const inner = parseUnary();
      depth--;
      const node = inner.node;
      if (
        node.kind === "group" &&
        !node.target &&
        ((inner.paren && node.op === "any") ||
          (inner.wrapped && node.children.length === 1))
      ) {
        node.op = "none";
        mark(node, token);
        return { node, fromNot: true };
      }
      return { node: mark(group("none", [node]), token), fromNot: true };
    }
    return parsePrimary();
  }

  function applyTarget(inner: Parsed, target: WordToken, inside: string) {
    if (inner.node.target) {
      fail(
        `This is already inside ${inside}; a condition can have only one of seed / candidate / both`,
        positions.get(inner.node) ?? target,
      );
    }
    inner.node.target = target.word as Target;
    addSpan(inner.node, { tgt: at(target) });
    mark(inner.node, target);
    return { node: inner.node, targeted: true };
  }

  function parsePrimary(): Parsed {
    const token = peek();
    if (!token) return fail("Expected a condition but the text ends here");
    if (isSymbol(token, "(")) {
      i++;
      deeper(token);
      if (isSymbol(peek(), ")")) {
        fail("Empty brackets: put a condition inside ( … )");
      }
      const inner = parseOr();
      expectClose(token);
      depth--;
      if (inner.chain) return { node: mark(inner.node, token), paren: true };
      return { node: mark(group("all", [inner.node]), token), wrapped: true };
    }
    if (token.type === "word" && TARGET_WORDS.includes(token.word)) {
      i++;
      deeper(token);
      const open = peek();
      if (!isSymbol(open, "(")) {
        // prefix form: the target applies to exactly one condition
        if (!open || isWord(open, "and", "or")) {
          fail(
            `Expected a condition after ${token.word}, like ${token.word} size > 20k`,
          );
        }
        const inner = parseUnary();
        depth--;
        return applyTarget(inner, token, token.word);
      }
      i++;
      if (isSymbol(peek(), ")")) {
        fail(`Put a condition inside ${token.word}( … )`);
      }
      const inner = parseOr();
      expectClose(open, `${token.word}( … )`);
      depth--;
      return applyTarget(inner, token, `${token.word}( … )`);
    }
    if (isWord(token, "no", "at", "exactly")) return { node: parseNeighbors() };
    if (isWord(token, "cut")) return { node: parseCutOff() };
    if (isWord(token, "in") && isWord(peek(1), "a")) {
      return { node: parsePart() };
    }
    if (token.type === "word" && FIELDS.includes(token.word)) {
      return { node: parseCompare() };
    }
    if (isWord(token, "true")) {
      fail("“true” can only stand alone, as a filter with no conditions");
    }
    if (isSymbol(token, ")")) {
      const previous = tokens[i - 1];
      fail(
        previous?.type === "word" && ["and", "or"].includes(previous.word)
          ? `Expected a condition after “${previous.word}”`
          : "This “)” has no matching “(”",
      );
    }
    if (token.type === "word" && VOCABULARY.includes(token.word)) {
      if (token.word === "and" || token.word === "or") {
        fail(`“${token.word}” needs a condition on each side`);
      }
      if (token.word === "in") {
        fail("Write “in a part <= 40k attached by <= 2 edges”");
      }
      fail(
        `“${token.word}” can’t start a condition. A condition starts with a measure (size, axon, dendrite, perikaryon, nucleus), a neighbor count (no, at least, at most, exactly), “in a part”, or seed / candidate / both`,
      );
    }
    if (token.type === "word") {
      const hint = suggest(token.word);
      fail(
        hint
          ? `Unknown word ${show(token)}. Did you mean “${hint}”?`
          : `Unknown word ${show(token)}. A condition starts with a measure (size, axon, dendrite, perikaryon, nucleus), a neighbor count (no, at least, at most, exactly), “in a part”, or seed( / candidate( / both(`,
      );
    }
    return fail(`Expected a condition but found ${show(token)}`);
  }

  function parseCompare(): FilterNode {
    const fieldToken = peek() as WordToken;
    i++;
    const field = fieldToken.word as ConditionField;
    const example =
      field === "size"
        ? ["20k..60k", "20k to 60k", "20k and 60k"]
        : ["10%..30%", "10% to 30%", "10% and 30%"];
    const opToken = peek();
    if (
      opToken?.type === "word" &&
      ["in", "between", "from"].includes(opToken.word)
    ) {
      i++;
      const low = valueToken(field);
      if (field === "size" && opToken.word !== "in") skipVoxels();
      if (opToken.word === "in") {
        if (!isSymbol(peek(), "..")) {
          fail(
            `Expected “..” between the two ends, like ${field} in ${example[0]}`,
          );
        }
      } else if (opToken.word === "from") {
        if (!isWord(peek(), "to")) {
          fail(`Expected “to”, like ${field} from ${example[1]}`);
        }
      } else if (!isWord(peek(), "and")) {
        fail(`Expected “and”, like ${field} between ${example[2]}`);
      }
      i++;
      const high = valueToken(field);
      if (low.value > high.value) {
        failSpan(
          `The range ${valueText(field, low.value)} to ${valueText(field, high.value)} is backwards; write ${field} from ${valueText(field, high.value)} to ${valueText(field, low.value)}`,
          low,
          high,
        );
      }
      if (field === "size") skipVoxels();
      const node = mark(
        condition(field, "between", low.value, high.value),
        fieldToken,
      );
      addSpan(node, {
        whole: [fieldToken.start, tokens[i - 1].end],
        field: at(fieldToken),
        value: at(low),
        value2: at(high),
      });
      return node;
    }
    if (
      !(
        opToken?.type === "symbol" &&
        ["<", "<=", ">", ">="].includes(opToken.symbol)
      )
    ) {
      fail(
        `Expected <, <=, >, >= or “from … to” after ${field} but found ${show(opToken)}`,
      );
    }
    const op = (opToken as SymbolToken).symbol as Compare;
    i++;
    const valueTok = valueToken(field);
    if (field === "size") skipVoxels();
    const node = mark(condition(field, op, valueTok.value), fieldToken);
    addSpan(node, {
      whole: [fieldToken.start, tokens[i - 1].end],
      field: at(fieldToken),
      op: at(opToken as SymbolToken),
      value: at(valueTok),
    });
    return node;
  }

  function parseNeighbors(): FilterNode {
    const first = peek() as WordToken;
    let quant: NeighborsNode["quant"];
    let count = 1;
    let countToken: NumberToken | undefined;
    if (isWord(first, "no")) {
      i++;
      quant = "no";
    } else if (isWord(first, "exactly")) {
      i++;
      quant = "exactly";
      countToken = wholeNumber("a neighbor count");
      count = countToken.value;
    } else {
      i++;
      const which = expectWord(["least", "most"]);
      quant = which.word === "least" ? "at_least" : "at_most";
      countToken = wholeNumber("a neighbor count");
      count = countToken.value;
    }
    expectWord(
      ["neighbor", "neighbors", "neighbour", "neighbours"],
      ["neighbor", "neighbors"],
    );
    expectWord(["within"]);
    const hopsToken = wholeNumber("the number of hops", MAX_HOPS);
    if (hopsToken.value < 1) fail("Hops must be at least 1", hopsToken);
    expectWord(["hops", "hop"]);
    const withToken = expectWord(
      ["with", "is", "are", "has", "have"],
      ["with"],
    );
    const open = peek();
    if (!isSymbol(open, "(")) {
      return fail(
        "Expected “(” with the conditions each counted neighbor has, like with (size > 200k)",
      );
    }
    i++;
    deeper(open);
    if (isSymbol(peek(), ")")) {
      fail(
        "Write “( true )” for a neighbor condition with no conditions inside",
      );
    }
    const neighborSpans = {
      head: [first.start, withToken.end] as Span,
      hops: at(hopsToken),
      ...(countToken && { count: at(countToken) }),
    };
    if (isWord(peek(), "true") && isSymbol(peek(1), ")")) {
      i += 2;
      depth--;
      const node = mark(
        neighborsNode(quant, count, hopsToken.value, group("all", [])),
        first,
      );
      addSpan(node, neighborSpans);
      return node;
    }
    const inner = parseOr();
    expectClose(open, "the neighbor condition");
    depth--;
    let where: GroupNode;
    if (inner.chain) where = inner.node as GroupNode;
    else if (
      inner.fromNot &&
      inner.node.kind === "group" &&
      inner.node.op === "none" &&
      !inner.node.target
    ) {
      where = inner.node;
    } else where = group("all", [inner.node]);
    const node = mark(
      neighborsNode(quant, count, hopsToken.value, where),
      first,
    );
    addSpan(node, neighborSpans);
    return node;
  }

  function sizeLimit(): NumberToken {
    const token = peek();
    if (token?.type !== "number") {
      return fail(`Expected a size in voxels but found ${show(token)}`);
    }
    if (token.percent) fail("Size is in voxels, so it takes no %", token);
    if (!Number.isInteger(token.value)) {
      fail("Size is a whole number of voxels", token);
    }
    if (token.value > MAX_SIZE) {
      fail(`Size can be at most ${formatNumber(MAX_SIZE)}`, token);
    }
    numberNeighborHint(token);
    i++;
    skipVoxels();
    return token;
  }

  // in a part <= 40k attached by <= 2 edges
  function parsePart(): FilterNode {
    const first = peek() as WordToken;
    i++;
    expectWord(["a"]);
    expectWord(["part"]);
    atMost("after “in a part”, like in a part <= 40k");
    const sizeToken = sizeLimit();
    expectWord(["attached"]);
    expectWord(["by"]);
    atMost("after “attached by”, like attached by <= 2 edges");
    const edgesToken = wholeNumber("the number of edges");
    expectWord(["edges", "edge"]);
    const node = mark(bondNode(edgesToken.value, sizeToken.value), first);
    addSpan(node, {
      whole: [first.start, tokens[i - 1].end],
      maxSize: at(sizeToken),
      edges: at(edgesToken),
    });
    return node;
  }

  // older wording: cut off by <= 2 edges with size <= 40k
  function parseCutOff(): FilterNode {
    const first = peek() as WordToken;
    i++;
    expectWord(["off"]);
    expectWord(["by"]);
    atMost("after “cut off by”, like cut off by <= 2 edges");
    const edgesToken = wholeNumber("the number of edges");
    expectWord(["edges", "edge"]);
    expectWord(["with"]);
    expectWord(["size"]);
    atMost("after “with size”, like with size <= 40k");
    const sizeToken = sizeLimit();
    const node = mark(bondNode(edgesToken.value, sizeToken.value), first);
    addSpan(node, {
      whole: [first.start, tokens[i - 1].end],
      maxSize: at(sizeToken),
      edges: at(edgesToken),
    });
    return node;
  }

  let root: GroupNode;
  if (
    tokens.length === 0 ||
    (tokens.length === 1 && isWord(tokens[0], "true"))
  ) {
    root = group("all", []);
  } else {
    const parsed = parseOr();
    if (peek()) {
      if (isSymbol(peek(), ")")) fail("This “)” has no matching “(”");
      fail(`Unexpected ${show(peek())}. Join conditions with “and” or “or”`);
    }
    root = parsed.chain
      ? (parsed.node as GroupNode)
      : group("all", [parsed.node]);
  }
  checkTargets(root, positions);
  normalizeTargets(root);
  return { root, spans };
}

/**
 * Both is filled in only for plain "a and b" text naming no target at all:
 * under "or" or "not" it would not read the same, so the parser asks. Only a
 * named seed or candidate makes an unnamed part ambiguous.
 */
function checkTargets(
  root: GroupNode,
  positions: WeakMap<FilterNode, { start: number; end: number }>,
) {
  let named = false;
  walk(root, (node) => {
    if (node.target && node.target !== "both") named = true;
  });
  const topAnd = root.op === "all" && !named;
  const check = (
    node: FilterNode,
    eligible: boolean,
    inNeighbors: boolean,
    top: boolean,
  ) => {
    const token = positions.get(node);
    const span: [number, number] = token ? [token.start, token.end] : [0, 0];
    if (isScore(node) && node.target) {
      throw new FilterParseError(
        "score is about the whole match; it takes no seed / candidate / both",
        ...span,
      );
    }
    if (node.target && inNeighbors) {
      throw new FilterParseError(
        `${node.target}( … ) can’t be used inside a neighbor condition; that part is checked on each neighbor`,
        ...span,
      );
    }
    if (node.target && !eligible) {
      throw new FilterParseError(
        "This is already covered by an outer seed / candidate / both",
        ...span,
      );
    }
    if (
      eligible &&
      !inNeighbors &&
      isLeaf(node) &&
      !node.target &&
      !isScore(node)
    ) {
      if (top && topAnd) node.target = "both";
      else {
        throw new FilterParseError(
          "Say whose piece this is about: put both( … ) around the whole condition, or seed / candidate / both before each part",
          ...span,
        );
      }
    }
    if (node.kind === "group") {
      for (const child of node.children) {
        check(child, eligible && !node.target, inNeighbors, false);
      }
    }
    if (node.kind === "neighbors") {
      for (const child of node.where.children) check(child, false, true, false);
    }
  };
  for (const child of root.children) check(child, true, false, true);
}

export function parseFilterText(src: string): GroupNode {
  return parse(src).root;
}

/** The tree plus where each node's words sit in `src`. */
export function parseFilterTextWithSpans(src: string) {
  return parse(src);
}

// --------------------------------------------------------------- display

export type TokenClass =
  | "comment"
  | "number"
  | "paren"
  | "operator"
  | "keyword"
  | "target"
  | "field"
  | "neighbor"
  | "plain";

export interface HighlightRun {
  text: string;
  cls: TokenClass;
  error: boolean;
}

function tokenClass(token: Token): TokenClass {
  switch (token.type) {
    case "comment":
      return "comment";
    case "number":
      return "number";
    case "symbol":
      return token.symbol === "(" || token.symbol === ")"
        ? "paren"
        : "operator";
    case "word":
      if (LOGIC.includes(token.word)) return "keyword";
      if (TARGET_WORDS.includes(token.word)) return "target";
      if (FIELDS.includes(token.word)) return "field";
      if (NEIGHBOR_WORDS.includes(token.word)) return "neighbor";
      return "plain";
    default:
      return "plain";
  }
}

/** The text as coloured runs, the words an error points at marked. */
export function highlightTokens(
  src: string,
  error?: FilterParseError,
): HighlightRun[] {
  const hits = (token: Token) =>
    error !== undefined &&
    token.type !== "space" &&
    token.start < Math.max(error.end, error.start + 1) &&
    token.end > error.start;
  const tokens = lex(src);
  const runs = tokens.map((token) => ({
    text: token.text,
    cls: tokenClass(token),
    error: hits(token),
  }));
  if (
    error !== undefined &&
    error.start >= src.replace(/\s+$/, "").length &&
    !tokens.some(hits)
  ) {
    runs.push({ text: " ", cls: "plain", error: true });
  }
  return runs;
}

export function lineColumn(
  src: string,
  position: number,
): { line: number; column: number } {
  const before = src.slice(0, position);
  return {
    line: before.split("\n").length,
    column: position - before.lastIndexOf("\n"),
  };
}

// ------------------------------------------------------ the user's text

const canonicalKey = (node: FilterNode) =>
  JSON.stringify(strip(simplify(node)));

/**
 * Gives freshly parsed nodes the ids of the nodes in the same place, so what
 * the editor keeps by id (collapsed rows, marks against the saved version)
 * survives an edit made as text.
 */
export function reconcileIds(old: FilterNode, fresh: FilterNode) {
  if (old.kind !== fresh.kind) return;
  fresh.id = old.id;
  if (old.kind === "group" && fresh.kind === "group") {
    // ANY of one row means ALL; keep the user's ANY so a second row does what they set up.
    if (old.op === "any" && fresh.op === "all" && fresh.children.length <= 1) {
      fresh.op = "any";
    }
    matchChildren(old.children, fresh.children);
  }
  if (old.kind === "neighbors" && fresh.kind === "neighbors") {
    reconcileIds(old.where, fresh.where);
  }
}

function matchChildren(olds: FilterNode[], news: FilterNode[]) {
  const used = new Set<number>();
  const oldKeys = olds.map(canonicalKey);
  const unmatched: FilterNode[] = [];
  for (const child of news) {
    const key = canonicalKey(child);
    const index = oldKeys.findIndex((old, i) => !used.has(i) && old === key);
    if (index >= 0) {
      used.add(index);
      reconcileIds(olds[index], child);
    } else unmatched.push(child);
  }
  for (const child of unmatched) {
    const index = olds.findIndex(
      (old, i) => !used.has(i) && old.kind === child.kind,
    );
    if (index >= 0) {
      used.add(index);
      reconcileIds(olds[index], child);
    }
  }
}

function parsesTo(text: string, tree: GroupNode): boolean {
  try {
    return sameFilter(parseFilterText(text), tree);
  } catch {
    return false;
  }
}

/** The user's own text, while it still says what the tree says. */
export function noteFor(tree: GroupNode): string | undefined {
  return tree.note !== undefined && parsesTo(tree.note, tree)
    ? tree.note
    : undefined;
}

export type PatchField =
  | "target"
  | "op"
  | "field"
  | "quant"
  | "value"
  | "value2"
  | "maxSize"
  | "count"
  | "hops"
  | "edges";

const NUMBER_FIELDS: readonly PatchField[] = [
  "value",
  "value2",
  "maxSize",
  "count",
  "hops",
  "edges",
];
const REPRINTED_NUMBERS: readonly PatchField[] = ["count", "hops", "edges"];

function replaceSpans(text: string, parts: [Span, string][]): string {
  let out = text;
  for (const [[start, end], word] of [...parts].sort(
    (a, b) => b[0][0] - a[0][0],
  )) {
    out = out.slice(0, start) + word + out.slice(end);
  }
  return out;
}

/**
 * Writes one tree edit into the user's commented text instead of reprinting
 * it: the changed word or number only, so comments around it stay. Undefined
 * when the edit cannot be written that way; the text is then reprinted.
 */
export function patchNote(
  note: string,
  before: GroupNode,
  after: GroupNode,
  id: string,
  field: PatchField,
): string | undefined {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(note);
  } catch {
    return undefined;
  }
  reconcileIds(before, parsed.root);
  let spans: FilterSpans | undefined;
  parsed.spans.forEach((value, node) => {
    if (node.id === id) spans = value;
  });
  let node: FilterNode | undefined;
  const find = (candidate: FilterNode) => {
    if (candidate.id === id) node = candidate;
    childrenOf(candidate).forEach(find);
  };
  find(after);
  if (spans === undefined || node === undefined) return undefined;
  const accept = (text: string) => (parsesTo(text, after) ? text : undefined);

  // Seed / Candidate / Both: one word. ALL ↔ ANY: the words between the rows.
  if (field === "target" && spans.tgt && node.target) {
    return accept(replaceSpans(note, [[spans.tgt, node.target]]));
  }
  if (
    field === "op" &&
    node.kind === "group" &&
    spans.joins?.length &&
    (node.op === "all" || node.op === "any")
  ) {
    const word = joinWord(node.op);
    return accept(
      replaceSpans(
        note,
        spans.joins.map((span): [Span, string] => [span, word]),
      ),
    );
  }
  const wide = node.kind === "neighbors" ? spans.head : spans.whole;
  const wideText = () =>
    node!.kind === "neighbors"
      ? neighborsHead(node as NeighborsNode)
      : leafText(node!);
  const hasComment = (span: Span | undefined) =>
    span !== undefined && note.slice(span[0], span[1]).includes("#");
  const values = node as unknown as Record<string, number>;
  let range: Span | undefined;
  let replacement = "";
  let tokenOnly = false;
  if (REPRINTED_NUMBERS.includes(field) && wide && !hasComment(wide)) {
    // Reprinted whole so "1 hop" / "2 hops" stays grammatical.
    range = wide;
    replacement = wideText();
  } else if (
    NUMBER_FIELDS.includes(field) &&
    spans[field as keyof FilterSpans]
  ) {
    range = spans[field as keyof FilterSpans] as Span;
    tokenOnly = true;
    replacement =
      node.kind === "cond"
        ? valueText(node.field, values[field])
        : field === "maxSize"
          ? formatNumber(values[field])
          : String(values[field]);
  } else if (wide && node.kind !== "group") {
    range = wide;
    replacement = wideText();
  }
  // A measure with a comment inside: rewrite only its words, right to left.
  if (
    node.kind === "cond" &&
    !tokenOnly &&
    hasComment(spans.whole) &&
    spans.field &&
    spans.value &&
    !!spans.value2 === (node.op === "between")
  ) {
    const parts: [Span, string][] = [
      [spans.field, node.field],
      [spans.value, valueText(node.field, node.value)],
    ];
    if (spans.op) parts.push([spans.op, node.op]);
    if (spans.value2) {
      parts.push([
        spans.value2,
        valueText(node.field, node.value2 ?? node.value),
      ]);
    }
    return accept(replaceSpans(note, parts));
  }
  if (range === undefined) return undefined;
  if (!tokenOnly && hasComment(range)) return undefined;
  return accept(replaceSpans(note, [[range, replacement]]));
}
