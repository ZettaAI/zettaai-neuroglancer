/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession, LayerId, Resolution } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import { sessionChunkDataSize } from "#src/editing/overlay/session_chunk_data_size.js";

const LAYER = "seg" as LayerId;
const FINE = "16x16x40" as Resolution;
const COARSE = "32x32x40" as Resolution;

function sessionWith(
  scales: Array<{ resolution: Resolution; chunkDataSize: number[] }>,
): Pick<EditSession, "baseline"> {
  return {
    baseline: {
      perLayer: new Map([[LAYER, { metadata: { scales } }]]),
    },
  } as unknown as Pick<EditSession, "baseline">;
}

describe("sessionChunkDataSize", () => {
  // The session's size, not NG's nominal 4096²: after TM-373 PR 9a a volume
  // smaller than one chunk has a chunk of its own extent.
  const session = sessionWith([
    { resolution: FINE, chunkDataSize: [1238, 1065, 1] },
    { resolution: COARSE, chunkDataSize: [619, 533, 1] },
  ]);

  it("returns the chunk size of the session's scale", () => {
    expect(sessionChunkDataSize(session, LAYER, FINE)).toEqual([1238, 1065, 1]);
    expect(sessionChunkDataSize(session, LAYER, COARSE)).toEqual([619, 533, 1]);
  });

  it("is undefined for a layer or scale the session does not have", () => {
    expect(
      sessionChunkDataSize(session, "other" as LayerId, FINE),
    ).toBeUndefined();
    expect(
      sessionChunkDataSize(session, LAYER, "8x8x40" as Resolution),
    ).toBeUndefined();
  });
});
