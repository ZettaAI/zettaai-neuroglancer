/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import { writableScopes } from "#src/editing/region/session_region_snapshot.js";

function sessionWith(
  layers: readonly {
    layerId: string;
    selectedResolutions: readonly string[];
  }[],
): EditSession {
  return { config: { layers } } as unknown as EditSession;
}

/** Writability is the host's to answer — `LayerSelection` does not carry it. */
function writable(...ids: readonly string[]) {
  return (layerId: string) => ids.includes(layerId);
}

describe("writableScopes", () => {
  it("lists every resolution of every writable layer", () => {
    const session = sessionWith([
      { layerId: "seg", selectedResolutions: ["8", "16"] },
    ]);

    expect(writableScopes(session, writable("seg"))).toEqual([
      { layerId: "seg", resolution: "8" },
      { layerId: "seg", resolution: "16" },
    ]);
  });

  /**
   * The image layer is the reason this filters. Nobody paints it, so nobody
   * else can have changed it — reloading it would buy a blank frame and a
   * refetch for nothing.
   */
  it("leaves read-only layers out", () => {
    const session = sessionWith([
      { layerId: "img", selectedResolutions: ["8"] },
      { layerId: "seg", selectedResolutions: ["8"] },
    ]);

    expect(writableScopes(session, writable("seg"))).toEqual([
      { layerId: "seg", resolution: "8" },
    ]);
  });

  it("is empty when nothing is writable", () => {
    const session = sessionWith([
      { layerId: "img", selectedResolutions: ["8"] },
    ]);

    expect(writableScopes(session, writable())).toEqual([]);
  });
});
