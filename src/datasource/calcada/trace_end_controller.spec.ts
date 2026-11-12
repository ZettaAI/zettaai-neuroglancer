import { describe, expect, it } from "vitest";
import type { Verdict } from "#src/datasource/calcada/candidate_filter_tree.js";
import type { PieceClasses } from "#src/datasource/calcada/candidate_heat.js";
import type { EdgeCandidate } from "#src/datasource/calcada/candidate_ranking.js";
import type { TraceDecision } from "#src/datasource/calcada/trace_end_check.js";
import { END_THRESHOLD_STEP } from "#src/datasource/calcada/trace_end_check.js";
import type { TraceEndDeps } from "#src/datasource/calcada/trace_end_controller.js";
import { TraceEndController } from "#src/datasource/calcada/trace_end_controller.js";
import type {
  TraceEndpointRow,
  TraceEndStatus,
} from "#src/datasource/calcada/trace_endpoint_table.js";
import { TRACE_SPHERE_RADIUS_MIN_NM } from "#src/datasource/calcada/trace_state.js";

const START_THRESHOLD = 0.3;
const RADIUS_NM = 1000;
const SEED_ROOT = 99n;
const DEPTH = 2;
const MAIN_BRANCH = 0;
const OTHER_BRANCH = 7;
const GRAPH_UNKNOWN_ERROR = "Could not load the piece graph for the end check";

const noClasses: PieceClasses = {
  perikaryon: 0,
  dendrite: 0,
  axon: 0,
  glia: 0,
  vasculature: 0,
  nucleus: 0,
  ecs: 0,
  other: 0,
};

