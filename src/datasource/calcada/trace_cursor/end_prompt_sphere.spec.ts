import { describe, expect, it } from "vitest";
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { EndPromptSphere } from "#src/datasource/calcada/trace_cursor/end_prompt_sphere.js";
import { SphereShowingEndPrompt } from "#src/datasource/calcada/trace_cursor/end_prompt_sphere.js";
import { WatchableValue } from "#src/trackable_value.js";

const TRACE_RADIUS_NM = 5000;
const END_RADIUS_NM = 1200;
const TRACE_CENTER = Float32Array.of(1, 2, 3);
const END_POINT = Float32Array.of(7, 8, 9);

function setUp(traceVisible: boolean) {
  const trace = {
    visible: new WatchableValue(traceVisible),
    center: new WatchableValue<Float32Array | undefined>(
      traceVisible ? TRACE_CENTER : undefined,
    ),
    radiusNm: new WatchableValue(TRACE_RADIUS_NM),
    coordinateSpace: new WatchableValue({} as CoordinateSpace),
  };
  const endSphere = new WatchableValue<EndPromptSphere | undefined>(undefined);
  const view = new SphereShowingEndPrompt(trace, endSphere);
  return { trace, endSphere, view };
}

describe("SphereShowingEndPrompt", () => {
  it("shows the trace's sphere while no prompt is open", () => {
    const { trace, view } = setUp(true);
    expect(view.visible.value).toBe(true);
    expect(view.center.value).toBe(TRACE_CENTER);
    expect(view.radiusNm.value).toBe(TRACE_RADIUS_NM);
    expect(view.coordinateSpace).toBe(trace.coordinateSpace);
    view.dispose();
  });

  it("shows the end sphere while the prompt is open, even when the trace's is hidden", () => {
    const { endSphere, view } = setUp(false);
    endSphere.value = { center: END_POINT, radiusNm: END_RADIUS_NM };
    expect(view.visible.value).toBe(true);
    expect(view.center.value).toBe(END_POINT);
    expect(view.radiusNm.value).toBe(END_RADIUS_NM);
    view.dispose();
  });

  it("goes back to the trace's sphere when the prompt closes", () => {
    const { trace, endSphere, view } = setUp(true);
    endSphere.value = { center: END_POINT, radiusNm: END_RADIUS_NM };
    endSphere.value = undefined;
    expect(view.visible.value).toBe(true);
    expect(view.center.value).toBe(TRACE_CENTER);
    expect(view.radiusNm.value).toBe(TRACE_RADIUS_NM);
    trace.visible.value = false;
    expect(view.visible.value).toBe(false);
    view.dispose();
  });

  it("tells the overlays when what it shows changes", () => {
    const { endSphere, view } = setUp(true);
    let redraws = 0;
    for (const value of [view.visible, view.center, view.radiusNm]) {
      value.changed.add(() => redraws++);
    }
    endSphere.value = { center: END_POINT, radiusNm: END_RADIUS_NM };
    expect(redraws).toBeGreaterThanOrEqual(2);
    view.dispose();
  });
});
