/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import "#src/datasource/calcada/calcada.css";

import type { AnnotationTableInfo } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { AnnotationTablesPanelConnection } from "#src/datasource/calcada/annotation_tables/annotation_tables_panel.js";
import { CalcadaAnnotationTablesPanel } from "#src/datasource/calcada/annotation_tables/annotation_tables_panel.js";
import type { AnnotationTableStatus } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { CalcadaAnnotationTablesState } from "#src/datasource/calcada/annotation_tables/annotation_tables_state.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";

const SIDE_PANEL_WIDTH_PX = 260;
const SWATCH_COLOR = vec3.fromValues(1, 0, 0);

const synapses: AnnotationTableInfo = {
  name: "synapses",
  schemaName: "synapse",
  schemaVersion: 2,
  description: "Predicted synapses",
  voxelResolution: [4, 4, 40],
  points: ["pre", "post"],
};
const nuclei: AnnotationTableInfo = {
  name: "nuclei",
  schemaName: "point",
  schemaVersion: 1,
  description: "",
  voxelResolution: [4, 4, 40],
  points: ["center"],
};

const status = (
  overrides: Partial<AnnotationTableStatus> & { table: string },
): AnnotationTableStatus => ({
  annotations: 0,
  fetchedRoots: 0,
  truncatedRoots: 0,
  ...overrides,
});

const refreshed = vi.fn();

class FakeSession {
  readonly tables: WatchableValue<AnnotationTableInfo[] | undefined>;
  readonly status = new WatchableValue<AnnotationTableStatus[]>([]);
  readonly listError = new WatchableValue<string | undefined>(undefined);
  readonly rootsNote = new WatchableValue<string | undefined>(undefined);
  private readonly color = SWATCH_COLOR;

  constructor(tables: AnnotationTableInfo[] | undefined) {
    this.tables = new WatchableValue(tables);
  }

  tableColor(_name: string) {
    return this.color;
  }

  refreshTables() {
    if (this.color !== SWATCH_COLOR)
      throw new Error("detached from its session");
    refreshed();
  }
}

function makeConnection(
  tables: AnnotationTableInfo[] | undefined,
  statuses: AnnotationTableStatus[] = [],
  ticked: string[] = [],
) {
  const annotationTables = new CalcadaAnnotationTablesState();
  annotationTables.setTicked(ticked);
  const session = new FakeSession(tables);
  session.status.value = statuses;
  const connection: AnnotationTablesPanelConnection = {
    state: { annotationTables },
    annotationTablesSession: session,
  };
  return { connection, annotationTables, session };
}

let tab: HTMLDivElement;
let disposer: Disposer;

afterEach(() => {
  invokeDisposer(disposer);
  tab.remove();
  refreshed.mockClear();
});

async function mountPanel(connection: AnnotationTablesPanelConnection) {
  tab = document.createElement("div");
  tab.className = "calcada-annotations-tab";
  tab.style.cssText = `width: ${SIDE_PANEL_WIDTH_PX}px; height: 600px;`;
  document.body.appendChild(tab);
  disposer = mountComponent(tab, CalcadaAnnotationTablesPanel, { connection });
  await vi.waitFor(() => {
    expect(tab.querySelector(".calcada-annotations-panel")).not.toBe(null);
  });
}

const refreshButton = () =>
  [...tab.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Refresh",
  )!;
const rows = () => [...tab.querySelectorAll(".calcada-annotations-table")];
const checkbox = (row: Element) =>
  row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

