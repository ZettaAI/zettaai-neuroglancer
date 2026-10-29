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

import type { AnnotationLayerState } from "#src/annotation/annotation_layer_state.js";
import { AnnotationType } from "#src/annotation/index.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import type { AnnotationTableInfo } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { AnnotationTablesPanelConnection } from "#src/datasource/calcada/annotation_tables/annotation_tables_panel.js";
import {
  ANNOTATION_ROW_HINT,
  CalcadaAnnotationTablesPanel,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_panel.js";
import type {
  AnnotationTableStatus,
  AnnotationTotals,
  DrawnAnnotation,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import {
  annotationLimitNote,
  MAX_DRAWN_ANNOTATIONS,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { CalcadaAnnotationTablesState } from "#src/datasource/calcada/annotation_tables/annotation_tables_state.js";
import { ANNOTATION_TABLES_TAB_LABEL } from "#src/datasource/calcada/annotation_tables/annotation_tables_tab.js";
import { CalcadaTableAnnotationSource } from "#src/datasource/calcada/annotation_tables/table_annotation_source.js";
import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import { WatchableValue } from "#src/trackable_value.js";
import type {
  AnnotationListColumnWidths,
  UserLayerWithAnnotations,
} from "#src/ui/annotations.js";
import {
  annotationListGridTemplate,
  makeAnnotationListElement,
  renderAnnotationListHeader,
} from "#src/ui/annotations.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import { NullarySignal, Signal } from "#src/util/signal.js";

const SIDE_PANEL_WIDTH_PX = 260;
const SWATCH_COLOR = vec3.fromValues(1, 0, 0);
const BEYOND_SAFE_INTEGER_ID = 9007199254740993n;
const LONG_LIST_LENGTH = 120;
const LIST_SCROLL_PX = 200;
const APPENDED_ROWS = 10;
const MANY_TABLES = 40;
/** Below 2^24, so float32 positions show every digit. */
const POSITION_MODULUS = 10_000_000n;
const WIDE_ID = 9_999_999n;
const NARROW_ID = 1n;
const LIST_COLUMN_PADDING = 2;
const HEADER_DIMENSION_EXTRA = 3;
const COUNTED_TOTAL = 1_234_567;
const FIRST_COLUMN_WIDTH = "--neuroglancer-column-0-width";
const SELECTED_ENTRY = "neuroglancer-annotation-selected";
const DIMENSIONS = ["x", "y", "z"];
const IDENTITY_CHUNK_TO_LAYER = Float32Array.of(
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
);

const synapses: AnnotationTableInfo = {
  name: "synapses",
  schemaName: "synapse",
  schemaVersion: 2,
  description: "Predicted synapses",
  voxelResolution: [4, 4, 40],
  points: ["pre", "post"],
  properties: { size: "integer", tag: "string" },
  canWrite: false,
};
const nuclei: AnnotationTableInfo = {
  name: "nuclei",
  schemaName: "point",
  schemaVersion: 1,
  description: "",
  voxelResolution: [4, 4, 40],
  points: ["center"],
  properties: {},
  canWrite: false,
};

const status = (
  overrides: Partial<AnnotationTableStatus> & { table: string },
): AnnotationTableStatus => ({
  annotations: 0,
  fetchedRoots: 0,
  ...overrides,
});

const drawnAnnotation = (table: string, id: bigint): DrawnAnnotation => ({
  table,
  layerId: `${table}:${id}`,
  id,
  value: Number(id % 100n) / 100,
});

const drawnRun = (table: string, length: number) =>
  Array.from({ length }, (_, index) =>
    drawnAnnotation(table, BigInt(index + 1)),
  );

const refreshed = vi.fn();

const metreSpace = (names: string[]) =>
  makeCoordinateSpace({
    names,
    units: names.map(() => "m"),
    scales: Float64Array.from(names, () => 1),
  });

const listLayer = {
  annotationDisplayState: { hoverState: new WatchableValue(undefined) },
  selectAnnotation: vi.fn(),
  manager: { root: { coordinateSpace: { value: metreSpace(DIMENSIONS) } } },
  localCoordinateSpace: { value: metreSpace([]) },
} as unknown as UserLayerWithAnnotations;

function tableLayerState(isReadonly: () => boolean) {
  const source = new CalcadaTableAnnotationSource(
    new WatchableCoordinateSpaceTransform(
      makeIdentityTransform(metreSpace(DIMENSIONS)),
    ),
    new WatchableValue([]),
    ["associated segments"],
    { isReadonly, onDelete: () => Promise.resolve() },
  );
  return {
    source,
    displayState: { color: new WatchableValue(vec3.create()) },
    chunkTransform: {
      value: {
        layerRank: DIMENSIONS.length,
        chunkToLayerTransform: IDENTITY_CHUNK_TO_LAYER,
        modelTransform: {
          globalToRenderLayerDimensions: DIMENSIONS.map((_, i) => i),
          localToRenderLayerDimensions: [],
        },
      },
    },
  } as unknown as AnnotationLayerState;
}

/** Builds NG's real list entry, as the session does through the connection. */
const nativeListElement = (
  state: AnnotationLayerState,
  item: DrawnAnnotation,
  description: string | undefined,
) =>
  makeAnnotationListElement(
    listLayer,
    {
      id: item.layerId,
      type: AnnotationType.POINT,
      point: Float32Array.of(Number(item.id % POSITION_MODULUS), 2, 3),
      relatedSegments: [BigUint64Array.of()],
      properties: [],
      description,
    },
    state,
    annotationListGridTemplate(DIMENSIONS.length),
    DIMENSIONS.map((_, i) => i),
    [],
  );

class FakeSession {
  readonly tables: WatchableValue<AnnotationTableInfo[] | undefined>;
  readonly status = new WatchableValue<AnnotationTableStatus[]>([]);
  readonly drawn = new WatchableValue<DrawnAnnotation[]>([]);
  readonly listError = new WatchableValue<string | undefined>(undefined);
  readonly rootsNote = new WatchableValue<string | undefined>(undefined);
  readonly limitNote = new WatchableValue<string | undefined>(undefined);
  readonly totals = new WatchableValue<AnnotationTotals>({
    complete: true,
    total: 0,
    byTable: new Map(),
  });
  readonly select = vi.fn<(item: DrawnAnnotation) => void>();
  readonly moveTo = vi.fn<(item: DrawnAnnotation) => void>();
  readonly clearHover = vi.fn();
  readonly selectedId = new WatchableValue<string | undefined>(undefined);
  readonly annotationSelectionChanged = this.selectedId.changed;
  readonly listCoordinatesChanged = new NullarySignal();
  readonly annotationUpdated = new Signal<
    (table: string, layerId: string) => void
  >();
  readonly descriptions = new Map<string, string>();
  private readonly color = SWATCH_COLOR;
  private readonly layerStates = new Map<string, AnnotationLayerState>();

  constructor(tables: AnnotationTableInfo[] | undefined) {
    this.tables = new WatchableValue(tables);
  }

  tableColor(_name: string) {
    return this.color;
  }

  makeListElement(item: DrawnAnnotation) {
    let state = this.layerStates.get(item.table);
    if (state === undefined) {
      state = tableLayerState(
        () =>
          !this.tables.value?.find(({ name }) => name === item.table)?.canWrite,
      );
      this.layerStates.set(item.table, state);
    }
    return nativeListElement(state, item, this.descriptions.get(item.layerId));
  }

  renderListHeader(
    _item: DrawnAnnotation,
    header: HTMLElement,
    columnWidths: AnnotationListColumnWidths,
  ) {
    renderAnnotationListHeader(
      header,
      listLayer,
      {
        globalDimensionIndices: DIMENSIONS.map((_, i) => i),
        localDimensionIndices: [],
      },
      columnWidths,
    );
    return true;
  }

  isSelected(item: DrawnAnnotation) {
    return item.layerId === this.selectedId.value;
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
const annotationList = () =>
  tab.querySelector<HTMLElement>(".calcada-annotations-list");
const listView = () =>
  tab.querySelector<HTMLElement>(".calcada-annotations-list-view");
const listHeader = () =>
  tab.querySelector<HTMLElement>(
    ".calcada-annotations-list-view .neuroglancer-annotation-list-header",
  );
/** The width the header asks of a dimension's column. */
const headerColumnWidth = () => {
  const dimension = listHeader()!.querySelector(
    ".neuroglancer-annotations-view-dimension",
  )!;
  return `${dimension.textContent!.length + HEADER_DIMENSION_EXTRA + LIST_COLUMN_PADDING}ch`;
};
const listRows = () => [
  ...tab.querySelectorAll<HTMLElement>(
    ".calcada-annotations-list .neuroglancer-annotation-list-entry",
  ),
];
const nextFrame = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );

async function renderedRows(count: number) {
  await vi.waitFor(() => expect(listRows()).toHaveLength(count));
  return listRows();
}

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

  it("rows are native annotation list entries with the table colour on the icon", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    session.drawn.value = [drawnAnnotation("synapses", BEYOND_SAFE_INTEGER_ID)];
    await mountPanel(connection);
    const [row] = await renderedRows(1);
    const icon = row.querySelector<HTMLElement>(
      ".neuroglancer-annotation-icon",
    )!;
    expect(icon.style.color).toBe("rgb(255, 0, 0)");
    expect(row.querySelector(".calcada-annotations-swatch")).toBe(null);
    expect(row.textContent).not.toContain("synapses");
  });

  it("no paging controls", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    session.drawn.value = drawnRun("synapses", LONG_LIST_LENGTH);
    await mountPanel(connection);
    await vi.waitFor(() => expect(listRows().length).toBeGreaterThan(0));
    expect(buttonLabelled("Previous page")).toBeUndefined();
    expect(buttonLabelled("Next page")).toBeUndefined();
  });

  it("header stays while the list scrolls", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [status({ table: "synapses", annotations: LONG_LIST_LENGTH })],
      ["synapses"],
    );
    session.drawn.value = drawnRun("synapses", LONG_LIST_LENGTH);
    await mountPanel(connection);
    await vi.waitFor(() => expect(listRows().length).toBeGreaterThan(0));
    const list = annotationList()!;
    list.scrollTop = LIST_SCROLL_PX;
    await vi.waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
    const tabTop = tab.getBoundingClientRect().top;
    expect(tab.scrollTop).toBe(0);
    for (const fixed of [pickerInput(), statusLines()[0]]) {
      expect(fixed.getBoundingClientRect().top).toBeGreaterThanOrEqual(tabTop);
      expect(fixed.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        list.getBoundingClientRect().top,
      );
    }
  });

  it("keeps the list scroll when only the statuses' counts change", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [status({ table: "synapses", annotations: 10 })],
      ["synapses"],
    );
    session.drawn.value = drawnRun("synapses", LONG_LIST_LENGTH);
    await mountPanel(connection);
    await vi.waitFor(() => expect(listRows().length).toBeGreaterThan(0));
    const list = annotationList()!;
    list.scrollTop = LIST_SCROLL_PX;
    await vi.waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
    await nextFrame();
    const scrolled = list.scrollTop;
    session.status.value = [status({ table: "synapses", annotations: 11 })];
    await vi.waitFor(() =>
      expect(statusLines()[0].textContent).toContain("11 annotations"),
    );
    expect(annotationList()).toBe(list);
    expect(list.scrollTop).toBe(scrolled);
  });

  it("keeps the list scroll when rows change below the shown ones", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    session.drawn.value = drawnRun("synapses", LONG_LIST_LENGTH);
    await mountPanel(connection);
    await vi.waitFor(() => expect(listRows().length).toBeGreaterThan(0));
    const list = annotationList()!;
    list.scrollTop = LIST_SCROLL_PX;
    await vi.waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
    await nextFrame();
    const scrolled = list.scrollTop;
    const heightBefore = list.scrollHeight;
    const firstShown = listRows()[0].dataset.annotationId;
    session.drawn.value = drawnRun(
      "synapses",
      LONG_LIST_LENGTH + APPENDED_ROWS,
    );
    await vi.waitFor(() =>
      expect(list.scrollHeight).toBeGreaterThan(heightBefore),
    );
    await nextFrame();
    expect(list.scrollTop).toBe(scrolled);
    expect(listRows()[0].dataset.annotationId).toBe(firstShown);
  });

  it("lines the columns up on the list and resets them with the coordinates", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    session.drawn.value = [
      drawnAnnotation("synapses", WIDE_ID),
      drawnAnnotation("synapses", NARROW_ID),
    ];
    await mountPanel(connection);
    const rows = await renderedRows(2);
    const view = listView()!;
    const wide = `${String(WIDE_ID).length + LIST_COLUMN_PADDING}ch`;
    expect(view.style.getPropertyValue(FIRST_COLUMN_WIDTH)).toBe(wide);
    for (const row of [...rows, listHeader()!]) {
      expect(row.style.getPropertyValue(FIRST_COLUMN_WIDTH)).toBe("");
    }
    session.drawn.value = [drawnAnnotation("synapses", NARROW_ID)];
    await renderedRows(1);
    expect(view.style.getPropertyValue(FIRST_COLUMN_WIDTH)).toBe(wide);
    session.listCoordinatesChanged.dispatch();
    await vi.waitFor(() =>
      expect(view.style.getPropertyValue(FIRST_COLUMN_WIDTH)).toBe(
        headerColumnWidth(),
      ),
    );
  });

  it("shows a header row with the dimension names above the list", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    session.drawn.value = drawnRun("synapses", LONG_LIST_LENGTH);
    await mountPanel(connection);
    await vi.waitFor(() => expect(listRows().length).toBeGreaterThan(0));
    const header = listHeader()!;
    const names = [
      ...header.querySelectorAll(
        ".neuroglancer-annotations-view-dimension-name",
      ),
    ].map((name) => name.textContent);
    expect(names).toEqual(DIMENSIONS);
    expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      annotationList()!.getBoundingClientRect().top,
    );
    const firstDimension = listRows()[0].querySelector(
      ".neuroglancer-annotation-coordinate",
    )!;
    const headerDimension = header.querySelector(
      ".neuroglancer-annotations-view-dimension",
    )!;
    expect(headerDimension.getBoundingClientRect().left).toBe(
      firstDimension.getBoundingClientRect().left,
    );
    annotationList()!.scrollTop = LIST_SCROLL_PX;
    await vi.waitFor(() =>
      expect(annotationList()!.scrollTop).toBeGreaterThan(0),
    );
    expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      annotationList()!.getBoundingClientRect().top,
    );
  });

  it("shows the counted total while nothing of the table is drawn", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [status({ table: "synapses" })],
      ["synapses"],
    );
    session.totals.value = {
      complete: false,
      total: COUNTED_TOTAL,
      byTable: new Map([["synapses", COUNTED_TOTAL]]),
    };
    await mountPanel(connection);
    expect(statusLines()[0].textContent).toContain("1 234 567 annotations");
    expect(statusLines()[0].textContent).not.toContain("segments");
    session.status.value = [
      status({
        table: "synapses",
        annotations: COUNTED_TOTAL,
        fetchedRoots: 2,
      }),
    ];
    await vi.waitFor(() =>
      expect(statusLines()[0].textContent).toContain(
        "1 234 567 annotations on 2 segments",
      ),
    );
  });

  it("clears the hover when the mouse leaves the list", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    session.drawn.value = [drawnAnnotation("synapses", 1n)];
    await mountPanel(connection);
    await renderedRows(1);
    annotationList()!.dispatchEvent(new MouseEvent("mouseleave"));
    expect(session.clearHover).toHaveBeenCalledTimes(1);
  });

  it("keeps room for the list under many selected tables", async () => {
    const many = Array.from({ length: MANY_TABLES }, (_, i) => ({
      ...nuclei,
      name: `table${i}`,
    }));
    const { connection } = makeConnection(
      many,
      [],
      many.map(({ name }) => name),
    );
    await mountPanel(connection);
    const controls = tab.querySelector<HTMLElement>(
      ".calcada-annotations-controls",
    )!;
    expect(controls.scrollHeight).toBeGreaterThan(controls.clientHeight);
    expect(annotationList()!.clientHeight).toBeGreaterThan(0);
  });

  it("highlights the selected row", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    const [first, second] = [
      drawnAnnotation("synapses", 1n),
      drawnAnnotation("synapses", 2n),
    ];
    session.drawn.value = [first, second];
    session.selectedId.value = first.layerId;
    await mountPanel(connection);
    const rows = await renderedRows(2);
    expect(rows.map((row) => row.classList.contains(SELECTED_ENTRY))).toEqual([
      true,
      false,
    ]);
    session.selectedId.value = second.layerId;
    expect(rows.map((row) => row.classList.contains(SELECTED_ENTRY))).toEqual([
      false,
      true,
    ]);
  });

  it("shows a row's description once the session fills it", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    const item = drawnAnnotation("synapses", 1n);
    session.drawn.value = [item];
    await mountPanel(connection);
    await renderedRows(1);
    session.descriptions.set(item.layerId, "tag: soma");
    session.annotationUpdated.dispatch(item.table, item.layerId);
    await vi.waitFor(() =>
      expect(listRows()[0].textContent).toContain("tag: soma"),
    );
  });

  it("limit message replaces the list", async () => {
    const { connection, session } = makeConnection(
      [synapses],
      [],
      ["synapses"],
    );
    const note = annotationLimitNote({
      complete: true,
      total: MAX_DRAWN_ANNOTATIONS + 1,
      byTable: new Map([["synapses", MAX_DRAWN_ANNOTATIONS + 1]]),
    })!;
    session.drawn.value = [drawnAnnotation("synapses", 1n)];
    session.limitNote.value = note;
    await mountPanel(connection);
    expect(tab.textContent).toContain(note);
    expect(annotationList()).toBe(null);
    session.limitNote.value = undefined;
    await renderedRows(1);
    expect(tab.textContent).not.toContain(note);
  });

  it("delete button only with write", async () => {
    const writable = { ...nuclei, canWrite: true };
    const { connection, session } = makeConnection(
      [synapses, writable],
      [],
      ["synapses", "nuclei"],
    );
    session.drawn.value = [
      drawnAnnotation("synapses", 1n),
      drawnAnnotation("nuclei", 2n),
    ];
    await mountPanel(connection);
    const [readOnlyRow, writableRow] = await renderedRows(2);
    const deleteButton = ".neuroglancer-annotation-list-entry-delete";
    expect(readOnlyRow.querySelector(deleteButton)).toBe(null);
    expect(writableRow.querySelector(deleteButton)).not.toBe(null);
  });

  it("switches a table to the whole table and back", async () => {
    const { connection, annotationTables } = makeConnection(
      [synapses],
      [status({ table: "synapses", annotations: 4, fetchedRoots: 2 })],
      ["synapses"],
    );
    await mountPanel(connection);
    const wholeTable = () =>
      statusLines()[0].querySelector<HTMLInputElement>(
        ".calcada-annotations-whole-table input",
      )!;
    expect(wholeTable().checked).toBe(false);
    wholeTable().click();
    await vi.waitFor(() =>
      expect(annotationTables.wholeTableOf("synapses")).toBe(true),
    );
    await vi.waitFor(() => expect(wholeTable().checked).toBe(true));
    expect(statusLines()[0].textContent).toContain("4 annotations");
    expect(statusLines()[0].textContent).not.toContain("segments");
    wholeTable().click();
    await vi.waitFor(() =>
      expect(annotationTables.wholeTableOf("synapses")).toBe(false),
    );
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
    const rows = await renderedRows(2);
    expect(annotationList()!.title).toBe(ANNOTATION_ROW_HINT);
    rows[1].click();
    expect(session.select).toHaveBeenCalledExactlyOnceWith(target);
    expect(session.moveTo).not.toHaveBeenCalled();
    const rightClick = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    rows[1].dispatchEvent(rightClick);
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
    session.drawn.value = [drawnAnnotation("synapses", BEYOND_SAFE_INTEGER_ID)];
    await mountPanel(connection);
    await renderedRows(1);
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
