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
 * Masked painting and swept strokes through the real app (TM-362, TM-363,
 * TM-364).
 *
 * The mask images are DESIGNED (`testdata/editing/generate.py`,
 * `mask_features_plane` / `coverage_blocks_plane`): shapes on an out-of-band
 * background (10) whose correct mask is known by construction. Each expected
 * set below is written out by hand from those shapes and was cross-checked
 * against scipy (`binary_closing` with the cross structure, `label` with
 * 4-connectivity) — the reference the TS kernel is pinned to — so the test
 * does not reuse the code it tests.
 *
 * `mask_features` (absolute image voxels, one shape per quadrant):
 *   - band:    stripes x[24,28)=50, x[30,34)=120, x[36,40)=250, y[28,36)
 *   - closing: square x[90,102) y[26,38)=200 with a slit x=96, y[28,36)=10
 *   - size:    2x2 blobs at (28,92), (36,92), (28,100), (36,100)
 *   - order:   bars x[90,93) and x[94,97), y[92,100), one voxel apart
 * `coverage_blocks` (16 nm image under a 32 nm target): target voxel (tx, ty),
 *   tx 10..14, ty 10..13, covers a 2x2 block with tx-10 in-band voxels.
 *
 * Every brush is large enough that the shape lies wholly inside its disk, so
 * the expected set does not depend on how the disk is rasterized.
 */

import { test, expect, type Page } from "@playwright/test";

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
  warmupPaintPath,
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";
import { paintedVoxelMap } from "#tests/editing/harness/painted_voxels.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);
const PAINT_VALUE = 100;
/** The band every mask case uses: 120 and 200 are in, 10, 50 and 250 are out. */
const BAND = { thresholdLow: 100, thresholdHigh: 200 };

type Box2 = { x0: number; x1: number; y0: number; y1: number };

/** `"x,y"` for every voxel in the boxes (half-open). */
function cells(...boxes: Box2[]): Set<string> {
  const out = new Set<string>();
  for (const { x0, x1, y0, y1 } of boxes) {
    for (let x = x0; x < x1; x++) {
      for (let y = y0; y < y1; y++) out.add(`${x},${y}`);
    }
  }
  return out;
}

const box = (x0: number, x1: number, y0: number, y1: number): Box2 => ({
  x0,
  x1,
  y0,
  y1,
});

/** The painted set in-plane, checking it all lies on one z slice. */
function inPlane(painted: Map<string, string>, z: number): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of painted) {
    const [x, y, voxelZ] = key.split(",").map(Number);
    expect(voxelZ, `voxel ${key} off the painted slice`).toBe(z);
    expect(value).toBe(String(PAINT_VALUE));
    out.add(`${x},${y}`);
  }
  return out;
}

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

/**
 * Where the view really is. NG snaps the state's `position` to a voxel centre
 * (the region centre 64 becomes 63.5), and the displayed — and painted — slice
 * is the voxel containing that centre.
 */
async function viewCentre(page: Page): Promise<Vec3> {
  const [x, y, z] = await page.evaluate(() =>
    Array.from(
      (window as any).viewer.navigationState.position.value as Float32Array,
    ),
  );
  return [x, y, z];
}

/** The slice the view shows and the brush paints. */
async function viewSlice(page: Page): Promise<number> {
  return Math.floor((await viewCentre(page))[2]);
}

/**
 * One stroke through the centres of the given target voxels. The harness takes
 * points relative to the view centre, in voxels.
 */
