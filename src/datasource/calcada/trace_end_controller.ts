import { errorMessage } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import type { Verdict } from "#src/datasource/calcada/candidate_filter_tree.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import type {
  CheckOutcome,
  TraceDecision,
} from "#src/datasource/calcada/trace_end_check.js";
import {
  checkOutcome,
  endPointOf,
  lowerEndThreshold,
  raiseEndThreshold,
} from "#src/datasource/calcada/trace_end_check.js";
import type { TraceEndpointRow } from "#src/datasource/calcada/trace_endpoint_table.js";

export interface TraceEndPromptView {
  phase: "checking" | "open";
  radiusNm: number;
  threshold: number;
  canGoDeeper: boolean;
  canGoBack: boolean;
  endPoint: Float32Array;
}

export interface TraceEndDeps {
  fetchAround(
    seedRoot: bigint,
    center: Float32Array,
    radiusNm: number,
  ): Promise<EdgeCandidate[]>;
  /** undefined = the trace's own filters; a number = score in [threshold, range high] and the rest of the filters. */
  verdict(threshold: number | undefined): (candidate: EdgeCandidate) => Verdict;
  /** Loads the graph facts `verdict(threshold)` asks about for these candidates. */
  fillGraph(
    candidates: readonly EdgeCandidate[],
    threshold: number | undefined,
  ): Promise<void>;
  startThreshold(): number;
  radiusNm(): number;
  branchId(): number;
  write(row: TraceEndpointRow, branchId: number): Promise<bigint>;
  remove(rowId: bigint, branchId: number): Promise<void>;
  /** Push onto the pool head if absent and show it. */
  continueWith(candidate: EdgeCandidate, depth: number): void;
  showNext(): void;
  /** Opaque; compared by identity to tell whether anything was edited since. */
  undoMark(): unknown;
  changed(): void;
  reportError(message: string): void;
}

const GRAPH_UNKNOWN_ERROR = "Could not load the piece graph for the end check";

interface EndCheck {
  after: TraceDecision;
  lineId: bigint;
  endPoint: Float32Array;
  radiusNm: number;
  startThreshold: number;
  continueDepth: number;
  found: readonly EdgeCandidate[];
  decided: ReadonlySet<bigint>;
}

interface PreparedCheck {
  lineId: bigint;
  radiusNm: number;
  found: Record<TraceDecision, Promise<EdgeCandidate[] | undefined>>;
}

type HistoryEntry =
  | { kind: "accept"; lineId: bigint }
  | {
      kind: "endpoint";
      check: EndCheck;
      threshold: number;
      branchId: number;
      rowId: Promise<bigint | undefined>;
      mark: unknown;
    };

/** The server's order for the one candidate it keeps per root pair. */
function ranksAbove(first: EdgeCandidate, second: EdgeCandidate): boolean {
  return first.score !== second.score
    ? first.score > second.score
    : first.lineId < second.lineId;
}

function bestPerPartnerRoot(candidates: EdgeCandidate[]): EdgeCandidate[] {
  const best = new Map<bigint, EdgeCandidate>();
  for (const found of candidates) {
    const held = best.get(found.partnerRootId);
    if (held === undefined || ranksAbove(found, held)) {
      best.set(found.partnerRootId, found);
    }
  }
  return [...best.values()];
}

export class TraceEndController {
  prompt: TraceEndPromptView | undefined;
  private check: EndCheck | undefined;
  private threshold = 0;
  private token = 0;
  private history: HistoryEntry[] = [];
  private prepared: PreparedCheck | undefined;

  constructor(private readonly deps: TraceEndDeps) {}

  get isAnswering(): boolean {
    return this.prompt?.phase === "open";
  }

