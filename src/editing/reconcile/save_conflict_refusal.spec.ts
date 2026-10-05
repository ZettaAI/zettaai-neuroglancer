/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import { canCombine } from "#src/editing/reconcile/save_conflict_refusal.js";
import type { StaleBaselineScan } from "#src/editing/reconcile/stale_baseline_scan.js";

function scan(diverged: number, uncomparable: number): StaleBaselineScan {
  return {
    diverged: Array.from({ length: diverged }, () => ({})),
    uncomparable: Array.from({ length: uncomparable }, () => ({})),
    unchangedCount: 0,
    alreadyAppliedCount: 0,
  } as unknown as StaleBaselineScan;
}

describe("canCombine", () => {
  it("combines a refusal made only of diverged chunks", () => {
    expect(canCombine(scan(2, 0))).toBe(true);
  });

  /**
   * A combine needs all three inputs, and an unprovable chunk has no baseline
   * to combine from. Offering it would promise something we cannot deliver for
   * part of the save.
   */
  it("refuses to combine when any chunk could not be checked", () => {
    expect(canCombine(scan(2, 1))).toBe(false);
  });

  it("has nothing to combine when nothing diverged", () => {
    expect(canCombine(scan(0, 0))).toBe(false);
  });
});