async function strokeAt(
  page: Page,
  path: ReadonlyArray<readonly [number, number]>,
  radius: number,
  mask?: Record<string, unknown>,
  stepMs?: number,
): Promise<void> {
  const [centreX, centreY] = await viewCentre(page);
  await page.evaluate(
    async (input) => {
      const host = (window as any).viewer.editSessionHost;
      host.painting.state.patchState({ activeValue: input.value });
      await (window as any).__editPaintBenchVoxelStroke({
        path: input.path,
        radius: input.radius,
        ...(input.mask !== undefined ? { mask: input.mask } : {}),
        ...(input.stepMs !== undefined ? { stepMs: input.stepMs } : {}),
      });
    },
    {
      path: path.map(([x, y]) => [x + 0.5 - centreX, y + 0.5 - centreY]),
      radius,
      mask,
      stepMs,
      value: PAINT_VALUE,
    },
  );
}

async function undoEverything(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const session = (window as any).viewer.editSessionHost.activeSession.value;
    while (session.getHistory().canUndo) await session.undo();
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).__editPaintBenchReadback().paintedVoxels as number,
        ),
      { timeout: 10_000 },
    )
    .toBe(0);
}

let fixtures: FixturesIndex;
let fakeGcs: FixtureGcs;

test.beforeAll(async () => {
  fixtures = loadFixturesIndex();
  fakeGcs = await startFixtureGcs();
});

test.afterAll(async () => {
  await fakeGcs?.[Symbol.asyncDispose]();
});

/**
 * One page per scenario; every test starts from an empty history (the
 * previous test's strokes are undone and the read-back must be empty).
 */
function describeScenario(
  scenario: Scenario,
  body: (getPage: () => Page) => void,
): void {
  test.describe(scenario.name, () => {
    test.describe.configure({ mode: "serial" });
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      page = await openScenarioPage(browser, {
        scenario,
        fixtures,
        fakeGcsUrl: fakeGcs.url,
        appPort: PORT,
      });
      await warmupPaintPath(page, { label: scenario.name });
    });

    test.beforeEach(async () => {
      await undoEverything(page);
    });

    test.afterAll(async () => {
      await page?.context().close();
    });

    body(() => page);
  });
}

// --- TM-362: threshold band and morphology, image aligned with the target ---

