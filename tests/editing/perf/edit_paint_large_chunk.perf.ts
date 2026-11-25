/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Large-chunk paint benchmark (TM-373, PR 0): the "before" numbers for painting
 * on 4096×4096×1 chunks, and the same strokes on a 256² control.
 *
 * Fixtures (`manifest_large_chunk.json`, generated separately — ~1.4 GB):
 *  - a copy of the portal test dataset: 1238×1065×11 at offset
 *    28943,8913,3404, chunk 4096²×1, uint64 and uint8, raw. Every z-slice is one
 *    edge chunk padded to 4096² (TM-353);
 *  - the same volume with 256²×1 chunks, the "fast" control;
 *  - 8192×8192×2 with 4096²×1 chunks: interior chunks and a real 4-chunk
 *    junction, to tell padding cost from large-chunk cost.
 *  - uint8 image layers on the same volumes, for the masked strokes' mask.
 *
 * Per fixture, on one page: five unmasked strokes inside one chunk (the first
 * is the first touch), undo everything, a closed loop with fill, a stroke
 * across a chunk junction, a long diagonal stroke, and three masked strokes
 * followed by undo. Strokes are placed in voxels, so a path lands on the same
 * voxels whatever the chunk size.
 *
 * Unmasked strokes redo by replay (TM-319): their history entry holds only the
 * before-image and `edit.record()` copies nothing. Masked strokes keep an
 * after-image, so they are the ones that pay the copy + hash at stroke end.
 *
 * Run:  npm run perf:large-chunk          (headless)
 *       npm run perf:large-chunk:headed   (real render loop: frameDraw, GPU)
 *
 * Output: a table in stdout, `test-results/edit_paint_large_chunk.json` and
 * `.md`. Not a CI gate.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type {
  FixtureInfo,
  FixturesIndex,
  Scenario,
  Vec3,
} from "#tests/editing/harness/build_ng_state.js";
import {
  loadFixturesIndex,
  openScenarioPage,
  startFixtureGcs,
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";
import {
  measureHeapBuffers,
  type BufferOwnerRule,
  type BufferOwnerTotal,
} from "#tests/editing/harness/heap_buffer_owners.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);

/** Brush radius for every stroke, in voxels. */
const BRUSH_RADIUS = 16;
/** Pointer moves per stroke. */
const STROKE_POINTS = 30;
/** Strokes in one chunk before the undo run. */
const SAME_CHUNK_STROKES = 5;
/** Each repeated stroke moves this far, so it paints voxels the last one didn't. */
const REPEAT_SHIFT_VOXELS = 6;
/**
 * Painted value: outside the fixtures' 1..7 ids, so every brushed voxel
 * differs, and within uint8, so the uint8 target stores it as is.
 */
const PAINT_VALUE = "200";
/** Radius of the closed loop for the fill check, in voxels. */
const FILL_LOOP_RADIUS_VOXELS = 80;
/** What the painting tools show when they refuse a fill (`painting_tools.ts`). */
const FILL_TOO_LARGE_TEXT = "too large to fill";
/** Shift of the stroke committed before re-entry, clear of the earlier ones. */
const COMMITTED_SHIFT_VOXELS = 60;
/** Masked strokes before their undo run. */
const MASKED_STROKES = 3;
/** Slack for the landing check: brush rasterization rounds at the rim. */
const LANDING_TOLERANCE_VOXELS = 3;

type Point = readonly [number, number];

/** A straight stroke between two region-relative voxel points. */
interface Segment {
  readonly from: Point;
  readonly to: Point;
}

interface LargeChunkScenario {
  readonly label: string;
  readonly fixtureId: string;
  /** Image layer for the masked strokes' threshold mask. */
  readonly imageFixtureId: string;
  readonly crossSectionScale: number;
  readonly sameChunk: Segment;
  readonly junction: Segment;
  readonly diagonal: Segment;
  /**
   * Region-relative centre of a closed-loop fill that stays inside one chunk,
   * where the panel-centre fill does not (TM-373 PR 1: one 4096² tile fits the
   * fill limit). Absent where the panel-centre fill is already in one chunk.
   */
  readonly oneChunkFill?: Point;
}

// 1238×1065 region. On the 256² grid [256, 512) is one chunk and 512 a
// junction; on the 4096² grid the whole region is one edge chunk.
const PORTAL_COPY_STROKES = {
  sameChunk: { from: [300, 300], to: [470, 470] },
  junction: { from: [440, 440], to: [590, 590] },
  diagonal: { from: [40, 40], to: [1020, 1020] },
} as const;

const SCENARIOS: readonly LargeChunkScenario[] = [
  {
    label: "256² control, uint64 (portal copy)",
    fixtureId: "large_seg_u64_256_edge",
    imageFixtureId: "large_img_u8_edge",
    crossSectionScale: 2,
    ...PORTAL_COPY_STROKES,
  },
  {
    label: "4096² edge, uint64 (portal copy)",
    fixtureId: "large_seg_u64_4096_edge",
    imageFixtureId: "large_img_u8_edge",
    crossSectionScale: 2,
    ...PORTAL_COPY_STROKES,
  },
  {
    label: "4096² edge, uint8 (portal copy)",
    fixtureId: "large_seg_u8_4096_edge",
    imageFixtureId: "large_img_u8_edge",
    crossSectionScale: 2,
    ...PORTAL_COPY_STROKES,
  },
  {
    // 8192² region; 4096 is the junction of the 2×2 interior chunks, and the
    // fill loop (at the panel centre) spans all four.
    label: "4096² interior, uint64 (8192²×2)",
    fixtureId: "large_seg_u64_4096_interior",
    imageFixtureId: "large_img_u8_interior",
    crossSectionScale: 16,
    sameChunk: { from: [1200, 1200], to: [1370, 1370] },
    junction: { from: [4020, 4020], to: [4170, 4170] },
    diagonal: { from: [64, 64], to: [4030, 4030] },
    oneChunkFill: [2048, 2048],
  },
];

/** What `__editPaintBench*` large-chunk calls return (see `edit_paint_bench.ts`). */
interface LargeChunkWindow {
  readonly ok: boolean;
  readonly error?: string;
  readonly wallMs: number;
  readonly frames: {
    frames: number;
    meanMs: number;
    p95Ms: number;
    maxMs: number;
  };
  readonly timings: Record<
    string,
    { totalMs: number; calls: number; maxMs: number }
  >;
  readonly counters: Record<string, number>;
  readonly summary: string;
  readonly jsHeapMb?: number;
}

interface UndoAllResult {
  readonly undone: number;
  readonly canUndoAfter: boolean;
  readonly undos: readonly LargeChunkWindow[];
}

interface ReadbackResult {
  readonly paintedVoxels: number;
  /** Patched voxels holding the requested `countValue`. */
  readonly valueCount: number;
  readonly bbox: { lo: Vec3; hi: Vec3 } | null;
  readonly error?: string;
}

/** A closed-loop fill: refused ("too large"), and the voxels the loop left. */
interface FillOutcome {
  readonly refused: boolean;
  readonly paintedVoxels: number;
}

interface ScenarioReport {
  label: string;
  fixtureId: string;
  sessionOpenMs?: number;
  setupError?: string;
  strokes: Array<{ name: string; window: LargeChunkWindow }>;
  undo?: UndoAllResult;
  maskedUndo?: UndoAllResult;
  fill?: {
    unmasked: FillOutcome;
    masked: FillOutcome;
  };
  oneChunkFill?: {
    unmasked: FillOutcome;
    masked: FillOutcome;
  };
  history?: unknown;
  memory: MemorySnapshot[];
}

/**
 * Main-thread memory after a step, after a forced GC: V8's own heap and the
 * ArrayBuffer backing stores (CDP `Runtime.getHeapUsage`), and who holds the
 * buffers of 1 MB and more (a heap snapshot, `MEMORY_OWNER_RULES`).
 * `usedJSHeapSize` misses the buffers, and a walk of fields misses the ones a
 * closure holds (lazy content refs, history entries).
 */
interface MemorySnapshot {
  readonly after: string;
  readonly heapMb?: number;
  readonly backingStoreMb?: number;
  /** Reachable edit sessions (objects with `overlay` + `historyJournal`). */
  readonly liveSessions?: number;
  readonly ownersMb?: Record<string, number>;
  /** Buffers no rule matched: MB by retaining path. */
  readonly unmatchedMb?: Record<string, number>;
  readonly error?: string;
}

/**
 * First match wins. The library's fields are those of `@zettaai/edit-session`
 * 0.1.2; a session reached other than through `activeSession` is one the host
 * should have let go.
 */
const MEMORY_OWNER_RULES: readonly BufferOwnerRule[] = [
  { label: "ng.mirror", match: ["editSessionHost", "perLayer", "patchStore"] },
  {
    label: "lib.slots",
    match: ["editSessionHost", "activeSession", "overlay", "slotMap", "data"],
  },
  {
    label: "lib.slot refs",
    match: [
      "editSessionHost",
      "activeSession",
      "overlay",
      "slotMap",
      "contentRef",
    ],
  },
  {
    label: "lib.baselineRefs",
    match: ["editSessionHost", "activeSession", "overlay", "baselineRefs"],
  },
  {
    label: "lib.baselineBuffers",
    match: ["editSessionHost", "activeSession", "overlay", "baselineBuffers"],
  },
  {
    label: "lib.history",
    match: ["editSessionHost", "activeSession", "historyJournal"],
  },
  { label: "lib.other", match: ["editSessionHost", "activeSession"] },
  { label: "inactive session", match: ["editSessionHost", "overlay"] },
  { label: "inactive session", match: ["editSessionHost", "historyJournal"] },
  { label: "ng.host", match: ["editSessionHost"], splitByNextEdge: true },
];

let fixtures: FixturesIndex | undefined;
let fixturesError: string | undefined;
try {
  fixtures = loadFixturesIndex("largeChunk");
} catch (e) {
  fixturesError = e instanceof Error ? e.message : String(e);
}

function fixtureOf(fixtureId: string) {
  const fixture = fixtures?.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) {
    throw new Error(`fixture ${fixtureId} missing from the large-chunk index`);
  }
  return fixture;
}

