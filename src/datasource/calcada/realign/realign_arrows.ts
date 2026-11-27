/**
 * @file How realign correspondences look and turn. They follow the portal's
 * correspondence tool: a yellow line from a blue start (the moving section) to
 * a red end (the reference section); a rejected one turns grey. Neuroglancer
 * draws no arrowheads, so the end colours give the direction. The box shares
 * the shader.
 */

import type { Line } from "#src/annotation/index.js";

export const REJECTED_PROPERTY_INDEX = 0;
export const REALIGN_ARROW_PROPERTIES = [
  { id: "rejected", type: "uint8", default: 0 },
];

export const REALIGN_ARROW_SHADER = `
void main() {
  vec4 line = prop_rejected() == 1u ? vec4(0.6, 0.6, 0.6, 1.0)
                                    : vec4(1.0, 1.0, 0.0, 1.0);
  setBoundingBoxBorderColor(vec4(1.0, 0.85, 0.1, 1.0));
  setBoundingBoxBorderWidth(2.0);
  setLineColor(line);
  setLineWidth(2.0);
  setEndpointMarkerSize(9.0, 9.0);
  setEndpointMarkerColor(vec4(0.0, 0.0, 1.0, 1.0), vec4(1.0, 0.0, 0.0, 1.0));
  setEndpointMarkerBorderColor(line, line);
  setEndpointMarkerBorderWidth(1.0, 1.0);
}
`;

const REVERSE_ARROW_CODE = "KeyR";
// Bare Q is bound neither by Neuroglancer nor by the calcada layer.
const SECTION_TOGGLE_CODE = "KeyQ";

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

/** Q: show the other of the moving and reference sections. */
export function isSectionToggleKey(event: KeyboardEvent): boolean {
  return (
    event.code === SECTION_TOGGLE_CODE &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}
