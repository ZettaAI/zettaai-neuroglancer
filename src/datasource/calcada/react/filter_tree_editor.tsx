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
  ConditionSide,
  PieceClass,
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
const SIDE_LABELS: Record<ConditionSide, string> = {
  seed: "Seed",
  candidate: "Candidate",
  both: "Both",
};
// Most filters ask the same of both ends, so a new sided criterion starts there.
const DEFAULT_SIDE: ConditionSide = "both";
const CLASSES = SEMANTIC_CLASSES.filter(
  (name): name is PieceClass => name !== "any",
);

// What a condition measures, apart from which end it asks.
function criterionKey(field: FilterField): string {
  if (field.measure === "share") return `share:${field.class}`;
  return field.measure;
}

function capitalized(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const CRITERION_OPTIONS: ReadonlyArray<[string, string]> = [
  ["score", "Score"],
  ["voxels", "Size"],
  ...CLASSES.map((cls): [string, string] => [
    `share:${cls}`,
    `${capitalized(cls)} %`,
  ]),
];

function withCriterion(field: FilterField, key: string): FilterField {
  if (key === "score") return { measure: "score" };
  const side = field.measure === "score" ? DEFAULT_SIDE : field.side;
  if (key === "voxels") return { side, measure: "voxels" };
  return { side, measure: "share", class: key.split(":")[1] as PieceClass };
}

const CMP_LABELS: Record<FilterCondition["cmp"], string> = {
  ">=": "≥",
  "<=": "≤",
};

// The trigger shows the label, not the stored key.
function criterionLabel(field: FilterField): string {
  const key = criterionKey(field);
  return CRITERION_OPTIONS.find(([option]) => option === key)?.[1] ?? key;
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
      <div className="calcada-filter-condition-what">
        <Select
          value={criterionKey(field)}
          onValueChange={(key) =>
            onChange({
              ...condition,
              field: withCriterion(field, key as string),
              value: 0,
            })
          }
        >
          <SelectTrigger
            size="sm"
            className="calcada-filter-field"
            title={criterionLabel(field)}
          >
            <SelectValue>{criterionLabel(field)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {CRITERION_OPTIONS.map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.measure !== "score" && (
          <Select
            value={field.side}
            onValueChange={(side) =>
              onChange({
                ...condition,
                field: { ...field, side: side as ConditionSide },
              })
            }
          >
            <SelectTrigger
              size="sm"
              className="calcada-filter-side"
              title="Which end of the candidate this applies to"
            >
              <SelectValue>{SIDE_LABELS[field.side]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SIDE_LABELS) as ConditionSide[]).map((side) => (
                <SelectItem key={side} value={side}>
                  {SIDE_LABELS[side]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="calcada-filter-condition-bound">
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
            field.measure === "score"
              ? 0.05
              : field.measure === "share"
                ? 5
                : 100
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
