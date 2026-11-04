#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "tensorstore",
#     "numpy",
# ]
# ///
"""
Generate deterministic `neuroglancer_precomputed` fixtures for the edit-session
e2e suite (TM-331, phase 2).

Reads `manifest.json` (the declarative data-axis matrix) and writes one
precomputed volume per fixture into a per-bucket directory layout that the
`fake-gcs-server` filesystem backend serves verbatim:

    testdata/editing/buckets/<BUCKET>/<fixture-id>/{info, <scale>/...}

so the built app can load `precomputed://gs://<BUCKET>/<fixture-id>` against a
LOCAL fake GCS — byte-identical URL scheme to prod, no auth, no cold `gs://`.

Content is a deterministic function of global voxel coords (so reads are
reproducible across runs): images get a gradient, segmentations get blocky IDs.
Also emits `fixtures.json` — the resolved index (source URL + axis metadata per
fixture) that the harness / `buildNgState` consume.

Run:  uv run testdata/editing/generate.py
      (CI / the harness can invoke it before the e2e run; output is gitignored.)

      uv run testdata/editing/generate.py --large-chunk
      (TM-373: the 4096² large-chunk perf fixtures from `manifest_large_chunk.json`
      into `fixtures_large_chunk.json` — ~1.4 GB of raw chunks, so they stay out
      of the default manifest that every e2e/perf run regenerates.)
"""

import argparse
import itertools
import json
import os
import shutil

import numpy as np
import tensorstore as ts

HERE = os.path.dirname(os.path.abspath(__file__))
BUCKET = "zetta-editing-test"
BUCKETS_ROOT = os.path.join(HERE, "buckets")

# compressed_segmentation needs a block size; 8³ divides every chunk we use.
CSEG_BLOCK = [8, 8, 8]


def downsample_factor(base, res):
    """Integer per-axis factor mapping the base resolution to `res`."""
    return [max(1, round(r / b)) for r, b in zip(res, base)]


def scale_size(size, factor):
    return [-(-s // f) for s, f in zip(size, factor)]  # ceil-div


# Above this many voxels a scale is written one chunk-aligned block at a time,
# so the 8192² large-chunk fixture never holds a whole volume in memory. Every
# fixture in `manifest.json` is at or under it and still writes in one go.
WHOLE_WRITE_MAX_VOXELS = 1 << 26


def content(kind: str, dtype: str, origin, shape):
    """Deterministic voxel content as a numpy array of `shape` + channel axis."""
    ox, oy, oz = origin
    sx, sy, sz = shape
    # Broadcast index grids (same values as a full `meshgrid`, without
    # materializing three volume-sized arrays).
    xx = np.arange(ox, ox + sx).reshape(sx, 1, 1)
    yy = np.arange(oy, oy + sy).reshape(1, sy, 1)
    zz = np.arange(oz, oz + sz).reshape(1, 1, sz)
    if kind == "image":
        val = ((xx * 2 + yy) % 256).astype(dtype)
    else:
        # Blocky 32-voxel segment IDs, never 0 (0 reads as "empty" in the app).
        val = (((xx // 32) + (yy // 32) + zz) % 7 + 1).astype(dtype)
    # The image gradient ignores z; give every fixture its full block shape.
    val = np.broadcast_to(val, (sx, sy, sz))
    return val[..., np.newaxis]  # trailing channel axis


def scale_metadata(fixture, res, factor):
    meta = {
        "encoding": fixture["encoding"],
        "chunk_size": fixture["chunk"],
        "resolution": res,
        "voxel_offset": [o // f for o, f in zip(fixture["offset"], factor)],
        "size": scale_size(fixture["size"], factor),
    }
    if fixture["encoding"] == "compressed_segmentation":
        meta["compressed_segmentation_block_size"] = CSEG_BLOCK
    return meta


def chunk_aligned_blocks(meta):
    """Per-axis global `(start, stop)` ranges, one chunk per block."""
    axes = []
    for origin, size, chunk in zip(
        meta["voxel_offset"], meta["size"], meta["chunk_size"]
    ):
        axes.append(
            [
                (origin + lo, origin + min(lo + chunk, size))
                for lo in range(0, size, chunk)
            ]
        )
    return itertools.product(*axes)


def write_scale(store, fixture, meta):
    origin = meta["voxel_offset"]
    size = meta["size"]
    if size[0] * size[1] * size[2] <= WHOLE_WRITE_MAX_VOXELS:
        store[...] = content(fixture["kind"], fixture["dtype"], origin, size)
        return
    # TensorStore indexes the volume in global coordinates (its domain starts
    # at `voxel_offset`), which is what `chunk_aligned_blocks` yields.
    for block in chunk_aligned_blocks(meta):
        block_origin = [start for start, _ in block]
        block_shape = [stop - start for start, stop in block]
        region = tuple(slice(start, stop) for start, stop in block)
        store[region] = content(
            fixture["kind"], fixture["dtype"], block_origin, block_shape
        )


def write_fixture(fixture):
    path = os.path.join(BUCKETS_ROOT, BUCKET, fixture["id"])
    shutil.rmtree(path, ignore_errors=True)
    base = fixture["resolutions"][0]
    for res in fixture["resolutions"]:
        factor = downsample_factor(base, res)
        meta = scale_metadata(fixture, res, factor)
        store = ts.open(
            {
                "driver": "neuroglancer_precomputed",
                "kvstore": {"driver": "file", "path": path},
                "scale_metadata": meta,
                "multiscale_metadata": {
                    "data_type": fixture["dtype"],
                    "num_channels": 1,
                    "type": fixture["kind"],
                },
            },
            create=True,
            open=True,
            dtype=getattr(ts, fixture["dtype"]),
        ).result()
        write_scale(store, fixture, meta)
    return {
        "id": fixture["id"],
        "kind": fixture["kind"],
        "dtype": fixture["dtype"],
        "encoding": fixture["encoding"],
        "chunk": fixture["chunk"],
        "offset": fixture["offset"],
        "size": fixture["size"],
        "resolutions": fixture["resolutions"],
        "source": f"precomputed://gs://{BUCKET}/{fixture['id']}",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--large-chunk",
        action="store_true",
        help="generate the TM-373 large-chunk perf fixtures instead",
    )
    args = parser.parse_args()
    manifest_name, index_name = (
        ("manifest_large_chunk.json", "fixtures_large_chunk.json")
        if args.large_chunk
        else ("manifest.json", "fixtures.json")
    )
    with open(os.path.join(HERE, manifest_name)) as f:
        manifest = json.load(f)
    resolved = [write_fixture(fx) for fx in manifest]
    index = {"bucket": BUCKET, "fixtures": resolved}
    with open(os.path.join(HERE, index_name), "w") as f:
        json.dump(index, f, indent=2)
        f.write("\n")
    print(f"Wrote {len(resolved)} fixtures to {os.path.join(BUCKETS_ROOT, BUCKET)}")
    for fx in resolved:
        print(f"  {fx['id']:<20} {fx['encoding']:<24} {fx['source']}")


if __name__ == "__main__":
    main()
