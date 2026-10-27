# Live 3D painted-volume preview (TM-490)

While an edit session is open, the **3D preview** toggle in the topbar (the cube
icon next to "Center view on edit region") shows the edited voxels in the 3D
panel as a smooth surface, live, with no meshing. It shows **every voxel of the segments
whose meshes NG would draw** in the session region: the datasource baseline
where nothing is painted, the session's patches everywhere else. This is the
same composite the 2D layer draws. The preview exists only for edit sessions
and never saves meshes.

## Same rules as meshes

The preview follows the mesh layer instead of rules of its own:

- **Which segments:** the objects `forEachVisibleSegment` yields, so the
  selection, the temporary visible set and the equivalence policy apply as they
  do to meshes. The brush segment gets no exception: paint with a segment that
  is not selected and the stroke shows in 2D but not in 3D, like its mesh.
- **Colour:** `getObjectColor` of the mapped id (the raw id under
  `baseSegmentColoring`), so saturation and the hover highlight match.
- **When colours update:** `registerCallbackWhenSegmentationDisplayStateChanged`,
  the mesh layer's own triggers. A colour or hover change re-uploads the 1 KiB
  palette and never touches the volume texture.
- **3D opacity 0** hides the preview, as it hides meshes.

Still different: the preview is drawn opaque at any 3D opacity above 0, has no
silhouette mode and cannot be picked in 3D (see "Why an opaque pass"). Segments
that touch share one surface; only their colours tell them apart.

## Smooth surface

Next to the R8UI class texture sits an R8 **per-slice signed distance field**
(`painted_volume_distance_field.ts`): for each texel, the distance within its
z slice to the nearest texel of the other kind, signed positive inside,
clamped to ±4 texels, sampled with linear filtering. The surface is where the
field crosses zero:

- in xy the crossing runs between texel centres, so a stroke's voxel staircase
  becomes a smooth outline;
- in z, interpolating two slices' distances morphs one outline into the next
  (shape-based interpolation), so slices join in slopes instead of steps;
- a one-texel-thin stroke keeps a crossing, so nothing thin disappears (a blur
  would erase it).

The ray march still walks texel by texel (DDA), samples the field at the
middle and the far end of each texel, and bisects the first crossing (10
halvings). The normal is the field's gradient averaged over a 3 × 3
neighbourhood, so the surface is lit as a mesh's averaged normals light it.
The colour is the class of the nearest occupied texel inward from the hit, in
either slice the hit lies between.

The field is computed on the CPU from a mirror of which texels are occupied,
over each uploaded box grown by the range in x and y: a row sweep per kind,
then the nearest over the rows within range; texels whose window holds none
of the other kind are written as saturated without the search. Rendering the
field on the GPU instead (a 3-D texture layer at a time) cost ~15 ms per
stroke on Metal and was dropped.

Costs: two GPU bytes per texel instead of one (the memory budget downsamples
a region at half the size it did) and one CPU byte per texel for the mirror.
Measured with `npm run perf`, worst call per stroke:

|                         | occupancy | upload before | upload after |
| ----------------------- | --------- | ------------- | ------------ |
| brush 51                | 0.14 ms   | ~0.02 ms      | 0.07 ms      |
| brush 251               | 1.8 ms    | ~0.02 ms      | 0.5 ms       |
| brush 1025              | 3.3 ms    | ~0.02 ms      | 3.6 ms       |
| worst region-fill frame | —         | 34.8 ms       | ~40 ms       |

The distance work costs about what the occupancy kernel already does, and
only on very large brushes.

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
meshes, slice planes and mouse picking all z-test against the surface correctly.
It also leaves the transparent pass's blend state alone. The trade-off: the
slice planes are drawn opaque after the surface, so they cut through it at the
current slice. To see inside, untick "Show cross sections in 3-d" in the
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
