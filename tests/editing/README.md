# Edit-session test suite

Tests for the edit-session painting stack (scheduler → pointer→voxel → mask
compute → commit → GPU → save). Conventions (tiers, naming, vocabulary) are in
[`docs/TESTING.md`](../../docs/TESTING.md); this is the suite-specific guide.

## Layout

```
unit/          *.spec.ts  — fast, isolated (Vitest). Compute matrices
               (painting_compute, painting_compute_matrix, patch_readback),
               adapters/, overlay/, local_patch_store, locked_writable_matrix,
               unsaved_edits_unload_guard, harness-helper tests
               (build_ng_state, gcs_route).
integration/   *.spec.ts  — EditSessionHost wiring (edit_session, edit_session_host),
               upstream layer UI under the session-layer structure lock.
e2e/           *.e2e.ts   — Playwright correctness on the built app.
perf/          *.perf.ts  — Playwright paint benchmark.
fakes/         FakeViewer / FakeLayerManager / FakeLogger / FakeLayerRoot.
harness/       drivers (no *.spec): e2e_setup, build_ng_state, gcs_route,
               fake_gcs_fixtures, serve_dist.
```

## Run

```bash
npm test                 # unit + integration (+ browser) — the gate
npm run e2e[:headed|:ui] # correctness e2e (fixtures + build + run)
npm run e2e:save[:headed] # save → storage e2e, real web API (needs ZETTA_UTILS_DIR)
npm run perf[:headed]    # paint benchmark
npm run test:fixtures    # (re)generate the precomputed fixtures only
```

## Reproducible datasource (e2e + perf)

Both Playwright suites run against **local fake-gcs fixtures** — no live `gs://`,
no auth, deterministic. The boot path is shared in `harness/e2e_setup.ts`:

```
testdata/editing/manifest.json ──generate.py──▶ precomputed buckets + fixtures.json
        │
        ▼  harness/fake_gcs_fixtures.mjs (free port, reaped on exit)
   fake-gcs-server ──harness/gcs_route.ts──▶ rewrite storage.googleapis.com → local
        │
        ▼  harness/build_ng_state.ts (scenario → ngState + editSession)
   built app (serve_dist.mjs, COOP/COEP → SAB) auto-opens the session
        │
        ▼  harness/e2e_setup.ts: openScenarioPage + warmupPaintPath
   deterministic stamp → __editPaintBench read-back → assert
```

Fixtures are generated (not committed) — see
[`testdata/editing/README.md`](../../testdata/editing/README.md) for the manifest + generator.
One Playwright config (`playwright.editing.config.ts`) with two projects: `e2e`, `perf`.

## Correctness read-back (`__editPaintBench*`)

The in-app harness (`src/editing/benchmarks/edit_paint_bench.ts`) can read back
**what got painted** so an e2e can assert correctness, not just timing. After a
stroke the painted voxels live in the target layer's overlay `LocalPatchStore`;
the read-back (`src/editing/benchmarks/patch_readback.ts`, unit-verified in
`unit/patch_readback.spec.ts`) summarizes them into a count, absolute bbox,
distinct values, a sample, and a stable `signature` (FNV-1a over the sorted
`x,y,z=value` set) — same inputs ⇒ same signature.

Window API:

- `__editPaintBenchStampReadback(input?)` → summary `+ strokeFired` — drives ONE
  deterministic stamp at a fixed panel position, then reads back. `input`:
  `{ masked?, radius?, erase?, fracX?, fracY?, clearFirst?, prime?, originOffset? }`.
- `__editPaintBenchReadback(opts?)` → read the current target overlay.
- `__editPaintBenchClearTarget()` → drop the target's patches between stamps.