/**
 * Read the fixtures straight from fake-gcs over http instead of through the
 * `gs://` route-rewrite: `route.fulfill` carries each body over the DevTools
 * protocol, whose 100 MB buffer a 4096² uint64 chunk (128 MB) overflows — the
 * browser is killed. Path-style downloads come with CORS headers, so the
 * cross-origin-isolated page can fetch them. Every scenario reads this way, so
 * the control and the large chunks share one path.
 */
function directFakeGcsSource(fakeGcsUrl: string) {
  return (fixture: FixtureInfo) =>
    `precomputed://${fakeGcsUrl}/${fixtures!.bucket}/${fixture.id}`;
}

function scenarioFor(large: LargeChunkScenario): Scenario {
  return {
    name: `large chunk: ${large.label}`,
    crossSectionScale: large.crossSectionScale,
    layers: [
      {
        fixtureId: large.imageFixtureId,
        role: "image",
        writable: false,
        name: "EM",
      },
      {
        fixtureId: large.fixtureId,
        role: "target",
        writable: true,
        name: "seg",
      },
    ],
    tooling: {
      activeToolId: "painting.brush",
      painting: {
        targetLayerId: "seg",
        targetResolution: "16x16x40",
        radius: BRUSH_RADIUS,
        activeValue: { t: "b", v: PAINT_VALUE },
        eraseValue: { t: "b", v: "0" },
        // Drops only image value 0 and skips morphology: the masked strokes
        // measure the image-redo history path, not the mask compute. (A mask
        // that keeps every voxel is ignored by a fill-capable stroke.)
        mask: {
          imageLayerId: "EM",
          imageResolution: "16x16x40",
          thresholdLow: 1,
          thresholdHigh: 255,
          minComponentSize: 0,
          binaryClosing: 0,
          filterComponentsFirst: false,
        },
      },
    },
  };
}

