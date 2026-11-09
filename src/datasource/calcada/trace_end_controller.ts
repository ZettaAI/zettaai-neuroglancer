import { errorMessage } from "#src/datasource/calcada/annotation_tables/annotation_tables_session.js";
import type { Verdict } from "#src/datasource/calcada/candidate_filter_tree.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import type { EndSphere } from "#src/datasource/calcada/trace_cursor/end_sphere.js";
import type { CheckOutcome } from "#src/datasource/calcada/trace_end_check.js";
import {
  checkOutcome,
  endPointOf,
  lowerEndThreshold,
  raiseEndThreshold,
} from "#src/datasource/calcada/trace_end_check.js";
import type {
  TraceEndpointRow,
  TraceEndStatus,
} from "#src/datasource/calcada/trace_endpoint_table.js";
import { stepTraceSphereRadiusNm } from "#src/datasource/calcada/trace_state.js";

export interface TraceEndPromptView {
  phase: "checking" | "open";
  radiusNm: number;
  threshold: number;
  canGoDeeper: boolean;
  canGoBack: boolean;
  canShrink: boolean;
  canGrow: boolean;
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
  insideEndSphere(
    point: Float32Array,
    center: Float32Array,
    radiusNm: number,
  ): boolean;
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
  remove(
    rowId: bigint,
    status: TraceEndStatus,
    branchId: number,
  ): Promise<void>;
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
  /** The rejected candidate's; undefined at the seed sphere. */
  lineId: bigint | undefined;
  endPoint: Float32Array;
  radiusNm: number;
  /** What `found` was read with; the sphere can shrink below it and grow back. */
  readRadiusNm: number;
  startThreshold: number;
  continueDepth: number;
  found: readonly EdgeCandidate[];
  decided: ReadonlySet<bigint>;
}

/** A look deeper that went on: what is left in its sphere belongs to its end. */
interface DeeperRound {
  check: EndCheck;
  threshold: number;
}

function smallerEndRadiusNm(radiusNm: number): number {
  return stepTraceSphereRadiusNm(radiusNm, -1);
}

function largerEndRadiusNm(check: EndCheck): number {
  return Math.min(
    check.readRadiusNm,
    stepTraceSphereRadiusNm(check.radiusNm, 1),
  );
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
      status: TraceEndStatus;
      threshold: number;
      branchId: number;
      rowId: Promise<bigint | undefined>;
      mark: unknown;
    };

export class TraceEndController {
  prompt: TraceEndPromptView | undefined;
  private check: EndCheck | undefined;
  private threshold = 0;
  private round: DeeperRound | undefined;
  private token = 0;
  private history: HistoryEntry[] = [];
  private prepared: PreparedReject | undefined;

  constructor(private readonly deps: TraceEndDeps) {}

  /** The open prompt's sphere, else the look-deeper round's. */
  get endSphere(): EndSphere | undefined {
    const prompt = this.prompt;
    if (prompt?.endPointKnown) {
      return { center: prompt.endPoint, radiusNm: prompt.radiusNm };
    }
    const check = this.round?.check;
    return check && { center: check.endPoint, radiusNm: check.radiusNm };
  }

  get isAnswering(): boolean {
    return this.prompt?.phase === "open";
  }

