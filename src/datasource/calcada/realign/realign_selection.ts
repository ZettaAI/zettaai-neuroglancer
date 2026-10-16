/**
 * @file Turns the realign annotation layer into a box and correspondences.
 *
 * A correspondence joins where a feature sits on the moving section (`z0`,
 * the box's section) to where it belongs on the reference section
 * (`z0 + referenceOffset`, the section below unless chosen otherwise).
 * web_api wants crop pixels as `[y, x]`, with `start` on the moving section.
 */

export interface RealignBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z: number;
}

export interface CorrespondenceLine {
  readonly id: string;
  readonly start: [number, number];
  readonly end: [number, number];
}

export interface LineEndpoints {
  readonly id: string;
  readonly pointA: ArrayLike<number>;
  readonly pointB: ArrayLike<number>;
}

export type RejectReason = "not-across-sections" | "outside-box";

export interface RealignSelection {
  readonly box: RealignBox;
  readonly referenceSection: number;
  readonly lines: CorrespondenceLine[];
  readonly rejected: { id: string; reason: RejectReason }[];
}

const X = 0;
const Y = 1;
const Z = 2;
// A section boundary converted from global coordinates can come back a hair
// below the integer; this keeps it on its own section.
const SECTION_EPSILON = 1e-6;

/** The section a graph-voxel z falls on. */
export function sectionOf(z: number): number {
  return Math.floor(z + SECTION_EPSILON);
}

/** The z range, in graph voxels, of the one section under `z`. */
export function sectionSpan(z: number): [number, number] {
  const section = sectionOf(z);
  return [section, section + 1];
}

/** The reference is the section below the moving one unless chosen otherwise. */
export const DEFAULT_REFERENCE_OFFSET = -1;
/** How far, in sections, the reference may lie from the moving section. */
export const MAX_REFERENCE_OFFSET = 3;

export type ReferenceDirection = "below" | "above";

export function referenceDirection(
  referenceOffset: number,
): ReferenceDirection {
  return referenceOffset < 0 ? "below" : "above";
}

/**
 * Whether an arrow runs from the reference section to the moving one, so that
 * turning it round puts its tail on the moving section.
 */
export function arrowNeedsReversal(
  pointA: ArrayLike<number>,
  pointB: ArrayLike<number>,
  movingSection: number,
  referenceSection: number,
): boolean {
  return (
    sectionOf(pointA[Z]) === referenceSection &&
    sectionOf(pointB[Z]) === movingSection
  );
}

/** The section to show next when toggling between the moving and reference. */
export function sectionToggleTarget(
  currentSection: number,
  movingSection: number,
  referenceSection: number,
): number {
  return currentSection === movingSection ? referenceSection : movingSection;
}

/**
 * The section a box realigns. A box drawn by the realign tool covers it, the
 * reference section and every section between, so it is the box's top
 * section when the reference is below and its bottom one when above.
 */
function movingSectionOf(
  zA: number,
  zB: number,
  referenceOffset: number,
): number {
  return referenceDirection(referenceOffset) === "below"
    ? sectionOf(Math.max(zA, zB)) - 1
    : sectionOf(Math.min(zA, zB));
}

export function boxFromCorners(
  pointA: ArrayLike<number>,
  pointB: ArrayLike<number>,
  referenceOffset = DEFAULT_REFERENCE_OFFSET,
): RealignBox {
  return {
    x0: Math.floor(Math.min(pointA[X], pointB[X])),
    y0: Math.floor(Math.min(pointA[Y], pointB[Y])),
    x1: Math.ceil(Math.max(pointA[X], pointB[X])),
    y1: Math.ceil(Math.max(pointA[Y], pointB[Y])),
    z: movingSectionOf(pointA[Z], pointB[Z], referenceOffset),
  };
}

function insideBox(box: RealignBox, point: ArrayLike<number>): boolean {
  const x = Math.floor(point[X]);
  const y = Math.floor(point[Y]);
  return x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;
}

function cropPixel(
  box: RealignBox,
  point: ArrayLike<number>,
): [number, number] {
  return [Math.floor(point[Y]) - box.y0, Math.floor(point[X]) - box.x0];
}

export function selectCorrespondences(
  box: RealignBox,
  lines: readonly LineEndpoints[],
  referenceOffset = DEFAULT_REFERENCE_OFFSET,
): RealignSelection {
  const accepted: CorrespondenceLine[] = [];
  const rejected: { id: string; reason: RejectReason }[] = [];
  const referenceSection = box.z + referenceOffset;
  for (const line of lines) {
    const sectionA = sectionOf(line.pointA[Z]);
    const sectionB = sectionOf(line.pointB[Z]);
    let moving: ArrayLike<number>;
    let reference: ArrayLike<number>;
    if (sectionA === box.z && sectionB === referenceSection) {
      [moving, reference] = [line.pointA, line.pointB];
    } else if (sectionB === box.z && sectionA === referenceSection) {
      [moving, reference] = [line.pointB, line.pointA];
    } else {
      rejected.push({ id: line.id, reason: "not-across-sections" });
      continue;
    }
    if (!insideBox(box, moving) || !insideBox(box, reference)) {
      rejected.push({ id: line.id, reason: "outside-box" });
      continue;
    }
    accepted.push({
      id: line.id,
      start: cropPixel(box, moving),
      end: cropPixel(box, reference),
    });
  }
  return { box, referenceSection, lines: accepted, rejected };
}
