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

import { XIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type {
  FilterField,
  FilterRow,
} from "#src/datasource/calcada/annotation_tables/annotation_filter.js";
import {
  BOOLEAN_TEXTS,
  buildFilter,
  isListOperator,
  LIST_SEPARATOR,
  localTimeZoneName,
  newRow,
  OPERATOR_LABELS,
  operatorsFor,
  rowsFromFilter,
  withField,
} from "#src/datasource/calcada/annotation_tables/annotation_filter.js";
import type { AnnotationTableFilter } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const LIST_PLACEHOLDER = `a${LIST_SEPARATOR} b${LIST_SEPARATOR} c`;
const TIMESTAMP_STEP_SECONDS = 1;
const ESCAPE_KEY = "Escape";
const VALUE_LABEL = "Value";
const REMOVE_LABEL = "Remove condition";

interface KeyedRow extends FilterRow {
  key: number;
}

/** Escape still reaches the popover, which closes on it. */
function keepKeysFromViewer(event: KeyboardEvent) {
  if (event.key !== ESCAPE_KEY) event.stopPropagation();
}

const rowControl = (key: number, label: string) =>
  `[data-row-key="${key}"] [aria-label="${label}"]`;

function ValueInput({
  field,
  row,
  invalid,
  onChange,
}: {
  field: FilterField | undefined;
  row: FilterRow;
  invalid: boolean;
  onChange: (text: string) => void;
}) {
  if (field?.kind === "boolean") {
    return (
      <Select value={row.text} onValueChange={(next) => onChange(String(next))}>
        <SelectTrigger
          size="sm"
          aria-label={VALUE_LABEL}
          aria-invalid={invalid}
        >
          <SelectValue>{row.text}</SelectValue>
        </SelectTrigger>
        <SelectContent onKeyDown={keepKeysFromViewer}>
          {BOOLEAN_TEXTS.map((text) => (
            <SelectItem key={text} value={text}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const timestamp = field?.kind === "timestamp";
  const moment = new Date(row.text);
  return (
    <>
      <Input
        aria-label={VALUE_LABEL}
        aria-invalid={invalid}
        className="calcada-annotations-filter-value"
        type={timestamp ? "datetime-local" : "text"}
        step={timestamp ? TIMESTAMP_STEP_SECONDS : undefined}
        placeholder={
          isListOperator(row.operator) ? LIST_PLACEHOLDER : undefined
        }
        value={row.text}
        onChange={(event) => onChange(event.target.value)}
      />
      {timestamp && (
        <span className="calcada-annotations-table-schema">
          {localTimeZoneName(
            Number.isNaN(moment.valueOf()) ? undefined : moment,
          )}
        </span>
      )}
    </>
  );
}

function ConditionRow({
  fields,
  row,
  problem,
  onChange,
  onRemove,
}: {
  fields: readonly FilterField[];
  row: KeyedRow;
  problem: string | undefined;
  onChange: (row: KeyedRow) => void;
  onRemove: () => void;
}) {
  const field = fields.find(({ name }) => name === row.field);
  const operators = field === undefined ? [] : operatorsFor(field.kind);
  return (
    <li className="calcada-annotations-filter-row" data-row-key={row.key}>
      <div className="calcada-annotations-filter-controls">
        <Select
          value={row.field}
          onValueChange={(next) =>
            onChange({ ...withField(row, String(next), fields), key: row.key })
          }
        >
          <SelectTrigger size="sm" aria-label="Field">
            <SelectValue>{row.field}</SelectValue>
          </SelectTrigger>
          <SelectContent onKeyDown={keepKeysFromViewer}>
            {fields.map(({ name, kind }) => (
              <SelectItem key={name} value={name}>
                {name}
                <span className="calcada-annotations-table-schema">{kind}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={row.operator}
          onValueChange={(next) =>
            onChange({ ...row, operator: next as FilterRow["operator"] })
          }
        >
          <SelectTrigger size="sm" aria-label="Operator">
            <SelectValue>{OPERATOR_LABELS[row.operator]}</SelectValue>
          </SelectTrigger>
          <SelectContent onKeyDown={keepKeysFromViewer}>
            {operators.map((operator) => (
              <SelectItem key={operator} value={operator}>
                {OPERATOR_LABELS[operator]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ValueInput
          field={field}
          row={row}
          invalid={problem !== undefined}
          onChange={(text) => onChange({ ...row, text })}
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={REMOVE_LABEL}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      </div>
      {problem !== undefined && (
        <div className="calcada-annotations-error">{problem}</div>
      )}
    </li>
  );
}

/**
 * Rows of field, operator and value for one table's filter. Mounted afresh on
 * each opening, so it always starts from the filter in force.
 */
export function AnnotationFilterEditor({
  fields,
  filter,
  onApply,
}: {
  fields: readonly FilterField[];
  filter: AnnotationTableFilter | undefined;
  onApply: (filter: AnnotationTableFilter | undefined) => void;
}) {
  const nextKey = useRef(0);
  const keyed = (row: FilterRow): KeyedRow => ({
    ...row,
    key: nextKey.current++,
  });
  const [rows, setRows] = useState(() => rowsFromFilter(filter).map(keyed));
  const form = useRef<HTMLFormElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const focusAfterRender =
    useRef<() => HTMLElement | null | undefined>(undefined);
  useEffect(() => {
    focusAfterRender.current?.()?.focus();
    focusAfterRender.current = undefined;
  });
  const control = (key: number, label: string) =>
    form.current?.querySelector<HTMLElement>(rowControl(key, label));
  const built = buildFilter(rows, fields);
  const valid = built.problems.every((problem) => problem === undefined);

  const addRow = () => {
    const added = keyed(newRow(fields));
    focusAfterRender.current = () => control(added.key, VALUE_LABEL);
    setRows([...rows, added]);
  };
  const removeRow = (removed: KeyedRow) => {
    const following = rows[rows.indexOf(removed) + 1];
    focusAfterRender.current = () =>
      following === undefined
        ? addButton.current
        : control(following.key, REMOVE_LABEL);
    setRows(rows.filter((row) => row !== removed));
  };

  return (
    <form
      ref={form}
      className="calcada-annotations-filter-editor"
      onKeyDown={keepKeysFromViewer}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onApply(built.filter);
      }}
    >
      <ul className="calcada-annotations-filter-rows">
        {rows.map((row, index) => (
          <ConditionRow
            key={row.key}
            fields={fields}
            row={row}
            problem={built.problems[index]}
            onChange={(next) =>
              setRows(rows.map((current) => (current === row ? next : current)))
            }
            onRemove={() => removeRow(row)}
          />
        ))}
      </ul>
      <div className="calcada-annotations-pager">
        <Button
          ref={addButton}
          type="button"
          size="xs"
          variant="outline"
          onClick={addRow}
        >
          Add condition
        </Button>
        <Button type="submit" size="xs" disabled={!valid}>
          Apply
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => onApply(undefined)}
        >
          Clear
        </Button>
      </div>
    </form>
  );
}