  prepare(candidate: EdgeCandidate, seedRoot: bigint): void {
    const radiusNm = this.deps.radiusNm();
    const around = (root: bigint, after: TraceDecision) =>
      this.deps.fetchAround(root, endPointOf(after, candidate), radiusNm);
    const merging = new Set([seedRoot, candidate.partnerRootId]);
    const accept = Promise.all([
      around(seedRoot, "accept"),
      around(candidate.partnerRootId, "accept"),
    ]).then((lists) =>
      bestPerPartnerRoot(
        lists.flat().filter((found) => !merging.has(found.partnerRootId)),
      ),
    );
    const failedAsUndefined = () => undefined;
    this.prepared = {
      lineId: candidate.lineId,
      radiusNm,
      found: {
        accept: accept.catch(failedAsUndefined),
        reject: around(seedRoot, "reject").catch(failedAsUndefined),
      },
    };
  }

  forgetPrepared(): void {
    this.prepared = undefined;
  }

  async afterDecision(
    after: TraceDecision,
    candidate: EdgeCandidate,
    seedRoot: bigint,
    depth: number,
    decided: ReadonlySet<bigint>,
  ): Promise<void> {
    const token = this.invalidate();
    const endPoint = endPointOf(after, candidate);
    const radiusNm = this.deps.radiusNm();
    const startThreshold = this.deps.startThreshold();
    this.showChecking(radiusNm, startThreshold, endPoint);
    try {
      const found = await this.foundAround(
        after,
        candidate,
        seedRoot,
        endPoint,
        radiusNm,
      );
      if (token !== this.token) return;
      const verdict = this.deps.verdict(undefined);
      let outcome: CheckOutcome | undefined = checkOutcome(
        found,
        decided,
        verdict,
      );
      if (outcome.kind === "waiting") {
        outcome = await this.filledOutcome(
          found,
          decided,
          undefined,
          verdict,
          token,
        );
      }
      if (outcome === undefined) return;
      this.check = {
        after,
        lineId: candidate.lineId,
        endPoint,
        radiusNm,
        startThreshold,
        continueDepth: after === "accept" ? depth + 1 : depth,
        found,
        decided,
      };
      this.settle(outcome, startThreshold);
    } catch (error) {
      if (token !== this.token) return;
      this.deps.reportError(
        `Could not look for candidates around the trace end: ${errorMessage(error)}`,
      );
      this.close();
    }
  }

  private foundAround(
    after: TraceDecision,
    candidate: EdgeCandidate,
    seedRoot: bigint,
    endPoint: Float32Array,
    radiusNm: number,
  ): Promise<EdgeCandidate[]> {
    const prepared = this.prepared;
    this.prepared = undefined;
    const fetch = () => this.deps.fetchAround(seedRoot, endPoint, radiusNm);
    if (
      prepared?.lineId !== candidate.lineId ||
      prepared.radiusNm !== radiusNm
    ) {
      return fetch();
    }
    return prepared.found[after].then((found) => found ?? fetch());
  }

  /** undefined when the graph stayed unknown (reported, closed) or the check was superseded. */
  private async filledOutcome(
    found: readonly EdgeCandidate[],
    decided: ReadonlySet<bigint>,
    threshold: number | undefined,
    verdict: (candidate: EdgeCandidate) => Verdict,
    token: number,
  ): Promise<CheckOutcome | undefined> {
    try {
      await this.deps.fillGraph(found, threshold);
    } catch (error) {
      if (token !== this.token) return undefined;
      this.deps.reportError(`${GRAPH_UNKNOWN_ERROR}: ${errorMessage(error)}`);
      this.close();
      return undefined;
    }
    if (token !== this.token) return undefined;
    const outcome = checkOutcome(found, decided, verdict);
    if (outcome.kind !== "waiting") return outcome;
    this.deps.reportError(GRAPH_UNKNOWN_ERROR);
    this.close();
    return undefined;
  }

  answer(status: TraceEndpointRow["status"]): void {
    const check = this.check;
    if (!this.isAnswering || check === undefined) return;
    const branchId = this.deps.branchId();
    const rowId = this.deps
      .write(
        {
          status,
          threshold: this.threshold,
          radiusNm: check.radiusNm,
          after: check.after,
          lineId: check.lineId,
          position: check.endPoint,
        },
        branchId,
      )
      .catch((error) => {
        this.deps.reportError(
          `Could not write the trace end: ${errorMessage(error)}`,
        );
        return undefined;
      });
    this.history.push({
      kind: "endpoint",
      check,
      threshold: this.threshold,
      branchId,
      rowId,
      mark: this.deps.undoMark(),
    });
    this.close();
  }

