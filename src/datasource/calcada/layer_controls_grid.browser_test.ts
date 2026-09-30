/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it } from "vitest";

import "#src/widget/layer_control.css";
import "#src/datasource/calcada/calcada.css";

// Mirrors the exact DOM shape `makeControl` in widget/layer_control.ts
// builds (controlContainer > labelContainer > label > labelTextContainer,
// plus a sibling controlElement) — this test exercises the CSS grid rules in
// calcada.css directly, without pulling in the full layer/viewer harness
// `tabContents` needs.
function makeRow(labelText: string, controlWidthPx: number) {
  const controlContainer = document.createElement("div");
  controlContainer.className = "neuroglancer-layer-control-container";

  const labelContainer = document.createElement("div");
  labelContainer.className = "neuroglancer-layer-control-label-container";
  const label = document.createElement("div");
  label.className = "neuroglancer-layer-control-label";
  const labelTextContainer = document.createElement("div");
  labelTextContainer.className =
    "neuroglancer-layer-control-label-text-container";
  labelTextContainer.textContent = labelText;
  label.appendChild(labelTextContainer);
  labelContainer.appendChild(label);
  controlContainer.appendChild(labelContainer);

  const controlElement = document.createElement("div");
  controlElement.className = "neuroglancer-layer-control-control";
  controlElement.style.cssText = `width: ${controlWidthPx}px; height: 20px; background: #444;`;
  controlContainer.appendChild(controlElement);

  return { controlContainer, labelContainer, controlElement };
}

let target: HTMLDivElement;

afterEach(() => {
  target.remove();
});

function mountRows(rows: { label: string; controlWidthPx: number }[]) {
  target = document.createElement("div");
  target.style.cssText = "position: fixed; top: 100px; left: 100px;";
  document.body.appendChild(target);
  const layerControls = document.createElement("div");
  layerControls.className = "neuroglancer-calcada-layer-controls";
  const built = rows.map(({ label, controlWidthPx }) => {
    const row = makeRow(label, controlWidthPx);
    layerControls.appendChild(row.controlContainer);
    return row;
  });
  target.appendChild(layerControls);
  return { layerControls, built };
}

describe("Graph tab layer-controls grid", () => {
  it("starts every control at the same left edge, however long its own label is", () => {
    const { built } = mountRows([
      { label: "Time", controlWidthPx: 80 },
      { label: "Label", controlWidthPx: 80 },
      { label: "Branch", controlWidthPx: 80 },
    ]);
    const lefts = built.map(
      (row) => row.controlElement.getBoundingClientRect().left,
    );
    expect(new Set(lefts).size).toBe(1);
  });

  it("sizes the shared label column to the widest label, not a fixed number", () => {
    const shortLabels = mountRows([
      { label: "AB", controlWidthPx: 80 },
      { label: "AB", controlWidthPx: 80 },
    ]);
    const shortControlLeft =
      shortLabels.built[0].controlElement.getBoundingClientRect().left;
    shortLabels.layerControls.parentElement!.remove();

    const longLabels = mountRows([
      { label: "A much longer label text", controlWidthPx: 80 },
      { label: "A much longer label text", controlWidthPx: 80 },
    ]);
    const longControlLeft =
      longLabels.built[0].controlElement.getBoundingClientRect().left;

    // The column grows to fit the longer label — nobody hardcoded a width,
    // so a longer label pushes the control column further right.
    expect(longControlLeft).toBeGreaterThan(shortControlLeft);
  });

  it("keeps the row inside the panel with margin from the right edge", () => {
    const { layerControls, built } = mountRows([
      { label: "Time", controlWidthPx: 40 },
    ]);
    const gridRight = layerControls.getBoundingClientRect().right;
    const controlRight = built[0].controlElement.getBoundingClientRect().right;
    // The grid's own right padding keeps the control off the panel edge.
    expect(gridRight - controlRight).toBeGreaterThan(0);
  });
});
