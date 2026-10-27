# Live 3D painted-volume preview (TM-490)

While an edit session is open, the **3D preview** toggle in the topbar (the cube
icon next to "Center view on edit region") shows the edited voxels in the 3D
panel as cubes, live, with no meshing. It shows **every voxel of the selected
segments plus the brush segment** in the session region: the datasource
baseline where nothing is painted, the session's patches everywhere else. This
is the same composite the 2D layer draws. The preview exists only for edit
sessions and never saves meshes.

The toggle is off on every load, and the choice is not remembered. All code
lives in `src/editing/painted_volume/`.

## Data flow

```
LocalPatchStore ──chunkChanged──▶ PaintedVolumePreview ──uploadBox──▶ R8UI class texture
  (stroke, undo,       (box)        │  composite baseline ⊕ patch,          │
   clear, rollback)                 │  shown segments → palette classes     ▼
                                    │                        PaintedVolumeRenderLayer
datasource baseline ──read──────────┘                        (opaque pass, DDA ray march)
  (region fill, baseline cache)
```

- **`PaintedVolumeHostBinding`** creates one preview per writable session layer
  while the toggle is on, attaches its render layer to the segmentation layer,
  and releases it at teardown, commit, discard and layer removal. The host
  only calls the binding at its lifecycle points.
- **`PaintedVolumePreview`** keeps the texture equal to the composite. A full
  recompute (on open, a selection or brush-value change, `clearAll`, or a
  datasource reload) reads the region in the background. Stroke deltas are
  composited against cached baselines. All texture work runs on the preview's
  own animation frame, within two budgets: a voxel budget per frame, and a
  wall-clock budget for the region fill.
- **`PaintedVolumeRenderLayer`** ray-marches the texture with a voxel DDA. It
  draws only the bounding box of occupied chunks, and keeps a window clear
  under the 3D brush cursor so the cursor stays visible above painted voxels.

## Why an opaque pass

Only volume-rendering layers get the depth buffer in the transparent pass. An
opaque layer writes depth itself (`gl_FragDepth` plus the panel's `out_z`), so
meshes, slice planes and mouse picking all z-test against the cubes correctly.
It also leaves the transparent pass's blend state alone. The trade-off: the
slice planes are drawn opaque after the cubes, so they cut through the current
layer of cubes. To see inside, untick "Show cross sections in 3-d" in the
settings.

## Why a separate change signal

`LocalPatchStore.chunkChanged` exists because no existing signal fits:

- `LocalPatchChunk.pendingUpload` belongs to the 2D texture cache, which
  clears it.
- `dirtyKeys` is never consumed.
- The painted sub-box registry is single-use, and `PatchMirror` already takes
  it.

The new signal fires synchronously with the exact changed box. Every existing
path reaches it, including rollbacks.

## Measuring

`tests/editing/perf/edit_painted_volume.perf.ts` (`npm run perf`) records these
`paintProfiler` keys:

- `7.preview.regionFill`: one entry per frame of region fill.
- `7.preview.occupancy`: the composite kernel, one entry per chunk box.
- `7.preview.upload`: the texture sub-upload, one entry per chunk box.

Targets: occupancy plus upload ≤ 2 ms for a typical stroke, and no fill frame
over 50 ms. Chromium runs on SwiftShader there, so GPU frame time has to be
measured by hand on real hardware. `tests/editing/e2e/edit_painted_volume.e2e.ts`
covers the visible behaviour in an `xy-3d` layout.
