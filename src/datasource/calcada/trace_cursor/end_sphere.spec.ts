import { describe, expect, it } from "vitest";
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { EndSphere } from "#src/datasource/calcada/trace_cursor/end_sphere.js";
import { EndSphereView } from "#src/datasource/calcada/trace_cursor/end_sphere.js";
import { WatchableValue } from "#src/trackable_value.js";

const END_RADIUS_NM = 1200;
const END_POINT = Float32Array.of(7, 8, 9);

function setUp() {
  const coordinateSpace = new WatchableValue({} as CoordinateSpace);
  const endSphere = new WatchableValue<EndSphere | undefined>(undefined);
  const shown = new WatchableValue(true);
  const view = new EndSphereView(endSphere, shown, coordinateSpace);
  return { coordinateSpace, endSphere, shown, view };
}

describe("EndSphereView", () => {
  it("is hidden while no end is looked for", () => {
    const { coordinateSpace, view } = setUp();
    expect(view.visible.value).toBe(false);
    expect(view.center.value).toBeUndefined();
    expect(view.coordinateSpace).toBe(coordinateSpace);
    view.dispose();
  });

  it("shows the end sphere and hides it again when the end is done", () => {
    const { endSphere, view } = setUp();
    endSphere.value = { center: END_POINT, radiusNm: END_RADIUS_NM };
    expect(view.visible.value).toBe(true);
    expect(view.center.value).toBe(END_POINT);
    expect(view.radiusNm.value).toBe(END_RADIUS_NM);
    endSphere.value = undefined;
    expect(view.visible.value).toBe(false);
    view.dispose();
  });

  it("tells the overlays when what it shows changes", () => {
    const { endSphere, view } = setUp();
    let redraws = 0;
    for (const value of [view.visible, view.center, view.radiusNm]) {
      value.changed.add(() => redraws++);
    }
    endSphere.value = { center: END_POINT, radiusNm: END_RADIUS_NM };
    expect(redraws).toBeGreaterThanOrEqual(2);
    view.dispose();
  });

  it("hides a known end until it is asked about or revealed", () => {
    const { endSphere, shown, view } = setUp();
    shown.value = false;
    endSphere.value = { center: END_POINT, radiusNm: END_RADIUS_NM };
    expect(view.visible.value).toBe(false);
    shown.value = true;
    expect(view.visible.value).toBe(true);
    view.dispose();
  });
});
