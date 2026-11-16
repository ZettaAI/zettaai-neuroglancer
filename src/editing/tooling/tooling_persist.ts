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
 * Serialization of consumer tool state for the persisted `editSession` block
 * (TM-315, decision C). Captures the painting family config (size, value,
 * erase value, mask, target binding) so a reload restores the user's tool
 * parameters. The active tool id is still serialized (keeping the block shape
 * backward/forward compatible) but no longer acted on at restore — every
 * session entry lands in navigation mode (TM-381). Lives separately from the
 * host so the encode/parse round-trip is unit-testable in isolation.
 *
 * `activeValue` / `eraseValue` are `number | bigint` (segment ids). JSON has no
 * bigint, so they are stored type-tagged and decoded back to the original kind.
 * Everything else in the mask/config is already JSON-safe (numbers, strings,
 * booleans). Parsing is intentionally tolerant: any malformed field drops the
 * whole tooling block (the session still restores, tools fall back to
 * defaults).
 */

import type { LayerId, Resolution } from "@zettaai/edit-session";

import type {
  FillMode,
  PaintingMaskConfig,
} from "#src/editing/tool_runtimes/paint_types.js";
import {
  clampBinaryClosing,
  DEFAULT_COVERAGE_THRESHOLD,
} from "#src/editing/tool_runtimes/paint_types.js";
import type { PaintingSharedState } from "#src/editing/tool_runtimes/painting_tools.js";

/** Type-tagged numeric/bigint value, JSON-safe. */
type SerializedValue =
  | { readonly t: "n"; readonly v: number }
  | { readonly t: "b"; readonly v: string };

interface SerializedPainting {
  readonly targetLayerId: string;
  readonly targetResolution: string;
  readonly radius: number;
  readonly activeValue: SerializedValue;
  readonly eraseValue: SerializedValue;
  readonly mask: PaintingMaskConfig | null;
  /** Fill connectivity mode (TM-269). Optional: older blocks default to 2D. */
  readonly fillMode?: FillMode;
  /** Auto-select the painted segment (TM-490). Optional: older blocks default on. */
  readonly autoSelectPaintedSegment?: boolean;
  /**
   * Fill inside (TM-268). Optional like the field above: absent ⇒ on, the app
   * default. Blocks written before it defaulted on stored it as
   * `fillClosedPaths`, almost always the old default `false`; that key is
   * ignored, so those users get the new default.
   */
  readonly fillInside?: boolean;
}

/** Coerce an unknown to the fill-inside flag, defaulting on (the app default). */
function parseFillInside(x: unknown): boolean {
  return x !== false;
}

/** Coerce an unknown to the auto-select flag, defaulting on (the app default). */
function parseAutoSelect(x: unknown): boolean {
  return x !== false;
}

/** Coerce an unknown to a `FillMode`, defaulting to `"2d"` (the app default). */
function parseFillMode(x: unknown): FillMode {
  return x === "3d" ? "3d" : "2d";
}

export interface ToolingPersistState {
  /**
   * Active tool id, or null for cursor mode. Persisted for block-shape
   * compatibility but ignored at restore (TM-381): sessions always enter in
   * navigation mode.
   */
  readonly activeToolId: string | null;
  /** Painting family config; absent if it could not be parsed. */
  readonly painting?: SerializedPainting;
  // Edit-hotkey overrides used to live here too (TM-315). They are now kept
  // per browser (`personal_keybinds.ts`) so a shared link does not carry them;
  // a `keybinds` field in an older block is ignored.
}

function serializeValue(value: number | bigint): SerializedValue {
  return typeof value === "bigint"
    ? { t: "b", v: value.toString() }
    : { t: "n", v: value };
}

function serializePainting(state: PaintingSharedState): SerializedPainting {
  return {
    targetLayerId: state.targetLayerId,
    targetResolution: state.targetResolution,
    radius: state.radius,
    activeValue: serializeValue(state.activeValue),
    eraseValue: serializeValue(state.eraseValue),
    mask: state.mask ?? null,
    fillMode: state.fillMode,
    autoSelectPaintedSegment: state.autoSelectPaintedSegment,
    fillInside: state.fillClosedPaths,
  };
}

/** Build the persisted tooling block from the live tool state. */
export function serializeTooling(
  activeToolId: string | undefined,
  painting: PaintingSharedState,
): ToolingPersistState {
  return {
    activeToolId: activeToolId ?? null,
    painting: serializePainting(painting),
  };
}

// -- Parsing (tolerant) -----------------------------------------------------

