/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  ChunkId,
  ChunkVoxelBuffer,
  Edit,
  LayerId,
  ReadonlyChunkVoxelBuffer,
  Resolution,
  ScaleMetadata,
  VoxelBox,
  WriteTarget,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdCodec,
  layerId,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { describe, expect, it, vi } from "vitest";

import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";
import type { MultipartPoster } from "#src/editing/tool_runtimes/propagate_mask_client.js";
import { PropagationImageSlices } from "#src/editing/tool_runtimes/propagation_image_slices.js";
import {
  NoTrackedVoxelsError,
  PROPAGATION_TIMING_PREFIX,
  propagateSlice,
  type PropagateSliceContext,
} from "#src/editing/tool_runtimes/slice_propagation.js";

const IMAGE: LayerId = layerId("image");
const MASK: LayerId = layerId("mask");
const RES: Resolution = ResolutionCtor.from([8, 8, 8]);

const IMAGE_SCALE: ScaleMetadata = {
  resolution: RES,
  voxelSizeNm: [8, 8, 8],
  voxelOffset: [0, 0, 0],
  sizeVoxels: [64, 64, 64],
  chunkDataSize: [8, 8, 8],
};

/** Image chunk reader that fills each voxel with its global Z (so a slice at
 * global Z reads uniformly = Z). Values stay within uint8. */
function imageReader(): ReadChunkAt {
  const size = 8;
  return (_layerId: LayerId, _resolution: Resolution, chunkId: ChunkId) => {
    const coord = ChunkIdCodec.toCoord(chunkId);
    const view = new Uint8Array(size * size * size);
    for (let lz = 0; lz < size; lz++) {
      const globalZ = coord.z * size + lz;
      for (let ly = 0; ly < size; ly++) {
        for (let lx = 0; lx < size; lx++) {
          view[lx + size * (ly + size * lz)] = globalZ;
        }
      }
    }
    const buffer: ReadonlyChunkVoxelBuffer = {
      byteLength: view.byteLength,
      asView: () => view,
    };
    return Promise.resolve(buffer);
  };
}

interface CapturedWrite {
  target: WriteTarget;
  dense: ChunkVoxelBuffer;
  box: VoxelBox;
  valueMask: Uint8Array | undefined;
}

/** Fake Edit: current mask slice is fixed; writes are captured. */
function fakeEdit(currentMask: BigUint64Array): {
  edit: Edit;
  reads: VoxelBox[];
  writes: CapturedWrite[];
} {
  const reads: VoxelBox[] = [];
  const writes: CapturedWrite[] = [];
  const edit = {
    readRegion: (_target: WriteTarget, box: VoxelBox) => {
      reads.push(box);
      return Promise.resolve({ box, data: currentMask });
    },
    writeRegion: (
      target: WriteTarget,
      dense: ChunkVoxelBuffer,
      box: VoxelBox,
      opts?: { valueMask?: Uint8Array },
    ) => {
      writes.push({ target, dense, box, valueMask: opts?.valueMask });
      return Promise.resolve();
    },
  } as unknown as Edit;
  return { edit, reads, writes };
}

/** Fake backend: captures the request form, replays a canned label prediction. */
function fakeClient(predicted: Uint8Array, height: number, width: number) {
  const requests: FormData[] = [];
  const client: MultipartPoster = {
    postMultipart(_path, form) {
      requests.push(form);
      return Promise.resolve(
        new Response(encodeResponse(height, width, predicted)),
      );
    },
  };
  return { client, requests };
}

function encodeResponse(
  height: number,
  width: number,
  labels: Uint8Array,
): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(
    JSON.stringify({ mask_shape: [height, width] }),
  );
  const buffer = new ArrayBuffer(4 + headerBytes.length + labels.length);
  const view = new DataView(buffer);
  view.setUint32(0, headerBytes.length, true);
  new Uint8Array(buffer, 4, headerBytes.length).set(headerBytes);
  new Uint8Array(buffer, 4 + headerBytes.length).set(labels);
  return buffer;
}

