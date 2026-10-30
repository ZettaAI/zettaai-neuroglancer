/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

export function hasExplicitTimestamp(coord: {
  timestamp?: number;
}): coord is { timestamp: number } {
  return coord.timestamp !== undefined && coord.timestamp > 0;
}

export function appendCoordParams(
  url: string,
  coord: { timestamp?: number; branchId?: number },
): string {
  const parts: string[] = [];
  if (hasExplicitTimestamp(coord)) {
    parts.push(`timestamp=${coord.timestamp / 1000}`);
  }
  if (coord.branchId !== undefined && coord.branchId !== 0) {
    parts.push(`branch_id=${coord.branchId}`);
  }
  if (parts.length === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${parts.join("&")}`;
}
