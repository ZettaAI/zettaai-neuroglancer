import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

/** One candidate between two selected segments. */
export interface PairContact {
  lineId: bigint;
  score: number;
  label: string;
  /** The rejection or ambiguous mark hiding it from the trace; empty if none. */
  hidingDecision: string;
  pointA: Float32Array;
  pointB: Float32Array;
}

/** Every candidate between two selected segments, `rootA < rootB`, best first. */
export interface SegmentPair {
  rootA: bigint;
  rootB: bigint;
  contacts: PairContact[];
}

const MIN_SEGMENTS = 2;
const LISTING_STATUS = "Listing candidates…";
const TOO_FEW_STATUS = "Select at least two segments";

function ranksAbove(contact: PairContact, other: PairContact) {
  return contact.score !== other.score
    ? contact.score > other.score
    : contact.lineId < other.lineId;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The server lists each contact under both of its segments; each is shown
 * once, under its pair. Pairs are ordered by their best contact.
 */
export function segmentPairs(
  byRoot: ReadonlyMap<bigint, readonly EdgeCandidate[]>,
): SegmentPair[] {
  const pairs = new Map<string, SegmentPair>();
  const seen = new Set<bigint>();
  for (const [root, candidates] of byRoot) {
    for (const candidate of candidates) {
      if (seen.has(candidate.lineId)) continue;
      seen.add(candidate.lineId);
      const [rootA, rootB] =
        root < candidate.partnerRootId
          ? [root, candidate.partnerRootId]
          : [candidate.partnerRootId, root];
      const key = `${rootA}:${rootB}`;
      let pair = pairs.get(key);
      if (pair === undefined) {
        pair = { rootA, rootB, contacts: [] };
        pairs.set(key, pair);
      }
      pair.contacts.push({
        lineId: candidate.lineId,
        score: candidate.score,
        label: candidate.label,
        hidingDecision: candidate.hidingDecision,
        pointA: candidate.pointA,
        pointB: candidate.pointB,
      });
    }
  }
  const sorted = [...pairs.values()];
  for (const pair of sorted) {
    pair.contacts.sort((a, b) => (ranksAbove(a, b) ? -1 : 1));
  }
  return sorted.sort((a, b) =>
    ranksAbove(a.contacts[0], b.contacts[0]) ? -1 : 1,
  );
}

/** A coordinate column of the list: the dimension's name and its scale. */
export interface PairListDimension {
  name: string;
  scale: string;
}

export interface SegmentPairCandidatesDeps {
  selectedRoots(): bigint[];
  dimensions(): PairListDimension[];
  /** The most candidates the server returns per segment. */
  contactLimit: number;
  fetchBetween(roots: bigint[]): Promise<Map<bigint, EdgeCandidate[]>>;
  goTo(point: Float32Array): void;
  /** Shows the segment as the Seg tab does; the returned function takes it away. */
  showSegment(root: bigint, parent: HTMLElement): () => void;
}

/** The candidates between the segments selected when it was last asked. */
export class SegmentPairCandidates extends RefCounted {
  readonly changed = new NullarySignal();
  status = "";
  pairs: SegmentPair[] = [];
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
    let byRoot: Map<bigint, EdgeCandidate[]>;
    try {
      byRoot = await this.deps.fetchBetween(roots);
    } catch (e) {
      if (token === this.fetchToken) {
        this.show([], `Could not list candidates: ${e}`);
      }
      return;
    }
    if (token !== this.fetchToken) return;
    const pairs = segmentPairs(byRoot);
    const contacts = pairs.reduce((sum, pair) => sum + pair.contacts.length, 0);
    let status = `${plural(contacts, "contact")} in ${plural(pairs.length, "pair")} between ${roots.length} segments`;
    const { contactLimit } = this.deps;
    if ([...byRoot.values()].some((list) => list.length >= contactLimit)) {
      status += ` · a segment reached the limit of ${contactLimit}, so some may be missing`;
    }
    this.show(pairs, status);
  }

  dimensions(): PairListDimension[] {
    return this.deps.dimensions();
  }

  showSegment(root: bigint, parent: HTMLElement) {
    return this.deps.showSegment(root, parent);
  }

  /** To the middle of the contact, where both segments meet. */
  goTo(contact: PairContact) {
    this.deps.goTo(
      contact.pointA.map((value, axis) => (value + contact.pointB[axis]) / 2),
    );
  }

  private show(pairs: SegmentPair[], status: string) {
    this.pairs = pairs;
    this.status = status;
    this.changed.dispatch();
  }
}