  prepare(candidate: EdgeCandidate, seedRoot: bigint): void {
    if (this.round !== undefined) return;
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

  /**
   * Asks for an end only inside a look-deeper round. `seedRoot` is the seed
   * before the merge: a child leading into it is now inside.
   */
  async afterAccept(
    candidate: EdgeCandidate,
    children: Promise<readonly EdgeCandidate[]>,
    seedRoot: bigint,
    depth: number,
    decided: ReadonlySet<bigint>,
  ): Promise<void> {
    const token = this.invalidate();
    const round = this.round;
    this.showChecking(
      this.deps.radiusNm(),
      round?.threshold ?? this.deps.startThreshold(),
      endPointOf("accept", candidate),
      false,
    );
    try {
      const found = (await children).filter(
        (child) => child.partnerRootId !== seedRoot,
      );
      if (token !== this.token) return;
      const outcome = await this.outcomeAt(found, decided, undefined, token);
      if (outcome === undefined) return;
      if (outcome.kind === "continue") {
        if (
          round !== undefined &&
          !this.inSphere(round.check, outcome.candidate)
        ) {
          this.round = undefined;
        }
        this.continueWith(outcome.candidate, depth + 1);
        return;
      }
      if (round === undefined) {
        this.close();
        return;
      }
      const inRound = found.filter((child) =>
        this.inSphere(round.check, child),
      );
      const deeper = await this.outcomeAt(
        inRound,
        decided,
        round.threshold,
        token,
      );
      if (deeper === undefined) return;
      if (deeper.kind === "continue") {
        this.continueWith(deeper.candidate, depth + 1);
      } else {
        await this.nextInRound(round, decided, token);
      }
    } catch (error) {
      if (token !== this.token) return;
      this.deps.reportError(`${CHILDREN_READ_ERROR}: ${errorMessage(error)}`);
      this.close();
    }
  }

  async afterReject(
    candidate: EdgeCandidate,
    seedRoot: bigint,
    depth: number,
    decided: ReadonlySet<bigint>,
  ): Promise<void> {
    if (this.round !== undefined) {
      this.prepared = undefined;
      await this.nextInRound(this.round, decided, this.invalidate());
      return;
    }
    await this.checkAround(
      endPointOf("reject", candidate),
      candidate.lineId,
      depth,
      decided,
      (endPoint, radiusNm) =>
        this.foundAround(candidate, seedRoot, endPoint, radiusNm),
    );
  }

  /** When nothing in the seed sphere passes: the end is asked for at its centre. */
  atSeed(
    center: Float32Array,
    seedRoot: bigint,
    decided: ReadonlySet<bigint>,
  ): Promise<void> {
    return this.checkAround(
      center,
      undefined,
      0,
      decided,
      (endPoint, radiusNm) =>
        this.deps.fetchAround(seedRoot, endPoint, radiusNm),
    );
  }

  private async checkAround(
    endPoint: Float32Array,
    lineId: bigint | undefined,
    depth: number,
    decided: ReadonlySet<bigint>,
    lookUp: (
      endPoint: Float32Array,
      radiusNm: number,
    ) => Promise<readonly EdgeCandidate[]>,
  ): Promise<void> {
    const token = this.invalidate();
    const radiusNm = this.deps.radiusNm();
    const startThreshold = this.deps.startThreshold();
    this.showChecking(radiusNm, startThreshold, endPoint, false);
    try {
      const found = await lookUp(endPoint, radiusNm);
      if (token !== this.token) return;
      const outcome = await this.outcomeAt(found, decided, undefined, token);
      if (outcome === undefined) return;
      this.check = {
        lineId,
        endPoint,
        radiusNm,
        readRadiusNm: radiusNm,
        startThreshold,
        continueDepth: depth,
        found,
        decided,
      };
      this.settle(outcome, startThreshold);
    } catch (error) {
      if (token !== this.token) return;
      this.deps.reportError(`${SPHERE_READ_ERROR}: ${errorMessage(error)}`);
      this.close();
    }
  }

  /** The round's best candidate left, else its end asked for again. */
  private async nextInRound(
    { check, threshold }: DeeperRound,
    decided: ReadonlySet<bigint>,
    token: number,
  ): Promise<void> {
    this.showChecking(check.radiusNm, threshold, check.endPoint, true);
    const outcome = await this.outcomeAt(
      this.candidatesIn(check),
      decided,
      threshold,
      token,
    );
    if (outcome === undefined) return;
    if (outcome.kind === "continue") {
      this.continueWith(outcome.candidate, check.continueDepth);
      return;
    }
    this.check = { ...check, decided };
    this.open(threshold);
  }

  private candidatesIn(check: EndCheck): readonly EdgeCandidate[] {
    if (check.radiusNm >= check.readRadiusNm) return check.found;
    return check.found.filter((candidate) => this.inSphere(check, candidate));
  }

  private inSphere(check: EndCheck, candidate: EdgeCandidate): boolean {
    return (
      this.deps.insideEndSphere(
        candidate.pointA,
        check.endPoint,
        check.radiusNm,
      ) ||
      this.deps.insideEndSphere(
        candidate.pointB,
        check.endPoint,
        check.radiusNm,
      )
    );
  }

  /** undefined when the check was superseded or closed. */
  private async outcomeAt(
    found: readonly EdgeCandidate[],
    decided: ReadonlySet<bigint>,
    threshold: number | undefined,
    token: number,
  ): Promise<CheckOutcome | undefined> {
    const verdict = this.deps.verdict(threshold);
    const outcome = checkOutcome(found, decided, verdict);
    if (outcome.kind !== "waiting") return outcome;
    return this.filledOutcome(found, decided, threshold, verdict, token);
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

  answer(status: TraceEndStatus): void {
    const check = this.check;
    if (!this.isAnswering || check === undefined) return;
    const branchId = this.deps.branchId();
    const rowId = this.deps
      .write(
        {
          status,
          threshold: this.threshold,
          radiusNm: check.radiusNm,
          position: check.endPoint,
          ...(check.lineId !== undefined && {
            after: "reject",
            lineId: check.lineId,
          }),
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
      status,
      threshold: this.threshold,
      branchId,
      rowId,
      mark: this.deps.undoMark(),
    });
    this.close();
  }

  deeper(): Promise<void> {
    return this.recheck(
      lowerEndThreshold(this.threshold),
      this.check?.radiusNm,
    );
  }

  back(): Promise<void> {
    const check = this.check;
    if (check === undefined) return Promise.resolve();
    return this.recheck(
      raiseEndThreshold(this.threshold, check.startThreshold),
      check.radiusNm,
    );
  }

  shrink(): Promise<void> {
    const check = this.check;
    if (check === undefined) return Promise.resolve();
    return this.recheck(this.threshold, smallerEndRadiusNm(check.radiusNm));
  }

  grow(): Promise<void> {
    const check = this.check;
    if (check === undefined) return Promise.resolve();
    return this.recheck(this.threshold, largerEndRadiusNm(check));
  }

  private async recheck(threshold: number, radiusNm: number | undefined) {
    const current = this.check;
    if (!this.isAnswering || current === undefined || radiusNm === undefined) {
      return;
    }
    if (threshold === this.threshold && radiusNm === current.radiusNm) return;
    const check = { ...current, radiusNm };
    this.check = check;
    const candidates = this.candidatesIn(check);
    const verdict = this.deps.verdict(threshold);
    const outcome = checkOutcome(candidates, check.decided, verdict);
    if (outcome.kind !== "waiting") {
      this.settle(outcome, threshold);
      return;
    }
    this.showChecking(check.radiusNm, threshold, check.endPoint, true);
    const filled = await this.filledOutcome(
      candidates,
      check.decided,
      threshold,
      verdict,
      this.token,
    );
    if (filled !== undefined) this.settle(filled, threshold);
  }

  dismiss(): void {
    this.prepared = undefined;
    if (this.prompt !== undefined) {
      this.close();
      return;
    }
    this.invalidate();
    if (this.round !== undefined) {
      this.round = undefined;
      this.deps.changed();
    }
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
        await this.deps.remove(rowId, newest.status, newest.branchId);
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
    this.round = undefined;
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
    this.round = undefined;
    this.setPrompt(undefined);
  }

  private settle(outcome: CheckOutcome, threshold: number) {
    if (outcome.kind !== "continue") {
      this.open(threshold);
      return;
    }
    const check = this.check!;
    this.round =
      threshold < check.startThreshold ? { check, threshold } : undefined;
    this.continueWith(outcome.candidate, check.continueDepth);
  }

  private continueWith(candidate: EdgeCandidate, depth: number) {
    this.invalidate();
    this.setPrompt(undefined);
    this.deps.continueWith(candidate, depth);
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
      canShrink: smallerEndRadiusNm(check.radiusNm) < check.radiusNm,
      canGrow: largerEndRadiusNm(check) > check.radiusNm,
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
      canShrink: false,
      canGrow: false,
      endPoint,
      endPointKnown,
    });
  }

  private close() {
    this.round = undefined;
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