const MASK_SCENARIO: Scenario = {
  name: "mask features (image aligned)",
  layers: [
    { fixtureId: "mask_features_u8", role: "image", writable: false },
    { fixtureId: "seg_u64_cseg", role: "target", writable: true },
  ],
};
describeScenario(MASK_SCENARIO, (getPage) => {
  const masked = async (
    at: readonly [number, number],
    mask: Record<string, unknown>,
  ) => {
    await strokeAt(getPage(), [at], 12, {
      ...BAND,
      binaryClosing: 0,
      minComponentSize: 0,
      filterComponentsFirst: false,
      ...mask,
    });
    return inPlane(
      await paintedVoxelMap(getPage(), [0, 0, 0]),
      await viewSlice(getPage()),
    );
  };

  test("threshold band: only in-band image voxels are painted", async () => {
    expect(sorted(await masked([32, 32], {}))).toEqual(
      sorted(cells(box(30, 34, 28, 36))),
    );
  });

  test("binary closing 0 keeps a one-voxel slit; closing 1 fills it", async () => {
    const square = cells(box(90, 102, 26, 38));
    const slit = cells(box(96, 97, 28, 36));
    expect(sorted(await masked([96, 32], {}))).toEqual(
      sorted(new Set([...square].filter((cell) => !slit.has(cell)))),
    );
    await undoEverything(getPage());
    expect(sorted(await masked([96, 32], { binaryClosing: 1 }))).toEqual(
      sorted(square),
    );
  });

  test("minComponentSize drops components smaller than it and keeps one of exactly its size", async () => {
    expect(sorted(await masked([32, 96], { minComponentSize: 5 }))).toEqual([]);
    await undoEverything(getPage());
    expect(sorted(await masked([32, 96], { minComponentSize: 4 }))).toEqual(
      sorted(
        cells(
          box(28, 30, 92, 94),
          box(36, 38, 92, 94),
          box(28, 30, 100, 102),
          box(36, 38, 100, 102),
        ),
      ),
    );
  });

  test("filterComponentsFirst orders the passes: close-then-filter keeps the merged bars, filter-then-close drops them", async () => {
    const morphology = { binaryClosing: 1, minComponentSize: 30 };
    expect(
      sorted(
        await masked([93, 96], { ...morphology, filterComponentsFirst: false }),
      ),
    ).toEqual(
      sorted(
        cells(box(90, 93, 92, 100), box(94, 97, 92, 100), box(93, 94, 93, 99)),
      ),
    );
    await undoEverything(getPage());
    expect(
      sorted(
        await masked([93, 96], { ...morphology, filterComponentsFirst: true }),
      ),
    ).toEqual([]);
  });

  /**
   * The contract is "gap-free while the brush keeps up". The default
   * scheduler (`latestWins`, TM-317) deliberately DROPS cursor samples that
   * arrive while a segment is computing and, past a cap of one brush radius,
   * stamps only a disk at the latest cursor — so a stall mid-stroke leaves a
   * gap by design. The stroke here moves about one voxel per sample (well
   * inside the cap) at a pace the brush keeps up with, after a throwaway
   * stroke has paid any first-stroke cost.
   */
  test("a swept stroke the brush keeps up with is a gap-free capsule between its endpoints", async () => {
    const radius = 4;
    const from: [number, number] = [24, 44];
    const to: [number, number] = [104, 84];
    const steps = 90;
    const path = Array.from({ length: steps + 1 }, (_, i) => [
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
    ]) as Array<[number, number]>;
    await strokeAt(
      getPage(),
      [
        [60, 100],
        [70, 100],
      ],
      radius,
    );
    await undoEverything(getPage());
    await strokeAt(getPage(), path, radius, undefined, 150);
    const painted = inPlane(
      await paintedVoxelMap(getPage(), [0, 0, 0]),
      await viewSlice(getPage()),
    );

    // Distance from a voxel's centre to the stroke's centre segment. The stroke
    // runs through voxel centres, so both sides carry the same +0.5 and it
    // cancels: voxel indices against the endpoint indices.
    const distance = (x: number, y: number) => {
      const [ax, ay] = from;
      const [bx, by] = to;
      const px = x;
      const py = y;
      const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSquared,
        ),
      );
      return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
    };
    const missing: string[] = [];
    const stray: string[] = [];
    for (let x = from[0] - 2 * radius; x <= to[0] + 2 * radius; x++) {
      for (let y = from[1] - 2 * radius; y <= to[1] + 2 * radius; y++) {
        const d = distance(x, y);
        const key = `${x},${y}`;
        if (d <= radius - 1 && !painted.has(key)) missing.push(key);
        if (d > radius + 1 && painted.has(key)) stray.push(key);
      }
    }
    expect(missing, "gaps inside the capsule").toEqual([]);
    expect(stray, "paint outside the capsule").toEqual([]);
    for (const [x, y] of [from, to]) {
      expect(painted.has(`${x},${y}`), `endpoint ${x},${y}`).toBe(true);
    }
  });
});

// --- TM-363: the mask image is JPEG-encoded (lossy) ---

/**
 * `img_u8_jpeg` holds the same `mask_features` shapes, but stored as JPEG, so
 * the voxels the mask sees are what a decoder makes of lossy chunks, not the
 * designed values. The expected set is therefore built from the stored chunks
 * decoded by the browser's own JPEG decoder (libjpeg-turbo in Chromium), not by
 * NG's `jpgjs`, which the mask path uses.
 *
 * The two decoders may round the inverse DCT differently (by one grey level on
 * this data). The test first asserts that no decoded voxel near the stroke sits
 * within that difference of a band edge, so the expected set holds for either
 * decoder; a fixture change that breaks this fails there, not in the mask.
 */
const JPEG_SCENARIO: Scenario = {
  name: "mask features (image JPEG-encoded)",
  layers: [
    { fixtureId: "img_u8_jpeg", role: "image", writable: false },
    { fixtureId: "seg_u64_cseg", role: "target", writable: true },
  ],
};

