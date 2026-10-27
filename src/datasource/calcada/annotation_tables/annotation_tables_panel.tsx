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

import type { AnnotationTableInfo } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import { MAX_ANNOTATIONS_PER_SEGMENT } from "#src/datasource/calcada/annotation_tables/annotation_tables_client.js";
import type { AnnotationTableStatus } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import { useSignalRerender } from "#src/editing/ui/interop/react/use_signal_rerender.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { vec3 } from "#src/util/geom.js";
import type { NullarySignal } from "#src/util/signal.js";
import { Button } from "@/components/ui/button";

const THOUSANDS_GROUP = /\B(?=(\d{3})+$)/g;
const formatCount = (count: number) =>
  String(count).replace(THOUSANDS_GROUP, " ");
const TRUNCATION_WARNING = `Some segments have more than ${formatCount(MAX_ANNOTATIONS_PER_SEGMENT)} annotations in this table; only the first ${formatCount(MAX_ANNOTATIONS_PER_SEGMENT)} are shown.`;
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
      tick(name: string): void;
      untick(...names: string[]): void;
    };
  };
  readonly annotationTablesSession: {
    readonly tables: WatchableValueInterface<AnnotationTableInfo[] | undefined>;
    readonly status: WatchableValueInterface<AnnotationTableStatus[]>;
    readonly listError: WatchableValueInterface<string | undefined>;
    readonly rootsNote: WatchableValueInterface<string | undefined>;
    tableColor(name: string): vec3;
    refreshTables(): void;
  };
}

function cssColor(color: vec3): string {
  const [red, green, blue] = Array.from(color, (channel) =>
    Math.round(channel * RGB_MAX),
  );
  return `rgb(${red} ${green} ${blue})`;
}

function TableRow({
  table,
  ticked,
  status,
  color,
  onToggle,
}: {
  table: AnnotationTableInfo;
  ticked: boolean;
  status: AnnotationTableStatus | undefined;
  color: vec3;
  onToggle: (ticked: boolean) => void;
}) {
  return (
    <li className="calcada-annotations-table">
      <label className="calcada-annotations-table-header">
        <input
          type="checkbox"
          checked={ticked}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span
          className="calcada-annotations-swatch"
          style={{ background: ticked ? cssColor(color) : "transparent" }}
        />
        <span className="calcada-annotations-table-name">{table.name}</span>
      </label>
      <div className="calcada-annotations-table-schema">
        {table.schemaName}@{table.schemaVersion}
      </div>
      {table.description !== "" && (
        <div className="calcada-annotations-table-description">
          {table.description}
        </div>
      )}
      {ticked && status?.note !== undefined && (
        <div className="calcada-annotations-empty">{status.note}</div>
      )}
      {ticked && status !== undefined && status.note === undefined && (
        <div className="calcada-annotations-table-count">
          {status.annotations}{" "}
          {status.annotations === 1 ? "annotation" : "annotations"} on{" "}
          {status.fetchedRoots}{" "}
          {status.fetchedRoots === 1 ? "segment" : "segments"}
        </div>
      )}
      {ticked && status !== undefined && status.truncatedRoots > 0 && (
        <div className="calcada-trace-panel-warning">{TRUNCATION_WARNING}</div>
      )}
      {status?.error !== undefined && (
        <div className="calcada-annotations-error">{status.error}</div>
      )}
    </li>
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
  const listError = useWatchable(session.listError);
  const rootsNote = useWatchable(session.rootsNote);
  const listed = new Set(tables?.map((table) => table.name));
  const orphans = statuses.filter(
    (status) =>
      (status.error !== undefined || status.note !== undefined) &&
      !listed.has(status.table),
  );
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
        <ul className="calcada-annotations-tables">
          {tables.map((table) => (
            <TableRow
              key={table.name}
              table={table}
              ticked={annotationTables.ticked.includes(table.name)}
              status={statuses.find((status) => status.table === table.name)}
              color={session.tableColor(table.name)}
              onToggle={(ticked) =>
                ticked
                  ? annotationTables.tick(table.name)
                  : annotationTables.untick(table.name)
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}