/**
 * Stroke points relative to the panel centre. `buildNgState` centres the view
 * on the region, so a region-relative point moves by half the region size.
 */
function strokePath(segment: Segment, regionSize: Vec3, shift = 0): Point[] {
  const centerX = regionSize[0] / 2;
  const centerY = regionSize[1] / 2;
  const points: Point[] = [];
  for (let i = 0; i < STROKE_POINTS; i++) {
    const t = i / (STROKE_POINTS - 1);
    const x = segment.from[0] + (segment.to[0] - segment.from[0]) * t;
    const y = segment.from[1] + (segment.to[1] - segment.from[1]) * t + shift;
    points.push([x - centerX, y - centerY]);
  }
  return points;
}

async function stroke(
  page: Page,
  points: Point[],
  masked = false,
): Promise<LargeChunkWindow> {
  return (await page.evaluate(
    async (input) => await (window as any).__editPaintBenchVoxelStroke(input),
    { path: points, radius: BRUSH_RADIUS, masked },
  )) as LargeChunkWindow;
}

const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

function megabyteRecord(
  totals: Record<string, BufferOwnerTotal>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(totals).map(([key, { bytes }]) => [key, megabytes(bytes)]),
  );
}

async function memorySnapshot(
  page: Page,
  after: string,
): Promise<MemorySnapshot> {
  try {
    const { usage, census } = await measureHeapBuffers(
      page,
      MEMORY_OWNER_RULES,
      { objectEdges: ["overlay", "historyJournal"] },
    );
    return {
      after,
      heapMb: megabytes(usage.usedSize),
      ...(usage.backingStorageSize !== undefined && {
        backingStoreMb: megabytes(usage.backingStorageSize),
      }),
      liveSessions: census.objectsWithEdges,
      ownersMb: megabyteRecord(census.owners),
      unmatchedMb: megabyteRecord(census.unmatched),
    };
  } catch (e) {
    return { after, error: e instanceof Error ? e.message : String(e) };
  }
}