/** The largest per-voxel difference two conforming JPEG decoders may show here. */
const DECODER_ROUNDING = 1;

/**
 * One z section of a JPEG fixture as the browser decodes it: `"x,y"` → grey
 * value, absolute voxels. Chunks are fetched from fake-gcs the way NG addresses
 * them; each `[64, 64, 1]` chunk is one 64×64 greyscale JPEG.
 */
async function browserDecodedSection(
  page: Page,
  fixture: FixtureInfo,
  z: number,
): Promise<Map<string, number>> {
  const [chunkSizeX, chunkSizeY, chunkSizeZ] = fixture.chunk;
  expect(chunkSizeZ, "one section per JPEG chunk").toBe(1);
  const [resolutionX, resolutionY, resolutionZ] = fixture.resolutions[0];
  const scaleKey = `${resolutionX}_${resolutionY}_${resolutionZ}`;
  const decoded = new Map<string, number>();
  for (let chunkX = 0; chunkX < fixture.size[0]; chunkX += chunkSizeX) {
    for (let chunkY = 0; chunkY < fixture.size[1]; chunkY += chunkSizeY) {
      const chunkName =
        `${chunkX}-${chunkX + chunkSizeX}_` +
        `${chunkY}-${chunkY + chunkSizeY}_${z}-${z + 1}`;
      const objectName = `${fixture.id}/${scaleKey}/${chunkName}`;
      const response = await fetch(
        `${fakeGcs.url}/storage/v1/b/${fixtures.bucket}/o/` +
          `${encodeURIComponent(objectName)}?alt=media`,
      );
      expect(response.status, objectName).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      const greys = await page.evaluate(async (base64) => {
        const raw = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const bitmap = await createImageBitmap(
          new Blob([raw], { type: "image/jpeg" }),
          { colorSpaceConversion: "none", premultiplyAlpha: "none" },
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height);
        const values: number[] = [];
        for (let i = 0; i < rgba.data.length; i += 4) {
          const isGrey =
            rgba.data[i] === rgba.data[i + 1] &&
            rgba.data[i] === rgba.data[i + 2];
          values.push(isGrey ? rgba.data[i] : -1);
        }
        return { width: bitmap.width, height: bitmap.height, values };
      }, bytes.toString("base64"));
      expect([greys.width, greys.height]).toEqual([chunkSizeX, chunkSizeY]);
      expect(greys.values, "a greyscale JPEG decodes to grey").not.toContain(
        -1,
      );
      greys.values.forEach((value, i) => {
        const x = chunkX + (i % chunkSizeX);
        const y = chunkY + Math.floor(i / chunkSizeX);
        decoded.set(`${x},${y}`, value);
      });
    }
  }
  return decoded;
}

