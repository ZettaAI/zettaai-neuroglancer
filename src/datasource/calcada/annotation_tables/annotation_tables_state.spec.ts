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
  it("restores the 4b form and the string array", () => {
    const fromNames = new CalcadaAnnotationTablesState();
    fromNames.restoreState(["syn", "mark"]);
    expect(fromNames.ticked).toEqual(["syn", "mark"]);
    expect(fromNames.filterOf("syn")).toBeUndefined();
    expect(fromNames.wholeTableOf("syn")).toBe(false);
    expect(fromNames.toJSON()).toEqual([{ table: "syn" }, { table: "mark" }]);
    const from4b = new CalcadaAnnotationTablesState();
    from4b.restoreState([
      { table: "syn", filter: SIZE_FILTER },
      { table: "mark" },
    ]);
    expect(from4b.ticked).toEqual(["syn", "mark"]);
    expect(from4b.filterOf("syn")).toEqual(SIZE_FILTER);
    expect(from4b.wholeTableOf("syn")).toBe(false);
    expect(from4b.wholeTableOf("mark")).toBe(false);
  });

  it("round-trips wholeTable and excludedSegments", () => {
    const json = [
      { table: "syn", filter: SIZE_FILTER, wholeTable: true },
      { table: "mark" },
    ];
    const state = new CalcadaAnnotationTablesState();
    state.restoreState(json);
    state.restoreExcludedSegments(["20", "10"]);
    expect(state.wholeTableOf("syn")).toBe(true);
    expect(state.wholeTableOf("mark")).toBe(false);
    expect(state.toJSON()).toEqual(json);
    expect(state.excludedSegmentsToJSON()).toEqual(["10", "20"]);
    expect([...state.excludedSegments]).toEqual(
      expect.arrayContaining([10n, 20n]),
    );
    const changed = vi.fn();
    state.changed.add(changed);
    state.setWholeTable("syn", false);
    state.excludedSegments.delete(10n);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(state.toJSON()).toEqual([
      { table: "syn", filter: SIZE_FILTER },
      { table: "mark" },
    ]);
    state.restoreExcludedSegments(undefined);
    expect(state.excludedSegmentsToJSON()).toBeUndefined();
  });

  it("an excluded root that is no longer present is kept but harmless", () => {
    const state = new CalcadaAnnotationTablesState();
    state.restoreState([{ table: "syn" }]);
    state.restoreExcludedSegments(["999"]);
    state.setTicked(["syn", "mark"]);
    expect(state.excludedSegmentsToJSON()).toEqual(["999"]);
    expect(state.ticked).toEqual(["syn", "mark"]);
    expect(state.toJSON()).toEqual([{ table: "syn" }, { table: "mark" }]);
  });

  it("keeps wholeTable while its table stays ticked and drops it on untick", () => {
    const state = new CalcadaAnnotationTablesState();
    state.setTicked(["syn"]);
    state.setWholeTable("syn", true);
    state.setTicked([...state.ticked, "mark"]);
    expect(state.wholeTableOf("syn")).toBe(true);
    state.untick("syn");
    state.setTicked([...state.ticked, "syn"]);
    expect(state.wholeTableOf("syn")).toBe(false);
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