async function undoAll(page: Page, max: number): Promise<UndoAllResult> {
  return (await page.evaluate(
    async (limit) =>
      await (window as any).__editPaintBenchUndoAll({ max: limit }),
    max,
  )) as UndoAllResult;
}

/**
 * Draw a closed loop with "fill closed paths" on, then undo it. `centerVoxels`
 * is relative to the panel centre (default: the centre).
 */
async function closedLoopFill(
  page: Page,
  large: LargeChunkScenario,
  originOffset: Vec3,
  masked: boolean,
  centerVoxels?: Point,
): Promise<FillOutcome> {
  const filled = (await page.evaluate(
    async (input) => await (window as any).__editPaintBenchStampReadback(input),
    {
      centerVoxels,
      closedLoopRadiusPx: FILL_LOOP_RADIUS_VOXELS / large.crossSectionScale,
      fillClosedPaths: true,
      masked,
      radius: 4,
      prime: 0,
      clearFirst: true,
      settleTimeoutMs: 60_000,
      maxVoxels: 1,
      sampleSize: 0,
      originOffset,
    },
  )) as ReadbackResult;
  const refused = await page.evaluate(
    (text) => document.body.innerText.includes(text),
    FILL_TOO_LARGE_TEXT,
  );
  // The refusal message shows for 8 s; undo the loop and wait it out so
  // the next fill starts clean.
  await undoAll(page, 1);
  await page.waitForFunction(
    (text) => !document.body.innerText.includes(text),
    FILL_TOO_LARGE_TEXT,
    { timeout: 15_000 },
  );
  return { refused, paintedVoxels: filled.paintedVoxels };
}

async function readback(
  page: Page,
  originOffset: Vec3,
  countValue?: string,
): Promise<ReadbackResult> {
  return (await page.evaluate(
    (input) =>
      (window as any).__editPaintBenchReadback({
        maxVoxels: 1,
        sampleSize: 0,
        originOffset: input.originOffset,
        countValue: input.countValue,
        // Explicit: after a discard there is no session to name the target.
        layerId: "seg",
      }),
    { originOffset, countValue },
  )) as ReadbackResult;
}

function attachWindow(name: string, window: LargeChunkWindow) {
  console.log(
    `\n── ${name}: wall ${window.wallMs} ms · frame max ${window.frames.maxMs} ms\n` +
      window.summary,
  );
  return test.info().attach(`${name}.txt`, {
    body: window.summary || `(no output) ${window.error ?? ""}`,
    contentType: "text/plain",
  });
}

