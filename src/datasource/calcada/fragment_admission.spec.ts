import { describe, expect, it } from "vitest";
import { FragmentAdmissionLatch } from "#src/datasource/calcada/fragment_admission.js";

describe("FragmentAdmissionLatch", () => {
  it("returns the charge-time value at release even when inputs changed", () => {
    const latch = new FragmentAdmissionLatch();
    const chunk = {};
    let supported: boolean | undefined = undefined;
    const decide = () => (supported === true ? 0 : undefined);
    expect(latch.get(chunk, "piece:0", decide)).toBeUndefined();
    supported = true;
    expect(latch.get(chunk, "piece:0", decide)).toBeUndefined();
  });

  it("gives a fresh decision to a new chunk after support flips", () => {
    const latch = new FragmentAdmissionLatch();
    let supported: boolean | undefined = undefined;
    const decide = () => (supported === true ? 0 : undefined);
    expect(latch.get({}, "a:0", decide)).toBeUndefined();
    supported = true;
    expect(latch.get({}, "b:0", decide)).toBe(0);
  });

  it("recomputes when a recycled chunk carries a different fragment id", () => {
    const latch = new FragmentAdmissionLatch();
    const chunk = {};
    let value: number | undefined = undefined;
    expect(latch.get(chunk, "a:0", () => value)).toBeUndefined();
    value = 0;
    expect(latch.get(chunk, "b:0", () => value)).toBe(0);
    expect(latch.get(chunk, "b:0", () => undefined)).toBe(0);
  });

  it("latches a zero decision just as firmly as an undefined one", () => {
    const latch = new FragmentAdmissionLatch();
    const chunk = {};
    expect(latch.get(chunk, "a:0", () => 0)).toBe(0);
    expect(latch.get(chunk, "a:0", () => undefined)).toBe(0);
  });
});
