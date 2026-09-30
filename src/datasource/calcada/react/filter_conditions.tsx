/** @jsxImportSource react */
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
 * @file The filter as a tree of rows, as Sergiy's prototype lays it out:
 * whose piece each row is about, its measure and numbers, groups that can be
 * collapsed, rows that can be added, duplicated, removed, dragged and moved
 * with Alt+arrows.
 */

import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import type { PatchField } from "#src/datasource/calcada/candidate_filter_text.js";
import {
  describeFilterNode,
  formatNumber,
  isPercent,
  patchNote,
} from "#src/datasource/calcada/candidate_filter_text.js";
import type {
  ConditionField,
  FilterNode,
  GroupNode,
  NeighborsNode,
  Target,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import type { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import type {
  AddKind,
  NumberField,
} from "#src/datasource/calcada/filter_tree_edits.js";
import {
  ADD_KINDS,
  addRow,
  checkNumber,
  dropRow,
  duplicateRow,
  findNode,
  isNeighborBody,
  moveRow,
  removeRow,
  setChoice,
  setNumber,
  setTarget,
} from "#src/datasource/calcada/filter_tree_edits.js";
import { useMenuDismissal } from "#src/datasource/calcada/react/use_menu_dismissal.js";

type Options = ReadonlyArray<[string, string]>;

const EACH_ROW = "each";
const TARGET_OPTIONS: Options = [
  ["both", "Both"],
  ["seed", "Seed"],
  ["candidate", "Candidate"],
];
const GROUP_TARGET_OPTIONS: Options = [
  ...TARGET_OPTIONS,
  [EACH_ROW, "Each row picks"],
];
// The hand-off doc's five measures first; the rest are this deployment's.
const FIELD_OPTIONS: Options = [
  ["size", "Size"],
  ["axon", "Axon"],
  ["dendrite", "Dendrite"],
  ["perikaryon", "Perikaryon"],
  ["nucleus", "Nucleus"],
  ["glia", "Glia"],
  ["vasculature", "Vasculature"],
  ["ecs", "ECS"],
  ["other", "Other"],
  ["score", "Score"],
];
const COMPARE_OPTIONS: Options = [
  ["<", "<"],
  ["<=", "≤"],
  [">", ">"],
  [">=", "≥"],
  ["between", "from … to"],
];
const GROUP_OPTIONS: Options = [
  ["all", "ALL of"],
  ["any", "ANY of"],
  ["none", "NONE of"],
];
const BODY_OPTIONS: Options = [
  ["all", "ALL"],
  ["any", "ANY"],
  ["none", "NONE"],
];
const ROOT_OPTIONS: Options = [
  ["all", "ALL"],
  ["any", "ANY"],
];
const QUANT_OPTIONS: Options = [
  ["no", "no"],
  ["at_least", "at least"],
  ["at_most", "at most"],
  ["exactly", "exactly"],
];
const OPTION_NAMES: Record<string, string> = {
  all: "ALL",
  any: "ANY",
  none: "NONE",
  between: "from … to",
  at_least: "at least",
  at_most: "at most",
  "<=": "≤",
  ">=": "≥",
  [EACH_ROW]: "each row picks",
};
const NUMBER_NAMES: Partial<Record<NumberField, string>> = {
  count: "neighbor count",
  hops: "hops",
  edges: "bond edges",
  maxSize: "bond part size",
};
const HINT_PREFIXES: Partial<Record<NumberField, string>> = {
  value2: "To: ",
  count: "Count: ",
  hops: "Hops: ",
  edges: "Edges: ",
  maxSize: "Part size: ",
};
const ADD_LABELS: Record<AddKind, string> = {
  cond: "adding a measure",
  group: "adding a group",
  neighbors: "adding a neighbor condition",
  bond: "adding a bond",
};
const ROW_DRAG_TYPE = "application/x-filter-row";

const optionName = (value: string) => OPTION_NAMES[value] ?? value;

const unitOf = (field: ConditionField) =>
  isPercent(field) ? "%" : field === "size" ? "vx" : "";
const plural = (word: string, count: number) =>
  count === 1 ? word : `${word}s`;

interface TreeContext {
  root: GroupNode;
  saved: Map<string, FilterNode>;
  edit: (
    label: string,
    change: (root: GroupNode) => void,
    patch?: { id: string; field: PatchField },
  ) => void;
  library: FilterLibrary;
  collapsed: ReadonlySet<string>;
  toggle: (id: string) => void;
  addOpen: string | undefined;
  setAddOpen: (id: string | undefined) => void;
  freshRow: string | undefined;
  dragging: { current: string | undefined };
  flash: (message: string) => void;
}

const Tree = createContext<TreeContext | undefined>(undefined);
const useTree = () => useContext(Tree)!;

function changedClass(ctx: TreeContext, node: FilterNode, field: string) {
  const saved = ctx.saved.get(node.id ?? "") as
    | Record<string, unknown>
    | undefined;
  if (saved === undefined || saved.kind !== node.kind) return "";
  if (ctx.library.badValue(`${node.id}|${field}`)) return "";
  const now = (node as unknown as Record<string, unknown>)[field];
  return (saved[field] ?? "") === (now ?? "") ? "" : " changed";
}

function Choice({
  value,
  options,
  onChange,
  className,
  label,
  title,
}: {
  value: string;
  options: Options;
  onChange: (value: string) => void;
  className: string;
  label: string;
  title?: string;
}) {
  const shown = options.find(([key]) => key === value)?.[1] ?? value;
  return (
    <select
      className={`calcada-filter-choice ${className}`}
      aria-label={label}
      title={title ?? shown}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map(([key, text]) => (
        <option key={key} value={key}>
          {text}
        </option>
      ))}
    </select>
  );
}

function NumberBox({
  node,
  field,
  label,
  short = false,
}: {
  node: FilterNode;
  field: NumberField;
  label: string;
  short?: boolean;
}) {
  const ctx = useTree();
  const key = `${node.id}|${field}`;
  const bad = ctx.library.badValue(key);
  const value = (node as unknown as Record<string, number>)[field];
  const shown = bad ? bad.raw : formatNumber(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text === shown) return;
    const checked = checkNumber(node, field, text);
    if ("message" in checked) {
      ctx.library.setBadValue(key, { raw: text, message: checked.message });
      return;
    }
    ctx.library.setBadValue(key, undefined);
    if (checked.value === value) {
      setText(formatNumber(value));
      return;
    }
    const name =
      node.kind === "cond"
        ? `${node.field}${node.op === "between" ? (field === "value" ? " (from)" : " (to)") : ""}`
        : (NUMBER_NAMES[field] ?? field);
    ctx.edit(
      `${name} ${formatNumber(value)} → ${formatNumber(checked.value)}`,
      (root) => setNumber(root, node.id!, field, checked.value),
      { id: node.id!, field },
    );
  };
  return (
    <input
      className={`calcada-filter-number${short ? " short" : ""}${bad ? " bad" : ""}${changedClass(ctx, node, field)}`}
      aria-label={label}
      aria-invalid={bad ? true : undefined}
      inputMode="decimal"
      autoComplete="off"
      value={text}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

function Hints({ node }: { node: FilterNode }) {
  const ctx = useTree();
  const hints = ctx.library.badValuesOf(node.id!);
  return (
    <>
      {hints.map(([key, bad]) => {
        const field = key as NumberField;
        const prefix =
          field === "value" && node.kind === "cond" && node.op === "between"
            ? "From: "
            : (HINT_PREFIXES[field] ?? "");
        return (
          <div key={key} className="calcada-filter-hint">
            {prefix}
            {bad.message}
          </div>
        );
      })}
    </>
  );
}

function TargetChoice({ node }: { node: FilterNode }) {
  const ctx = useTree();
  const isGroup = node.kind === "group";
  return (
    <Choice
      className={`calcada-filter-target${node.target ? "" : " each"}${changedClass(ctx, node, "target")}`}
      label="Whose piece"
      title={
        node.target
          ? "Whose piece this is about: the seed, the candidate, or each of them separately"
          : "Each row inside picks Seed, Candidate or Both"
      }
      value={node.target ?? EACH_ROW}
      options={isGroup ? GROUP_TARGET_OPTIONS : TARGET_OPTIONS}
      onChange={(value) => {
        const target = value === EACH_ROW ? undefined : (value as Target);
        let replaced = false;
        ctx.edit(
          `whose piece ${optionName(node.target ?? EACH_ROW)} → ${optionName(value)}`,
          (root) => {
            replaced = setTarget(root, node.id!, target).replaced;
          },
          { id: node.id!, field: "target" },
        );
        if (replaced && target !== undefined) {
          const name = TARGET_OPTIONS.find(([key]) => key === target)![1];
          ctx.flash(
            `Every row in this group now uses ${name}; their own choices were replaced (Undo brings them back)`,
          );
        }
      }}
    />
  );
}

function AddMenu({ group }: { group: GroupNode }) {
  const ctx = useTree();
  const open = group.id !== undefined && ctx.addOpen === group.id;
  const anchor = useRef<HTMLSpanElement>(null);
  const { setAddOpen } = ctx;
  const close = useCallback(() => setAddOpen(undefined), [setAddOpen]);
  useMenuDismissal(open, anchor, close);
  return (
    <span ref={anchor} className="calcada-filter-menu-anchor">
      <button
        type="button"
        className="calcada-filter-link"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add a row to this group"
        onClick={() => ctx.setAddOpen(open ? undefined : group.id)}
      >
        + Add
      </button>
      {open && (
        <div className="calcada-filter-menu" role="menu">
          {ADD_KINDS.map(([kind, text]) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => {
                ctx.setAddOpen(undefined);
                ctx.edit(ADD_LABELS[kind], (root) => {
                  addRow(root, group.id!, kind);
                });
              }}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function groupNote(group: GroupNode, eligible: boolean): string {
  if (group.op === "any" && group.children.length <= 1) {
    return "same as ALL until there are two rows";
  }
  if (group.target === "both") {
    if (group.op === "any") {
      return "seed and candidate are checked separately; each may pass a different option";
    }
    if (group.op === "none") {
      return "neither seed nor candidate may pass any row";
    }
    return "";
  }
  if (eligible && !group.target) {
    return "each row below picks Seed, Candidate or Both";
  }
  return "";
}

function Row({
  node,
  lead,
  children,
}: {
  node: FilterNode;
  lead: ReactNode;
  children: ReactNode;
}) {
  const ctx = useTree();
  const rowRef = useRef<HTMLDivElement>(null);
  const isNew = ctx.saved.size > 0 && !ctx.saved.has(node.id ?? "");
  useEffect(() => {
    if (ctx.freshRow !== node.id) return;
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
    rowRef.current
      ?.querySelector<HTMLElement>(
        ".calcada-filter-row-controls button, .calcada-filter-row-controls input",
      )
      ?.focus({ preventScroll: true });
  }, [ctx.freshRow, node.id]);
  const move = (direction: -1 | 1) => {
    const parent = findNode(ctx.root, node.id!)?.parent;
    const siblings = parent?.kind === "group" ? parent.children : [node];
    const index = siblings.indexOf(node);
    if (direction < 0 && index <= 0) {
      return ctx.flash("Already the first row in this group");
    }
    if (direction > 0 && index >= siblings.length - 1) {
      return ctx.flash("Already the last row in this group");
    }
    ctx.edit("moving a row", (root) => {
      moveRow(root, node.id!, direction);
    });
  };
  const onHandleKey = (event: KeyboardEvent) => {
    if (!event.altKey) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      move(event.key === "ArrowUp" ? -1 : 1);
    }
  };
  return (
    <div
      ref={rowRef}
      className={`calcada-filter-row${ctx.freshRow === node.id ? " fresh" : ""}${isNew ? " new" : ""}`}
      data-row={node.id}
      title={isNew ? "Not in the saved version" : undefined}
    >
      <button
        type="button"
        className="calcada-filter-handle"
        draggable
        aria-label="Move row: drag, or press Alt+Up / Alt+Down"
        title="Drag to move, or Alt+↑ / Alt+↓"
        onKeyDown={onHandleKey}
        onDragStart={(event: DragEvent) => {
          ctx.dragging.current = node.id;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(ROW_DRAG_TYPE, node.id!);
        }}
        onDragEnd={() => {
          ctx.dragging.current = undefined;
        }}
      >
        ⠿
      </button>
      {lead}
      <div className="calcada-filter-row-controls">{children}</div>
      <span className="calcada-filter-row-tail">
        <button
          type="button"
          className="calcada-filter-icon"
          aria-label="Duplicate"
          title="Duplicate"
          onClick={() =>
            ctx.edit("duplicating a row", (root) =>
              duplicateRow(root, node.id!),
            )
          }
        >
          ⧉
        </button>
        <button
          type="button"
          className="calcada-filter-icon"
          aria-label="Remove"
          title="Remove"
          onClick={() =>
            ctx.edit("removing a row", (root) => removeRow(root, node.id!))
          }
        >
          ×
        </button>
      </span>
    </div>
  );
}

function Toggle({ node, what }: { node: FilterNode; what: string }) {
  const ctx = useTree();
  const collapsed = ctx.collapsed.has(node.id!);
  return (
    <button
      type="button"
      className="calcada-filter-icon calcada-filter-toggle"
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${what}`}
      onClick={() => ctx.toggle(node.id!)}
    >
      {collapsed ? "▸" : "▾"}
    </button>
  );
}

const Spacer = () => <span className="calcada-filter-toggle-space" />;

function DropZone({ group }: { group: GroupNode }) {
  const ctx = useTree();
  const [over, setOver] = useState(false);
  return (
    <div
      className={`calcada-filter-dropzone${over ? " over" : ""}`}
      aria-hidden="true"
      onDragOver={(event) => {
        if (ctx.dragging.current === undefined) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        dropHere(ctx, event, group.id!, undefined);
      }}
    />
  );
}

function dropHere(
  ctx: TreeContext,
  event: DragEvent,
  intoId: string,
  beforeId: string | undefined,
) {
  const dragged = ctx.dragging.current;
  if (dragged === undefined) return;
  event.preventDefault();
  ctx.dragging.current = undefined;
  const into = findNode(ctx.root, intoId)?.node;
  const from = findNode(ctx.root, dragged)?.parent;
  ctx.edit("moving a row", (root) => {
    dropRow(root, dragged, intoId, beforeId);
  });
  if (
    into !== undefined &&
    isNeighborBody(ctx.root, into) &&
    (from === undefined || !isNeighborBody(ctx.root, from))
  ) {
    ctx.flash(
      "Moved into the neighbor condition: it now applies to each neighbor",
    );
  }
}

function RowList({
  group,
  eligible,
  inNeighbors,
}: {
  group: GroupNode;
  eligible: boolean;
  inNeighbors: boolean;
}) {
  const ctx = useTree();
  return (
    <>
      {group.children.map((child) => (
        <div
          key={child.id}
          onDragOver={(event) => {
            if (ctx.dragging.current === undefined) return;
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.stopPropagation();
            dropHere(ctx, event, group.id!, child.id);
          }}
        >
          <Node node={child} eligible={eligible} inNeighbors={inNeighbors} />
        </div>
      ))}
      <DropZone group={group} />
    </>
  );
}

function Node({
  node,
  eligible,
  inNeighbors,
}: {
  node: FilterNode;
  eligible: boolean;
  inNeighbors: boolean;
}) {
  const ctx = useTree();
  // Score is about the whole match, never one piece of it.
  const isScore = node.kind === "cond" && node.field === "score";
  const target =
    eligible && !isScore ? (
      <TargetChoice node={node} />
    ) : inNeighbors ? (
      <span
        className="calcada-filter-neighbor-label"
        title="This row is checked on each neighbor"
      >
        neighbor
      </span>
    ) : null;
  const collapsed = ctx.collapsed.has(node.id!);
  const choose = (
    choice: "field" | "op" | "quant",
    value: string,
    label: string,
    old: string,
  ) =>
    ctx.edit(
      `${label} ${optionName(old)} → ${optionName(value)}`,
      (root) => setChoice(root, node.id!, choice, value),
      { id: node.id!, field: choice },
    );

  switch (node.kind) {
    case "group": {
      const note = collapsed ? "" : groupNote(node, eligible);
      return (
        <>
          <Row node={node} lead={<Toggle node={node} what="group" />}>
            {target}
            <Choice
              className={`calcada-filter-op${changedClass(ctx, node, "op")}`}
              label="Group type"
              value={node.op}
              options={GROUP_OPTIONS}
              onChange={(value) => choose("op", value, "group type", node.op)}
            />
            {collapsed ? (
              <span className="calcada-filter-muted">
                {node.children.length} {plural("row", node.children.length)}
              </span>
            ) : (
              <AddMenu group={node} />
            )}
            {note && <span className="calcada-filter-group-note">{note}</span>}
          </Row>
          {collapsed ? (
            <div className="calcada-filter-summary">
              {describeFilterNode(node)}
            </div>
          ) : (
            <div
              className={`calcada-filter-group${node.target ? " targeted" : ""}`}
            >
              <RowList
                group={node}
                eligible={eligible && !node.target}
                inNeighbors={inNeighbors}
              />
            </div>
          )}
        </>
      );
    }
    case "cond": {
      const between = node.op === "between";
      const unit = unitOf(node.field);
      return (
        <>
          <Row node={node} lead={<Spacer />}>
            {target}
            <Choice
              className={`calcada-filter-field${changedClass(ctx, node, "field")}`}
              label="Measure"
              title={
                node.field === "size"
                  ? "Size of this piece in voxels"
                  : node.field === "score"
                    ? "The match's score"
                    : `Share of this piece classified as ${node.field}`
              }
              value={node.field}
              options={FIELD_OPTIONS}
              onChange={(value) =>
                choose("field", value, "measure", node.field)
              }
            />
            <Choice
              className={`calcada-filter-compare${changedClass(ctx, node, "op")}`}
              label="Comparison"
              title={between ? "from … to includes both ends" : undefined}
              value={node.op}
              options={COMPARE_OPTIONS}
              onChange={(value) => choose("op", value, "operator", node.op)}
            />
            <span className="calcada-filter-inline">
              <NumberBox
                node={node}
                field="value"
                label={between ? "From" : "Value"}
              />
              {!between && unit && (
                <span className="calcada-filter-unit">{unit}</span>
              )}
            </span>
            {between && (
              <span className="calcada-filter-inline">
                <span className="calcada-filter-muted">to</span>
                <NumberBox node={node} field="value2" label="To" />
                {unit && <span className="calcada-filter-unit">{unit}</span>}
              </span>
            )}
          </Row>
          <Hints node={node} />
        </>
      );
    }
    case "neighbors":
      return <NeighborsRow node={node} target={target} collapsed={collapsed} />;
    case "bond":
      return (
        <>
          <Row node={node} lead={<Spacer />}>
            {target}
            <span className="calcada-filter-inline">
              <span
                className="calcada-filter-muted"
                title="The piece lies in a small part (e.g. a spine) that hangs off the rest by only a few edges"
              >
                in a part ≤
              </span>
              <NumberBox
                node={node}
                field="maxSize"
                label="Largest part size"
              />
              <span className="calcada-filter-unit">vx</span>
            </span>
            <span className="calcada-filter-inline">
              <span className="calcada-filter-muted">attached by ≤</span>
              <NumberBox node={node} field="edges" label="Most edges" short />
              <span className="calcada-filter-muted">
                {plural("edge", node.edges)}
              </span>
            </span>
          </Row>
          <Hints node={node} />
        </>
      );
  }
}

function NeighborsRow({
  node,
  target,
  collapsed,
}: {
  node: NeighborsNode;
  target: ReactNode;
  collapsed: boolean;
}) {
  const ctx = useTree();
  const one = node.quant !== "no" && node.count === 1;
  return (
    <>
      <Row node={node} lead={<Toggle node={node} what="neighbor condition" />}>
        {target}
        <span className="calcada-filter-inline">
          <Choice
            className={`calcada-filter-quant${changedClass(ctx, node, "quant")}`}
            label="How many neighbors"
            value={node.quant}
            options={QUANT_OPTIONS}
            onChange={(value) =>
              ctx.edit(
                `neighbor count ${optionName(node.quant)} → ${optionName(value)}`,
                (root) => setChoice(root, node.id!, "quant", value),
                { id: node.id!, field: "quant" },
              )
            }
          />
          {node.quant !== "no" && (
            <NumberBox node={node} field="count" label="Neighbor count" short />
          )}
          <span
            className="calcada-filter-muted"
            title="Pieces adjacent to this piece in the piece graph"
          >
            {one ? "neighbor" : "neighbors"}
          </span>
        </span>
        <span className="calcada-filter-inline">
          <span className="calcada-filter-muted">within</span>
          <NumberBox node={node} field="hops" label="Hops" short />
          <span className="calcada-filter-muted">
            {plural("hop", node.hops)}
          </span>
        </span>
        <span className="calcada-filter-inline">
          <span className="calcada-filter-muted">with</span>
          <Choice
            className={`calcada-filter-op${changedClass(ctx, node.where, "op")}`}
            label="How the rows below combine"
            value={node.where.op}
            options={BODY_OPTIONS}
            onChange={(value) =>
              ctx.edit(
                `group type ${optionName(node.where.op)} → ${optionName(value)}`,
                (root) => setChoice(root, node.where.id!, "op", value),
                { id: node.where.id!, field: "op" },
              )
            }
          />
          <span className="calcada-filter-muted">of:</span>
        </span>
        {!collapsed && <AddMenu group={node.where} />}
      </Row>
      <Hints node={node} />
      {collapsed ? (
        <div className="calcada-filter-summary">
          with {describeFilterNode(node.where)}
        </div>
      ) : (
        <div className="calcada-filter-group neighbors">
          {node.where.children.length === 0 && (
            <div className="calcada-filter-muted">
              No conditions here, so every neighbor counts.
            </div>
          )}
          <RowList group={node.where} eligible={false} inNeighbors />
        </div>
      )}
    </>
  );
}

function indexById(root: GroupNode | undefined): Map<string, FilterNode> {
  const index = new Map<string, FilterNode>();
  const visit = (node: FilterNode) => {
    if (node.id) index.set(node.id, node);
    if (node.kind === "group") node.children.forEach(visit);
    if (node.kind === "neighbors") visit(node.where);
  };
  if (root) visit(root);
  return index;
}

function collapsibleIds(root: GroupNode): string[] {
  const ids: string[] = [];
  const visit = (node: FilterNode) => {
    if ((node.kind === "group" && node !== root) || node.kind === "neighbors") {
      ids.push(node.id!);
    }
    if (node.kind === "group") node.children.forEach(visit);
    if (node.kind === "neighbors") node.where.children.forEach(visit);
  };
  visit(root);
  return ids;
}

export function FilterConditions({
  library,
  flash,
}: {
  library: FilterLibrary;
  flash: (message: string) => void;
}) {
  const name = library.current;
  const root = name === undefined ? undefined : library.tree(name);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [addOpen, setAddOpen] = useState<string>();
  const [freshRow, setFreshRow] = useState<string>();
  const [open, setOpen] = useState(true);
  const dragging = useRef<string | undefined>(undefined);

  if (root === undefined) {
    return (
      <div className="calcada-filter-muted">
        {library.names.length
          ? "Pick a filter above."
          : "No filters yet. Click “+ New” to create one."}
      </div>
    );
  }

  const edit: TreeContext["edit"] = (label, change, patch) => {
    const before = indexById(root);
    const { noteDropped } = library.edit((copy) => {
      const unchanged = structuredClone(copy);
      change(copy);
      if (copy.note !== undefined && patch !== undefined) {
        const patched = patchNote(
          copy.note,
          unchanged,
          copy,
          patch.id,
          patch.field,
        );
        if (patched !== undefined) copy.note = patched;
      }
      return copy;
    }, label);
    if (noteDropped) {
      flash(
        "Your comments were taken out of the text because this change reprints it. Undo brings them back.",
      );
    }
    const after = library.tree(name!);
    const added = [...indexById(after).keys()].find((id) => !before.has(id));
    setFreshRow(added);
  };

  const ctx: TreeContext = {
    root,
    saved: indexById(library.saved(name!)),
    edit,
    library,
    collapsed,
    toggle: (id) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    addOpen,
    setAddOpen,
    freshRow,
    dragging,
    flash,
  };

  const rows = root.children.length;
  return (
    <Tree.Provider value={ctx}>
      <div className="calcada-filter-section">
        <div className="calcada-filter-section-head">
          <button
            type="button"
            className="calcada-filter-icon calcada-filter-toggle"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} conditions`}
            onClick={() => setOpen(!open)}
          >
            {open ? "▾" : "▸"}
          </button>
          <span className="calcada-filter-section-title">Conditions</span>
          <span className="calcada-filter-push" />
          <button
            type="button"
            className="calcada-filter-link"
            disabled={!open}
            onClick={() => setCollapsed(new Set(collapsibleIds(root)))}
          >
            Collapse all
          </button>
          <button
            type="button"
            className="calcada-filter-link"
            disabled={!open}
            onClick={() => setCollapsed(new Set())}
          >
            Expand all
          </button>
        </div>
        {open && (
          <>
            {library.textError !== undefined && (
              <div className="calcada-filter-stale">
                The text below has an error, so these conditions show the last
                version that parsed. Changing a condition here will replace the
                text.
              </div>
            )}
            <div className="calcada-filter-root">
              {rows === 0 ? (
                <span>No conditions yet, so every match passes.</span>
              ) : rows === 1 ? (
                <span>A match passes when:</span>
              ) : (
                <>
                  <span>A match passes when</span>
                  <Choice
                    className="calcada-filter-op"
                    label="How the top rows combine"
                    value={root.op}
                    options={ROOT_OPTIONS}
                    onChange={(value) =>
                      edit(
                        `group type ${optionName(root.op)} → ${optionName(value)}`,
                        (copy) => setChoice(copy, root.id!, "op", value),
                        { id: root.id!, field: "op" },
                      )
                    }
                  />
                  <span>of these hold:</span>
                </>
              )}
              <AddMenu group={root} />
            </div>
            <div className="calcada-filter-group top">
              <RowList group={root} eligible inNeighbors={false} />
            </div>
          </>
        )}
      </div>
    </Tree.Provider>
  );
}
