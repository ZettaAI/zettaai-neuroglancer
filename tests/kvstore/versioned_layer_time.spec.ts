/**
 * @license
 * Copyright 2026 Zetta AI.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A precomputed layer viewed at its "Version history" time (TM-521): the
 * data source is loaded once from its plain URL, and only the chunk sources
 * a layer asks for read the bucket at the layer's time. Runs against a fake
 * GCS bucket with object versioning.
 */

import "#src/kvstore/gcs/register.js";
import "#src/kvstore/http/register_frontend.js";
import "#src/kvstore/versioned/register.js";
import "#src/datasource/precomputed/register_default.js";
import { beforeAll, describe, expect, test } from "vitest";
import type { MultiscaleAnnotationSource } from "#src/annotation/frontend_source.js";
import type { DataSource } from "#src/datasource/index.js";
import { siblingAtVersionTime } from "#src/kvstore/versioned/version_time_source.js";
import type { MeshSource } from "#src/mesh/frontend.js";
import type { SkeletonSource } from "#src/skeleton/frontend.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { dataSourceProviderFixture } from "#tests/fixtures/datasource_provider.js";
import {
  createBucket,
  fakeGcsServerFixture,
  writeObject,
} from "#tests/fixtures/fake_gcs_server.js";
import { mswFixture } from "#tests/fixtures/msw";
import { sharedKvStoreContextFixture } from "#tests/fixtures/shared_kvstore_context.js";

const msw = mswFixture();
const fakeGcsServer = fakeGcsServerFixture(msw);
const sharedKvStoreContext = sharedKvStoreContextFixture();
const dataSourceProvider = dataSourceProviderFixture(sharedKvStoreContext);

const BUCKET = "versioned-layer-time";

const SEGMENTATION_INFO = JSON.stringify({
  type: "segmentation",
  data_type: "uint64",
  num_channels: 1,
  mesh: "mesh",
  skeletons: "skeletons",
  scales: [
    {
      key: "8_8_8",
      size: [64, 64, 64],
      resolution: [8, 8, 8],
      chunk_sizes: [[64, 64, 64]],
      encoding: "raw",
      voxel_offset: [0, 0, 0],
    },
  ],
});

const SKELETON_INFO = JSON.stringify({
  "@type": "neuroglancer_skeletons",
  vertex_attributes: [],
});

const ANNOTATION_INFO = JSON.stringify({
  "@type": "neuroglancer_annotations_v1",
  annotation_type: "POINT",
  dimensions: { x: [8e-9, "m"], y: [8e-9, "m"], z: [8e-9, "m"] },
  lower_bound: [0, 0, 0],
  upper_bound: [100, 100, 100],
  properties: [],
  relationships: [{ id: "segments", key: "rel_segments" }],
  by_id: { key: "by_id" },
  spatial: [
    {
      key: "spatial0",
      grid_shape: [1, 1, 1],
      chunk_size: [100, 100, 100],
      limit: 1000,
    },
  ],
});

/** Every object at version `label`; the info files never change. */
function objectsAt(label: string): Record<string, string> {
  return {
    "seg/8_8_8/0-64_0-64_0-64": `chunk-${label}`,
    "seg/mesh/1:0": `mesh-${label}`,
    "seg/skeletons/1": `skeleton-${label}`,
    "points/by_id/1": `annotation-${label}`,
    "points/spatial0/0_0_0": `spatial-${label}`,
    "points/rel_segments/1": `related-${label}`,
  };
}

let timeAfterFirstWrite: number;

async function pause() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function writeAll(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await writeObject(fakeGcsServer, BUCKET, path, content);
  }
}

beforeAll(async () => {
  await createBucket(fakeGcsServer, BUCKET, undefined, { versioning: true });
  await writeAll({
    "seg/info": SEGMENTATION_INFO,
    "seg/skeletons/info": SKELETON_INFO,
    "points/info": ANNOTATION_INFO,
    ...objectsAt("v1"),
  });
  await pause();
  timeAfterFirstWrite = Date.now();
  await pause();
  await writeAll(objectsAt("v2"));
});

async function readText(url: string) {
  const response = await (
    await sharedKvStoreContext()
  ).kvStoreContext.read(url);
  return response === undefined ? undefined : response.response.text();
}

/** Data source loaded from the layer's plain URL, as the layer keeps it. */
async function plainDataSource(layer: string): Promise<DataSource> {
  const provider = await dataSourceProvider();
  return provider.get({
    url: `precomputed://gs://${BUCKET}/${layer}`,
    globalCoordinateSpace: undefined as any,
    transform: undefined,
  });
}

