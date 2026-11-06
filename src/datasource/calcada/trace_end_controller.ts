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
  /** False while the first check still looks for where the end is. */
  endPointKnown: boolean;
}

export interface TraceEndDeps {
  fetchAround(
    seedRoot: bigint,
    center: Float32Array,
    radiusNm: number,
  ): Promise<EdgeCandidate[]>;
  /** Where the branch ends after `candidate` merged into `mergedRoot`; undefined = at the contact. */
  acceptEndPoint(
    candidate: EdgeCandidate,
    mergedRoot: bigint,
    radiusNm: number,
  ): Promise<Float32Array | undefined>;
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
const CHILDREN_READ_ERROR = "Could not read the merged piece's candidates";
const SPHERE_READ_ERROR = "Could not look for candidates around the trace end";

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

interface PreparedReject {
  lineId: bigint;
  radiusNm: number;
  found: Promise<EdgeCandidate[] | undefined>;
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

export class TraceEndController {
  prompt: TraceEndPromptView | undefined;
  private check: EndCheck | undefined;
  private threshold = 0;
  private token = 0;
  private history: HistoryEntry[] = [];
  private prepared: PreparedReject | undefined;

  constructor(private readonly deps: TraceEndDeps) {}

  get isAnswering(): boolean {
    return this.prompt?.phase === "open";
  }

  prepare(candidate: EdgeCandidate, seedRoot: bigint): void {
    const radiusNm = this.deps.radiusNm();
    this.prepared = {
      lineId: candidate.lineId,
      radiusNm,
      found: this.deps
        .fetchAround(seedRoot, endPointOf("reject", candidate), radiusNm)
        .catch(() => undefined),
    };
  }

  forgetPrepared(): void {
    this.prepared = undefined;
  }

  /** `seedRoot` is the seed before the merge: a child leading into it is now inside. */
  afterAccept(
    candidate: EdgeCandidate,
    children: Promise<readonly EdgeCandidate[]>,
    seedRoot: bigint,
    mergedRoot: bigint,
    depth: number,
    decided: ReadonlySet<bigint>,
  ): Promise<void> {
    return this.checkEnd(
      "accept",
      candidate,
      depth,
      decided,
      CHILDREN_READ_ERROR,
      async () =>
        (await children).filter((child) => child.partnerRootId !== seedRoot),
      (radiusNm) => this.deps.acceptEndPoint(candidate, mergedRoot, radiusNm),
    );
  }

  afterReject(
    candidate: EdgeCandidate,
    seedRoot: bigint,
    depth: number,
    decided: ReadonlySet<bigint>,
  ): Promise<void> {
    return this.checkEnd(
      "reject",
      candidate,
      depth,
      decided,
      SPHERE_READ_ERROR,
      (endPoint, radiusNm) =>
        this.foundAround(candidate, seedRoot, endPoint, radiusNm),
    );
  }

  private async checkEnd(
    after: TraceDecision,
    candidate: EdgeCandidate,
    depth: number,
    decided: ReadonlySet<bigint>,
    lookUpError: string,
    lookUp: (
      endPoint: Float32Array,
      radiusNm: number,
    ) => Promise<readonly EdgeCandidate[]>,
    endPointIfEnded?: (radiusNm: number) => Promise<Float32Array | undefined>,
  ): Promise<void> {
    const token = this.invalidate();
    const endPoint = endPointOf(after, candidate);
    const radiusNm = this.deps.radiusNm();
    const startThreshold = this.deps.startThreshold();
    this.showChecking(radiusNm, startThreshold, endPoint, false);
    try {
      const found = await lookUp(endPoint, radiusNm);
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
      let checkedEndPoint = endPoint;
      if (outcome.kind !== "continue" && endPointIfEnded !== undefined) {
        checkedEndPoint =
          (await endPointIfEnded(radiusNm).catch(() => undefined)) ?? endPoint;
        if (token !== this.token) return;
      }
      this.check = {
        after,
        lineId: candidate.lineId,
        endPoint: checkedEndPoint,
        radiusNm,
        startThreshold,
        continueDepth: after === "accept" ? depth + 1 : depth,
        found,
        decided,
      };
      this.settle(outcome, startThreshold);
    } catch (error) {
      if (token !== this.token) return;
      this.deps.reportError(`${lookUpError}: ${errorMessage(error)}`);
      this.close();
    }
  }

  private foundAround(
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
    return prepared.found.then((found) => found ?? fetch());
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
    this.showChecking(check.radiusNm, threshold, check.endPoint, true);
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
      endPointKnown: true,
    });
  }

  private showChecking(
    radiusNm: number,
    threshold: number,
    endPoint: Float32Array,
    endPointKnown: boolean,
  ) {
    this.setPrompt({
      phase: "checking",
      radiusNm,
      threshold,
      canGoDeeper: false,
      canGoBack: false,
      endPoint,
      endPointKnown,
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
