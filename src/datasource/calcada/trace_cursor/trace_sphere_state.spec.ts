import { describe, expect, it } from "vitest";
import { TraceSphereState } from "#src/datasource/calcada/trace_cursor/trace_sphere_state.js";
import { ZettaTraceState } from "#src/datasource/calcada/trace_state.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";

function makeHost() {
  const mouseState = {
    active: true,
    unsnappedPosition: Float32Array.of(5, 6, 7),
    changed: new NullarySignal(),
  };
  const selection = { hasSelectedSegment: true, changed: new NullarySignal() };
  const coordinateSpace = new WatchableValue({
    valid: true,
    rank: 3,
    scales: Float64Array.of(16e-9, 16e-9, 45e-9),
    units: ["m", "m", "m"],
  });
  return { mouseState, selection, coordinateSpace };
}

describe("TraceSphereState", () => {
  it("stays hidden while neither aiming nor tracing", () => {
    const { mouseState, selection, coordinateSpace } = makeHost();
    const trace = new ZettaTraceState();
    const state = new TraceSphereState(
      trace,
      mouseState as any,
      selection as any,
      coordinateSpace as any,
    );
    expect(state.visible.value).toBe(false);
    state.dispose();
    trace.dispose();
  });

  it("follows the cursor while aiming over a segment", () => {
    const { mouseState, selection, coordinateSpace } = makeHost();
    const trace = new ZettaTraceState();
    const state = new TraceSphereState(
      trace,
      mouseState as any,
      selection as any,
      coordinateSpace as any,
    );
    trace.aiming.value = true;
    expect(state.visible.value).toBe(true);
    expect(Array.from(state.center.value!)).toEqual([5, 6, 7]);

    mouseState.unsnappedPosition = Float32Array.of(1, 2, 3);
    mouseState.changed.dispatch();
    expect(Array.from(state.center.value!)).toEqual([1, 2, 3]);
    state.dispose();
    trace.dispose();
  });

  it("hides over empty space while aiming", () => {
    const { mouseState, selection, coordinateSpace } = makeHost();
    const trace = new ZettaTraceState();
    const state = new TraceSphereState(
      trace,
      mouseState as any,
      selection as any,
      coordinateSpace as any,
    );
    trace.aiming.value = true;
    selection.hasSelectedSegment = false;
    selection.changed.dispatch();
    expect(state.visible.value).toBe(false);
    state.dispose();
    trace.dispose();
  });

  it("pins the placed sphere regardless of the cursor", () => {
    const { mouseState, selection, coordinateSpace } = makeHost();
    const trace = new ZettaTraceState();
    const state = new TraceSphereState(
      trace,
      mouseState as any,
      selection as any,
      coordinateSpace as any,
    );
    trace.active.value = true;
    trace.sphereCenter.value = Float32Array.of(100, 200, 300);
    selection.hasSelectedSegment = false;
    selection.changed.dispatch();

    expect(state.visible.value).toBe(true);
    expect(Array.from(state.center.value!)).toEqual([100, 200, 300]);
    state.dispose();
    trace.dispose();
  });

  it("prefers the cursor when aiming over a live trace", () => {
    const { mouseState, selection, coordinateSpace } = makeHost();
    const trace = new ZettaTraceState();
    const state = new TraceSphereState(
      trace,
      mouseState as any,
      selection as any,
      coordinateSpace as any,
    );
    trace.active.value = true;
    trace.sphereCenter.value = Float32Array.of(100, 200, 300);
    trace.aiming.value = true;
    expect(Array.from(state.center.value!)).toEqual([5, 6, 7]);
    state.dispose();
    trace.dispose();
  });
});
