/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file The graph image as calcada serves it: one precomputed volume per
 * branch at `…/segmentation/table/{graph}/image/{branch}/`. A revision after
 * the branch id (`{branch}.{revision}`) gives the volume a new URL, so
 * Neuroglancer reads its chunks again; calcada lists the patches again for a
 * revision newer than any it served.
 */

// calcada serves a graph under `/segmentation/table/` and `/segmentation/api/v1/table/`.
const TABLE_PATH = String.raw`\/segmentation\/(?:api\/v\d+\/)?table\/`;
const BRANCH_SEGMENT = new RegExp(
  String.raw`(${TABLE_PATH}[^/]+\/image\/)[^/|]+(\/|\|)`,
);
const CALCADA_GRAPH = new RegExp(
  String.raw`(https?:\/\/[^/]+)${TABLE_PATH}([^/|?]+)`,
);
const REVISION_SEPARATOR = ".";
export const NO_REVISION = 0;

// One counter for the page: sessions over one graph share its image layer.
let latestRevision = NO_REVISION;

/** A revision no earlier bump on this page has used. */
export function nextImageRevision(): number {
  latestRevision++;
  return latestRevision;
}

/** The calcada host and graph id a URL addresses, if it addresses one. */
function calcadaGraph(url: string): string | undefined {
  const match = url.match(CALCADA_GRAPH);
  if (match === null) return undefined;
  const [, origin, graphId] = match;
  return `${origin}/${graphId}`;
}

/** Whether `url` is calcada's image source of the graph at `graphUrl`. */
export function isCalcadaImageSource(url: string, graphUrl: string): boolean {
  const graph = calcadaGraph(url);
  return (
    BRANCH_SEGMENT.test(url) &&
    graph !== undefined &&
    graph === calcadaGraph(graphUrl)
  );
}

/** Points calcada's image source at `branchId`, under `revision`. */
export function calcadaImageSource(
  url: string,
  branchId: number,
  revision: number,
): string {
  const segment =
    revision === NO_REVISION
      ? String(branchId)
      : `${branchId}${REVISION_SEPARATOR}${revision}`;
  return url.replace(
    BRANCH_SEGMENT,
    (_match, head: string, tail: string) => `${head}${segment}${tail}`,
  );
}
