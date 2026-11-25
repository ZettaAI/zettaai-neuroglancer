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
 * @file A table filter as editor rows of field, operator and typed text, and
 * the CAVE filter dicts they stand for. Rows on the same field and `in` or
 * `notin` merge their lists; for any other operator the later row wins.
 */

import { uniq } from "lodash-es";
import type {
  AnnotationPropertyType,
  AnnotationTableFilter,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { ANNOTATION_FILTER_OPERATORS } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";

export type AnnotationFilterOperator =
  (typeof ANNOTATION_FILTER_OPERATORS)[number];
export type FilterFieldKind = AnnotationPropertyType | "id" | "timestamp";

export interface FilterField {
  name: string;
  kind: FilterFieldKind;
}

export interface FilterRow {
  field: string;
  operator: AnnotationFilterOperator;
  text: string;
}

export interface BuiltFilter {
  filter: AnnotationTableFilter | undefined;
  /** Per row: why it cannot be sent, or `undefined` when it can. */
  problems: (string | undefined)[];
}

const BUILT_IN_FIELDS: readonly FilterField[] = [
  { name: "value", kind: "number" },
  { name: "user_id", kind: "string" },
  { name: "ts", kind: "timestamp" },
  { name: "id", kind: "id" },
];

export const OPERATOR_LABELS: Record<AnnotationFilterOperator, string> = {
  filter_equal_dict: "=",
  filter_in_dict: "in",
  filter_notin_dict: "not in",
  filter_greater_dict: ">",
  filter_less_dict: "<",
  filter_greater_equal_dict: "≥",
  filter_less_equal_dict: "≤",
  filter_regex_dict: "regex",
};

const LIST_OPERATORS: readonly AnnotationFilterOperator[] = [
  "filter_in_dict",
  "filter_notin_dict",
];
const ORDERING_OPERATORS: readonly AnnotationFilterOperator[] = [
  "filter_greater_dict",
  "filter_less_dict",
  "filter_greater_equal_dict",
  "filter_less_equal_dict",
];
const NUMERIC_OPERATORS: readonly AnnotationFilterOperator[] = [
  "filter_equal_dict",
  ...LIST_OPERATORS,
  ...ORDERING_OPERATORS,
];

const OPERATORS_BY_KIND: Record<
  FilterFieldKind,
  readonly AnnotationFilterOperator[]
> = {
  number: NUMERIC_OPERATORS,
  integer: NUMERIC_OPERATORS,
  string: ["filter_equal_dict", ...LIST_OPERATORS, "filter_regex_dict"],
  boolean: ["filter_equal_dict"],
  id: NUMERIC_OPERATORS,
  timestamp: ORDERING_OPERATORS,
};

export const LIST_SEPARATOR = ",";
const LIST_JOINER = `${LIST_SEPARATOR} `;
export const BOOLEAN_TEXTS = ["true", "false"] as const;
const INTEGER_TEXT = /^[-+]?\d+$/;
const DECIMAL_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DECIMAL_ID_TEXT = /^\d+$/;
const DATETIME_LOCAL_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const ZONED_TIMESTAMP_TEXT = /(Z|[+-]\d{2}:?\d{2})$/i;
const DATE_PART_WIDTH = 2;
const EMPTY_VALUE_PROBLEM = "Enter a value";
const TOO_LARGE_PROBLEM = "is too large";

const KIND_NOUNS: Record<FilterFieldKind, string> = {
  number: "a number",
  integer: "an integer",
  string: "a string",
  boolean: "true or false",
  id: "a decimal id",
  timestamp: "a date and time",
};

type ParsedValue = { value: unknown } | { problem: string };

const notA = (kind: FilterFieldKind, text: string): ParsedValue => ({
  problem: `"${text}" is not ${KIND_NOUNS[kind]}`,
});

const VALUE_PARSERS: Record<FilterFieldKind, (text: string) => ParsedValue> = {
  number: (text) => {
    const parsed = Number(text);
    return DECIMAL_TEXT.test(text) && Number.isFinite(parsed)
      ? { value: parsed }
      : notA("number", text);
  },
  integer: (text) => {
    if (!INTEGER_TEXT.test(text)) return notA("integer", text);
    const parsed = Number(text);
    return Number.isSafeInteger(parsed)
      ? { value: parsed }
      : { problem: `"${text}" ${TOO_LARGE_PROBLEM}` };
  },
  string: (text) => ({ value: text }),
  boolean: (text) =>
    text === "true"
      ? { value: true }
      : text === "false"
        ? { value: false }
        : notA("boolean", text),
  id: (text) =>
    DECIMAL_ID_TEXT.test(text)
      ? { value: BigInt(text).toString() }
      : notA("id", text),
  timestamp: (text) => {
    const date = new Date(text);
    return DATETIME_LOCAL_TEXT.test(text) && !Number.isNaN(date.valueOf())
      ? { value: date.toISOString() }
      : notA("timestamp", text);
  },
};

/** The built-in columns first; a schema property cannot shadow one. */
export function filterFields(
  properties: Record<string, AnnotationPropertyType>,
): FilterField[] {
  const builtInNames = new Set(BUILT_IN_FIELDS.map(({ name }) => name));
  return [
    ...BUILT_IN_FIELDS,
    ...Object.entries(properties)
      .filter(([name]) => !builtInNames.has(name))
      .map(([name, kind]) => ({ name, kind })),
  ];
}

export function operatorsFor(
  kind: FilterFieldKind,
): readonly AnnotationFilterOperator[] {
  return OPERATORS_BY_KIND[kind];
}

export function isListOperator(operator: AnnotationFilterOperator): boolean {
  return LIST_OPERATORS.includes(operator);
}

const initialText = (kind: FilterFieldKind) =>
  kind === "boolean" ? String(true) : "";

const kindOf = (field: string, fields: readonly FilterField[]) =>
  fields.find(({ name }) => name === field)?.kind;

export function newRow(fields: readonly FilterField[]): FilterRow {
  const [first] = fields;
  return {
    field: first.name,
    operator: operatorsFor(first.kind)[0],
    text: initialText(first.kind),
  };
}

export function withField(
  row: FilterRow,
  field: string,
  fields: readonly FilterField[],
): FilterRow {
  const kind = kindOf(field, fields);
  if (kind === undefined) return { ...row, field };
  const allowed = operatorsFor(kind);
  const operator = allowed.includes(row.operator) ? row.operator : allowed[0];
  const text =
    kind === kindOf(row.field, fields) ? row.text : initialText(kind);
  return { ...row, field, operator, text };
}

function parseRow(row: FilterRow, fields: readonly FilterField[]): ParsedValue {
  const kind = kindOf(row.field, fields);
  if (kind === undefined) return { problem: `Unknown field "${row.field}"` };
  if (!operatorsFor(kind).includes(row.operator)) {
    return { problem: `${row.field} cannot use this operator` };
  }
  if (!isListOperator(row.operator)) {
    const text = row.text.trim();
    return text === ""
      ? { problem: EMPTY_VALUE_PROBLEM }
      : VALUE_PARSERS[kind](text);
  }
  const items = row.text
    .split(LIST_SEPARATOR)
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (items.length === 0) return { problem: EMPTY_VALUE_PROBLEM };
  const values: unknown[] = [];
  for (const item of items) {
    const parsed = VALUE_PARSERS[kind](item);
    if ("problem" in parsed) return parsed;
    values.push(parsed.value);
  }
  return { value: values };
}

export function buildFilter(
  rows: readonly FilterRow[],
  fields: readonly FilterField[],
): BuiltFilter {
  const filter: AnnotationTableFilter = {};
  const problems = rows.map((row) => {
    const parsed = parseRow(row, fields);
    if ("problem" in parsed) return parsed.problem;
    const conditions = (filter[row.operator] ??= {});
    const earlier = conditions[row.field];
    conditions[row.field] =
      isListOperator(row.operator) && Array.isArray(earlier)
        ? uniq([...earlier, ...(parsed.value as unknown[])])
        : parsed.value;
    return undefined;
  });
  return {
    filter: Object.keys(filter).length === 0 ? undefined : filter,
    problems,
  };
}

function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(textOf).join(LIST_JOINER);
  return String(value);
}

