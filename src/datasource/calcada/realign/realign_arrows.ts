/**
 * @file How realign correspondences look and turn: a small hollow tail on the
 * moving section, a large filled head on the reference, red when rejected.
 * The box shares the shader and the colour.
 */

import type { Line } from "#src/annotation/index.js";

export const REJECTED_PROPERTY_INDEX = 0;
export const REALIGN_ARROW_PROPERTIES = [
  { id: "rejected", type: "uint8", default: 0 },
];

export const REALIGN_ARROW_SHADER = `
void main() {
  vec4 arrow = prop_rejected() == 1u ? vec4(1.0, 0.25, 0.25, 1.0)
                                     : vec4(1.0, 0.85, 0.1, 1.0);
  setBoundingBoxBorderColor(arrow);
  setBoundingBoxBorderWidth(2.0);
  setLineColor(arrow);
  setLineWidth(2.0);
  setEndpointMarkerSize(5.0, 13.0);
  setEndpointMarkerColor(vec4(0.0), arrow);
  setEndpointMarkerBorderColor(arrow, arrow);
  setEndpointMarkerBorderWidth(2.0, 0.0);
}
`;

const REVERSE_ARROW_CODE = "KeyR";

export function reversedLine(line: Line): Line {
  return { ...line, pointA: line.pointB, pointB: line.pointA };
}

export function withRejectedFlag(
  line: Line,
  rejected: boolean,
): Line | undefined {
  const flag = rejected ? 1 : 0;
  if (line.properties[REJECTED_PROPERTY_INDEX] === flag) return undefined;
  const properties = [...line.properties];
  properties[REJECTED_PROPERTY_INDEX] = flag;
  return { ...line, properties };
}

/** Shift+R: plain R is Neuroglancer's rotate-relative-z-. */
export function isReverseArrowKey(event: KeyboardEvent): boolean {
  return (
    event.code === REVERSE_ARROW_CODE &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}