function candidate(overrides: Partial<EdgeCandidate> = {}): EdgeCandidate {
  return {
    lineId: 1n,
    score: 0.5,
    selfPieceId: 1n,
    partnerPieceId: 2n,
    partnerRootId: 2n,
    pointA: new Float32Array([1, 2, 3]),
    pointB: new Float32Array([4, 5, 6]),
    nInterfaces: 1,
    modelDecision: "",
    label: "",
    hidingDecision: "",
    partnerVoxels: 500,
    partnerClasses: noClasses,
    partnerHasInfo: false,
    selfVoxels: 500,
    selfClasses: noClasses,
    selfHasInfo: false,
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeDeps implements TraceEndDeps {
  fetches: {
    seedRoot: bigint;
    center: Float32Array;
    radiusNm: number;
    result: Deferred<EdgeCandidate[]>;
  }[] = [];
  fills: {
    candidates: readonly EdgeCandidate[];
    threshold: number | undefined;
    result: Deferred<void>;
  }[] = [];
  writes: {
    row: TraceEndpointRow;
    branchId: number;
    result: Deferred<bigint>;
  }[] = [];
  removed: bigint[] = [];
  removedOn: number[] = [];
  removedFrom: TraceEndStatus[] = [];
  branch = MAIN_BRANCH;
  removeFails = false;
  continued: { candidate: EdgeCandidate; depth: number }[] = [];
  shownNext = 0;
  changes = 0;
  errors: string[] = [];
  unknownUntilFill = new Set<bigint>();
  graphFillLeavesUnknown = false;
  verdictThresholds: (number | undefined)[] = [];
  mark: unknown = "edit-1";

  fetchAround(seedRoot: bigint, center: Float32Array, radiusNm: number) {
    const result = deferred<EdgeCandidate[]>();
    this.fetches.push({ seedRoot, center, radiusNm, result });
    return result.promise;
  }

  insideEndSphere(point: Float32Array, center: Float32Array, radiusNm: number) {
    return (
      Math.hypot(...point.map((value, i) => value - center[i])) <= radiusNm
    );
  }

  verdict(threshold: number | undefined) {
    this.verdictThresholds.push(threshold);
    return (edge: EdgeCandidate): Verdict => {
      if (edge.score < (threshold ?? START_THRESHOLD)) return false;
      return this.unknownUntilFill.has(edge.lineId) ? undefined : true;
    };
  }

  fillGraph(
    candidates: readonly EdgeCandidate[],
    threshold: number | undefined,
  ) {
    const result = deferred<void>();
    this.fills.push({ candidates, threshold, result });
    return result.promise.then(() => {
      if (!this.graphFillLeavesUnknown) this.unknownUntilFill.clear();
    });
  }

  startThreshold() {
    return START_THRESHOLD;
  }

  radiusNm() {
    return RADIUS_NM;
  }

  branchId() {
    return this.branch;
  }

  write(row: TraceEndpointRow, branchId: number) {
    const result = deferred<bigint>();
    this.writes.push({ row, branchId, result });
    return result.promise;
  }

  async remove(rowId: bigint, status: TraceEndStatus, branchId: number) {
    if (this.removeFails) throw new Error("HTTP 409");
    this.removed.push(rowId);
    this.removedFrom.push(status);
    this.removedOn.push(branchId);
  }

  continueWith(edge: EdgeCandidate, depth: number) {
    this.continued.push({ candidate: edge, depth });
  }

  showNext() {
    this.shownNext++;
  }

  undoMark() {
    return this.mark;
  }

  changed() {
    this.changes++;
  }

  reportError(message: string) {
    this.errors.push(message);
  }
}

function setUp() {
  const deps = new FakeDeps();
  return { deps, controller: new TraceEndController(deps) };
}

const LOW = candidate({ lineId: 20n, score: 0.1 });
const DECIDED = candidate({ lineId: 10n });

function acceptWith(
  controller: TraceEndController,
  children: EdgeCandidate[],
  decided: ReadonlySet<bigint> = new Set(),
) {
  return controller.afterAccept(
    DECIDED,
    Promise.resolve(children),
    SEED_ROOT,
    DEPTH,
    decided,
  );
}

async function decide(
  controller: TraceEndController,
  deps: FakeDeps,
  after: TraceDecision,
  found: EdgeCandidate[],
  decided: ReadonlySet<bigint> = new Set(),
) {
  if (after === "accept") {
    await acceptWith(controller, found, decided);
    return;
  }
  const done = controller.afterReject(DECIDED, SEED_ROOT, DEPTH, decided);
  deps.fetches.at(-1)!.result.resolve(found);
  await done;
}

async function openPrompt(
  after: TraceDecision = "reject",
  found: EdgeCandidate[] = [LOW],
) {
  const setup = setUp();
  await decide(setup.controller, setup.deps, after, found);
  return setup;
}

async function answerWithRow(
  controller: TraceEndController,
  deps: FakeDeps,
  rowId: bigint,
) {
  await decide(controller, deps, "reject", []);
  controller.answer("certain");
  deps.writes.at(-1)!.result.resolve(rowId);
}

const SHRUNK_RADIUS_NM = 800;
const SEED_CENTER = Float32Array.of(3, 3, 3);
const SHRINKS_TO_MIN = 20;

const STEPS_TO_ZERO = Math.round(START_THRESHOLD / END_THRESHOLD_STEP);

describe("TraceEndController", () => {
  it("accept whose children all fail opens no prompt and shows the next candidate", async () => {
    const { deps, controller } = setUp();
    const done = acceptWith(controller, [LOW]);
    expect(controller.prompt).toMatchObject({
      phase: "checking",
      endPointKnown: false,
    });
    await done;
    expect(controller.prompt).toBeUndefined();
    expect(controller.isAnswering).toBe(false);
    expect(deps.continued).toEqual([]);
    expect(deps.writes).toEqual([]);
    expect(deps.shownNext).toBe(1);
  });

  it("accept with a passing child far from the contact opens no prompt", async () => {
    const { deps, controller } = setUp();
    const farChild = candidate({
      lineId: 30n,
      score: 0.8,
      pointA: new Float32Array([1e6, 1e6, 1e6]),
      pointB: new Float32Array([1e6, 1e6, 1e6 + 1]),
    });
    await acceptWith(controller, [LOW, farChild]);
    expect(deps.fetches).toEqual([]);
    expect(deps.continued).toEqual([{ candidate: farChild, depth: DEPTH + 1 }]);
    expect(controller.prompt).toBeUndefined();
    expect(deps.shownNext).toBe(0);
  });

  it("accept does not fetch around pointB", async () => {
    const { deps, controller } = setUp();
    controller.prepare(DECIDED, SEED_ROOT);
    expect(deps.fetches.map((fetch) => fetch.center)).toEqual([DECIDED.pointA]);
    await acceptWith(controller, []);
    expect(deps.fetches).toHaveLength(1);
    expect(controller.prompt).toBeUndefined();
    expect(deps.shownNext).toBe(1);
  });

  it("a child leading back into the seed does not continue the trace", async () => {
    const { deps, controller } = setUp();
    const intoSeed = candidate({
      lineId: 30n,
      score: 0.8,
      partnerRootId: SEED_ROOT,
    });
    await acceptWith(controller, [intoSeed]);
    expect(deps.continued).toEqual([]);
    expect(deps.shownNext).toBe(1);
  });

  it("a failed children read after an accept reports and shows the next candidate", async () => {
    const { deps, controller } = setUp();
    await controller.afterAccept(
      DECIDED,
      Promise.reject(new Error("HTTP 503")),
      SEED_ROOT,
      DEPTH,
      new Set(),
    );
    expect(deps.errors).toEqual([
      "Could not read the merged piece's candidates: HTTP 503",
    ]);
    expect(deps.shownNext).toBe(1);
    expect(deps.continued).toEqual([]);
    expect(controller.prompt).toBeUndefined();
  });

  it("accept with one passing candidate continues with it one level deeper and opens nothing", async () => {
    const { deps, controller } = setUp();
    const passing = candidate({ lineId: 30n, score: 0.8 });
    await decide(controller, deps, "accept", [LOW, passing]);
    expect(deps.continued).toEqual([{ candidate: passing, depth: DEPTH + 1 }]);
    expect(controller.prompt).toBeUndefined();
  });

  it("reject with none opens the prompt at pointA", async () => {
    const { deps, controller } = setUp();
    await decide(controller, deps, "reject", [LOW]);
    expect(deps.fetches[0].center).toBe(DECIDED.pointA);
    expect(controller.prompt).toMatchObject({
      phase: "open",
      endPoint: DECIDED.pointA,
    });
  });

  it("reject with one passing candidate continues at the same depth", async () => {
    const { deps, controller } = setUp();
    const passing = candidate({ lineId: 30n, score: 0.8 });
    await decide(controller, deps, "reject", [passing]);
    expect(deps.continued).toEqual([{ candidate: passing, depth: DEPTH }]);
    expect(controller.prompt).toBeUndefined();
  });

  it("a candidate decided this session does not keep the prompt shut", async () => {
    const { deps, controller } = setUp();
    const skipped = candidate({ lineId: 30n, score: 0.8 });
    await decide(controller, deps, "reject", [skipped], new Set([30n]));
    expect(deps.continued).toEqual([]);
    expect(controller.prompt?.phase).toBe("open");
  });

  it("waits for the graph when a verdict is unknown, then decides", async () => {
    const { deps, controller } = setUp();
    const pending = candidate({ lineId: 30n, score: 0.8 });
    deps.unknownUntilFill.add(30n);
    const done = acceptWith(controller, [pending]);
    await settle();
    expect(deps.fills).toHaveLength(1);
    expect(deps.fills[0].candidates).toEqual([pending]);
    expect(deps.continued).toEqual([]);
    expect(controller.prompt?.phase).toBe("checking");
    deps.fills[0].result.resolve();
    await done;
    expect(deps.continued).toEqual([{ candidate: pending, depth: DEPTH + 1 }]);
    expect(controller.prompt).toBeUndefined();
  });

  it("a verdict still unknown after the fill reports and shows the next candidate", async () => {
    const { deps, controller } = setUp();
    deps.unknownUntilFill.add(30n);
    deps.graphFillLeavesUnknown = true;
    const done = acceptWith(controller, [candidate({ lineId: 30n })]);
    await settle();
    deps.fills[0].result.resolve();
    await done;
    expect(deps.errors).toEqual([GRAPH_UNKNOWN_ERROR]);
    expect(deps.shownNext).toBe(1);
    expect(deps.continued).toEqual([]);
    expect(controller.prompt).toBeUndefined();
  });

  it("a failed fetch shows the next candidate and reports", async () => {
    const { deps, controller } = setUp();
    const done = controller.afterReject(DECIDED, SEED_ROOT, DEPTH, new Set());
    deps.fetches[0].result.reject(new Error("HTTP 503"));
    await done;
    expect(deps.errors).toHaveLength(1);
    expect(deps.errors[0]).toContain("HTTP 503");
    expect(deps.shownNext).toBe(1);
    expect(controller.prompt).toBeUndefined();
  });

  it("certain writes one row with status, threshold, radius, after and line id, then shows the next candidate", async () => {
    const { deps, controller } = await openPrompt();
    controller.answer("certain");
    expect(deps.writes.map((write) => write.row)).toEqual([
      {
        status: "certain",
        threshold: START_THRESHOLD,
        radiusNm: RADIUS_NM,
        after: "reject",
        lineId: DECIDED.lineId,
        position: DECIDED.pointA,
      },
    ]);
    expect(controller.prompt).toBeUndefined();
    expect(deps.shownNext).toBe(1);
  });

  it("uncertain writes one row likewise, then shows the next candidate", async () => {
    const { deps, controller } = await openPrompt("reject");
    controller.answer("uncertain");
    expect(deps.writes.map((write) => write.row)).toEqual([
      {
        status: "uncertain",
        threshold: START_THRESHOLD,
        radiusNm: RADIUS_NM,
        after: "reject",
        lineId: DECIDED.lineId,
        position: DECIDED.pointA,
      },
    ]);
    expect(controller.prompt).toBeUndefined();
    expect(deps.shownNext).toBe(1);
  });

  it("a failed write reports an error naming the failure", async () => {
    const { deps, controller } = await openPrompt();
    controller.answer("certain");
    deps.writes[0].result.reject(new Error("HTTP 403"));
    await settle();
    expect(deps.errors).toHaveLength(1);
    expect(deps.errors[0]).toMatch(/trace end.*HTTP 403/);
  });

  it("answer is ignored until the prompt is open", async () => {
    const { deps, controller } = setUp();
    controller.answer("certain");
    const done = controller.afterReject(DECIDED, SEED_ROOT, DEPTH, new Set());
    controller.answer("certain");
    expect(deps.writes).toEqual([]);
    expect(deps.shownNext).toBe(0);
    deps.fetches[0].result.resolve([LOW]);
    await done;
    expect(controller.prompt?.phase).toBe("open");
  });

  it("a reject while looking deeper goes on with the next candidate of the same sphere", async () => {
    const first = candidate({ lineId: 30n, score: 0.22 });
    const second = candidate({ lineId: 31n, score: 0.21 });
    const { deps, controller } = await openPrompt("reject", [first, second]);
    controller.deeper();
    controller.deeper();
    expect(deps.continued).toEqual([{ candidate: first, depth: DEPTH }]);

    controller.prepare(first, SEED_ROOT);
    await controller.afterReject(first, SEED_ROOT, DEPTH, new Set([30n]));
    expect(deps.fetches).toHaveLength(1);
    expect(deps.continued.at(-1)).toEqual({ candidate: second, depth: DEPTH });
    expect(controller.prompt).toBeUndefined();
  });

  it("a look-deeper round with nothing left reopens the prompt at its centre and threshold", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    controller.deeper();
    controller.deeper();
    await controller.afterReject(lower, SEED_ROOT, DEPTH, new Set([30n]));
    expect(deps.fetches).toHaveLength(1);
    expect(controller.prompt).toMatchObject({
      phase: "open",
      endPoint: DECIDED.pointA,
      radiusNm: RADIUS_NM,
      threshold: 0.2,
      canGoBack: true,
    });
    controller.answer("certain");
    expect(deps.writes[0].row).toMatchObject({
      lineId: DECIDED.lineId,
      position: DECIDED.pointA,
      threshold: 0.2,
    });
  });

  it("looking deeper again keeps the round's sphere", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const lowest = candidate({ lineId: 31n, score: 0.12 });
    const { deps, controller } = await openPrompt("reject", [lower, lowest]);
    controller.deeper();
    controller.deeper();
    await controller.afterReject(lower, SEED_ROOT, DEPTH, new Set([30n]));
    controller.deeper();
    controller.deeper();
    expect(deps.continued.at(-1)).toEqual({ candidate: lowest, depth: DEPTH });
    await controller.afterReject(lowest, SEED_ROOT, DEPTH, new Set([30n, 31n]));
    expect(deps.fetches).toHaveLength(1);
    expect(controller.prompt).toMatchObject({
      phase: "open",
      endPoint: DECIDED.pointA,
      threshold: 0.1,
    });
  });

  it("an answer ends the look-deeper round", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    controller.deeper();
    controller.deeper();
    await controller.afterReject(lower, SEED_ROOT, DEPTH, new Set([30n]));
    controller.answer("uncertain");
    await decide(controller, deps, "reject", [
      candidate({ lineId: 40n, score: 0.21 }),
    ]);
    expect(deps.fetches).toHaveLength(2);
    expect(controller.prompt).toMatchObject({
      phase: "open",
      threshold: START_THRESHOLD,
    });
  });

  it("dismiss and a new trace end the look-deeper round", async () => {
    for (const end of ["dismiss", "reset"] as const) {
      const lower = candidate({ lineId: 30n, score: 0.22 });
      const { deps, controller } = await openPrompt("reject", [lower]);
      controller.deeper();
      controller.deeper();
      controller[end]();
      await decide(controller, deps, "reject", [
        candidate({ lineId: 40n, score: 0.21 }),
      ]);
      expect(deps.fetches).toHaveLength(2);
      expect(controller.prompt).toMatchObject({
        phase: "open",
        threshold: START_THRESHOLD,
      });
    }
  });

  it("a failed read in a round ends it before the next candidate is shown", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    controller.deeper();
    controller.deeper();
    await controller.afterAccept(
      lower,
      Promise.reject(new Error("HTTP 503")),
      SEED_ROOT,
      DEPTH,
      new Set([30n]),
    );
    await decide(controller, deps, "reject", [
      candidate({ lineId: 40n, score: 0.21 }),
    ]);
    expect(deps.fetches).toHaveLength(2);
    expect(controller.prompt).toMatchObject({ threshold: START_THRESHOLD });
  });

  it("an accept in a round whose piece goes nowhere goes on with the round", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    controller.deeper();
    controller.deeper();
    await acceptWith(controller, [], new Set([30n]));
    expect(controller.prompt).toMatchObject({
      phase: "open",
      endPoint: DECIDED.pointA,
      threshold: 0.2,
    });
    expect(deps.continued).toHaveLength(1);
  });

  it("an accept in a round goes on with a child in the sphere at the round's threshold", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    controller.deeper();
    controller.deeper();
    const outside = new Float32Array([RADIUS_NM * 10, 0, 0]);
    const far = candidate({
      lineId: 41n,
      score: 0.21,
      pointA: outside,
      pointB: outside,
    });
    const near = candidate({ lineId: 42n, score: 0.21 });
    await acceptWith(controller, [far, near], new Set([30n]));
    expect(deps.continued.at(-1)).toEqual({
      candidate: near,
      depth: DEPTH + 1,
    });
  });

  it("an accept whose child leaves the sphere ends the round", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    controller.deeper();
    controller.deeper();
    const outside = new Float32Array([RADIUS_NM * 10, 0, 0]);
    const leaving = candidate({
      lineId: 41n,
      score: 0.8,
      pointA: outside,
      pointB: outside,
    });
    await acceptWith(controller, [leaving], new Set([30n]));
    expect(deps.continued.at(-1)).toEqual({
      candidate: leaving,
      depth: DEPTH + 1,
    });
    await decide(controller, deps, "reject", [
      candidate({ lineId: 40n, score: 0.21 }),
    ]);
    expect(controller.prompt).toMatchObject({
      phase: "open",
      threshold: START_THRESHOLD,
    });
  });

  it("the end sphere is the open prompt's, then the round's while it goes on", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = setUp();
    const done = controller.afterReject(DECIDED, SEED_ROOT, DEPTH, new Set());
    expect(controller.endSphere).toBeUndefined();
    deps.fetches[0].result.resolve([lower]);
    await done;
    const sphere = { center: DECIDED.pointA, radiusNm: RADIUS_NM };
    expect(controller.endSphere).toEqual(sphere);
    controller.deeper();
    controller.deeper();
    expect(controller.prompt).toBeUndefined();
    expect(controller.endSphere).toEqual(sphere);
    const checking = acceptWith(controller, [], new Set([30n]));
    expect(controller.endSphere).toEqual(sphere);
    await checking;
    controller.answer("certain");
    expect(controller.endSphere).toBeUndefined();
  });

  it("the end is in question while its prompt is open or rechecked, not while a round goes on", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const lowest = candidate({ lineId: 31n, score: 0.12 });
    const { deps, controller } = await openPrompt("reject", [lower, lowest]);
    expect(controller.endInQuestion).toBe(true);
    deps.unknownUntilFill.add(30n);
    void controller.deeper();
    const done = controller.deeper();
    expect(controller.prompt?.phase).toBe("checking");
    expect(controller.endInQuestion).toBe(true);
    deps.fills[0].result.resolve();
    await done;
    expect(deps.continued).toHaveLength(1);
    expect(controller.endSphere).toBeDefined();
    expect(controller.endInQuestion).toBe(false);
    await controller.afterReject(lower, SEED_ROOT, DEPTH, new Set([30n]));
    expect(controller.prompt?.phase).toBe("open");
    expect(controller.endInQuestion).toBe(true);
  });

  it("a dismiss while a round goes on tells that its sphere is gone", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    controller.deeper();
    controller.deeper();
    const changes = deps.changes;
    controller.dismiss();
    expect(controller.endSphere).toBeUndefined();
    expect(deps.changes).toBeGreaterThan(changes);
  });

  it("a smaller sphere leaves out the candidates outside it", async () => {
    const outside = Float32Array.of(901, 2, 3);
    const between = candidate({
      lineId: 30n,
      score: 0.22,
      pointA: outside,
      pointB: outside,
    });
    const { deps, controller } = await openPrompt("reject", [between]);
    expect(controller.prompt).toMatchObject({
      canShrink: true,
      canGrow: false,
    });
    controller.shrink();
    expect(controller.prompt).toMatchObject({
      phase: "open",
      radiusNm: SHRUNK_RADIUS_NM,
      canGrow: true,
    });
    expect(controller.endSphere?.radiusNm).toBe(SHRUNK_RADIUS_NM);
    controller.deeper();
    controller.deeper();
    expect(deps.continued).toEqual([]);
    expect(controller.prompt).toMatchObject({ threshold: 0.2 });
    controller.answer("certain");
    expect(deps.writes[0].row.radiusNm).toBe(SHRUNK_RADIUS_NM);
  });

  it("a larger sphere goes back no further than the radius read", async () => {
    const { controller } = await openPrompt("reject", []);
    controller.grow();
    expect(controller.prompt?.radiusNm).toBe(RADIUS_NM);
    controller.shrink();
    controller.shrink();
    controller.grow();
    controller.grow();
    expect(controller.prompt).toMatchObject({
      radiusNm: RADIUS_NM,
      canGrow: false,
    });
  });

  it("growing back goes on with a candidate passing at the lowered threshold", async () => {
    const outside = Float32Array.of(901, 2, 3);
    const between = candidate({
      lineId: 30n,
      score: 0.22,
      pointA: outside,
      pointB: outside,
    });
    const { deps, controller } = await openPrompt("reject", [between]);
    controller.shrink();
    controller.deeper();
    controller.deeper();
    controller.grow();
    expect(deps.continued).toEqual([{ candidate: between, depth: DEPTH }]);
  });

  it("a look-deeper round keeps the smaller sphere", async () => {
    const near = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [near]);
    controller.shrink();
    controller.deeper();
    controller.deeper();
    expect(deps.continued).toEqual([{ candidate: near, depth: DEPTH }]);
    expect(controller.endSphere?.radiusNm).toBe(SHRUNK_RADIUS_NM);
  });

  it("shrinking stops at the smallest sphere", async () => {
    const { controller } = await openPrompt("reject", []);
    for (let i = 0; i < SHRINKS_TO_MIN; i++) controller.shrink();
    expect(controller.prompt).toMatchObject({
      radiusNm: TRACE_SPHERE_RADIUS_MIN_NM,
      canShrink: false,
    });
  });

  it("a seed sphere with nothing passing asks for an end at its centre", async () => {
    const { deps, controller } = setUp();
    const done = controller.atSeed(SEED_CENTER, SEED_ROOT, new Set());
    expect(deps.fetches[0]).toMatchObject({
      seedRoot: SEED_ROOT,
      center: SEED_CENTER,
      radiusNm: RADIUS_NM,
    });
    deps.fetches[0].result.resolve([LOW]);
    await done;
    expect(controller.prompt).toMatchObject({
      phase: "open",
      endPoint: SEED_CENTER,
      threshold: START_THRESHOLD,
    });
    controller.answer("uncertain");
    expect(deps.writes[0].row).toEqual({
      status: "uncertain",
      threshold: START_THRESHOLD,
      radiusNm: RADIUS_NM,
      position: SEED_CENTER,
    });
  });

  it("look deeper from the seed sphere goes on at depth 0 in a round", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = setUp();
    const done = controller.atSeed(SEED_CENTER, SEED_ROOT, new Set());
    deps.fetches[0].result.resolve([lower]);
    await done;
    controller.deeper();
    controller.deeper();
    expect(deps.continued).toEqual([{ candidate: lower, depth: 0 }]);
    expect(controller.endSphere?.center).toBe(SEED_CENTER);
  });

  it("deeper is unavailable at 0", async () => {
    const { controller } = await openPrompt("reject", []);
    for (let i = 0; i < STEPS_TO_ZERO; i++) controller.deeper();
    expect(controller.prompt).toMatchObject({
      threshold: 0,
      canGoDeeper: false,
    });
    const atZero = controller.prompt;
    controller.deeper();
    expect(controller.prompt).toBe(atZero);
  });

  it("back stops at the start threshold", async () => {
    const { controller } = await openPrompt("reject", []);
    const atStart = controller.prompt;
    controller.back();
    expect(controller.prompt).toBe(atStart);
    controller.deeper();
    controller.back();
    expect(controller.prompt).toMatchObject({
      threshold: START_THRESHOLD,
      canGoBack: false,
      canGoDeeper: true,
    });
  });

  it("a score equal to the threshold passes", async () => {
    const atThreshold = candidate({ lineId: 30n, score: 0.25 });
    const { deps, controller } = await openPrompt("reject", [atThreshold]);
    controller.deeper();
    expect(deps.verdictThresholds.at(-1)).toBe(0.25);
    expect(deps.continued).toEqual([{ candidate: atThreshold, depth: DEPTH }]);
  });

  it("deeper and back are ignored while checking", async () => {
    const { deps, controller } = setUp();
    void controller.afterReject(DECIDED, SEED_ROOT, DEPTH, new Set());
    const checking = controller.prompt;
    controller.deeper();
    controller.back();
    expect(controller.prompt).toBe(checking);
    expect(deps.verdictThresholds).toEqual([]);
  });

  it("dismiss writes nothing and shows the next candidate", async () => {
    const { deps, controller } = await openPrompt();
    controller.dismiss();
    expect(controller.prompt).toBeUndefined();
    expect(deps.writes).toEqual([]);
    expect(deps.shownNext).toBe(1);
  });

  it("undo after an answer removes the row and reopens the same prompt", async () => {
    const { deps, controller } = await openPrompt("reject", []);
    controller.deeper();
    const answered = controller.prompt;
    controller.answer("uncertain");
    deps.writes[0].result.resolve(55n);
    expect(await controller.undo()).toBe(true);
    expect(deps.removed).toEqual([55n]);
    expect(deps.removedFrom).toEqual(["uncertain"]);
    expect(controller.prompt).toEqual(answered);
    controller.answer("certain");
    expect(deps.writes.map((write) => write.row)).toMatchObject([
      { status: "uncertain", threshold: 0.25 },
      { status: "certain", threshold: 0.25 },
    ]);
  });

  it("undo of an endpoint whose write failed reopens the prompt and removes nothing", async () => {
    const { deps, controller } = await openPrompt();
    const answered = controller.prompt;
    controller.answer("certain");
    deps.writes[0].result.reject(new Error("HTTP 500"));
    expect(await controller.undo()).toBe(true);
    expect(deps.removed).toEqual([]);
    expect(controller.prompt).toEqual(answered);
  });

  it("undo with an accept on top returns false", async () => {
    const { deps, controller } = setUp();
    await answerWithRow(controller, deps, 55n);
    controller.noteAccept(6n);
    expect(await controller.undo()).toBe(false);
    expect(deps.removed).toEqual([]);
    expect(controller.prompt).toBeUndefined();
  });

  it("endpoints above an accept are undone before it", async () => {
    const { deps, controller } = setUp();
    controller.noteAccept(5n);
    await answerWithRow(controller, deps, 55n);
    await answerWithRow(controller, deps, 56n);
    expect(await controller.undo()).toBe(true);
    expect(await controller.undo()).toBe(true);
    expect(await controller.undo()).toBe(false);
    expect(deps.removed).toEqual([56n, 55n]);
  });

  it("an endpoint carries the undo mark taken when it was answered", async () => {
    const { deps, controller } = setUp();
    expect(controller.newestEndpointMark()).toBeUndefined();
    deps.mark = "edit-7";
    await answerWithRow(controller, deps, 55n);
    deps.mark = "edit-8";
    expect(controller.newestEndpointMark()).toBe("edit-7");
  });

  it("has no endpoint mark when an accept is newest", async () => {
    const { deps, controller } = setUp();
    await answerWithRow(controller, deps, 55n);
    controller.noteAccept(6n);
    expect(controller.newestEndpointMark()).toBeUndefined();
  });

  it("forgetAccept drops the newest accept from the history", async () => {
    const { deps, controller } = setUp();
    await answerWithRow(controller, deps, 55n);
    controller.noteAccept(6n);
    controller.forgetAccept();
    expect(await controller.undo()).toBe(true);
    expect(deps.removed).toEqual([55n]);
  });

  it("a new decision while the prompt is open replaces it", async () => {
    const { deps, controller } = await openPrompt();
    const done = controller.afterReject(DECIDED, SEED_ROOT, DEPTH, new Set());
    expect(controller.prompt?.phase).toBe("checking");
    deps.fetches.at(-1)!.result.resolve([]);
    await done;
    expect(controller.prompt).toMatchObject({
      phase: "open",
      endPoint: DECIDED.pointA,
    });
  });

  it("a check that resolves after dismiss opens nothing", async () => {
    const { deps, controller } = setUp();
    const done = controller.afterReject(DECIDED, SEED_ROOT, DEPTH, new Set());
    controller.dismiss();
    expect(deps.shownNext).toBe(1);
    deps.fetches[0].result.resolve([candidate({ lineId: 30n, score: 0.8 })]);
    await done;
    expect(controller.prompt).toBeUndefined();
    expect(deps.continued).toEqual([]);
    expect(deps.shownNext).toBe(1);
  });

  it("a check that resolves after reset opens nothing", async () => {
    const { deps, controller } = setUp();
    deps.unknownUntilFill.add(30n);
    const done = acceptWith(controller, [candidate({ lineId: 30n })]);
    await settle();
    controller.reset();
    deps.fills[0].result.resolve();
    await done;
    expect(controller.prompt).toBeUndefined();
    expect(deps.continued).toEqual([]);
    expect(deps.shownNext).toBe(0);
    expect(deps.errors).toEqual([]);
  });

  it("reset clears the undo history", async () => {
    const { deps, controller } = setUp();
    await answerWithRow(controller, deps, 55n);
    controller.reset();
    expect(await controller.undo()).toBe(false);
  });

  it("an undo finishing after reset removes the row but reopens nothing", async () => {
    const { deps, controller } = await openPrompt();
    controller.answer("certain");
    const undone = controller.undo();
    controller.reset();
    deps.writes[0].result.resolve(55n);
    expect(await undone).toBe(true);
    expect(deps.removed).toEqual([55n]);
    expect(controller.prompt).toBeUndefined();
  });

  it("a failed remove reports and reopens nothing", async () => {
    const { deps, controller } = setUp();
    await answerWithRow(controller, deps, 55n);
    deps.removeFails = true;
    expect(await controller.undo()).toBe(true);
    expect(deps.errors).toHaveLength(1);
    expect(deps.errors[0]).toMatch(/trace end.*HTTP 409/);
    expect(controller.prompt).toBeUndefined();
    deps.removeFails = false;
    expect(await controller.undo()).toBe(true);
    expect(deps.removed).toEqual([55n]);
  });

  it("undo during a check whose remove fails shows the next candidate", async () => {
    const { deps, controller } = setUp();
    await answerWithRow(controller, deps, 55n);
    void controller.afterReject(DECIDED, SEED_ROOT, DEPTH, new Set());
    expect(controller.prompt?.phase).toBe("checking");
    deps.removeFails = true;
    const shownBefore = deps.shownNext;
    expect(await controller.undo()).toBe(true);
    expect(controller.prompt).toBeUndefined();
    expect(deps.shownNext).toBe(shownBefore + 1);
  });

  it("an undo over an open prompt replaces it with the reopened one and shows next only once", async () => {
    const { deps, controller } = setUp();
    await decide(controller, deps, "reject", []);
    const answered = controller.prompt;
    controller.answer("certain");
    deps.writes[0].result.resolve(55n);
    await decide(controller, deps, "reject", []);
    const shownBefore = deps.shownNext;
    const undone = controller.undo();
    expect(controller.prompt).toBeUndefined();
    expect(await undone).toBe(true);
    expect(controller.prompt).toEqual(answered);
    expect(deps.shownNext).toBe(shownBefore);
  });

  it("a prepared check is reused by afterReject for the same line", async () => {
    const { deps, controller } = setUp();
    controller.prepare(DECIDED, SEED_ROOT);
    expect(deps.fetches.map((fetch) => fetch.center)).toEqual([DECIDED.pointA]);
    for (const fetch of deps.fetches) fetch.result.resolve([LOW]);
    await controller.afterReject(DECIDED, SEED_ROOT, DEPTH, new Set());
    expect(deps.fetches).toHaveLength(1);
    expect(controller.prompt).toMatchObject({
      phase: "open",
      endPoint: DECIDED.pointA,
    });
  });

  it("a prepared check for another line is dropped", async () => {
    const { deps, controller } = setUp();
    controller.prepare(candidate({ lineId: 40n }), SEED_ROOT);
    controller.prepare(DECIDED, SEED_ROOT);
    controller.prepare(candidate({ lineId: 41n }), SEED_ROOT);
    for (const fetch of deps.fetches) fetch.result.resolve([LOW]);
    await decide(controller, deps, "reject", [LOW]);
    expect(deps.fetches).toHaveLength(4);
    expect(deps.fetches[3]).toMatchObject({
      seedRoot: SEED_ROOT,
      center: DECIDED.pointA,
    });
  });

  it("a prepared check that failed is replaced by a fresh fetch", async () => {
    const { deps, controller } = setUp();
    controller.prepare(DECIDED, SEED_ROOT);
    for (const fetch of deps.fetches)
      fetch.result.reject(new Error("HTTP 500"));
    const done = controller.afterReject(DECIDED, SEED_ROOT, DEPTH, new Set());
    await settle();
    expect(deps.fetches).toHaveLength(2);
    deps.fetches[1].result.resolve([LOW]);
    await done;
    expect(deps.errors).toEqual([]);
    expect(controller.prompt?.phase).toBe("open");
  });

  it("a forgotten prepared check is not reused", async () => {
    const { deps, controller } = setUp();
    controller.prepare(DECIDED, SEED_ROOT);
    for (const fetch of deps.fetches) fetch.result.resolve([LOW]);
    controller.forgetPrepared();
    await decide(controller, deps, "reject", [LOW]);
    expect(deps.fetches).toHaveLength(2);
  });

  it("a prepared check is not reused after the radius changed or a reset", async () => {
    const { deps, controller } = setUp();
    controller.prepare(DECIDED, SEED_ROOT);
    controller.reset();
    await decide(controller, deps, "reject", [LOW]);
    expect(deps.fetches).toHaveLength(2);
    controller.prepare(DECIDED, SEED_ROOT);
    deps.radiusNm = () => RADIUS_NM * 2;
    await decide(controller, deps, "reject", [LOW]);
    expect(deps.fetches).toHaveLength(4);
    expect(deps.fetches[3].radiusNm).toBe(RADIUS_NM * 2);
  });

  it("deeper fills the graph for a candidate below the start threshold, then continues with it", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    deps.unknownUntilFill.add(30n);
    void controller.deeper();
    const done = controller.deeper();
    expect(controller.prompt).toMatchObject({
      phase: "checking",
      threshold: 0.2,
    });
    expect(deps.fills.map((fill) => fill.threshold)).toEqual([0.2]);
    expect(deps.fills[0].candidates).toEqual([lower]);
    expect(deps.continued).toEqual([]);
    deps.fills[0].result.resolve();
    await done;
    expect(deps.continued).toEqual([{ candidate: lower, depth: DEPTH }]);
    expect(controller.prompt).toBeUndefined();
    expect(deps.writes).toEqual([]);
  });

  it("a deeper re-check keeps the known end point while it waits for the graph", async () => {
    const lower = candidate({ lineId: 30n, score: 0.22 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    deps.unknownUntilFill.add(30n);
    void controller.deeper();
    void controller.deeper();
    expect(controller.prompt).toMatchObject({
      phase: "checking",
      endPoint: DECIDED.pointA,
      endPointKnown: true,
    });
  });

  it("deeper with the graph still unknown after the fill reports and shows the next candidate", async () => {
    const lower = candidate({ lineId: 30n, score: 0.27 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    deps.unknownUntilFill.add(30n);
    deps.graphFillLeavesUnknown = true;
    const done = controller.deeper();
    deps.fills[0].result.resolve();
    await done;
    expect(deps.errors).toEqual([GRAPH_UNKNOWN_ERROR]);
    expect(deps.shownNext).toBe(1);
    expect(deps.continued).toEqual([]);
    expect(deps.writes).toEqual([]);
    expect(controller.prompt).toBeUndefined();
  });

  it("a look-deeper fill that resolves after dismiss opens nothing", async () => {
    const lower = candidate({ lineId: 30n, score: 0.27 });
    const { deps, controller } = await openPrompt("reject", [lower]);
    deps.unknownUntilFill.add(30n);
    const done = controller.deeper();
    controller.dismiss();
    deps.fills[0].result.resolve();
    await done;
    expect(deps.continued).toEqual([]);
    expect(controller.prompt).toBeUndefined();
  });

  it("a failed graph fill reports the graph error with its cause", async () => {
    const { deps, controller } = setUp();
    deps.unknownUntilFill.add(30n);
    const done = acceptWith(controller, [candidate({ lineId: 30n })]);
    await settle();
    deps.fills[0].result.reject(new Error("HTTP 500"));
    await done;
    expect(deps.errors).toEqual([`${GRAPH_UNKNOWN_ERROR}: HTTP 500`]);
    expect(deps.shownNext).toBe(1);
    expect(controller.prompt).toBeUndefined();
  });

  it("a dismiss during a pending endpoint undo keeps its prompt shut", async () => {
    const { deps, controller } = await openPrompt();
    controller.answer("certain");
    const undone = controller.undo();
    controller.dismiss();
    deps.writes[0].result.resolve(55n);
    expect(await undone).toBe(true);
    expect(deps.removed).toEqual([55n]);
    expect(controller.prompt).toBeUndefined();
  });

  it("undo removes the row on the branch it was written on", async () => {
    const { deps, controller } = setUp();
    deps.branch = OTHER_BRANCH;
    await answerWithRow(controller, deps, 55n);
    expect(deps.writes[0].branchId).toBe(OTHER_BRANCH);
    deps.branch = MAIN_BRANCH;
    expect(await controller.undo()).toBe(true);
    expect(deps.removedOn).toEqual([OTHER_BRANCH]);
  });
});
