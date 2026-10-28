/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest";
import { ANNOTATION_FILTER_OPERATORS } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { CalcadaAnnotationTablesState } from "#src/datasource/calcada/annotation_tables/annotation_tables_state.js";

const SIZE_FILTER = { filter_greater_dict: { size: 10 } };

describe("CalcadaAnnotationTablesState", () => {
  it("restores the old array of table names", () => {
    const state = new CalcadaAnnotationTablesState();
    state.restoreState(["syn", "mark"]);
    expect(state.ticked).toEqual(["syn", "mark"]);
    expect(state.filterOf("syn")).toBeUndefined();
    expect(state.toJSON()).toEqual([{ table: "syn" }, { table: "mark" }]);
  });

  it("round-trips tables with filters in selection order", () => {
    const json = [{ table: "syn", filter: SIZE_FILTER }, { table: "mark" }];
    const state = new CalcadaAnnotationTablesState();
    state.restoreState(json);
    expect(state.ticked).toEqual(["syn", "mark"]);
    expect(state.filterOf("syn")).toEqual(SIZE_FILTER);
    expect(state.toJSON()).toEqual(json);
  });

  it("rejects a filter that is not an object of operator dicts", () => {
    const state = new CalcadaAnnotationTablesState();
    expect(() =>
      state.restoreState([{ table: "syn", filter: { filter_equal_dict: 1 } }]),
    ).toThrow();
  });

  it("sets and clears a ticked table's filter, signalling only real changes", () => {
    const state = new CalcadaAnnotationTablesState();
    state.setTicked(["syn"]);
    const changed = vi.fn();
    state.changed.add(changed);
    state.setFilter("syn", SIZE_FILTER);
    state.setFilter("syn", { filter_greater_dict: { size: 10 } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(state.filterOf("syn")).toEqual(SIZE_FILTER);
    state.setFilter("syn", undefined);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(state.toJSON()).toEqual([{ table: "syn" }]);
  });

  it("keeps a filter while its table stays ticked and drops it on untick", () => {
    const state = new CalcadaAnnotationTablesState();
    state.setTicked(["syn"]);
    state.setFilter("syn", SIZE_FILTER);
    state.setTicked([...state.ticked, "mark"]);
    expect(state.filterOf("syn")).toEqual(SIZE_FILTER);
    state.untick("syn");
    state.setTicked([...state.ticked, "syn"]);
    expect(state.filterOf("syn")).toBeUndefined();
  });

  it("ignores a filter for a table that is not ticked", () => {
    const state = new CalcadaAnnotationTablesState();
    state.setFilter("syn", SIZE_FILTER);
    expect(state.ticked).toEqual([]);
    expect(state.toJSON()).toBeUndefined();
  });

  it("treats a filter with no known operator as no filter", () => {
    const state = new CalcadaAnnotationTablesState();
    state.setTicked(["syn"]);
    const changed = vi.fn();
    state.changed.add(changed);
    state.setFilter("syn", {});
    state.setFilter("syn", { after_id: { id: 1 } });
    expect(changed).not.toHaveBeenCalled();
    expect(state.filterOf("syn")).toBeUndefined();
    expect(state.toJSON()).toEqual([{ table: "syn" }]);
  });

  it("keeps only the known operators of a filter", () => {
    const state = new CalcadaAnnotationTablesState();
    state.restoreState([
      {
        table: "syn",
        filter: { ...SIZE_FILTER, after_id: "5", limit: 3 },
      },
    ]);
    expect(state.filterOf("syn")).toEqual(SIZE_FILTER);
    expect(state.toJSON()).toEqual([{ table: "syn", filter: SIZE_FILTER }]);
    expect(ANNOTATION_FILTER_OPERATORS).toContain("filter_regex_dict");
  });

  it("is not changed by a caller mutating the filter it set or read", () => {
    const state = new CalcadaAnnotationTablesState();
    state.setTicked(["syn"]);
    const filter = { filter_greater_dict: { size: 10 } };
    state.setFilter("syn", filter);
    filter.filter_greater_dict.size = 99;
    expect(state.filterOf("syn")).toEqual(SIZE_FILTER);
    const read = state.filterOf("syn")!;
    expect(() => {
      read.filter_greater_dict.size = 99;
    }).toThrow();
    expect(state.filterOf("syn")).toEqual(SIZE_FILTER);
  });
});