function partBytes(form: FormData, name: string): Promise<Uint8Array> {
  const part = form.get(name) as Blob;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(part);
  });
}

function contextWith(overrides: {
  edit: Edit;
  client: MultipartPoster;
}): PropagateSliceContext {
  return {
    edit: overrides.edit,
    readChunkAt: imageReader(),
    client: overrides.client,
    image: {
      layerId: IMAGE,
      resolution: RES,
      scale: IMAGE_SCALE,
      dataType: "uint8",
    },
    mask: {
      layerId: MASK,
      resolution: RES,
      scale: IMAGE_SCALE,
      dataType: "uint64",
    },
    imageWindow: {
      originX: 0,
      originY: 0,
      width: 2,
      height: 2,
      currentZ: 5,
      nextZ: 6,
    },
    maskWindow: {
      originX: 0,
      originY: 0,
      width: 2,
      height: 2,
      currentZ: 5,
      nextZ: 6,
    },
    trackedIds: [100n, 200n],
  };
}

describe("propagateSlice", () => {
  it("sends labelized mask + normalized current/next images", async () => {
    const { edit } = fakeEdit(BigUint64Array.from([100n, 0n, 200n, 0n]));
    const { client, requests } = fakeClient(
      Uint8Array.from([0, 0, 0, 0]),
      2,
      2,
    );
    await propagateSlice(contextWith({ edit, client }));

    const form = requests[0];
    // labelize([100,0,200,0]) with {100->1, 200->2}
    expect([...(await partBytes(form, "mask-data"))]).toEqual([1, 0, 2, 0]);
    // image voxels carry their global Z: currentZ=5, nextZ=6.
    expect([...(await partBytes(form, "current-image-data"))]).toEqual([
      5, 5, 5, 5,
    ]);
    expect([...(await partBytes(form, "image-data"))]).toEqual([6, 6, 6, 6]);
  });

  it("refuses a current slice with no tracked voxels, before the backend", async () => {
    // 300 is painted, but only 100 and 200 are tracked.
    const { edit, writes } = fakeEdit(BigUint64Array.from([300n, 0n, 0n, 0n]));
    const { client, requests } = fakeClient(
      Uint8Array.from([1, 1, 1, 1]),
      2,
      2,
    );
    const run = propagateSlice(contextWith({ edit, client }));
    await expect(run).rejects.toBeInstanceOf(NoTrackedVoxelsError);
    await expect(run).rejects.toMatchObject({ z: 5 });
    expect(requests).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("reads the mask at the current Z", async () => {
    const { edit, reads } = fakeEdit(BigUint64Array.from([100n, 0n, 200n, 0n]));
    const { client } = fakeClient(Uint8Array.from([0, 0, 0, 0]), 2, 2);
    await propagateSlice(contextWith({ edit, client }));
    expect(reads[0].origin).toEqual([0, 0, 5]);
    expect(reads[0].size).toEqual([2, 2, 1]);
  });

  it("writes decoded ids at the next Z, gated by the value mask", async () => {
    const { edit, writes } = fakeEdit(
      BigUint64Array.from([100n, 0n, 200n, 0n]),
    );
    // Predicted labels → ids via {1->100, 2->200}: [200,200,0,100].
    const { client } = fakeClient(Uint8Array.from([2, 2, 0, 1]), 2, 2);
    const result = await propagateSlice(contextWith({ edit, client }));

    expect(writes).toHaveLength(1);
    expect(writes[0].target).toEqual({ layerId: MASK, resolution: RES });
    expect(writes[0].box.origin).toEqual([0, 0, 6]);
    expect(writes[0].box.size).toEqual([2, 2, 1]);
    expect(writes[0].dense).toBeInstanceOf(BigUint64Array);
    expect([...(writes[0].dense as BigUint64Array)]).toEqual([
      200n,
      200n,
      0n,
      100n,
    ]);
    expect([...(writes[0].valueMask ?? [])]).toEqual([1, 1, 0, 1]);
    expect(result.voxelsWritten).toBe(3);
  });

  it("narrows ids into a uint32 mask layer's buffer", async () => {
    const { edit, writes } = fakeEdit(
      BigUint64Array.from([100n, 200n, 0n, 0n]),
    );
    const { client } = fakeClient(Uint8Array.from([1, 2, 0, 0]), 2, 2);
    const ctx = contextWith({ edit, client });
    await propagateSlice({
      ...ctx,
      mask: {
        layerId: MASK,
        resolution: RES,
        scale: IMAGE_SCALE,
        dataType: "uint32",
      },
    });
    expect(writes[0].dense).toBeInstanceOf(Uint32Array);
    expect([...(writes[0].dense as Uint32Array)]).toEqual([100, 200, 0, 0]);
  });

  it("resamples a coarse mask up to the image grid and back down", async () => {
    // Image 4×4 @ 8nm; mask 2×2 @ 16nm (same Z). Mask [100,0 / 0,200].
    const maskRes = ResolutionCtor.from([16, 16, 8]);
    const maskScale: ScaleMetadata = {
      resolution: maskRes,
      voxelSizeNm: [16, 16, 8],
      voxelOffset: [0, 0, 0],
      sizeVoxels: [32, 32, 64],
      chunkDataSize: [8, 8, 8],
    };
    const { edit, writes } = fakeEdit(
      BigUint64Array.from([100n, 0n, 0n, 200n]),
    );
    // Prediction at the image grid mirrors the upsampled mask (top-left = 1,
    // bottom-right = 2).
    const predicted = Uint8Array.from([
      1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 2, 2, 0, 0, 2, 2,
    ]);
    const { client, requests } = fakeClient(predicted, 4, 4);

    const result = await propagateSlice({
      edit,
      readChunkAt: imageReader(),
      client,
      image: {
        layerId: IMAGE,
        resolution: RES,
        scale: IMAGE_SCALE,
        dataType: "uint8",
      },
      mask: {
        layerId: MASK,
        resolution: maskRes,
        scale: maskScale,
        dataType: "uint64",
      },
      imageWindow: {
        originX: 0,
        originY: 0,
        width: 4,
        height: 4,
        currentZ: 5,
        nextZ: 6,
      },
      maskWindow: {
        originX: 0,
        originY: 0,
        width: 2,
        height: 2,
        currentZ: 5,
        nextZ: 6,
      },
      trackedIds: [100n, 200n],
    });

    // Mask sent to the backend is the 2×2 labels upsampled to the 4×4 image grid.
    expect([...(await partBytes(requests[0], "mask-data"))]).toEqual([
      1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 2, 2, 0, 0, 2, 2,
    ]);
    // Images are read natively at the 4×4 image grid (uniform per-Z value).
    expect([
      ...(await partBytes(requests[0], "current-image-data")),
    ]).toHaveLength(16);
    // Prediction downsampled back to the 2×2 mask grid, decoded to real IDs.
    expect(writes[0].box.size).toEqual([2, 2, 1]);
    expect([...(writes[0].dense as BigUint64Array)]).toEqual([
      100n,
      0n,
      0n,
      200n,
    ]);
    expect([...(writes[0].valueMask ?? [])]).toEqual([1, 0, 0, 1]);
    expect(result.voxelsWritten).toBe(2);
  });

  it("starts the mask and image reads together (TM-518)", async () => {
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const held = <T>(label: string, value: () => Promise<T>) => {
      started.push(label);
      return new Promise<T>((resolve) => {
        releases.push(() => resolve(value()));
      });
    };
    const { edit: innerEdit } = fakeEdit(
      BigUint64Array.from([100n, 0n, 200n, 0n]),
    );
    const edit = {
      ...innerEdit,
      readRegion: (target: WriteTarget, box: VoxelBox) =>
        held("mask", () => innerEdit.readRegion(target, box)),
      writeRegion: innerEdit.writeRegion,
    } as unknown as Edit;
    const innerReader = imageReader();
    const readChunkAt: ReadChunkAt = (layer, resolution, chunkId) =>
      held("image", () => innerReader(layer, resolution, chunkId));
    const { client } = fakeClient(Uint8Array.from([0, 0, 0, 0]), 2, 2);

    const step = propagateSlice({
      ...contextWith({ edit, client }),
      readChunkAt,
    });
    await Promise.resolve();
    // Z 5 and 6 share image chunk z=0: one image read, alongside the mask read.
    expect(started.sort()).toEqual(["image", "mask"]);
    for (const release of releases) release();
    await step;
  });

  it("stops before the backend when aborted during the reads", async () => {
    const { edit, writes } = fakeEdit(
      BigUint64Array.from([100n, 0n, 200n, 0n]),
    );
    const { client, requests } = fakeClient(
      Uint8Array.from([1, 1, 1, 1]),
      2,
      2,
    );
    const abort = new AbortController();
    const innerReader = imageReader();
    const readChunkAt: ReadChunkAt = (layer, resolution, chunkId) => {
      abort.abort();
      return innerReader(layer, resolution, chunkId);
    };
    await expect(
      propagateSlice({
        ...contextWith({ edit, client }),
        readChunkAt,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("takes image slices from the cache it is given", async () => {
    let chunkReads = 0;
    const innerReader = imageReader();
    const countingReader: ReadChunkAt = (layer, resolution, chunkId) => {
      chunkReads++;
      return innerReader(layer, resolution, chunkId);
    };
    const imageSlices = new PropagationImageSlices(countingReader);
    const { edit } = fakeEdit(BigUint64Array.from([100n, 0n, 200n, 0n]));
    const { client, requests } = fakeClient(
      Uint8Array.from([0, 0, 0, 0]),
      2,
      2,
    );
    const ctx = { ...contextWith({ edit, client }), imageSlices };
    await propagateSlice(ctx);
    await propagateSlice(ctx);
    expect(chunkReads).toBe(1);
    expect([...(await partBytes(requests[1], "image-data"))]).toEqual([
      6, 6, 6, 6,
    ]);
  });

  it("reads the next slice only when segments must be protected there", async () => {
    const { edit, reads } = fakeEdit(BigUint64Array.from([100n, 0n, 200n, 0n]));
    const { client } = fakeClient(Uint8Array.from([0, 0, 0, 0]), 2, 2);
    await propagateSlice(contextWith({ edit, client }));
    expect(reads.map((box) => box.origin[2])).toEqual([5]);

    reads.length = 0;
    await propagateSlice({
      ...contextWith({ edit, client }),
      protectedIds: [300n],
    });
    expect(reads.map((box) => box.origin[2]).sort()).toEqual([5, 6]);
  });

  it("does not write over protected segments on the next slice", async () => {
    // The fake returns the same slice for both Z: [100, 0, 200, 0].
    const { edit, writes } = fakeEdit(
      BigUint64Array.from([100n, 0n, 200n, 0n]),
    );
    const { client } = fakeClient(Uint8Array.from([1, 1, 1, 1]), 2, 2);
    const result = await propagateSlice({
      ...contextWith({ edit, client }),
      trackedIds: [100n],
      protectedIds: [200n],
    });
    expect([...(writes[0].valueMask ?? [])]).toEqual([1, 1, 0, 1]);
    expect(result.voxelsWritten).toBe(3);
  });

  it("records each phase as a performance measure", async () => {
    const measure = vi.spyOn(performance, "measure");
    const { edit } = fakeEdit(BigUint64Array.from([100n, 0n, 200n, 0n]));
    const { client } = fakeClient(Uint8Array.from([0, 0, 0, 0]), 2, 2);
    await propagateSlice(contextWith({ edit, client }));
    expect(measure.mock.calls.map(([name]) => name)).toEqual(
      ["read", "encode", "backend", "decode", "write"].map(
        (phase) => PROPAGATION_TIMING_PREFIX + phase,
      ),
    );
    measure.mockRestore();
  });
});