describe("CalcadaAnnotationTablesPanel", () => {
  it("lists each table with its schema and description", async () => {
    const { connection } = makeConnection([synapses, nuclei]);
    await mountPanel(connection);
    expect(rows()).toHaveLength(2);
    expect(rows()[0].textContent).toContain("synapses");
    expect(rows()[0].textContent).toContain("synapse@2");
    expect(rows()[0].textContent).toContain("Predicted synapses");
    expect(rows()[1].textContent).toContain("point@1");
  });

  it("ticks and unticks through the state", async () => {
    const { connection, annotationTables } = makeConnection([synapses]);
    await mountPanel(connection);
    checkbox(rows()[0]).click();
    await vi.waitFor(() => expect(checkbox(rows()[0]).checked).toBe(true));
    expect(annotationTables.ticked).toEqual(["synapses"]);
    checkbox(rows()[0]).click();
    await vi.waitFor(() => expect(checkbox(rows()[0]).checked).toBe(false));
    expect(annotationTables.ticked).toEqual([]);
  });

  it("shows counts and the colour swatch for a ticked table only", async () => {
    const { connection } = makeConnection(
      [synapses, nuclei],
      [status({ table: "synapses", annotations: 12, fetchedRoots: 3 })],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(rows()[0].textContent).toContain("12 annotations on 3 segments");
    expect(
      rows()[0].querySelector<HTMLElement>(".calcada-annotations-swatch")!.style
        .background,
    ).toBe("rgb(255, 0, 0)");
    expect(rows()[1].textContent).not.toContain("annotations on");
  });

  it("warns when a segment's annotations were truncated", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [status({ table: "synapses", annotations: 10000, fetchedRoots: 1 })],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(tab.querySelector(".calcada-trace-panel-warning")).toBe(null);
    session.status.value = [
      status({
        table: "synapses",
        annotations: 10000,
        fetchedRoots: 1,
        truncatedRoots: 1,
      }),
    ];
    await vi.waitFor(() => {
      expect(
        tab.querySelector(".calcada-trace-panel-warning")?.textContent,
      ).toBe(
        "Some segments have more than 10 000 annotations in this table; only the first 10 000 are shown.",
      );
    });
  });

  it("shows a table's error in red", async () => {
    const { connection } = makeConnection(
      [synapses],
      [
        status({
          table: "synapses",
          error: "No read permission on annotation table synapses",
        }),
      ],
    );
    await mountPanel(connection);
    const error = tab.querySelector<HTMLElement>(".calcada-annotations-error")!;
    expect(error.textContent).toBe(
      "No read permission on annotation table synapses",
    );
    expect(getComputedStyle(error).color).toBe("rgb(240, 90, 90)");
  });

  it("says so when the graph has no tables", async () => {
    const { connection } = makeConnection([]);
    await mountPanel(connection);
    expect(tab.textContent).toContain("No annotation tables on this graph");
  });

  it("re-lists the tables on Refresh", async () => {
    const { connection } = makeConnection([synapses]);
    await mountPanel(connection);
    refreshButton().click();
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it("shows the list error instead of loading, and Refresh stays", async () => {
    const { connection, session } = makeConnection(undefined);
    session.listError.value = "Could not list annotation tables: boom";
    await mountPanel(connection);
    expect(tab.querySelector(".calcada-annotations-error")?.textContent).toBe(
      "Could not list annotation tables: boom",
    );
    expect(tab.textContent).not.toContain("Loading annotation tables");
    expect(refreshButton()).toBeDefined();
  });

  it("shows the note about segments beyond the fetch limit", async () => {
    const { connection, session } = makeConnection([synapses]);
    session.rootsNote.value =
      "Showing annotations for 50 of 120 visible segments.";
    await mountPanel(connection);
    expect(tab.textContent).toContain(
      "Showing annotations for 50 of 120 visible segments.",
    );
  });

  it("shows a ticked table's note in place of its counts", async () => {
    const { connection } = makeConnection(
      [synapses],
      [status({ table: "synapses", note: "Not present at this time" })],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(rows()[0].textContent).toContain("Not present at this time");
    expect(rows()[0].textContent).not.toContain("annotations on");
  });

  it("shows the note of a ticked table missing from the list", async () => {
    const { connection } = makeConnection(
      [synapses],
      [status({ table: "gone", note: "Not in the current table list" })],
      ["gone"],
    );
    await mountPanel(connection);
    expect(tab.textContent).toContain("gone: Not in the current table list");
  });

  it("uses singular nouns for one annotation on one segment", async () => {
    const { connection } = makeConnection(
      [synapses],
      [status({ table: "synapses", annotations: 1, fetchedRoots: 1 })],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(rows()[0].textContent).toContain("1 annotation on 1 segment");
    expect(rows()[0].textContent).not.toContain("annotations");
  });
});