const datePart = (part: number) => String(part).padStart(DATE_PART_WIDTH, "0");

/** What a `datetime-local` input with seconds shows for this moment. */
function wallClockText(date: Date): string {
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()];
  return `${day.map(datePart).join("-")}T${time.map(datePart).join(":")}`;
}

/** Only a value that names its zone is a moment; anything else is shown as sent. */
function timestampText(value: unknown): string {
  const text = textOf(value);
  const date = new Date(text);
  return ZONED_TIMESTAMP_TEXT.test(text) && !Number.isNaN(date.valueOf())
    ? wallClockText(date)
    : text;
}

/** The viewer's zone as the locale names it, e.g. "CET" or "GMT+2". */
export function localTimeZoneName(date = new Date()): string {
  return (
    new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(date)
      .find(({ type }) => type === "timeZoneName")?.value ?? ""
  );
}

/** Operators in their canonical order, then fields in the order sent. */
export function rowsFromFilter(
  filter: AnnotationTableFilter | undefined,
): FilterRow[] {
  if (filter === undefined) return [];
  return ANNOTATION_FILTER_OPERATORS.flatMap((operator) =>
    Object.entries(filter[operator] ?? {}).map(([field, value]) => ({
      field,
      operator,
      text:
        kindOf(field, BUILT_IN_FIELDS) === "timestamp"
          ? timestampText(value)
          : textOf(value),
    })),
  );
}

export function conditionCount(
  filter: AnnotationTableFilter | undefined,
): number {
  return rowsFromFilter(filter).length;
}