  deeper(): Promise<void> {
    return this.retryAt(lowerEndThreshold(this.threshold));
  }

  back(): Promise<void> {
    const check = this.check;
    if (check === undefined) return Promise.resolve();
    return this.retryAt(
      raiseEndThreshold(this.threshold, check.startThreshold),
    );
  }

  private async retryAt(threshold: number) {
    const check = this.check;
    if (!this.isAnswering || check === undefined) return;
    if (threshold === this.threshold) return;
    const verdict = this.deps.verdict(threshold);
    const outcome = checkOutcome(check.found, check.decided, verdict);
    if (outcome.kind !== "waiting") {
      this.settle(outcome, threshold);
      return;
    }
    this.showChecking(check.radiusNm, threshold, check.endPoint);
    const filled = await this.filledOutcome(
      check.found,
      check.decided,
      threshold,
      verdict,
      this.token,
    );
    if (filled !== undefined) this.settle(filled, threshold);
  }

  dismiss(): void {
    this.prepared = undefined;
    if (this.prompt !== undefined) this.close();
    else this.invalidate();
  }

  async undo(): Promise<boolean> {
    const newest = this.history.at(-1);
    if (newest?.kind !== "endpoint") return false;
    const history = this.history;
    const position = history.length - 1;
    history.pop();
    const token = this.invalidate();
    this.setPrompt(undefined);
    const rowId = await newest.rowId;
    try {
      if (rowId !== undefined) {
        await this.deps.remove(rowId, newest.branchId);
      }
    } catch (error) {
      this.deps.reportError(
        `Could not remove the trace end: ${errorMessage(error)}`,
      );
      history.splice(Math.min(position, history.length), 0, newest);
      if (token === this.token) this.deps.showNext();
      return true;
    }
    if (token !== this.token) return true;
    this.check = newest.check;
    this.open(newest.threshold);
    return true;
  }

  newestEndpointMark(): unknown {
    const newest = this.history.at(-1);
    return newest?.kind === "endpoint" ? newest.mark : undefined;
  }

  noteAccept(lineId: bigint): void {
    this.history.push({ kind: "accept", lineId });
  }

  forgetAccept(): void {
    const index = this.history.findLastIndex(
      (entry) => entry.kind === "accept",
    );
    if (index >= 0) this.history.splice(index, 1);
  }

  reset(): void {
    this.invalidate();
    this.history = [];
    this.prepared = undefined;
    this.setPrompt(undefined);
  }

  private settle(outcome: CheckOutcome, threshold: number) {
    if (outcome.kind !== "continue") {
      this.open(threshold);
      return;
    }
    const { continueDepth } = this.check!;
    this.invalidate();
    this.setPrompt(undefined);
    this.deps.continueWith(outcome.candidate, continueDepth);
  }

  private open(threshold: number) {
    const check = this.check!;
    this.threshold = threshold;
    this.setPrompt({
      phase: "open",
      radiusNm: check.radiusNm,
      threshold,
      canGoDeeper: lowerEndThreshold(threshold) < threshold,
      canGoBack: raiseEndThreshold(threshold, check.startThreshold) > threshold,
      endPoint: check.endPoint,
    });
  }

  private showChecking(
    radiusNm: number,
    threshold: number,
    endPoint: Float32Array,
  ) {
    this.setPrompt({
      phase: "checking",
      radiusNm,
      threshold,
      canGoDeeper: false,
      canGoBack: false,
      endPoint,
    });
  }

  private close() {
    this.invalidate();
    this.setPrompt(undefined);
    this.deps.showNext();
  }

  private invalidate(): number {
    this.check = undefined;
    return ++this.token;
  }

  private setPrompt(prompt: TraceEndPromptView | undefined) {
    this.prompt = prompt;
    this.deps.changed();
  }
}
