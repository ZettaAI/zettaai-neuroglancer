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

import { useEffect, useRef, useState } from "react";

import {
  AnnotationType,
  annotationTypeHandlers,
} from "#src/annotation/index.js";
import {
  conditionCount,
  filterFields,
} from "#src/datasource/calcada/annotation_tables/annotation_filter.js";
import { AnnotationFilterEditor } from "#src/datasource/calcada/annotation_tables/annotation_filter_editor.js";
import type {
  AnnotationPayload,
  AnnotationPayloadValue,
  AnnotationTableFilter,
  AnnotationTableInfo,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type {
  AnnotationTableStatus,
  AnnotationTotals,
  PlacementType,
  TablePlacement,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { formatCount } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import type {
  DrawnAnnotation,
  DrawnRows,
} from "#src/datasource/calcada/annotation_tables/drawn_rows.js";
import { NO_DRAWN_ROWS } from "#src/datasource/calcada/annotation_tables/drawn_rows.js";
import { PayloadField } from "#src/datasource/calcada/annotation_tables/payload_field.js";
import { useSignalRerender } from "#src/editing/ui/interop/react/use_signal_rerender.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { AnnotationListColumnWidths } from "#src/ui/annotations.js";
import type { ArraySpliceOp } from "#src/util/array.js";
import { serializeColor } from "#src/util/color.js";
import { RefCounted } from "#src/util/disposable.js";
import type { vec3 } from "#src/util/geom.js";
import type { ReadonlySignal } from "#src/util/signal.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import type { VirtualListSource } from "#src/widget/virtual_list.js";
import { VirtualList } from "#src/widget/virtual_list.js";
import "#src/widget/icon.css";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export const ANNOTATION_ROW_HINT = "Click to select, right-click to move to it";

const SELECTED_ENTRY_CLASS = "neuroglancer-annotation-selected";

const LOADING_TEXT = "Loading…";

const PLACEMENT_HINT = "Ctrl+click in a view to place";
const PLACEMENT_TYPES: readonly PlacementType[] = [
  AnnotationType.POINT,
  AnnotationType.LINE,
];
const PLACEMENT_LABELS = new Map<PlacementType, string>([
  [AnnotationType.POINT, "Add point"],
  [AnnotationType.LINE, "Add line"],
]);
const OTHER_TYPE_HINT = "The table's rows are another kind of annotation";
const FILL_IN_PREFIX = "Fill in ";
const FILL_IN_SUFFIX = " to add";

export interface AnnotationTablesPanelSession {
  readonly tables: WatchableValueInterface<AnnotationTableInfo[] | undefined>;
  readonly status: WatchableValueInterface<AnnotationTableStatus[]>;
  readonly drawn: WatchableValueInterface<DrawnRows>;
  readonly listError: WatchableValueInterface<string | undefined>;
  readonly rootsNote: WatchableValueInterface<string | undefined>;
  readonly limitNote: WatchableValueInterface<string | undefined>;
  readonly totals: WatchableValueInterface<AnnotationTotals>;
  readonly placement: WatchableValueInterface<TablePlacement | undefined>;
  readonly placingChanged: ReadonlySignal<() => void>;
  isPlacing(): boolean;
  togglePlacing(): void;
  readonly newRowPayload: WatchableValueInterface<AnnotationPayload>;
  setNewRowValue(name: string, value: AnnotationPayloadValue | undefined): void;
  /** Required properties of the placement table not yet typed. */
  missingRequired(): string[];
  tableColor(name: string): vec3;
  readonly colorsChanged: ReadonlySignal<() => void>;
  refreshTables(): void;
  select(item: DrawnAnnotation): void;
  moveTo(item: DrawnAnnotation): void;
  makeListElement(item: DrawnAnnotation): [HTMLElement, number[]] | undefined;
  renderListHeader(
    item: DrawnAnnotation,
    header: HTMLElement,
    columnWidths: AnnotationListColumnWidths,
  ): boolean;
  isSelected(item: DrawnAnnotation): boolean;
  selectAdjacent(offset: number): void;
  selectedDrawnIndex(): number | undefined;
  readonly annotationSelectionChanged: ReadonlySignal<() => void>;
  readonly listCoordinatesChanged: ReadonlySignal<() => void>;
  clearHover(): void;
}

/**
 * What the panel needs from the graph connection, stated structurally so this
 * file never imports `frontend.ts` at runtime.
 */
export interface AnnotationTablesPanelConnection {
  readonly state: {
    readonly annotationTables: {
      readonly changed: NullarySignal;
      readonly ticked: readonly string[];
      setTicked(names: readonly string[]): void;
      filterOf(table: string): AnnotationTableFilter | undefined;
      setFilter(table: string, filter: AnnotationTableFilter | undefined): void;
      wholeTableOf(table: string): boolean;
      setWholeTable(table: string, on: boolean): void;
      setColor(table: string, color: string | undefined): void;
    };
  };
  readonly annotationTablesSession: AnnotationTablesPanelSession;
}

function Swatch({ color }: { color: vec3 }) {
  return (
    <span
      aria-hidden
      className="calcada-annotations-swatch"
      style={{ background: serializeColor(color) }}
    />
  );
}

function TablePicker({
  tables,
  ticked,
  tableColor,
  onChange,
}: {
  tables: AnnotationTableInfo[];
  ticked: readonly string[];
  tableColor: (name: string) => vec3;
  onChange: (names: string[]) => void;
}) {
  const anchor = useComboboxAnchor();
  const infoByName = new Map(tables.map((table) => [table.name, table]));
  const items = [...new Set([...infoByName.keys(), ...ticked])];
  return (
    <Combobox
      multiple
      items={items}
      value={[...ticked]}
      onValueChange={(next: string[]) => onChange(next)}
    >
      <ComboboxChips ref={anchor} className="calcada-annotations-picker">
        <ComboboxValue>
          {(selected: string[]) =>
            selected.map((name) => (
              <ComboboxChip
                key={name}
                className="calcada-annotations-chip"
                title={name}
              >
                <Swatch color={tableColor(name)} />
                <span className="calcada-annotations-table-name">{name}</span>
              </ComboboxChip>
            ))
          }
        </ComboboxValue>
        <ComboboxChipsInput
          placeholder={ticked.length === 0 ? "Choose tables" : ""}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No matching tables</ComboboxEmpty>
        <ComboboxList>
          {(name: string) => {
            const info = infoByName.get(name);
            return (
              <ComboboxItem key={name} value={name} title={info?.description}>
                <span className="calcada-annotations-table-name">{name}</span>
                {info !== undefined && (
                  <span className="calcada-annotations-table-schema">
                    {info.schemaName}@{info.schemaVersion}
                  </span>
                )}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function PlacementControl({
  placement,
  info,
  placing,
  missing,
  onToggle,
  onValue,
}: {
  placement: TablePlacement;
  info: AnnotationTableInfo | undefined;
  placing: boolean;
  missing: readonly string[];
  onToggle: () => void;
  onValue: (name: string, value: AnnotationPayloadValue | undefined) => void;
}) {
  const { type, blockedBy } = placement;
  const missingNote =
    missing.length > 0
      ? `${FILL_IN_PREFIX}${missing.join(", ")}${FILL_IN_SUFFIX}`
      : undefined;
  return (
    <div className="calcada-annotations-place">
      <div className="calcada-annotations-place-tools" role="toolbar">
        {PLACEMENT_TYPES.map((toolType) => {
          const label = PLACEMENT_LABELS.get(toolType)!;
          const pressed = placing && type === toolType;
          const disabled = type !== toolType || missingNote !== undefined;
          return (
            <div
              key={toolType}
              role="button"
              className="neuroglancer-icon"
              aria-label={label}
              aria-pressed={pressed}
              aria-disabled={disabled}
              title={type === toolType ? label : OTHER_TYPE_HINT}
              onClick={disabled ? undefined : onToggle}
            >
              {annotationTypeHandlers[toolType].icon}
            </div>
          );
        })}
      </div>
      {info !== undefined && (
        <div className="calcada-annotations-payload" key={info.name}>
          {Object.entries(info.properties).map(([name, propertyType]) => (
            <PayloadField
              key={name}
              name={name}
              type={propertyType}
              required={info.requiredProperties.includes(name)}
              onValue={(value) => onValue(name, value)}
            />
          ))}
        </div>
      )}
      <span className="calcada-annotations-empty">
        {blockedBy ?? missingNote ?? (placing ? PLACEMENT_HINT : undefined)}
      </span>
    </div>
  );
}

function FilterButton({
  info,
  filter,
  onApply,
}: {
  info: AnnotationTableInfo;
  filter: AnnotationTableFilter | undefined;
  onApply: (filter: AnnotationTableFilter | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="outline" />}>
        Filter
      </PopoverTrigger>
      <PopoverContent align="start" className="calcada-annotations-filter">
        <AnnotationFilterEditor
          fields={filterFields(info.properties)}
          filter={filter}
          onApply={(next) => {
            onApply(next);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function TableStatusLine({
  info,
  status,
  counted,
  color,
  filter,
  onFilter,
  wholeTable,
  onWholeTable,
  onColor,
}: {
  info: AnnotationTableInfo;
  status: AnnotationTableStatus | undefined;
  /** Shown while none of the table is drawn: counting, or over the limit. */
  counted: number;
  color: vec3;
  filter: AnnotationTableFilter | undefined;
  onFilter: (filter: AnnotationTableFilter | undefined) => void;
  wholeTable: boolean;
  onWholeTable: (on: boolean) => void;
  onColor: (color: string) => void;
}) {
  const conditions = conditionCount(filter);
  const drawn = status?.annotations ?? 0;
  const shown = drawn > 0 ? drawn : counted;
  return (
    <li className="calcada-annotations-table">
      <div className="calcada-annotations-table-header">
        <input
          type="color"
          className="calcada-annotations-color"
          title="Table colour"
          value={serializeColor(color)}
          onInput={(event) => onColor(event.currentTarget.value)}
        />
        <span className="calcada-annotations-table-name">{info.name}</span>
        {conditions > 0 && (
          <span className="calcada-annotations-filtered">
            filtered: {conditions}{" "}
            {conditions === 1 ? "condition" : "conditions"}
          </span>
        )}
        <FilterButton info={info} filter={filter} onApply={onFilter} />
        <label className="calcada-annotations-whole-table">
          <input
            type="checkbox"
            checked={wholeTable}
            onChange={(event) => onWholeTable(event.target.checked)}
          />
          Whole table
        </label>
      </div>
      {status?.note !== undefined && (
        <div className="calcada-annotations-empty">{status.note}</div>
      )}
      {status !== undefined && status.note === undefined && (
        <div>
          {status.loading && shown === 0 ? (
            LOADING_TEXT
          ) : (
            <>
              {formatCount(shown)} {shown === 1 ? "annotation" : "annotations"}
              {drawn > 0 && !wholeTable && (
                <>
                  {" "}
                  on {status.fetchedRoots}{" "}
                  {status.fetchedRoots === 1 ? "segment" : "segments"}
                </>
              )}
              {status.loading && (
                <span className="calcada-annotations-loading">
                  {LOADING_TEXT}
                </span>
              )}
            </>
          )}
        </div>
      )}
      {status?.error !== undefined && (
        <div className="calcada-annotations-error">{status.error}</div>
      )}
    </li>
  );
}

/** One splice from `before` to `after` that keeps their common ends; none if equal. */
function drawnSplice(
  before: DrawnRows,
  after: DrawnRows,
): ArraySpliceOp | undefined {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before.isSameRow(prefix, after, prefix)) {
    ++prefix;
  }
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before.isSameRow(
      before.length - 1 - suffix,
      after,
      after.length - 1 - suffix,
    )
  ) {
    ++suffix;
  }
  const deleteCount = before.length - prefix - suffix;
  const insertCount = after.length - prefix - suffix;
  if (deleteCount === 0 && insertCount === 0) return undefined;
  return { retainCount: prefix, deleteCount, insertCount };
}

/**
 * NG's header row over NG's `VirtualList` of NG's own entries, the table's
 * colour on each type symbol.
 */
class DrawnAnnotationListView extends RefCounted {
  readonly element = document.createElement("div");
  private readonly header = document.createElement("div");
  private headerShown = false;
  private items = NO_DRAWN_ROWS;
  private readonly source = {
    length: 0,
    render: (index: number) => this.render(this.items.at(index)),
    changed: new Signal<(splices: ArraySpliceOp[]) => void>(),
    renderChanged: new NullarySignal(),
  } satisfies VirtualListSource;
  private readonly list = this.registerDisposer(
    new VirtualList({ source: this.source }),
  );
  private readonly columnWidths = new AnnotationListColumnWidths(this.element);

  constructor(private readonly session: AnnotationTablesPanelSession) {
    super();
    this.element.className = "calcada-annotations-list-view";
    this.header.className = "neuroglancer-annotation-list-header";
    const { element } = this.list;
    element.className = "calcada-annotations-list";
    element.title = ANNOTATION_ROW_HINT;
    element.addEventListener("mouseleave", () => session.clearHover());
    this.element.append(this.header, element);
    this.registerDisposer(
      session.annotationSelectionChanged.add(() => this.showSelection()),
    );
    this.registerDisposer(
      session.listCoordinatesChanged.add(() => {
        this.columnWidths.reset();
        this.headerShown = false;
        this.source.renderChanged.dispatch();
      }),
    );
    this.registerDisposer(
      session.colorsChanged.add(() => this.source.renderChanged.dispatch()),
    );
  }

  show(items: DrawnRows) {
    const splice = drawnSplice(this.items, items);
    this.items = items;
    this.source.length = items.length;
    if (splice !== undefined) this.source.changed.dispatch([splice]);
  }

  private showSelection() {
    this.list.forEachRenderedItem((element, index) =>
      element.classList.toggle(
        SELECTED_ENTRY_CLASS,
        this.session.isSelected(this.items.at(index)),
      ),
    );
    const selected = this.session.selectedDrawnIndex();
    if (selected !== undefined) this.list.scrollItemIntoView(selected);
  }

  private render(item: DrawnAnnotation): HTMLElement {
    const { session } = this;
    const entry = session.makeListElement(item);
    if (entry === undefined) return document.createElement("div");
    if (!this.headerShown) {
      this.headerShown = session.renderListHeader(
        item,
        this.header,
        this.columnWidths,
      );
    }
    const [element, widths] = entry;
    for (const [column, width] of widths.entries()) {
      this.columnWidths.widen(column, width);
    }
    const icon = element.querySelector<HTMLElement>(
      ".neuroglancer-annotation-icon",
    );
    if (icon !== null) {
      icon.style.color = serializeColor(session.tableColor(item.table));
    }
    element.classList.toggle(SELECTED_ENTRY_CLASS, session.isSelected(item));
    element.addEventListener("click", () => session.select(item));
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      session.moveTo(item);
    });
    return element;
  }
}

function DrawnAnnotationList({
  session,
  drawn,
}: {
  session: AnnotationTablesPanelSession;
  drawn: DrawnRows;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const view = useRef<DrawnAnnotationListView>(undefined);
  useEffect(() => {
    const created = new DrawnAnnotationListView(session);
    holder.current!.appendChild(created.element);
    view.current = created;
    return () => {
      created.dispose();
      view.current = undefined;
    };
  }, [session]);
  useEffect(() => view.current?.show(drawn), [session, drawn]);
  return <div ref={holder} className="calcada-annotations-list-holder" />;
}

export function CalcadaAnnotationTablesPanel({
  connection,
}: {
  connection: AnnotationTablesPanelConnection;
}) {
  const { annotationTables } = connection.state;
  const session = connection.annotationTablesSession;
  useSignalRerender(annotationTables.changed);
  const tables = useWatchable(session.tables);
  const statuses = useWatchable(session.status);
  const drawn = useWatchable(session.drawn);
  const listError = useWatchable(session.listError);
  const rootsNote = useWatchable(session.rootsNote);
  const limitNote = useWatchable(session.limitNote);
  const totals = useWatchable(session.totals);
  const placement = useWatchable(session.placement);
  useSignalRerender(session.newRowPayload.changed);
  useSignalRerender(session.placingChanged);
  const infoByName = new Map(tables?.map((table) => [table.name, table]));
  const orphans = statuses.filter(
    (status) =>
      (status.error !== undefined || status.note !== undefined) &&
      !infoByName.has(status.table),
  );
  const tableColor = (name: string) => session.tableColor(name);
  return (
    <div className="calcada-annotations-panel">
      <div className="calcada-annotations-controls">
        <div className="calcada-annotations-header">
          <span>Annotation tables</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => session.refreshTables()}
          >
            Refresh
          </Button>
        </div>
        {listError !== undefined && (
          <div className="calcada-annotations-error">{listError}</div>
        )}
        {rootsNote !== undefined && (
          <div className="calcada-annotations-empty">{rootsNote}</div>
        )}
        {orphans.map((status) =>
          status.error !== undefined ? (
            <div key={status.table} className="calcada-annotations-error">
              {status.error}
            </div>
          ) : (
            <div key={status.table} className="calcada-annotations-empty">
              {status.table}: {status.note}
            </div>
          ),
        )}
        {tables === undefined ? (
          listError === undefined && (
            <div className="calcada-annotations-empty">
              Loading annotation tables…
            </div>
          )
        ) : tables.length === 0 ? (
          <div className="calcada-annotations-empty">
            No annotation tables on this graph
          </div>
        ) : (
          <>
            <TablePicker
              tables={tables}
              ticked={annotationTables.ticked}
              tableColor={tableColor}
              onChange={(names) => annotationTables.setTicked(names)}
            />
            <ul className="calcada-annotations-tables">
              {annotationTables.ticked.map((name) => {
                const info = infoByName.get(name);
                return (
                  info !== undefined && (
                    <TableStatusLine
                      key={name}
                      info={info}
                      status={statuses.find((status) => status.table === name)}
                      counted={totals.byTable.get(name) ?? 0}
                      color={tableColor(name)}
                      filter={annotationTables.filterOf(name)}
                      onFilter={(filter) =>
                        annotationTables.setFilter(name, filter)
                      }
                      wholeTable={annotationTables.wholeTableOf(name)}
                      onWholeTable={(on) =>
                        annotationTables.setWholeTable(name, on)
                      }
                      onColor={(color) =>
                        annotationTables.setColor(name, color)
                      }
                    />
                  )
                );
              })}
            </ul>
          </>
        )}
        {limitNote !== undefined && (
          <div className="calcada-annotations-limit">{limitNote}</div>
        )}
        {placement !== undefined && (
          <PlacementControl
            placement={placement}
            info={tables?.find(({ name }) => name === placement.table)}
            placing={session.isPlacing()}
            missing={session.missingRequired()}
            onToggle={() => session.togglePlacing()}
            onValue={(name, value) => session.setNewRowValue(name, value)}
          />
        )}
      </div>
      {limitNote === undefined && (
        <DrawnAnnotationList session={session} drawn={drawn} />
      )}
    </div>
  );
}