for (const large of SCENARIOS) {
  test.describe.serial(large.label, () => {
    let page: Page | undefined;
    let fakeGcs: FixtureGcs | undefined;
    const report: ScenarioReport = {
      label: large.label,
      fixtureId: large.fixtureId,
      strokes: [],
      memory: [],
    };
    const recordMemory = async (activePage: Page, after: string) => {
      const snapshot = await memorySnapshot(activePage, after);
      report.memory.push(snapshot);
      console.log(
        `[large-chunk] ${large.label}: memory after ${after} ` +
          JSON.stringify(snapshot),
      );
    };

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(10 * 60 * 1000);
      if (fixturesError !== undefined) {
        report.setupError = fixturesError;
        return;
      }
      try {
        fakeGcs = await startFixtureGcs();
        const start = Date.now();
        page = await openScenarioPage(browser, {
          scenario: scenarioFor(large),
          fixtures: fixtures!,
          fakeGcsUrl: fakeGcs.url,
          appPort: PORT,
          sourceFor: directFakeGcsSource(fakeGcs.url),
        });
        report.sessionOpenMs = Date.now() - start;
      } catch (e) {
        report.setupError = e instanceof Error ? e.message : String(e);
      }
    });

    test.afterAll(async () => {
      if (page !== undefined) {
        await page
          .context()
          .close()
          .catch(() => {});
      }
      await fakeGcs?.[Symbol.asyncDispose]?.();
      writeScenarioReport(report);
    });

    const requirePage = (): Page => {
      test.skip(
        page === undefined,
        `setup failed: ${report.setupError ?? "no page"}`,
      );
      return page!;
    };

    test(`${SAME_CHUNK_STROKES} strokes in one chunk`, async () => {
      const activePage = requirePage();
      const fixture = fixtureOf(large.fixtureId);
      for (let i = 0; i < SAME_CHUNK_STROKES; i++) {
        const name =
          i === 0 ? "stroke 1 (first touch)" : `stroke ${i + 1} (same chunk)`;
        const window = await stroke(
          activePage,
          strokePath(large.sameChunk, fixture.size, i * REPEAT_SHIFT_VOXELS),
        );
        report.strokes.push({ name, window });
        await attachWindow(name, window);
        expect(window.error ?? "", `${name} failed`).toBe("");

        if (i === 0) {
          // The voxel→screen mapping is what puts a stroke on the chunks the
          // case is about; check the first stroke landed where it was aimed.
          const landed = await readback(activePage, fixture.offset);
          expect(landed.error ?? "").toBe("");
          expect(landed.bbox, "first stroke painted nothing").not.toBeNull();
          console.log(
            `[large-chunk] ${large.label}: first stroke bbox ` +
              JSON.stringify(landed.bbox),
          );
          const { from, to } = large.sameChunk;
          for (const axis of [0, 1] as const) {
            const expectedLo =
              fixture.offset[axis] +
              Math.min(from[axis], to[axis]) -
              BRUSH_RADIUS;
            const expectedHi =
              fixture.offset[axis] +
              Math.max(from[axis], to[axis]) +
              BRUSH_RADIUS;
            expect(
              Math.abs(landed.bbox!.lo[axis] - expectedLo),
              `stroke lo on axis ${axis}`,
            ).toBeLessThanOrEqual(LANDING_TOLERANCE_VOXELS);
            expect(
              Math.abs(landed.bbox!.hi[axis] - expectedHi),
              `stroke hi on axis ${axis}`,
            ).toBeLessThanOrEqual(LANDING_TOLERANCE_VOXELS);
          }
        }
      }
      await recordMemory(activePage, "same-chunk strokes");
    });

    test("undo everything", async () => {
      const activePage = requirePage();
      const undo = await undoAll(activePage, SAME_CHUNK_STROKES + 5);
      report.undo = undo;
      undo.undos.forEach((window, i) => attachWindow(`undo ${i + 1}`, window));
      console.log(
        `[large-chunk] ${large.label}: undo depth ${undo.undone} of ` +
          `${SAME_CHUNK_STROKES} strokes`,
      );
      await recordMemory(activePage, "undo everything");
      expect(undo.undone, "no undo ran").toBeGreaterThan(0);
    });

    test("closed loop fill", async () => {
      // Runs on an empty history (right after the undo run), so the only thing
      // that decides each fill is its own size. Unmasked strokes redo by replay
      // (history holds the before-image only); masked ones by image (before +
      // after), which doubles the bytes the fill limit counts.
      const activePage = requirePage();
      const fixture = fixtureOf(large.fixtureId);
      report.fill = {
        unmasked: await closedLoopFill(
          activePage,
          large,
          fixture.offset,
          false,
        ),
        masked: await closedLoopFill(activePage, large, fixture.offset, true),
      };
      console.log(
        `[large-chunk] ${large.label}: fill ${JSON.stringify(report.fill)}`,
      );
    });

    const oneChunkFill = large.oneChunkFill;
    if (oneChunkFill !== undefined) {
      test("closed loop fill inside one chunk", async () => {
        // One tile: replay redo records 1 chunk, image redo 2. Both must fit
        // half of the session's history budget (TM-373 PR 1).
        const activePage = requirePage();
        const fixture = fixtureOf(large.fixtureId);
        const [centerVoxels] = strokePath(
          { from: oneChunkFill, to: oneChunkFill },
          fixture.size,
        );
        report.oneChunkFill = {
          unmasked: await closedLoopFill(
            activePage,
            large,
            fixture.offset,
            false,
            centerVoxels,
          ),
          masked: await closedLoopFill(
            activePage,
            large,
            fixture.offset,
            true,
            centerVoxels,
          ),
        };
        console.log(
          `[large-chunk] ${large.label}: one-chunk fill ` +
            JSON.stringify(report.oneChunkFill),
        );
        expect(report.oneChunkFill.unmasked.refused, "unmasked refused").toBe(
          false,
        );
        expect(report.oneChunkFill.masked.refused, "masked refused").toBe(
          false,
        );
        // The loop's disc is ~20k voxels; the outline alone is a few hundred.
        for (const outcome of [
          report.oneChunkFill.unmasked,
          report.oneChunkFill.masked,
        ]) {
          expect(outcome.paintedVoxels, "fill painted nothing").toBeGreaterThan(
            10_000,
          );
        }
      });
    }

    test("stroke across a chunk junction", async () => {
      const activePage = requirePage();
      const fixture = fixtureOf(large.fixtureId);
      const window = await stroke(
        activePage,
        strokePath(large.junction, fixture.size),
      );
      report.strokes.push({ name: "junction", window });
      await attachWindow("junction", window);
      await recordMemory(activePage, "junction");
      expect(window.error ?? "").toBe("");
    });

    test("long diagonal stroke", async () => {
      const activePage = requirePage();
      const fixture = fixtureOf(large.fixtureId);
      const window = await stroke(
        activePage,
        strokePath(large.diagonal, fixture.size),
      );
      report.strokes.push({ name: "diagonal", window });
      await attachWindow("diagonal", window);
      await recordMemory(activePage, "diagonal");
      expect(window.error ?? "").toBe("");
    });

    test(`${MASKED_STROKES} masked strokes, then undo`, async () => {
      const activePage = requirePage();
      const fixture = fixtureOf(large.fixtureId);
      for (let i = 0; i < MASKED_STROKES; i++) {
        const name = `masked ${i + 1} (same chunk)`;
        const window = await stroke(
          activePage,
          strokePath(large.sameChunk, fixture.size, i * REPEAT_SHIFT_VOXELS),
          true,
        );
        report.strokes.push({ name, window });
        await attachWindow(name, window);
        expect(window.error ?? "", `${name} failed`).toBe("");
      }
      await recordMemory(activePage, "masked strokes");
      const undo = await undoAll(activePage, MASKED_STROKES);
      report.maskedUndo = undo;
      undo.undos.forEach((window, i) =>
        attachWindow(`masked undo ${i + 1}`, window),
      );
      expect(undo.undone, "no undo ran").toBeGreaterThan(0);
    });

    test("commit, re-enter, discard", async () => {
      // The committed paint must survive re-entry and the discard that ends
      // the re-entered session. A committed chunk comes back whole, so the
      // paint is counted by its value, not by "patched".
      const activePage = requirePage();
      const fixture = fixtureOf(large.fixtureId);
      // While the session that painted everything is still open: the 3D
      // preview's status (after the discard there is no session to ask).
      report.history = await activePage.evaluate(() =>
        (window as any).__editPaintBenchHistory(),
      );
      const committedPaint = async () =>
        (await readback(activePage, fixture.offset, PAINT_VALUE)).valueCount;
      const sessionCall = async (name: string) =>
        (await activePage.evaluate(
          async (fn) => await (window as any)[fn](),
          name,
        )) as { ok: boolean; error?: string };

      await stroke(
        activePage,
        strokePath(large.sameChunk, fixture.size, COMMITTED_SHIFT_VOXELS),
      );
      const committed = await committedPaint();
      expect(committed).toBeGreaterThan(0);

      const reenter = await sessionCall("__editPaintBenchCommitAndReenter");
      expect(reenter.error ?? "").toBe("");
      expect(await committedPaint()).toBe(committed);

      await recordMemory(activePage, "commit + re-enter");

      const discard = await sessionCall("__editPaintBenchDiscard");
      expect(discard.error ?? "").toBe("");
      expect(await committedPaint()).toBe(committed);
    });
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function total(window: LargeChunkWindow, key: string): string {
  const bucket = window.timings[key];
  return bucket === undefined
    ? "–"
    : `${bucket.totalMs.toFixed(0)}/${bucket.calls}`;
}

function count(window: LargeChunkWindow, key: string): string {
  return String(window.counters[key] ?? 0);
}

const STROKE_COLUMNS: ReadonlyArray<
  readonly [string, (window: LargeChunkWindow) => string]
> = [
  ["wall ms", (window) => window.wallMs.toFixed(0)],
  ["frame max ms", (window) => window.frames.maxMs.toFixed(0)],
  ["frame p95 ms", (window) => window.frames.p95Ms.toFixed(0)],
  ["mirror.read ms/calls", (window) => total(window, "5.mirror.read(io)")],
  ["mirror.fuse ms/calls", (window) => total(window, "5.mirror.fuse(cpu)")],
  ["syncs full", (window) => count(window, "mirror.syncs.full")],
  ["syncs bounded", (window) => count(window, "mirror.syncs.bounded")],
  [
    "materialize.fetch ms",
    (window) => total(window, "overlay.paint.materialize.fetchBaseline"),
  ],
  [
    "materialize.clones ms",
    (window) => total(window, "overlay.paint.materialize.clones"),
  ],
  ["edit.record ms", (window) => total(window, "edit.record(cpu)")],
  ["longtask ms", (window) => total(window, "mt.longtask(>50ms)")],
  ["preview reads", (window) => count(window, "previewBaseline.reads")],
  ["heap MB", (window) => String(window.jsHeapMb ?? "–")],
];

const UNMATCHED_SHOWN = 3;
/** Every path from the window starts so; the report drops it. */
const GLOBAL_PREFIX = /^\d+\.global_object\./;

/** Main-thread MB after each step (after GC), buffers by owner. */
function memorySection(snapshots: readonly MemorySnapshot[]): string[] {
  if (snapshots.length === 0) return [];
  const ruleOrder = (owner: string) =>
    MEMORY_OWNER_RULES.findIndex(
      ({ label }) => owner === label || owner.startsWith(`${label}.`),
    );
  const owners = [
    ...new Set(snapshots.flatMap((s) => Object.keys(s.ownersMb ?? {}))),
  ].sort((a, b) => ruleOrder(a) - ruleOrder(b));
  const rows = snapshots.map((snapshot) => {
    if (snapshot.error !== undefined) {
      return [snapshot.after, `error: ${snapshot.error}`];
    }
    const unmatched = Object.entries(snapshot.unmatchedMb ?? {}).sort(
      ([, a], [, b]) => b - a,
    );
    const restMb = unmatched
      .slice(UNMATCHED_SHOWN)
      .reduce((sum, [, mb]) => sum + mb, 0);
    const other = [
      ...unmatched
        .slice(0, UNMATCHED_SHOWN)
        .map(([path, mb]) => `${mb} \`${path.replace(GLOBAL_PREFIX, "")}\``),
      ...(restMb > 0
        ? [`+${restMb} in ${unmatched.length - UNMATCHED_SHOWN} more`]
        : []),
    ].join("<br>");
    return [
      snapshot.after,
      String(snapshot.heapMb ?? "–"),
      String(snapshot.backingStoreMb ?? "–"),
      String(snapshot.liveSessions ?? "–"),
      ...owners.map((owner) => String(snapshot.ownersMb?.[owner] ?? 0)),
      other || "–",
    ];
  });
  return [
    "",
    "Memory, main thread, after GC (MB). *Buffers* is every ArrayBuffer " +
      "backing store; the owner columns split those of ≥ 1 MB by their " +
      "shortest retaining path (heap snapshot); `ng.host.<field>` is the host " +
      "field that path leaves by. *Other* lists the largest of the rest by path.",
    "",
    markdownTable(
      [
        "after",
        "V8 heap",
        "buffers",
        "live sessions",
        ...owners,
        "other ≥ 1 MB",
      ],
      rows,
    ),
  ];
}

function markdownTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join(
    "\n",
  );
}