function subsource(dataSource: DataSource, id: string) {
  const entry = dataSource.subsources.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`No ${id} subsource`);
  return entry.subsource;
}

/**
 * URL the chunks of the volume's only scale are read from. Volume chunk
 * sources need WebGL, so the chunk source options are captured instead of
 * creating the source.
 */
function volumeChunkUrl(
  volume: MultiscaleVolumeChunkSource,
  versionTime: number | undefined,
) {
  const { chunkManager } = volume;
  const getChunkSource = chunkManager.getChunkSource;
  chunkManager.getChunkSource = ((_constructor: unknown, options: unknown) =>
    options) as typeof getChunkSource;
  try {
    const [[source]] = volume.getSources({
      displayRank: 3,
      multiscaleToViewTransform: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1),
      modelChannelDimensionIndices: [],
      versionTime,
    });
    return (source.chunkSource as unknown as { parameters: { url: string } })
      .parameters.url;
  } finally {
    chunkManager.getChunkSource = getChunkSource;
  }
}

describe("volume", () => {
  test("chunks are read at the time the layer asks for", async () => {
    const volume = subsource(await plainDataSource("seg"), "default").volume!;
    const live = volumeChunkUrl(volume, undefined);
    const past = volumeChunkUrl(volume, timeAfterFirstWrite);
    expect(live).toBe(`gs://${BUCKET}/seg/8_8_8/`);
    expect(await readText(`${live}0-64_0-64_0-64`)).toBe("chunk-v2");
    expect(await readText(`${past}0-64_0-64_0-64`)).toBe("chunk-v1");
  });
});

describe("mesh and skeletons", () => {
  test("the sibling at a time reads that version; the loaded source is unchanged", async () => {
    const dataSource = await plainDataSource("seg");
    const mesh = subsource(dataSource, "mesh").mesh as MeshSource & {
      parameters: { url: string };
    };
    const meshAtTime = siblingAtVersionTime(mesh, timeAfterFirstWrite)!;
    try {
      expect(meshAtTime).not.toBe(mesh);
      expect(await readText(`${meshAtTime.parameters.url}1:0`)).toBe("mesh-v1");
      expect(await readText(`${mesh.parameters.url}1:0`)).toBe("mesh-v2");
    } finally {
      meshAtTime.dispose();
    }
    const skeletons = subsource(dataSource, "skeletons")
      .mesh as SkeletonSource & { parameters: { url: string } };
    const skeletonsAtTime = siblingAtVersionTime(
      skeletons,
      timeAfterFirstWrite,
    )!;
    try {
      expect(await readText(`${skeletonsAtTime.parameters.url}1`)).toBe(
        "skeleton-v1",
      );
      expect(await readText(`${skeletons.parameters.url}1`)).toBe(
        "skeleton-v2",
      );
    } finally {
      skeletonsAtTime.dispose();
    }
  });

  test("no time: no sibling, the layer shows the loaded source", async () => {
    const mesh = subsource(await plainDataSource("seg"), "mesh").mesh!;
    expect(siblingAtVersionTime(mesh, undefined)).toBeUndefined();
  });

  test("the same time gives the same sibling (shared cache)", async () => {
    const mesh = subsource(await plainDataSource("seg"), "mesh").mesh!;
    const first = siblingAtVersionTime(mesh, timeAfterFirstWrite)!;
    const second = siblingAtVersionTime(mesh, timeAfterFirstWrite)!;
    try {
      expect(second).toBe(first);
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

describe("annotations", () => {
  test("by id, relationships and spatial index are read at the time", async () => {
    const annotation = subsource(await plainDataSource("points"), "default")
      .annotation as MultiscaleAnnotationSource & {
      parameters: {
        byId: { url: string };
        relationships: { url: string }[];
      };
    };
    const atTime = siblingAtVersionTime(annotation, timeAfterFirstWrite)!;
    try {
      const { byId, relationships } = atTime.parameters;
      expect(await readText(`${byId.url}1`)).toBe("annotation-v1");
      expect(await readText(`${relationships[0].url}1`)).toBe("related-v1");
      const [[spatial]] = atTime.getSources({} as any);
      const spatialUrl = (
        spatial.chunkSource as unknown as { parameters: { url: string } }
      ).parameters.url;
      expect(await readText(`${spatialUrl}0_0_0`)).toBe("spatial-v1");
      spatial.chunkSource.dispose();
      // The loaded source still reads the latest data.
      expect(await readText(`${annotation.parameters.byId.url}1`)).toBe(
        "annotation-v2",
      );
    } finally {
      atTime.dispose();
    }
  });
});
