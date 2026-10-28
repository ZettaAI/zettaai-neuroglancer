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

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import {
  conditionCount,
  filterFields,
} from "#src/datasource/calcada/annotation_tables/annotation_filter.js";
import { AnnotationFilterEditor } from "#src/datasource/calcada/annotation_tables/annotation_filter_editor.js";
import { FIRST_PAGE } from "#src/datasource/calcada/annotation_tables/annotation_page_windows.js";
import type {
  AnnotationTableFilter,
  AnnotationTableInfo,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type {
  AnnotationTableStatus,
  DrawnAnnotation,
} from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { ANNOTATIONS_PER_PAGE } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { useSignalRerender } from "#src/editing/ui/interop/react/use_signal_rerender.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { vec3 } from "#src/util/geom.js";
import type { NullarySignal } from "#src/util/signal.js";
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

export const ANNOTATION_LIST_PAGE_SIZE = 50;

const THOUSANDS_GROUP = /\B(?=(\d{3})+$)/g;
const formatCount = (count: number) =>
  String(count).replace(THOUSANDS_GROUP, " ");
const PREVIOUS_SERVER_PAGE_LABEL = `Previous ${ANNOTATIONS_PER_PAGE}`;
const NEXT_SERVER_PAGE_LABEL = `Next ${ANNOTATIONS_PER_PAGE}`;
const RGB_MAX = 255;

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
    };
  };
  readonly annotationTablesSession: {
    readonly tables: WatchableValueInterface<AnnotationTableInfo[] | undefined>;
    readonly status: WatchableValueInterface<AnnotationTableStatus[]>;
    readonly drawn: WatchableValueInterface<DrawnAnnotation[]>;
    readonly listError: WatchableValueInterface<string | undefined>;
    readonly rootsNote: WatchableValueInterface<string | undefined>;
    tableColor(name: string): vec3;
    refreshTables(): void;
    nextPage(table: string): void;
    previousPage(table: string): void;
    moveTo(item: DrawnAnnotation): void;
  };
}

function cssColor(color: vec3): string {
  const [red, green, blue] = Array.from(color, (channel) =>
    Math.round(channel * RGB_MAX),
  );
  return `rgb(${red} ${green} ${blue})`;
}

function Swatch({ color }: { color: vec3 }) {
  return (
    <span
      aria-hidden
      className="calcada-annotations-swatch"
      style={{ background: cssColor(color) }}
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
  color,
  filter,
  onFilter,
  onPrevious,
  onNext,
}: {
  info: AnnotationTableInfo;
  status: AnnotationTableStatus | undefined;
  color: vec3;
  filter: AnnotationTableFilter | undefined;
  onFilter: (filter: AnnotationTableFilter | undefined) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const conditions = conditionCount(filter);
  return (
    <li className="calcada-annotations-table">
      <div className="calcada-annotations-table-header">
        <Swatch color={color} />
        <span className="calcada-annotations-table-name">{info.name}</span>
        {conditions > 0 && (
          <span className="calcada-annotations-filtered">
            filtered: {conditions}{" "}
            {conditions === 1 ? "condition" : "conditions"}
          </span>
        )}
        <FilterButton info={info} filter={filter} onApply={onFilter} />
      </div>
      {status?.note !== undefined && (
        <div className="calcada-annotations-empty">{status.note}</div>
      )}
      {status !== undefined && status.note === undefined && (
        <>
          <div>
            {status.annotations}{" "}
            {status.annotations === 1 ? "annotation" : "annotations"} on{" "}
            {status.fetchedRoots}{" "}
            {status.fetchedRoots === 1 ? "segment" : "segments"}
          </div>
          <div className="calcada-annotations-pager">
            <span>Page {status.page}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={!status.hasPrevious}
              onClick={onPrevious}
            >
              {PREVIOUS_SERVER_PAGE_LABEL}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!status.hasNext}
              onClick={onNext}
            >
              {NEXT_SERVER_PAGE_LABEL}
            </Button>
          </div>
        </>
      )}
      {status?.error !== undefined && (
        <div className="calcada-annotations-error">{status.error}</div>
      )}
    </li>
  );
}

function AnnotationRow({
  item,
  color,
  onPick,
}: {
  item: DrawnAnnotation;
  color: vec3;
  onPick: () => void;
}) {
  const { annotation } = item;
  return (
    <li>
      <button
        type="button"
        className="calcada-annotations-row"
        onClick={onPick}
      >
        <span className="calcada-annotations-row-header">
          <Swatch color={color} />
          <span className="calcada-annotations-table-name">{item.table}</span>
          <span className="calcada-annotations-row-id">
            {String(annotation.id)}
          </span>
          <span>{String(annotation.value)}</span>
        </span>
        {annotation.points.map((point) => (
          <span
            key={point.name}
            className="calcada-annotations-row-position"
            title={point.name}
          >
            {point.position.join(", ")}
          </span>
        ))}
      </button>
    </li>
  );
}

function AnnotationList({
  drawn,
  tableColor,
  onPick,
}: {
  drawn: DrawnAnnotation[];
  tableColor: (name: string) => vec3;
  onPick: (item: DrawnAnnotation) => void;
}) {
  const [listPage, setListPage] = useState(0);
  const lastPage = Math.max(
    0,
    Math.ceil(drawn.length / ANNOTATION_LIST_PAGE_SIZE) - 1,
  );
  if (listPage > lastPage) setListPage(lastPage);
  if (drawn.length === 0) return null;
  const page = Math.min(listPage, lastPage);
  const start = page * ANNOTATION_LIST_PAGE_SIZE;
  const shown = drawn.slice(start, start + ANNOTATION_LIST_PAGE_SIZE);
  return (
    <div className="calcada-annotations-list">
      <div className="calcada-annotations-pager">
        <span className="calcada-annotations-list-range">
          {formatCount(start + 1)}–{formatCount(start + shown.length)} of{" "}
          {formatCount(drawn.length)}
        </span>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Previous page"
          disabled={page === 0}
          onClick={() => setListPage((current) => current - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Next page"
          disabled={page === lastPage}
          onClick={() => setListPage((current) => current + 1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
      <ul className="calcada-annotations-rows">
        {shown.map((item) => (
          <AnnotationRow
            key={`${item.table}:${item.layerId}`}
            item={item}
            color={tableColor(item.table)}
            onPick={() => onPick(item)}
          />
        ))}
      </ul>
    </div>
  );
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
  const infoByName = new Map(tables?.map((table) => [table.name, table]));
  const orphans = statuses.filter(
    (status) =>
      (status.error !== undefined || status.note !== undefined) &&
      !infoByName.has(status.table),
  );
  const tableColor = (name: string) => session.tableColor(name);
  const pageOf = (name: string) =>
    statuses.find((status) => status.table === name)?.page ?? FIRST_PAGE;
  const shownPages = annotationTables.ticked
    .map(
      (name) =>
        `${name}@${pageOf(name)}${JSON.stringify(annotationTables.filterOf(name) ?? {})}`,
    )
    .join(" ");
  return (
    <div className="calcada-annotations-panel">
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
                    color={tableColor(name)}
                    filter={annotationTables.filterOf(name)}
                    onFilter={(filter) =>
                      annotationTables.setFilter(name, filter)
                    }
                    onPrevious={() => session.previousPage(name)}
                    onNext={() => session.nextPage(name)}
                  />
                )
              );
            })}
          </ul>
        </>
      )}
      <AnnotationList
        key={shownPages}
        drawn={drawn}
        tableColor={tableColor}
        onPick={(item) => session.moveTo(item)}
      />
    </div>
  );
}
