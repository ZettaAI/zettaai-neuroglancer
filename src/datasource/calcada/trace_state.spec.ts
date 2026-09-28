import { describe, expect, it } from "vitest";
import {
  TRACE_SPHERE_RADIUS_DEFAULT_NM,
  ZettaTraceState,
} from "#src/datasource/calcada/trace_state.js";

describe("ZettaTraceState", () => {
  it("starts off with no aiming and the default radius", () => {
    const state = new ZettaTraceState();
    expect(state.active.value).toBe(false);
    expect(state.aiming.value).toBe(false);
    expect(state.sphereRadiusNm.value).toBe(TRACE_SPHERE_RADIUS_DEFAULT_NM);
    expect(state.sphereCenter.value).toBeUndefined();
    state.dispose();
  });

  it("keeps the trace alive while aiming over it", () => {
    const state = new ZettaTraceState();
    state.active.value = true;
    state.aiming.value = true;
    expect(state.active.value).toBe(true);
    state.aiming.value = false;
    expect(state.active.value).toBe(true);
    state.dispose();
  });

  it("does not serialize the aiming phase", () => {
    const state = new ZettaTraceState();
    state.aiming.value = true;
    expect(JSON.stringify(state.toJSON())).not.toContain("aiming");
    state.dispose();
  });

  it("round-trips the sphere through JSON", () => {
    const state = new ZettaTraceState();
    state.active.value = true;
    state.sphereRadiusNm.value = 1234;
    state.sphereCenter.value = Float32Array.of(10, 20, 30);

    const restored = new ZettaTraceState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.sphereRadiusNm.value).toBe(1234);
    expect(Array.from(restored.sphereCenter.value!)).toEqual([10, 20, 30]);
    state.dispose();
    restored.dispose();
  });

  it("keeps the radius but drops the placed sphere on reset", () => {
    const state = new ZettaTraceState();
    state.sphereRadiusNm.value = 999;
    state.sphereCenter.value = Float32Array.of(1, 2, 3);
    state.aiming.value = true;
    state.reset();
    expect(state.sphereCenter.value).toBeUndefined();
    expect(state.aiming.value).toBe(false);
    expect(state.sphereRadiusNm.value).toBe(999);
    state.dispose();
  });

  it("cancels only the aim when escaping over a live trace", () => {
    const state = new ZettaTraceState();
    state.active.value = true;
    state.aiming.value = true;
    state.cancelInnermost();
    expect(state.aiming.value).toBe(false);
    expect(state.active.value).toBe(true);
    state.dispose();
  });

  it("ends the trace when escaping with the sights down", () => {
    const state = new ZettaTraceState();
    state.active.value = true;
    state.cancelInnermost();
    expect(state.active.value).toBe(false);
    state.dispose();
  });

  it("defaults to the sphere scope and round-trips the other", () => {
    const state = new ZettaTraceState();
    expect(state.scope.value).toBe("sphere");
    state.scope.value = "segment";

    const restored = new ZettaTraceState();
    restored.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(restored.scope.value).toBe("segment");
    state.dispose();
    restored.dispose();
  });

  it("refuses a scope it does not know", () => {
    const state = new ZettaTraceState();
    state.restoreState({ scope: "everything" });
    expect(state.scope.value).toBe("sphere");
    state.dispose();
  });
});