function undoSection(
  label: string,
  undo: UndoAllResult | undefined,
  strokes: number,
): string[] {
  if (undo === undefined) return [];
  return [
    "",
    `${label} undo depth: **${undo.undone}** of ${strokes} strokes.`,
    "",
    markdownTable(
      ["undo", ...STROKE_COLUMNS.map(([name]) => name)],
      undo.undos.map((window, i) => [
        String(i + 1),
        ...STROKE_COLUMNS.map(([, cell]) => cell(window)),
      ]),
    ),
  ];
}

function renderReport(reports: readonly ScenarioReport[]): string {
  const sections: string[] = [
    "# TM-373 large-chunk paint benchmark",
    "",
    "Timings are `total ms / calls` per stroke window, from the first pointer " +
      "event until the mirror and `edit.record()` settle.",
  ];
  for (const report of reports) {
    sections.push("", `## ${report.label} (\`${report.fixtureId}\`)`, "");
    if (report.setupError !== undefined) {
      sections.push(`Setup failed: ${report.setupError}`);
      continue;
    }
    sections.push(`Session open: ${report.sessionOpenMs ?? "–"} ms`, "");
    sections.push(
      markdownTable(
        ["stroke", ...STROKE_COLUMNS.map(([name]) => name)],
        report.strokes.map(({ name, window }) => [
          name,
          ...STROKE_COLUMNS.map(([, cell]) => cell(window)),
        ]),
      ),
    );
    sections.push(
      ...undoSection("Unmasked (replay redo)", report.undo, SAME_CHUNK_STROKES),
      ...undoSection("Masked (image redo)", report.maskedUndo, MASKED_STROKES),
    );
    if (report.fill !== undefined) {
      const outcome = (fill: FillOutcome) =>
        (fill.refused ? "**refused (too large)**" : "**filled**") +
        ` (${fill.paintedVoxels} voxels)`;
      sections.push(
        "",
        `Fill of a ${FILL_LOOP_RADIUS_VOXELS}-voxel-radius loop: unmasked ` +
          `(replay redo) ${outcome(report.fill.unmasked)}, masked (image redo) ` +
          `${outcome(report.fill.masked)}.`,
      );
    }
    if (report.oneChunkFill !== undefined) {
      const outcome = (fill: FillOutcome) =>
        (fill.refused ? "**refused (too large)**" : "**filled**") +
        ` (${fill.paintedVoxels} voxels)`;
      sections.push(
        "",
        `Fill of the same loop inside one chunk: unmasked (replay redo) ` +
          `${outcome(report.oneChunkFill.unmasked)}, masked (image redo) ` +
          `${outcome(report.oneChunkFill.masked)}.`,
      );
    }
    if (report.history !== undefined) {
      sections.push("", `3D preview: \`${JSON.stringify(report.history)}\``);
    }
    sections.push(...memorySection(report.memory ?? []));
  }
  return sections.join("\n") + "\n";
}

