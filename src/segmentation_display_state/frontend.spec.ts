import { describe, expect, it } from "vitest";
import {
  resolveStatedColor,
  unpackColorWithAlpha,
} from "#src/segmentation_display_state/frontend.js";
import { Uint64Map } from "#src/uint64_map.js";

describe("resolveStatedColor", () => {
  it("prefers the temp map when useTemp is true and the id is present", () => {
    const temp = new Uint64Map();
    temp.set(5n, 0xffn);
    const persistent = new Uint64Map();
    persistent.set(5n, 0x11n);
    expect(resolveStatedColor(true, temp, persistent, 5n)).toBe(0xffn);
  });
  it("falls back to the persistent map when useTemp is false", () => {
    const temp = new Uint64Map();
    temp.set(5n, 0xffn);
    const persistent = new Uint64Map();
    persistent.set(5n, 0x11n);
    expect(resolveStatedColor(false, temp, persistent, 5n)).toBe(0x11n);
  });
  it("falls back to the persistent map when the id is absent from temp", () => {
    const temp = new Uint64Map();
    const persistent = new Uint64Map();
    persistent.set(5n, 0x11n);
    expect(resolveStatedColor(true, temp, persistent, 5n)).toBe(0x11n);
  });
});

describe("unpackColorWithAlpha", () => {
  it("extracts r/g/b and scales fallbackAlpha by the packed alpha byte", () => {
    const packed = (0x80n << 24n) | (0x00n << 16n) | (0x84n << 8n) | 0xffn;
    const out = new Float32Array(4);
    unpackColorWithAlpha(packed, out, 1.0);
    expect(out[0]).toBeCloseTo(1.0, 2);
    expect(out[1]).toBeCloseTo(132 / 255, 2);
    expect(out[2]).toBeCloseTo(0, 2);
    expect(out[3]).toBeCloseTo((0x80 / 255) * 1.0, 2);
  });
  it("uses fallbackAlpha unscaled when the packed alpha byte is zero", () => {
    const packed = 0x00ffffffn;
    const out = new Float32Array(4);
    unpackColorWithAlpha(packed, out, 0.7);
    expect(out[3]).toBeCloseTo(0.7, 2);
  });
});
