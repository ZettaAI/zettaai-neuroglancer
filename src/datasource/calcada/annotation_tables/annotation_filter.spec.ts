/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";
import type { FilterRow } from "#src/datasource/calcada/annotation_tables/annotation_filter.js";
import {
  buildFilter,
  conditionCount,
  filterFields,
  operatorsFor,
  rowsFromFilter,
  withField,
} from "#src/datasource/calcada/annotation_tables/annotation_filter.js";

const fields = filterFields({
  size: "integer",
  score: "number",
  tag: "string",
  proofread: "boolean",
});
const row = (
  field: string,
  operator: FilterRow["operator"],
  text: string,
): FilterRow => ({ field, operator, text });
const BEYOND_SAFE_INTEGER_ID = "9007199254740993";
const WALL_CLOCK = "2026-10-27T09:30";
const WALL_CLOCK_WITH_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe("filterFields", () => {
  it("offers value, user_id, ts and id before the schema's properties", () => {
    expect(fields.map(({ name, kind }) => [name, kind])).toEqual([
      ["value", "number"],
      ["user_id", "string"],
      ["ts", "timestamp"],
      ["id", "id"],
      ["size", "integer"],
      ["score", "number"],
      ["tag", "string"],
      ["proofread", "boolean"],
    ]);
  });

  it("lets a built-in field win over a property of the same name", () => {
    expect(
      filterFields({ value: "string" }).filter(({ name }) => name === "value"),
    ).toEqual([{ name: "value", kind: "number" }]);
  });
});

describe("operatorsFor", () => {
  it("offers each type only the operators that make sense for it", () => {
    expect(operatorsFor("integer")).toEqual([
      "filter_equal_dict",
      "filter_in_dict",
      "filter_notin_dict",
      "filter_greater_dict",
      "filter_less_dict",
      "filter_greater_equal_dict",
      "filter_less_equal_dict",
    ]);
    expect(operatorsFor("number")).toEqual(operatorsFor("integer"));
    expect(operatorsFor("string")).toEqual([
      "filter_equal_dict",
      "filter_in_dict",
      "filter_notin_dict",
      "filter_regex_dict",
    ]);
    expect(operatorsFor("boolean")).toEqual(["filter_equal_dict"]);
    expect(operatorsFor("id")).toEqual([
      "filter_equal_dict",
      "filter_in_dict",
      "filter_notin_dict",
      "filter_greater_dict",
      "filter_less_dict",
      "filter_greater_equal_dict",
      "filter_less_equal_dict",
    ]);
    expect(operatorsFor("timestamp")).toEqual([
      "filter_greater_dict",
      "filter_less_dict",
      "filter_greater_equal_dict",
      "filter_less_equal_dict",
    ]);
  });
});

describe("withField", () => {
  it("keeps the operator and text for a field of the same kind", () => {
    expect(
      withField(row("value", "filter_in_dict", "1"), "score", fields),
    ).toEqual(row("score", "filter_in_dict", "1"));
  });

  it("clears the text when the kind changes, keeping an allowed operator", () => {
    expect(
      withField(row("size", "filter_in_dict", "1"), "tag", fields),
    ).toEqual(row("tag", "filter_in_dict", ""));
  });

  it("falls back to the new field's first operator", () => {
    expect(
      withField(row("tag", "filter_regex_dict", "ax"), "ts", fields),
    ).toEqual(row("ts", "filter_greater_dict", ""));
  });

  it("starts a boolean field at true", () => {
    expect(
      withField(row("tag", "filter_equal_dict", "ax"), "proofread", fields),
    ).toEqual(row("proofread", "filter_equal_dict", "true"));
  });
});