function parseValue(x: unknown): number | bigint | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const o = x as Record<string, unknown>;
  if (o.t === "n" && typeof o.v === "number") return o.v;
  if (o.t === "b" && typeof o.v === "string") {
    try {
      return BigInt(o.v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseMask(x: unknown): PaintingMaskConfig | null | undefined {
  if (x === null) return null;
  if (typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (
    typeof o.imageLayerId !== "string" ||
    typeof o.imageResolution !== "string" ||
    typeof o.thresholdLow !== "number" ||
    typeof o.thresholdHigh !== "number" ||
    typeof o.minComponentSize !== "number" ||
    typeof o.binaryClosing !== "number" ||
    typeof o.filterComponentsFirst !== "boolean" ||
    // Optional (added TM-339); reject only a present-but-wrong-typed value so
    // older persisted configs without the field still parse.
    (o.coverageThreshold !== undefined &&
      typeof o.coverageThreshold !== "number")
  ) {
    return undefined;
  }
  return {
    imageLayerId: o.imageLayerId as LayerId,
    imageResolution: o.imageResolution as Resolution,
    thresholdLow: o.thresholdLow,
    thresholdHigh: o.thresholdHigh,
    coverageThreshold:
      typeof o.coverageThreshold === "number"
        ? o.coverageThreshold
        : DEFAULT_COVERAGE_THRESHOLD,
    minComponentSize: o.minComponentSize,
    binaryClosing: clampBinaryClosing(o.binaryClosing),
    filterComponentsFirst: o.filterComponentsFirst,
  };
}

function parsePainting(x: unknown): SerializedPainting | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const o = x as Record<string, unknown>;
  if (
    typeof o.targetLayerId !== "string" ||
    typeof o.targetResolution !== "string" ||
    typeof o.radius !== "number"
  ) {
    return undefined;
  }
  const activeValue = parseValue(o.activeValue);
  const eraseValue = parseValue(o.eraseValue);
  const mask = parseMask(o.mask);
  if (
    activeValue === undefined ||
    eraseValue === undefined ||
    mask === undefined
  ) {
    return undefined;
  }
  return {
    targetLayerId: o.targetLayerId,
    targetResolution: o.targetResolution,
    radius: o.radius,
    activeValue: serializeValue(activeValue),
    eraseValue: serializeValue(eraseValue),
    mask,
    fillMode: parseFillMode(o.fillMode),
    autoSelectPaintedSegment: parseAutoSelect(o.autoSelectPaintedSegment),
    fillInside: parseFillInside(o.fillInside),
  };
}

/** Parse a persisted tooling block. Returns undefined when absent/malformed. */
export function parseTooling(x: unknown): ToolingPersistState | undefined {
  if (x === null || x === undefined) return undefined;
  if (typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const activeToolId =
    o.activeToolId === null
      ? null
      : typeof o.activeToolId === "string"
        ? o.activeToolId
        : undefined;
  if (activeToolId === undefined) return undefined;
  const painting =
    o.painting === undefined ? undefined : parsePainting(o.painting);
  if (o.painting !== undefined && painting === undefined) return undefined;
  return {
    activeToolId,
    ...(painting !== undefined ? { painting } : {}),
  };
}

/**
 * Resolve a persisted painting config into a `PaintingSharedState` patch,
 * validated against the session's layers. Returns the patch to apply, or
 * undefined if the target binding is no longer valid (the caller keeps
 * defaults). A persisted mask referencing a missing layer is dropped while the
 * rest of the config still applies.
 *
 * `allowedByLayer` maps each session layer to the resolutions the session
 * actually opened (and the host preloads/pins). A persisted
 * `mask.imageResolution` that is NOT among them is repaired to the layer's
 * first allowed resolution rather than restored verbatim: the image layer's
 * datasource pyramid usually contains finer scales the session never pinned, so
 * a stale value would otherwise drive every masked stamp to cold-read native
 * full-resolution EM (a 10–20 s/chunk stall). Repairing keeps masking on at a
 * resident scale instead of dropping it.
 */
export function paintingPatchFromPersist(
  p: SerializedPainting,
  allowedByLayer: ReadonlyMap<string, readonly Resolution[]>,
): Partial<PaintingSharedState> | undefined {
  if (!allowedByLayer.has(p.targetLayerId)) return undefined;
  const activeValue = parseValue(p.activeValue);
  const eraseValue = parseValue(p.eraseValue);
  if (activeValue === undefined || eraseValue === undefined) return undefined;
  const mask = repairMaskResolution(p.mask, allowedByLayer);
  return {
    targetLayerId: p.targetLayerId as LayerId,
    targetResolution: p.targetResolution as Resolution,
    radius: p.radius,
    activeValue,
    eraseValue,
    mask,
    fillMode: parseFillMode(p.fillMode),
    autoSelectPaintedSegment: parseAutoSelect(p.autoSelectPaintedSegment),
    fillClosedPaths: parseFillInside(p.fillInside),
  };
}

/**
 * Validate a persisted mask against the session's opened resolutions. Returns:
 *   • `undefined` — no mask persisted, or its image layer is gone from the
 *     session (dropped, same as the missing-target-layer behavior).
 *   • the mask unchanged — its `imageResolution` is one the session opened.
 *   • the mask with `imageResolution` swapped for the layer's first allowed
 *     resolution — a stale/finer value the session never pinned.
 */
function repairMaskResolution(
  mask: PaintingMaskConfig | null,
  allowedByLayer: ReadonlyMap<string, readonly Resolution[]>,
): PaintingMaskConfig | undefined {
  if (mask === null) return undefined;
  const allowed = allowedByLayer.get(mask.imageLayerId);
  if (allowed === undefined || allowed.length === 0) return undefined;
  if (allowed.includes(mask.imageResolution)) return mask;
  return { ...mask, imageResolution: allowed[0] };
}
