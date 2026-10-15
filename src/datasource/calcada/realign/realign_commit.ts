/**
 * @file Committing a realign: how many sections the field is spread over, how
 * well the field honours each arrow, and the field's wire form.
 */

import type { FloatTensor } from "#src/datasource/calcada/realign/apply_correspondences_request.js";
import type {
  CorrespondenceLine,
  RealignSelection,
} from "#src/datasource/calcada/realign/realign_selection.js";

export const MAX_REALIGN_SECTIONS = 100;
export const DEFAULT_MAX_SHIFT_PX = 1;

const X_CHANNEL = 0;
const Y_CHANNEL = 1;

export interface RealignCommitStatus {
  readonly status: "running" | "done" | "failed";
  readonly sectionsDone?: number;
  readonly sectionsTotal?: number;
  readonly error?: string;
  /** Once done: every old root the commit cut, mapped to the new roots its pieces moved to. */
  readonly rootMap?: ReadonlyMap<bigint, readonly bigint[]>;
}

/**
 * Parses a commit's root map: decimal strings on the wire, because root ids
 * exceed 2^53 and a JSON number would round them.
 */
export function parseRootMap(
  raw: Readonly<Record<string, readonly string[]>> | null | undefined,
): Map<bigint, bigint[]> {
  const rootMap = new Map<bigint, bigint[]>();
  if (raw === undefined || raw === null) return rootMap;
  for (const [oldRoot, newRoots] of Object.entries(raw)) {
    rootMap.set(BigInt(oldRoot), newRoots.map(BigInt));
  }
  return rootMap;
}

/** A committed realign of a branch, as the Commits list shows it. */
export interface RealignCommitRow {
  readonly operationId: number;
  /** x0, y0, x1, y1 in graph voxels. */
  readonly box: [number, number, number, number];
  readonly z0: number;
  readonly sections: number;
  readonly status: string;
  readonly undoable: boolean;
  /** The later overlapping realign to undo first. */
  readonly blockedBy?: number;
}

interface RawCommitRow {
  readonly operation_id: number;
  readonly box: [number, number, number, number];
  readonly z0: number;
  readonly sections: number;
  readonly status: string;
  readonly undoable: boolean;
  readonly blocked_by?: number;
}

export function parseCommitRows(json: {
  readonly commits?: readonly RawCommitRow[] | null;
}): RealignCommitRow[] {
  return (json.commits ?? []).map((row) => ({
    operationId: row.operation_id,
    box: row.box,
    z0: row.z0,
    sections: row.sections,
    status: row.status,
    undoable: row.undoable,
    ...(row.blocked_by === undefined ? {} : { blockedBy: row.blocked_by }),
  }));
}

/**
 * An undo whose graph step went through but whose voxel step did not: the
 * roots changed already, so the client retargets them before reporting it.
 */
export class PartialUndoError extends Error {
  constructor(
    message: string,
    readonly rootMap: ReadonlyMap<bigint, readonly bigint[]>,
  ) {
    super(message);
    this.name = "PartialUndoError";
  }
}

function fieldGrid(field: FloatTensor) {
  const [, height, width] = field.shape;
  const valueAt = (channel: number, row: number, column: number) =>
    field.data[(channel * height + row) * width + column];
  return { height, width, valueAt };
}

export function sectionCount(field: FloatTensor, maxShiftPx: number): number {
  const { height, width, valueAt } = fieldGrid(field);
  let largest = 0;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      largest = Math.max(
        largest,
        Math.hypot(
          valueAt(X_CHANNEL, row, column),
          valueAt(Y_CHANNEL, row, column),
        ),
      );
    }
  }
  return Math.max(1, Math.ceil(largest / maxShiftPx));
}

/** Pixel distance between each arrow's tail and where the field pulls its head from. */
export function residualErrors(
  field: FloatTensor,
  lines: readonly CorrespondenceLine[],
): number[] {
  const { valueAt } = fieldGrid(field);
  return lines.map(
    ({ start: [startRow, startColumn], end: [endRow, endColumn] }) =>
      Math.hypot(
        endColumn + valueAt(X_CHANNEL, endRow, endColumn) - startColumn,
        endRow + valueAt(Y_CHANNEL, endRow, endColumn) - startRow,
      ),
  );
}

export async function encodeField(field: FloatTensor): Promise<ArrayBuffer> {
  return new Response(
    new Response(Float32Array.from(field.data)).body!.pipeThrough(
      new CompressionStream("gzip"),
    ),
  ).arrayBuffer();
}

/** Gives each request a check that is true only while no newer request began. */
export function latestRequestGate(): { begin(): () => boolean } {
  let latest = 0;
  return {
    begin() {
      const ticket = ++latest;
      return () => ticket === latest;
    },
  };
}

/**
 * Identifies what an applied field was computed for: the box, its arrows and
 * the branch whose composited image the field was fitted to.
 */
export function appliedFieldKey(
  selection: RealignSelection,
  branchId: number,
): string {
  return JSON.stringify([branchId, selection.box, selection.lines]);
}

/** The commit's progress line: which section is being written, and how many pieces the whole commit cuts. */
export function commitProgressMessage(
  done: number,
  total: number,
  cut: number,
): string {
  return `Writing section ${done} of ${total} (${cut} pieces cut)…`;
}

const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const COMMIT_POLL_INTERVAL_MS = 1000;

export interface CommitPollOptions {
  readonly onProgress: (status: RealignCommitStatus) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly isStopped?: () => boolean;
}

function sleepFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Polls a commit until it is no longer running. A failed poll does not mean a
 * failed commit, so a few in a row are ridden out before giving up.
 */
export async function pollCommit(
  fetchStatus: () => Promise<RealignCommitStatus>,
  { onProgress, sleep = sleepFor, isStopped = () => false }: CommitPollOptions,
): Promise<RealignCommitStatus> {
  let failures = 0;
  for (;;) {
    try {
      const status = await fetchStatus();
      failures = 0;
      if (status.status !== "running") return status;
      onProgress(status);
    } catch (error) {
      if (++failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
    }
    if (isStopped()) return { status: "running" };
    await sleep(COMMIT_POLL_INTERVAL_MS);
  }
}
