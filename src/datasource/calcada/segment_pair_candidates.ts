import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

/** The best candidate between two selected segments, `rootA < rootB`. */
export interface PairCandidate {
  lineId: bigint;
  score: number;
  label: string;
  rootA: bigint;
  rootB: bigint;
  pointA: Float32Array;
  pointB: Float32Array;
}

const MIN_SEGMENTS = 2;
const LISTING_STATUS = "Listing candidates…";
const TOO_FEW_STATUS = "Select at least two segments";

function ranksAbove(row: PairCandidate, other: PairCandidate) {
  return row.score !== other.score
    ? row.score > other.score
    : row.lineId < other.lineId;
}

/**
 * The server lists each pair under both of its segments; one row per pair is
 * what is shown, its best candidate, best pairs first.
 */
export function pairCandidates(
  byRoot: ReadonlyMap<bigint, readonly EdgeCandidate[]>,
): PairCandidate[] {
  const best = new Map<string, PairCandidate>();
  for (const [root, candidates] of byRoot) {
    for (const candidate of candidates) {
      const [rootA, rootB] =
        root < candidate.partnerRootId
          ? [root, candidate.partnerRootId]
          : [candidate.partnerRootId, root];
      const row: PairCandidate = {
        lineId: candidate.lineId,
        score: candidate.score,
        label: candidate.label,
        rootA,
        rootB,
        pointA: candidate.pointA,
        pointB: candidate.pointB,
      };
      const key = `${rootA}:${rootB}`;
      const kept = best.get(key);
      if (kept === undefined || ranksAbove(row, kept)) best.set(key, row);
    }
  }
  return [...best.values()].sort((a, b) => (ranksAbove(a, b) ? -1 : 1));
}

export interface SegmentPairCandidatesDeps {
  selectedRoots(): bigint[];
  fetchBetween(roots: bigint[]): Promise<Map<bigint, EdgeCandidate[]>>;
  goTo(point: Float32Array): void;
}

/** The candidates between the segments selected when it was last asked. */
export class SegmentPairCandidates extends RefCounted {
  readonly changed = new NullarySignal();
  status = "";
  rows: PairCandidate[] = [];
  // A listing that lands after a newer one was asked for is dropped.
  private fetchToken = 0;

  constructor(private deps: SegmentPairCandidatesDeps) {
    super();
  }

  async list() {
    const token = ++this.fetchToken;
    const roots = this.deps.selectedRoots();
    if (roots.length < MIN_SEGMENTS) {
      this.show([], TOO_FEW_STATUS);
      return;
    }
    this.show([], LISTING_STATUS);
    let rows: PairCandidate[];
    try {
      rows = pairCandidates(await this.deps.fetchBetween(roots));
    } catch (e) {
      if (token === this.fetchToken) {
        this.show([], `Could not list candidates: ${e}`);
      }
      return;
    }
    if (token !== this.fetchToken) return;
    const pairs = rows.length === 1 ? "pair" : "pairs";
    this.show(rows, `${rows.length} ${pairs} between ${roots.length} segments`);
  }

  /** To the middle of the contact, where both segments meet. */
  goTo(row: PairCandidate) {
    this.deps.goTo(
      row.pointA.map((value, axis) => (value + row.pointB[axis]) / 2),
    );
  }

  private show(rows: PairCandidate[], status: string) {
    this.rows = rows;
    this.status = status;
    this.changed.dispatch();
  }
}
