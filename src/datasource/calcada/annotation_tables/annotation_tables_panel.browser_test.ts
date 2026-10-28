/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import "#src/datasource/calcada/calcada.css";

import type { AnnotationTableInfo } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { AnnotationTablesPanelConnection } from "#src/datasource/calcada/annotation_tables/annotation_tables_panel.js";
import {
  ANNOTATION_LIST_PAGE_SIZE,
  CalcadaAnnotationTablesPanel,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_panel.js";
import type {
  AnnotationTableStatus,
  DrawnAnnotation,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { CalcadaAnnotationTablesState } from "#src/datasource/calcada/annotation_tables/annotation_tables_state.js";
import { ANNOTATION_TABLES_TAB_LABEL } from "#src/datasource/calcada/annotation_tables/annotation_tables_tab.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";

const SIDE_PANEL_WIDTH_PX = 260;
const SWATCH_COLOR = vec3.fromValues(1, 0, 0);
const BEYOND_SAFE_INTEGER_ID = 9007199254740993n;
const LONG_LIST_LENGTH = 120;
const SHRUNK_LIST_LENGTH = 30;

const synapses: AnnotationTableInfo = {
  name: "synapses",
  schemaName: "synapse",
  schemaVersion: 2,
  description: "Predicted synapses",
  voxelResolution: [4, 4, 40],
  points: ["pre", "post"],
  properties: { size: "integer", tag: "string" },
};
const nuclei: AnnotationTableInfo = {
  name: "nuclei",
  schemaName: "point",
  schemaVersion: 1,
  description: "",
  voxelResolution: [4, 4, 40],
  points: ["center"],
  properties: {},
};

const status = (
  overrides: Partial<AnnotationTableStatus> & { table: string },
): AnnotationTableStatus => ({
  annotations: 0,
  fetchedRoots: 0,
  page: 1,
  hasNext: false,
  hasPrevious: false,
  ...overrides,
});

const drawnAnnotation = (
  table: string,
  id: bigint,
  positions: [number, number, number][] = [[1, 2, 3]],
): DrawnAnnotation => ({
  table,
  annotation: {
    id,
    value: Number(id % 100n) / 100,
    payload: {},
    points: positions.map((position, index) => ({
      name: `point${index}`,
      position,
      pieceId: id,
      rootId: id,
    })),
  },
  layerId: `${table}:${id}`,
});

const drawnRun = (table: string, length: number) =>
  Array.from({ length }, (_, index) =>
    drawnAnnotation(table, BigInt(index + 1)),
  );

const refreshed = vi.fn();

class FakeSession {
  readonly tables: WatchableValue<AnnotationTableInfo[] | undefined>;
  readonly status = new WatchableValue<AnnotationTableStatus[]>([]);
  readonly drawn = new WatchableValue<DrawnAnnotation[]>([]);
  readonly listError = new WatchableValue<string | undefined>(undefined);
  readonly rootsNote = new WatchableValue<string | undefined>(undefined);
  readonly nextPage = vi.fn<(table: string) => void>();
  readonly previousPage = vi.fn<(table: string) => void>();
  readonly select = vi.fn<(item: DrawnAnnotation) => void>();
  readonly moveTo = vi.fn<(item: DrawnAnnotation) => void>();
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
let disposer: Disposer | undefined;

afterEach(() => {
  refreshed.mockClear();
  if (disposer === undefined) return;
  invokeDisposer(disposer);
  disposer = undefined;
  tab.remove();
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

const buttonLabelled = (label: string) =>
  [...tab.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  )!;
const pickerInput = () =>
  tab.querySelector<HTMLInputElement>(".calcada-annotations-picker input")!;
const chips = () => [
  ...tab.querySelectorAll<HTMLElement>(".calcada-annotations-chip"),
];
const statusLines = () => [
  ...tab.querySelectorAll<HTMLElement>(".calcada-annotations-table"),
];
const listRows = () => [
  ...tab.querySelectorAll<HTMLElement>(".calcada-annotations-row"),
];
const listRange = () =>
  tab.querySelector(".calcada-annotations-list-range")?.textContent;

const SIZE_FILTER = { filter_greater_dict: { size: 10 } };

const inDocument = <T extends Element>(selector: string) => [
  ...document.querySelectorAll<T>(selector),
];
const filterRows = () =>
  inDocument<HTMLElement>(".calcada-annotations-filter-row");
const valueInput = (row: HTMLElement) =>
  row.querySelector<HTMLInputElement>('input[aria-label="Value"]')!;
const documentButton = (label: string) =>
  inDocument<HTMLButtonElement>("button").find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  )!;

async function openFilterEditor() {
  buttonLabelled("Filter").click();
  await vi.waitFor(() =>
    expect(
      document.querySelector(".calcada-annotations-filter-editor"),
    ).not.toBe(null),
  );
}

async function chooseInRow(row: HTMLElement, label: string, option: string) {
  row.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click();
  const item = await vi.waitFor(() => {
    const found = inDocument<HTMLElement>('[role="option"]').find((candidate) =>
      candidate.textContent?.trim().startsWith(option),
    );
    expect(found).toBeDefined();
    return found!;
  });
  item.click();
  await vi.waitFor(() =>
    expect(row.querySelector(`[aria-label="${label}"]`)!.textContent).toContain(
      option,
    ),
  );
}

async function pickOption(name: string) {
  await userEvent.click(pickerInput());
  const option = await vi.waitFor(() => {
    const found = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent?.includes(name));
    expect(found).toBeDefined();
    return found!;
  });
  option.click();
}

describe("CalcadaAnnotationTablesPanel", () => {
  it("selects tables in the picker, in selection order", async () => {
    const { connection, annotationTables } = makeConnection([synapses, nuclei]);
    await mountPanel(connection);
    await pickOption("nuclei");
    await vi.waitFor(() => expect(annotationTables.ticked).toEqual(["nuclei"]));
    await pickOption("synapses");
    await vi.waitFor(() =>
      expect(annotationTables.ticked).toEqual(["nuclei", "synapses"]),
    );
    await vi.waitFor(() =>
      expect(chips().map((chip) => chip.textContent)).toEqual([
        "nuclei",
        "synapses",
      ]),
    );
  });

  it("unselects a table by removing its chip", async () => {
    const { connection, annotationTables } = makeConnection(
      [synapses, nuclei],
      [],
      ["synapses", "nuclei"],
    );
    await mountPanel(connection);
    chips()[0]
      .querySelector<HTMLButtonElement>('[data-slot="combobox-chip-remove"]')!
      .click();
    await vi.waitFor(() => expect(annotationTables.ticked).toEqual(["nuclei"]));
    await vi.waitFor(() => expect(chips()).toHaveLength(1));
  });

  it("shows the table colour on its chip", async () => {
    const { connection } = makeConnection([synapses], [], ["synapses"]);
    await mountPanel(connection);
    expect(
      chips()[0].querySelector<HTMLElement>(".calcada-annotations-swatch")!
        .style.background,
    ).toBe("rgb(255, 0, 0)");
  });

  it("shows counts for each selected table only", async () => {
    const { connection } = makeConnection(
      [synapses, nuclei],
      [status({ table: "synapses", annotations: 12, fetchedRoots: 3 })],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(statusLines()).toHaveLength(1);
    expect(statusLines()[0].textContent).toContain("synapses");
    expect(statusLines()[0].textContent).toContain(
      "12 annotations on 3 segments",
    );
  });

  it("uses singular nouns for one annotation on one segment", async () => {
    const { connection } = makeConnection(
      [synapses],
      [status({ table: "synapses", annotations: 1, fetchedRoots: 1 })],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(statusLines()[0].textContent).toContain("1 annotation on 1 segment");
    expect(statusLines()[0].textContent).not.toContain("annotations");
  });

  it("shows the server page and turns it per table", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [
        status({
          table: "synapses",
          annotations: 1000,
          fetchedRoots: 1,
          page: 2,
          hasNext: true,
          hasPrevious: true,
        }),
      ],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(statusLines()[0].textContent).toContain("Page 2");
    buttonLabelled("Next 1000").click();
    expect(session.nextPage).toHaveBeenCalledWith("synapses");
    buttonLabelled("Previous 1000").click();
    expect(session.previousPage).toHaveBeenCalledWith("synapses");
  });

  it("disables page turns the server has nothing for", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [status({ table: "synapses", annotations: 3, fetchedRoots: 1 })],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(buttonLabelled("Next 1000").disabled).toBe(true);
    expect(buttonLabelled("Previous 1000").disabled).toBe(true);
    session.status.value = [
      status({
        table: "synapses",
        annotations: 1000,
        fetchedRoots: 1,
        hasNext: true,
      }),
    ];
    await vi.waitFor(() =>
      expect(buttonLabelled("Next 1000").disabled).toBe(false),
    );
    expect(buttonLabelled("Previous 1000").disabled).toBe(true);
  });

  it("lists drawn annotations with id, value and positions", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    session.drawn.value = [
      drawnAnnotation("synapses", BEYOND_SAFE_INTEGER_ID, [
        [10, 20, 30],
        [11, 21, 31],
      ]),
    ];
    await mountPanel(connection);
    expect(listRows()).toHaveLength(1);
    const text = listRows()[0].textContent!;
    expect(text).toContain("synapses");
    expect(text).toContain(String(BEYOND_SAFE_INTEGER_ID));
    expect(text).toContain("0.93");
    expect(text).toContain("10, 20, 30");
    expect(text).toContain("11, 21, 31");
  });

  it("pages the list and keeps the page in range when it shrinks", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    session.drawn.value = drawnRun("synapses", LONG_LIST_LENGTH);
    await mountPanel(connection);
    expect(listRows()).toHaveLength(ANNOTATION_LIST_PAGE_SIZE);
    expect(listRange()).toBe("1–50 of 120");
    expect(buttonLabelled("Previous page").disabled).toBe(true);
    buttonLabelled("Next page").click();
    buttonLabelled("Next page").click();
    await vi.waitFor(() => expect(listRange()).toBe("101–120 of 120"));
    expect(listRows()).toHaveLength(20);
    expect(buttonLabelled("Next page").disabled).toBe(true);
    session.drawn.value = drawnRun("synapses", SHRUNK_LIST_LENGTH);
    await vi.waitFor(() => expect(listRange()).toBe("1–30 of 30"));
    expect(listRows()).toHaveLength(SHRUNK_LIST_LENGTH);
    session.drawn.value = [];
    await vi.waitFor(() => expect(listRows()).toHaveLength(0));
    expect(tab.querySelector(".calcada-annotations-list-range")).toBe(null);
  });

  it("goes back to the first list page when the server page turns", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [status({ table: "synapses", annotations: 1000, hasNext: true })],
      ["synapses"],
    );
    session.drawn.value = drawnRun("synapses", LONG_LIST_LENGTH);
    session.nextPage.mockImplementation((table) => {
      session.status.value = [
        status({ table, annotations: 1000, page: 2, hasPrevious: true }),
      ];
      session.drawn.value = drawnRun(table, LONG_LIST_LENGTH);
    });
    await mountPanel(connection);
    buttonLabelled("Next page").click();
    await vi.waitFor(() => expect(listRange()).toBe("51–100 of 120"));
    buttonLabelled("Next 1000").click();
    await vi.waitFor(() => expect(listRange()).toBe("1–50 of 120"));
  });

  it("keeps the list page when only the statuses' counts change", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [status({ table: "synapses", annotations: 10 })],
      ["synapses"],
    );
    session.drawn.value = drawnRun("synapses", LONG_LIST_LENGTH);
    await mountPanel(connection);
    buttonLabelled("Next page").click();
    await vi.waitFor(() => expect(listRange()).toBe("51–100 of 120"));
    session.status.value = [status({ table: "synapses", annotations: 11 })];
    await vi.waitFor(() =>
      expect(statusLines()[0].textContent).toContain("11 annotations"),
    );
    expect(listRange()).toBe("51–100 of 120");
  });

  it("selects on click and moves on right-click", async () => {
    const { connection, session } = makeConnection(
      [synapses, nuclei],
      [],
      ["synapses", "nuclei"],
    );
    const target = drawnAnnotation("nuclei", 7n);
    session.drawn.value = [drawnAnnotation("synapses", 1n), target];
    await mountPanel(connection);
    listRows()[1].click();
    expect(session.select).toHaveBeenCalledExactlyOnceWith(target);
    expect(session.moveTo).not.toHaveBeenCalled();
    const rightClick = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    listRows()[1].dispatchEvent(rightClick);
    expect(session.moveTo).toHaveBeenCalledExactlyOnceWith(target);
    expect(rightClick.defaultPrevented).toBe(true);
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
      ["synapses"],
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
    buttonLabelled("Refresh").click();
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
    expect(buttonLabelled("Refresh")).toBeDefined();
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

  it("shows a selected table's note in place of its counts", async () => {
    const { connection } = makeConnection(
      [synapses],
      [status({ table: "synapses", note: "Not present at this time" })],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(statusLines()[0].textContent).toContain("Not present at this time");
    expect(statusLines()[0].textContent).not.toContain("annotations on");
  });

  it("shows the note of a selected table missing from the list", async () => {
    const { connection } = makeConnection(
      [synapses],
      [status({ table: "gone", note: "Not in the current table list" })],
      ["gone"],
    );
    await mountPanel(connection);
    expect(tab.textContent).toContain("gone: Not in the current table list");
  });

  it("applies a filter from the editor and says the table is filtered", async () => {
    const { connection, annotationTables } = makeConnection(
      [synapses],
      [status({ table: "synapses" })],
      ["synapses"],
    );
    await mountPanel(connection);
    expect(statusLines()[0].textContent).not.toContain("filtered");
    await openFilterEditor();
    documentButton("Add condition").click();
    const row = await vi.waitFor(() => {
      expect(filterRows()).toHaveLength(1);
      return filterRows()[0];
    });
    await chooseInRow(row, "Field", "size");
    await chooseInRow(row, "Operator", ">");
    await userEvent.fill(valueInput(row), "10");
    documentButton("Apply").click();
    await vi.waitFor(() =>
      expect(annotationTables.filterOf("synapses")).toEqual(SIZE_FILTER),
    );
    await vi.waitFor(() =>
      expect(statusLines()[0].textContent).toContain("filtered: 1 condition"),
    );
  });

  it("opens on the table's filter and clears it", async () => {
    const { connection, annotationTables } = makeConnection(
      [synapses],
      [status({ table: "synapses" })],
      ["synapses"],
    );
    annotationTables.setFilter("synapses", SIZE_FILTER);
    await mountPanel(connection);
    await openFilterEditor();
    const [row] = filterRows();
    expect(row.textContent).toContain("size");
    expect(valueInput(row).value).toBe("10");
    documentButton("Clear").click();
    await vi.waitFor(() =>
      expect(annotationTables.filterOf("synapses")).toBeUndefined(),
    );
    await vi.waitFor(() =>
      expect(statusLines()[0].textContent).not.toContain("filtered"),
    );
  });

  it("names invalid input and will not apply it", async () => {
    const { connection, annotationTables } = makeConnection(
      [synapses],
      [status({ table: "synapses" })],
      ["synapses"],
    );
    annotationTables.setFilter("synapses", SIZE_FILTER);
    await mountPanel(connection);
    await openFilterEditor();
    await userEvent.fill(valueInput(filterRows()[0]), "abc");
    await vi.waitFor(() =>
      expect(
        document.querySelector(".calcada-annotations-filter-editor")!
          .textContent,
      ).toContain('"abc" is not an integer'),
    );
    expect(documentButton("Apply").disabled).toBe(true);
    expect(annotationTables.filterOf("synapses")).toEqual(SIZE_FILTER);
  });

  it("applies on Enter and focuses each new row's value", async () => {
    const { connection, annotationTables } = makeConnection(
      [synapses],
      [status({ table: "synapses" })],
      ["synapses"],
    );
    await mountPanel(connection);
    await openFilterEditor();
    documentButton("Add condition").click();
    const row = await vi.waitFor(() => {
      expect(filterRows()).toHaveLength(1);
      return filterRows()[0];
    });
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(valueInput(row)),
    );
    await userEvent.keyboard("0.5{Enter}");
    await vi.waitFor(() =>
      expect(annotationTables.filterOf("synapses")).toEqual({
        filter_equal_dict: { value: 0.5 },
      }),
    );
  });

  it("moves focus to what follows a removed row", async () => {
    const { connection, annotationTables } = makeConnection(
      [synapses],
      [status({ table: "synapses" })],
      ["synapses"],
    );
    annotationTables.setFilter("synapses", {
      filter_greater_dict: { size: 10 },
      filter_equal_dict: { tag: "axon" },
    });
    await mountPanel(connection);
    await openFilterEditor();
    const removeButtons = () =>
      filterRows().map(
        (row) =>
          row.querySelector<HTMLElement>('[aria-label="Remove condition"]')!,
      );
    removeButtons()[0].click();
    await vi.waitFor(() => {
      expect(filterRows()).toHaveLength(1);
      expect(document.activeElement).toBe(removeButtons()[0]);
    });
    removeButtons()[0].click();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(documentButton("Add condition")),
    );
  });

  it("keeps typed keys from the viewer's bindings; Escape still closes", async () => {
    const { connection } = makeConnection(
      [synapses],
      [status({ table: "synapses" })],
      ["synapses"],
    );
    await mountPanel(connection);
    await openFilterEditor();
    documentButton("Add condition").click();
    await vi.waitFor(() => expect(filterRows()).toHaveLength(1));
    const reachedDocument = vi.fn();
    document.addEventListener("keydown", reachedDocument);
    try {
      await userEvent.keyboard("a");
      expect(reachedDocument).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() =>
        expect(
          document.querySelector(".calcada-annotations-filter-editor"),
        ).toBe(null),
      );
    } finally {
      document.removeEventListener("keydown", reachedDocument);
    }
  });

  it("fits the side panel without scrolling sideways", async () => {
    const { connection, session } = makeConnection(
      [synapses, nuclei],
      [
        status({ table: "synapses", annotations: 1000, fetchedRoots: 50 }),
        status({ table: "nuclei", annotations: 2, fetchedRoots: 1 }),
      ],
      ["synapses", "nuclei"],
    );
    session.drawn.value = [
      drawnAnnotation("synapses", BEYOND_SAFE_INTEGER_ID, [
        [123456, 234567, 34567],
        [123457, 234568, 34568],
      ]),
    ];
    await mountPanel(connection);
    const tabRight = tab.getBoundingClientRect().right;
    const overflowing = [...tab.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.getBoundingClientRect().right > tabRight + 1)
      .map(
        (element) =>
          `${element.tagName}.${element.className} ${Math.round(element.getBoundingClientRect().right - tabRight)}px`,
      );
    expect(overflowing).toEqual([]);
    expect(tab.scrollWidth).toBeLessThanOrEqual(tab.clientWidth);
  });
});

describe("CalcadaAnnotationTablesTab", () => {
  it("is labelled Tables", () => {
    expect(ANNOTATION_TABLES_TAB_LABEL).toBe("Tables");
  });
});
