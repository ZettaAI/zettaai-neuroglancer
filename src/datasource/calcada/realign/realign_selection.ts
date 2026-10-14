/**
 * @file Turns the realign annotation layer into a box and correspondences.
 *
 * A correspondence joins where a feature sits on the moving section (`z0`,
 * the box's section) to where it belongs on the reference section (`z0 - 1`).
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
  readonly lines: CorrespondenceLine[];
  readonly rejected: { id: string; reason: RejectReason }[];
}

const X = 0;
const Y = 1;
const Z = 2;

export function boxFromCorners(
  pointA: ArrayLike<number>,
  pointB: ArrayLike<number>,
): RealignBox {
  return {
    x0: Math.floor(Math.min(pointA[X], pointB[X])),
    y0: Math.floor(Math.min(pointA[Y], pointB[Y])),
    x1: Math.ceil(Math.max(pointA[X], pointB[X])),
    y1: Math.ceil(Math.max(pointA[Y], pointB[Y])),
    z: Math.floor(Math.min(pointA[Z], pointB[Z])),
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
): RealignSelection {
  const accepted: CorrespondenceLine[] = [];
  const rejected: { id: string; reason: RejectReason }[] = [];
  const referenceSection = box.z - 1;
  for (const line of lines) {
    const sectionA = Math.floor(line.pointA[Z]);
    const sectionB = Math.floor(line.pointB[Z]);
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
  return { box, lines: accepted, rejected };
}