describe("buildFilter", () => {
  it("turns a row into a CAVE filter dict", () => {
    expect(
      buildFilter([row("size", "filter_greater_dict", "10")], fields),
    ).toEqual({
      filter: { filter_greater_dict: { size: 10 } },
      problems: [undefined],
    });
  });

  it("parses a comma list for in, trimmed and typed", () => {
    expect(
      buildFilter(
        [
          row("tag", "filter_in_dict", " axon, soma ,"),
          row("size", "filter_notin_dict", "1,2"),
        ],
        fields,
      ).filter,
    ).toEqual({
      filter_in_dict: { tag: ["axon", "soma"] },
      filter_notin_dict: { size: [1, 2] },
    });
  });

  it("merges lists on the same field and operator; a later scalar wins", () => {
    expect(
      buildFilter(
        [
          row("tag", "filter_in_dict", "axon"),
          row("tag", "filter_in_dict", "soma, axon"),
          row("size", "filter_greater_dict", "10"),
          row("size", "filter_greater_dict", "20"),
          row("size", "filter_less_dict", "50"),
        ],
        fields,
      ).filter,
    ).toEqual({
      filter_in_dict: { tag: ["axon", "soma"] },
      filter_greater_dict: { size: 20 },
      filter_less_dict: { size: 50 },
    });
  });

  it("types values by field", () => {
    expect(
      buildFilter(
        [
          row("score", "filter_greater_equal_dict", "0.5"),
          row("value", "filter_less_dict", "-1e3"),
          row("value", "filter_greater_dict", ".5"),
          row("proofread", "filter_equal_dict", "true"),
          row("user_id", "filter_equal_dict", "42"),
          row("tag", "filter_regex_dict", "^ax"),
        ],
        fields,
      ).filter,
    ).toEqual({
      filter_greater_equal_dict: { score: 0.5 },
      filter_less_dict: { value: -1000 },
      filter_greater_dict: { value: 0.5 },
      filter_equal_dict: { proofread: true, user_id: "42" },
      filter_regex_dict: { tag: "^ax" },
    });
  });

  it("sends ids as decimal strings, beyond 2^53 too", () => {
    expect(
      buildFilter(
        [
          row("id", "filter_greater_dict", BEYOND_SAFE_INTEGER_ID),
          row("id", "filter_in_dict", `007, ${BEYOND_SAFE_INTEGER_ID}`),
        ],
        fields,
      ).filter,
    ).toEqual({
      filter_greater_dict: { id: BEYOND_SAFE_INTEGER_ID },
      filter_in_dict: { id: ["7", BEYOND_SAFE_INTEGER_ID] },
    });
  });

  it("reads ts as local wall-clock time and sends an ISO string", () => {
    expect(
      buildFilter([row("ts", "filter_greater_dict", WALL_CLOCK)], fields)
        .filter,
    ).toEqual({
      filter_greater_dict: { ts: new Date(WALL_CLOCK).toISOString() },
    });
  });

  it("names each invalid row and builds nothing from it", () => {
    const { filter, problems } = buildFilter(
      [
        row("size", "filter_equal_dict", "abc"),
        row("size", "filter_in_dict", "1, 2.5"),
        row("size", "filter_equal_dict", BEYOND_SAFE_INTEGER_ID),
        row("score", "filter_equal_dict", "0x10"),
        row("value", "filter_equal_dict", "0b1"),
        row("score", "filter_greater_dict", ""),
        row("proofread", "filter_equal_dict", "yes"),
        row("id", "filter_equal_dict", "-3"),
        row("ts", "filter_less_dict", "yesterday"),
        row("tag", "filter_in_dict", " , "),
        row("ghost", "filter_equal_dict", "1"),
        row("tag", "filter_greater_dict", "a"),
        row("tag", "filter_equal_dict", "kept"),
      ],
      fields,
    );
    expect(problems).toEqual([
      '"abc" is not an integer',
      '"2.5" is not an integer',
      `"${BEYOND_SAFE_INTEGER_ID}" is too large`,
      '"0x10" is not a number',
      '"0b1" is not a number',
      "Enter a value",
      '"yes" is not true or false',
      '"-3" is not a decimal id',
      '"yesterday" is not a date and time',
      "Enter a value",
      'Unknown field "ghost"',
      "tag cannot use this operator",
      undefined,
    ]);
    expect(filter).toEqual({ filter_equal_dict: { tag: "kept" } });
  });

  it("is no filter without rows", () => {
    expect(buildFilter([], fields)).toEqual({
      filter: undefined,
      problems: [],
    });
  });
});

describe("rowsFromFilter", () => {
  it("round-trips a filter through rows", () => {
    const filter = {
      filter_in_dict: { tag: ["axon", "soma"], id: [BEYOND_SAFE_INTEGER_ID] },
      filter_greater_dict: { size: 10, ts: "2026-10-27T09:30:15.000Z" },
      filter_equal_dict: { proofread: false },
    };
    const rows = rowsFromFilter(filter);
    expect(rows.slice(0, -1)).toEqual([
      row("tag", "filter_in_dict", "axon, soma"),
      row("id", "filter_in_dict", BEYOND_SAFE_INTEGER_ID),
      row("proofread", "filter_equal_dict", "false"),
      row("size", "filter_greater_dict", "10"),
    ]);
    const timestamp = rows[rows.length - 1];
    expect(timestamp.field).toBe("ts");
    expect(timestamp.text).toMatch(WALL_CLOCK_WITH_SECONDS);
    expect(new Date(timestamp.text).toISOString()).toBe(
      filter.filter_greater_dict.ts,
    );
    expect(buildFilter(rows, fields)).toEqual({
      filter,
      problems: rows.map(() => undefined),
    });
  });

  it("shows a ts without a zone as it was written", () => {
    expect(rowsFromFilter({ filter_less_dict: { ts: WALL_CLOCK } })).toEqual([
      row("ts", "filter_less_dict", WALL_CLOCK),
    ]);
  });

  it("reads a ts with an explicit offset", () => {
    const [timestamp] = rowsFromFilter({
      filter_less_dict: { ts: "2026-10-27T09:30:00+02:00" },
    });
    expect(new Date(timestamp.text).toISOString()).toBe(
      "2026-10-27T07:30:00.000Z",
    );
  });

  it("has no rows without a filter", () => {
    expect(rowsFromFilter(undefined)).toEqual([]);
  });
});

describe("conditionCount", () => {
  it("counts field conditions across operators", () => {
    expect(
      conditionCount({
        filter_in_dict: { tag: ["axon"] },
        filter_greater_dict: { size: 1, value: 0.5 },
      }),
    ).toBe(3);
    expect(conditionCount(undefined)).toBe(0);
  });

  it("counts only the operators the editor shows", () => {
    expect(
      conditionCount({
        filter_spatial_dict: { pt: [1, 2, 3] },
        filter_in_dict: { tag: ["axon"] },
      }),
    ).toBe(1);
  });
});