describeScenario(JPEG_SCENARIO, (getPage) => {
  const radius = 12;
  // The square is designed at 200, the top of `BAND`, so lossy decoding puts
  // it on both sides of that edge; its band ends above it instead.
  for (const { label, at, band } of [
    { label: "the stripes", at: [32, 32], band: BAND },
    {
      label: "the square",
      at: [96, 32],
      band: { thresholdLow: 100, thresholdHigh: 255 },
    },
  ] as const) {
    test(`the band selects the decoded in-band voxels under ${label}`, async () => {
      const page = getPage();
      const slice = await viewSlice(page);
      const fixture = fixtures.fixtures.find(
        (candidate) => candidate.id === "img_u8_jpeg",
      )!;
      const decoded = await browserDecodedSection(page, fixture, slice);
      // Distance from a voxel centre to the stroke point (a voxel centre too).
      const distance = (key: string) => {
        const [x, y] = key.split(",").map(Number);
        return Math.hypot(x - at[0], y - at[1]);
      };
      const near = [...decoded].filter(([key]) => distance(key) <= radius + 1);
      const onBandEdge = near.filter(([, value]) =>
        [band.thresholdLow, band.thresholdHigh].some(
          (edge) => Math.abs(value - edge) <= DECODER_ROUNDING,
        ),
      );
      expect(onBandEdge, "decoded voxels on a band edge").toEqual([]);
      const inBand = near.filter(
        ([, value]) =>
          value >= band.thresholdLow && value <= band.thresholdHigh,
      );
      const onDiskEdge = inBand.filter(([key]) => distance(key) > radius - 1);
      expect(onDiskEdge, "in-band voxels on the brush edge").toEqual([]);
      const expected = new Set(inBand.map(([key]) => key));
      expect(expected.size, "the stroke covers in-band voxels").toBeGreaterThan(
        0,
      );

      await strokeAt(page, [at], radius, {
        ...band,
        binaryClosing: 0,
        minComponentSize: 0,
        filterComponentsFirst: false,
      });
      expect(
        sorted(inPlane(await paintedVoxelMap(page, [0, 0, 0]), slice)),
      ).toEqual(sorted(expected));
    });
  }
});

// --- TM-364 (1): the mask image has a voxel offset ---

const OFFSET_SCENARIO: Scenario = {
  name: "mask features (image voxelOffset [-8,-4,0])",
  layers: [
    { fixtureId: "mask_features_u8_offset", role: "image", writable: false },
    { fixtureId: "seg_u64_cseg", role: "target", writable: true },
  ],
};

describeScenario(OFFSET_SCENARIO, (getPage) => {
  test("the band and a closing land on the same absolute voxels as with an aligned image", async () => {
    const mask = {
      ...BAND,
      binaryClosing: 0,
      minComponentSize: 0,
      filterComponentsFirst: false,
    };
    await strokeAt(getPage(), [[32, 32]], 12, mask);
    expect(
      sorted(
        inPlane(
          await paintedVoxelMap(getPage(), [0, 0, 0]),
          await viewSlice(getPage()),
        ),
      ),
    ).toEqual(sorted(cells(box(30, 34, 28, 36))));

    await undoEverything(getPage());
    await strokeAt(getPage(), [[96, 32]], 12, {
      ...mask,
      binaryClosing: 1,
    });
    expect(
      sorted(
        inPlane(
          await paintedVoxelMap(getPage(), [0, 0, 0]),
          await viewSlice(getPage()),
        ),
      ),
    ).toEqual(sorted(cells(box(90, 102, 26, 38))));
  });
});

// --- TM-364 (2): the target is coarser than the mask image ---

const COVERAGE_SCENARIO: Scenario = {
  name: "coverage (image 16 nm under a 32 nm target)",
  layers: [
    { fixtureId: "coverage_blocks_u8", role: "image", writable: false },
    { fixtureId: "seg_u32_raw_32nm", role: "target", writable: true },
  ],
};
describeScenario(COVERAGE_SCENARIO, (getPage) => {
  const coveragePaint = async (coverageThreshold?: number) => {
    await strokeAt(getPage(), [[12, 12]], 6, {
      ...BAND,
      binaryClosing: 0,
      minComponentSize: 0,
      filterComponentsFirst: false,
      ...(coverageThreshold !== undefined ? { coverageThreshold } : {}),
    });
    return inPlane(
      await paintedVoxelMap(getPage(), [0, 0, 0]),
      await viewSlice(getPage()),
    );
  };

  test("default coverage (majority): a target voxel is painted when at least 2 of its 4 image voxels are in band", async () => {
    expect(sorted(await coveragePaint())).toEqual(
      sorted(cells(box(12, 15, 10, 14))),
    );
  });

  test("coverage 1.0: only target voxels whose 4 image voxels are all in band", async () => {
    expect(sorted(await coveragePaint(1.0))).toEqual(
      sorted(cells(box(14, 15, 10, 14))),
    );
  });
});