`originOffset` (= the target scale's `voxelOffset`) makes the read-back report
ABSOLUTE global voxels, comparable to the edit region.

## e2e correctness (`e2e/edit_paint.e2e.ts`)

Per scenario: warm the paint path → save a before/after/full-page **screenshot**
for manual review (`test-results/correctness/`, attached to the report) → drive a
deterministic stamp → assert painted count, value, absolute region-containment
(the offset axis end-to-end), determinism, and erase. Scenarios exercise data
axes the in-memory matrix can't reach (offset, encodings, multi-res).

## save e2e (`e2e/*.save.e2e.ts`)

Paint → save → what storage actually holds. The production save path runs end
to end; only the storage service and the auth header stand in for prod:

```
NG HttpSaveBackend ──POST /painting/cutout──▶ harness/backend_route.ts
  (payload, gzip, retry, 409 replay,              │ forwards; journals every request;
   stale-baseline scan, read-back verify)         │ one-shot faults (500/409/200-without-write)
                                                  ▼
                       REAL web API painting + segmentation routes
                       (harness/webapi_app.py + webapi_server.mjs, from a
                       zetta_utils checkout; only the z-extrapolation model
                       is a stand-in that shifts the mask 3 voxels along x)
                                                  │ CloudVolume / chunk_cas
                                                  ▼  STORAGE_EMULATOR_HOST
                                            fake-gcs (the fixtures)
```

- **Specs**: `edit_save` — paint → save → reload round-trip per scenario, an
  unconfirmed save, an outage and recovery (TM-361); `edit_session_lifecycle`
  — discard/exit, exit after an unconfirmed save, save → exit → re-open →
  continue, a cancelled save (TM-365); `edit_save_conflict` — two tabs on one
  region: automerge, Combine, Take mine, Take theirs, Esc, checked voxel for
  voxel; `edit_save_layers` — 1–2 writable + 0–2 locked layers, target switch
  through the UI, a `partial` save when one target fails; `edit_save_region` —
  the stroke clipped at the region boundary, regions smaller than a chunk and
  unaligned (TM-366); `edit_z_extrapolation` — Run ×3, Reset, an untracked
  segment, save; `edit_fill_inside` — Fill inside with the real mouse.
- **Z-extrapolation model**: never runs. `webapi_app.py` replaces
  `segmentation._run_propagation` (a private zetta_utils function) with a
  stand-in that shifts the mask 3 voxels along x, so the result is known
  exactly; everything around it (panel, request, route, write-back, save) is
  real. Model quality is out of scope. If zetta_utils renames that function,
  this harness — not the product — breaks.
- **Expected failures** (`test.fail`, each names its cause; remove the marker
  when the bug is fixed): `edit_save` › the view shows each stroke only where it
  was painted (a stroke at a coarser target resolution is shown at the wrong
  place); `edit_fill_inside` › the fill adds only what the outline encloses (the
  fill outline is one voxel wider at sharp turns).
- **Driver** (`harness/save_session.ts`): fresh storage, an editing page wired
  to the web API, stamps, saves, UI helpers (Save all, Exit, dialogs) and
  `appValuesAt` — what the page shows, through NG's own value lookup.
- **Faults** (`backend_route.ts`): one-shot (`failNext`) or standing
  (`failAlways` / `clearFaults`): `respond` (any status), `acknowledgeWithoutWriting`
  (200, nothing stored), `hang` (never answers; aborted on `clearFaults`).
- **Oracle** (`harness/storage_oracle.ts`): storage is read from Node through
  the web API's `GET /painting/cutout` before and after the save, never through
  the page. The voxels that changed must equal the voxels the app showed as
  painted — same count, same value, same signature (`voxelSetSignature`, pinned
  to the app read-back by `unit/storage_oracle.spec.ts`).
- **Setup**: `ZETTA_UTILS_DIR` must point at a zetta_utils checkout with its
  web-api env (`uv sync --locked --extra web-api --python 3.13`). Missing → a
  hard error with instructions, never a skip. Its own Playwright project
  (`e2e-save`), so `npm run e2e` does not need zetta_utils. Last verified
  against zetta_utils `9cf05b017` (`web_api/app/painting.py` and
  `segmentation.py` unchanged on its `main` since). The env pulls in CPU
  `torch` (~0.5 GB): `segmentation.py` imports it at load even though the
  model never runs here; no GPU, weights or cloud access are used.
- **Local only**: like every Playwright suite here, it does not run in CI. Run
  it before merging changes to the save path. Two Playwright runs on one
  machine at once compete for the app port (`EDITING_APP_PORT`, default 9777)
  and, with software WebGL, for CPU — expect timeouts or a crashed tab.
- **Isolation**: each scenario gets a fresh fake-gcs + web API (a save mutates
  storage). The web API runs with an unusable service account and an empty
  `HOME`, so nothing can reach real GCS.
- `warmupPaintPath` undoes its own strokes and checks nothing is left
  (history, unsaved flag, mirror), so a test starts from the freshly opened
  session. It needs an empty history and throws otherwise.

## mask and stroke e2e (`e2e/edit_paint_mask.e2e.ts`, TM-362 / TM-364)

Masked painting against designed mask images (see `testdata/editing/README.md`):
threshold band, binary closing, minimum component size, their order
(`filterComponentsFirst`), an image with a voxel offset, and the coverage
(majority) rule under a 2× coarser target — each compared with a hand-written
expected voxel set. Plus a swept stroke's gap-free capsule at a pace the brush
keeps up with: the default `latestWins` scheduler drops samples during a stall
by design (TM-317), so that is the contract tested.

Stroke points are aimed at voxel centres from the REAL view centre: NG snaps
`position` to a voxel centre (64 → 63.5), and the displayed and painted slice
is the voxel containing it.

## perf benchmark (`perf/edit_paint.perf.ts`)

Sweeps brush sizes × {masked, unmasked, eraser} on the large `perf_*` fixture
(2048², room for radius up to 512), measuring per-size cost from
`__paintProfiler`. Each `{case × size}` is its own test (a tree in the UI).

- **Use `:headed` for fully-real numbers** — headless chromium does not run the
  render loop, so `frameDraw` / `gpu.upload` / `mirror.fuse` (the RENDER phase)
  are absent.
- Before measuring, the harness warms the data (8 max-radius stamps) so chunks
  are resident.
- Output: a table in stdout + `test-results/edit_paint_bench.json`.
- Perf-regression **baseline comparison** (committed baselines + tolerance) is a
  follow-up (TM-331 Phase 3).

## large-chunk benchmark (`perf/edit_paint_large_chunk.perf.ts`, TM-373)

Paint cost on 4096²×1 chunks against a 256² control, on the large-chunk fixture
set (see `testdata/editing/README.md`). Its own Playwright project
(`perf-large-chunk`), so `npm run perf` does not need the 1.4 GB fixtures.

```bash
npm run perf:large-chunk          # fixtures + build + run
npm run perf:large-chunk:headed   # real render loop (frameDraw, GPU upload)
```

- Per fixture: 5 unmasked strokes in one chunk (the first is the first touch),
  undo all (undo depth), a closed-loop fill unmasked and masked (refused or
  not), a stroke across a chunk junction, a long diagonal stroke, and 3 masked
  strokes + undo. Unmasked strokes redo by replay (no after-image, so
  `edit.record()` is cheap); masked ones keep an after-image — those show the
  stroke-end copy + hash and the shallower undo.
- Strokes are placed in voxels (`__editPaintBenchVoxelStroke`), so a path hits
  the same voxels whatever the chunk size; the first stroke checks it landed
  where it was aimed.
- Layers read straight from fake-gcs over http (`sourceFor`), not through
  `gcs_route`: `route.fulfill` sends bodies over the DevTools protocol, whose
  100 MB buffer a 128 MB chunk overflows (the browser is killed).
- Output: a markdown table in stdout and `test-results/edit_paint_large_chunk.md`
  (+ `.json`, and one file per fixture in `test-results/edit_paint_large_chunk/`).
- Memory: after each step, a GC, CDP `Runtime.getHeapUsage` and a heap
  snapshot; buffers of ≥ 1 MB are split by owner (NG mirror, the library's
  overlay copies and history, an inactive session, `ng.host.<field>`) from
  their shortest retaining path (`harness/heap_buffer_owners.ts`). The
  stroke table's `heap MB` is `usedJSHeapSize` and misses buffers: read the
  memory table instead. Main thread only; the snapshots add ~1 min to the run.
- Micro-costs of one chunk (decode, copy, hash, full fuse) by chunk size:
  `npx vitest bench --run src/editing/adapters/baseline_chunk_costs.benchmark.ts`.

## `// TUNE:` points (dial in on a live GPU)

The Playwright suites can't be verified offline. Expect to adjust:

1. **Fixtures generated** — `npm run test:fixtures` (fast-fails with a clear
   message if a layer can't load).
2. **WebGL flags** (`playwright.editing.config.ts`) if the canvas stays black.
3. **Pointer dispatch / settle** — `harness/e2e_setup.ts` warmup +
   `edit_paint_bench.ts` `waitForSettle` / `waitForPaintStable` / priming, if
   stamps don't register or read-back races the async overlay write.