/**
 * A failed test restarts the Playwright worker, and with it this module, so
 * each scenario writes its own file and the table is rebuilt from all of this
 * run's files (`EDITING_PERF_RUN_ID` is set once per run by the config).
 */
const REPORT_DIR = path.join("test-results", "edit_paint_large_chunk");
const RUN_ID = process.env.EDITING_PERF_RUN_ID ?? "local";

function writeScenarioReport(report: ScenarioReport): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    path.join(REPORT_DIR, `${report.fixtureId}.json`),
    JSON.stringify({ runId: RUN_ID, report }, null, 2),
  );
}

function readRunReports(): ScenarioReport[] {
  const found: ScenarioReport[] = [];
  for (const { fixtureId } of SCENARIOS) {
    try {
      const saved = JSON.parse(
        readFileSync(path.join(REPORT_DIR, `${fixtureId}.json`), "utf8"),
      ) as { runId: string; report: ScenarioReport };
      if (saved.runId === RUN_ID) found.push(saved.report);
    } catch {
      // Not run (yet) in this run.
    }
  }
  return found;
}

test.afterAll(() => {
  const runReports = readRunReports();
  if (runReports.length === 0) return;
  const markdown = renderReport(runReports);
  console.log("\n" + markdown);
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    path.join("test-results", "edit_paint_large_chunk.md"),
    markdown,
  );
  writeFileSync(
    path.join("test-results", "edit_paint_large_chunk.json"),
    JSON.stringify(runReports, null, 2),
  );
});
