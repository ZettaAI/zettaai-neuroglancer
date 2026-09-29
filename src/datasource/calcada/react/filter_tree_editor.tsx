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
 * @file The candidate filter as an outline: a group is a line down its left
 * edge, and the word between two of its rows is its operator — clicking it
 * flips the whole group, so one level never mixes AND and OR.
 */

import { Fragment } from "react";

import type {
  FilterCondition,
  FilterField,
  FilterGroup,
  FilterPath,
  PieceClass,
  TreeSide,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import {
  addChild,
  defaultCondition,
  emptyFilterTree,
  removeNode,
  replaceNode,
  toggleGroupOp,
} from "#src/datasource/calcada/candidate_filter_tree.js";
import { SEMANTIC_CLASSES } from "#src/datasource/calcada/candidate_heat.js";
import { FilterNumberInput } from "#src/datasource/calcada/react/filter_number_input.js";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PERCENT = 100;
const SIDE_LABELS: Record<TreeSide, string> = {
  seed: "Seed",
  candidate: "Candidate",
};
const CLASSES = SEMANTIC_CLASSES.filter(
  (name): name is PieceClass => name !== "any",
);

function fieldKey(field: FilterField): string {
  if (field.measure === "score") return "score";
  if (field.measure === "voxels") return `${field.side}:voxels`;
  return `${field.side}:share:${field.class}`;
}

function parseFieldKey(key: string): FilterField {
  if (key === "score") return { measure: "score" };
  const [side, measure, cls] = key.split(":") as [TreeSide, string, PieceClass];
  return measure === "voxels"
    ? { side, measure: "voxels" }
    : { side, measure: "share", class: cls };
}

const FIELD_OPTIONS: ReadonlyArray<[string, string]> = [
  ["score", "Score"],
  ...(["seed", "candidate"] as const).flatMap(
    (side): Array<[string, string]> => [
      [`${side}:voxels`, `${SIDE_LABELS[side]} · size`],
      ...CLASSES.map((cls): [string, string] => [
        `${side}:share:${cls}`,
        `${SIDE_LABELS[side]} · ${cls} %`,
      ]),
    ],
  ),
];

const CMP_LABELS: Record<FilterCondition["cmp"], string> = {
  ">=": "≥",
  "<=": "≤",
};

// The trigger shows the label, not the stored key.
function fieldLabel(field: FilterField): string {
  const key = fieldKey(field);
  return FIELD_OPTIONS.find(([option]) => option === key)?.[1] ?? key;
}

// Condition values are stored as the tree evaluates them; share is a fraction
// there and a percentage on screen.
function shownValue(condition: FilterCondition): number {
  return condition.field.measure === "share"
    ? Math.round(condition.value * PERCENT)
    : condition.value;
}

function storedValue(field: FilterField, shown: number): number {
  if (field.measure === "share")
    return Math.max(0, Math.min(PERCENT, shown)) / PERCENT;
  if (field.measure === "score") return Math.max(0, Math.min(1, shown));
  return Math.max(0, Math.round(shown));
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: FilterCondition;
  onChange: (condition: FilterCondition) => void;
  onRemove: () => void;
}) {
  const { field } = condition;
  return (
    <div className="calcada-filter-condition">
      <Select
        value={fieldKey(field)}
        onValueChange={(key) =>
          onChange({
            ...condition,
            field: parseFieldKey(key as string),
            value: 0,
          })
        }
      >
        <SelectTrigger
          size="sm"
          className="calcada-filter-field"
          title={fieldLabel(field)}
        >
          <SelectValue>{fieldLabel(field)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {FIELD_OPTIONS.map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={condition.cmp}
        onValueChange={(cmp) =>
          onChange({ ...condition, cmp: cmp as FilterCondition["cmp"] })
        }
      >
        <SelectTrigger size="sm" className="calcada-filter-cmp">
          <SelectValue>{CMP_LABELS[condition.cmp]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value=">=">{CMP_LABELS[">="]}</SelectItem>
          <SelectItem value="<=">{CMP_LABELS["<="]}</SelectItem>
        </SelectContent>
      </Select>
      <FilterNumberInput
        className="calcada-filter-value"
        min={0}
        step={
          field.measure === "score" ? 0.05 : field.measure === "share" ? 5 : 100
        }
        value={shownValue(condition)}
        onValueChange={(shown) =>
          onChange({ ...condition, value: storedValue(field, shown) })
        }
      />
      <button
        type="button"
        className="calcada-filter-remove"
        title="Remove condition"
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}

function GroupBody({
  group,
  path,
  root,
  onChange,
}: {
  group: FilterGroup;
  path: FilterPath;
  root: FilterGroup;
  onChange: (tree: FilterGroup) => void;
}) {
  const word = group.op === "and" ? "AND" : "OR";
  return (
    <>
      {group.children.map((child, index) => {
        const childPath = [...path, index];
        return (
          <Fragment key={index}>
            {index > 0 && (
              <button
                type="button"
                className="calcada-filter-op"
                title="Switch this group between AND and OR"
                onClick={() => onChange(toggleGroupOp(root, path))}
              >
                {word}
              </button>
            )}
            {child.kind === "condition" ? (
              <ConditionRow
                condition={child}
                onChange={(next) =>
                  onChange(replaceNode(root, childPath, next))
                }
                onRemove={() => onChange(removeNode(root, childPath))}
              />
            ) : (
              <div className="calcada-filter-group">
                <button
                  type="button"
                  className="calcada-filter-remove calcada-filter-group-remove"
                  title="Remove this group and everything in it"
                  onClick={() => onChange(removeNode(root, childPath))}
                >
                  ✕
                </button>
                <GroupBody
                  group={child}
                  path={childPath}
                  root={root}
                  onChange={onChange}
                />
              </div>
            )}
          </Fragment>
        );
      })}
      <div className="calcada-filter-add">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => onChange(addChild(root, path, defaultCondition()))}
        >
          + condition
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            onChange(
              addChild(root, path, {
                ...emptyFilterTree(),
                children: [defaultCondition()],
              }),
            )
          }
        >
          + group
        </Button>
      </div>
    </>
  );
}

export function FilterTreeEditor({
  tree,
  onChange,
}: {
  tree: FilterGroup;
  onChange: (tree: FilterGroup) => void;
}) {
  return (
    <div className="calcada-filter-tree">
      <GroupBody group={tree} path={[]} root={tree} onChange={onChange} />
    </div>
  );
}
