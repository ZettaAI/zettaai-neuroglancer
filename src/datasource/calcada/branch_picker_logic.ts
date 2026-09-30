/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  CalcadaBranch,
  CalcadaGraphSource,
} from "#src/datasource/calcada/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { ListboxOption } from "#src/widget/listbox_dropdown.js";

export const BRANCH_PICKER_TITLE =
  "Calcada branch (main = 0). Switching clears segments not present on the new branch.";

export const MAIN_BRANCH_ID = 0;

// Stand-in for layers whose graph isn't a CalcadaGraphSource: the control still
// renders (with only "main") so the layer-control row keeps its shape.
export const NO_BRANCHES = new WatchableValue<CalcadaBranch[]>([]);

const BRANCH_CREATING_POLL_MS = 2000;
const BRANCH_CREATING_POLL_LIMIT = 300;

/**
 * How long anything is still watching a fork this session started, and so how
 * long a caller can keep claiming to be following one. Past it both watchers
 * below have given up: whatever the copy does next, nobody here will hear
 * about it.
 */
export const BRANCH_CREATE_FOLLOW_LIMIT_MS =
  BRANCH_CREATING_POLL_MS * BRANCH_CREATING_POLL_LIMIT;

// Follows an async fork to completion, so the picker learns it landed (or
// failed) from the operation itself rather than waiting for a branch-list
// refresh to notice. The operation reports running-or-terminal and nothing
// else: neither it nor the branch row carries a percentage, so how far along
// a copy is is not something anyone can ask.
//
// Only the session that started the fork can do this: the operation id is
// returned by the create call and stored nowhere else, so a reload or another
// user waits on the branch list instead.
const BRANCH_CREATE_POLL_MS = 1000;
// The operation id lives only in this session, so a fork we can no longer reach
// is one nobody will ever get an answer about. Give up rather than polling for
// the life of the tab; the branch list still refreshes on its own.
const BRANCH_CREATE_MAX_FAILURES = 10;

export async function pollBranchCreate(
  graph: CalcadaGraphSource,
  branchId: number,
  operationId: number,
  isCancelled: () => boolean,
) {
  const patch = (status: string) => {
    graph.branches.value = graph.branches.value.map((branch) =>
      branch.id === branchId ? { ...branch, status } : branch,
    );
  };
  let failures = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, BRANCH_CREATE_POLL_MS));
    if (isCancelled()) return;
    let status: string;
    try {
      ({ status } = await graph.createBranchStatus(operationId));
      failures = 0;
    } catch {
      // A dropped poll is not a failed copy — the server is still working. Try
      // again rather than declaring the fork dead.
      if (++failures >= BRANCH_CREATE_MAX_FAILURES) return;
      continue;
    }
    if (isCancelled()) return;
    if (status === "completed") {
      patch("active");
      return;
    }
    if (status === "failed") {
      patch("abandoned");
      return;
    }
  }
}

export function defaultParentForNewBranch(graph: CalcadaGraphSource): number {
  return graph.branchId.value;
}

// Drop selected segments synchronously before switching branches — the
// branchId.changed listener also clears, but doing it here too suppresses the
// "Could not fetch root: piece not found" spam that would otherwise fire from
// any in-flight selectedSegments changes referencing pieces local to the
// previous branch.
export function watchBranchUntilActive(
  graph: CalcadaGraphSource,
  id: number,
  originBranchId: number,
  isCancelled: () => boolean,
  attempt = 0,
): void {
  if (isCancelled() || attempt >= BRANCH_CREATING_POLL_LIMIT) return;
  const entry = graph.branches.value.find((branch) => branch.id === id);
  if (entry !== undefined && entry.status === "active") {
    // Only follow the user onto the new branch if they're still where they
    // were when the fork was requested — a slow copy can take minutes, and
    // switching branchId out from under someone who navigated elsewhere
    // would move their view and drop their undo stack.
    if (graph.branchId.value === originBranchId) {
      graph.branchId.value = id;
    }
    return;
  }
  if (entry !== undefined && entry.status === "abandoned") return;
  graph.triggerBranchRefresh();
  setTimeout(
    () =>
      watchBranchUntilActive(
        graph,
        id,
        originBranchId,
        isCancelled,
        attempt + 1,
      ),
    BRANCH_CREATING_POLL_MS,
  );
}

export function branchLabel(
  branch: CalcadaBranch,
  branches: readonly CalcadaBranch[],
) {
  const { name, status, parentId } = branch;
  if (status === "creating") return `${name} (creating…)`;
  if (status !== "active") return `${name} (${status})`;
  if (parentId !== MAIN_BRANCH_ID) {
    const parentName =
      branches.find((candidate) => candidate.id === parentId)?.name ??
      `#${parentId}`;
    return `${name} ← ${parentName}`;
  }
  return name;
}

/**
 * The branch list as options: "main" always, plus every active or creating
 * branch. Other statuses (merged/abandoned) are hidden unless the layer state
 * points at one of them — dropping that option on restore would leave the
 * picker reading "main" while `branchId` says otherwise, looking like state
 * restore had failed.
 *
 * A selected branch missing from the list entirely gets a placeholder option
 * for the same reason: restoring state puts `branchId` on a branch before
 * /branches answers (its middleauth handshake can retry for seconds), and
 * without an option to match the picker renders a blank row instead of the
 * branch the state asked for.
 */
export function branchOptions(
  branches: readonly CalcadaBranch[],
  selectedId: number,
): ListboxOption[] {
  const options: ListboxOption[] = [
    { key: String(MAIN_BRANCH_ID), label: "main" },
  ];
  for (const branch of branches) {
    const isActive = branch.status === "active";
    const isCreating = branch.status === "creating";
    if (!isActive && !isCreating && branch.id !== selectedId) continue;
    options.push({
      key: String(branch.id),
      label: branchLabel(branch, branches),
      disabled: isCreating,
    });
  }
  const selectedKey = String(selectedId);
  if (!options.some((option) => option.key === selectedKey)) {
    options.push({ key: selectedKey, label: `#${selectedId}` });
  }
  return options;
}

export function diffUrl(graph: CalcadaGraphSource, branchId: number): string {
  // segmentationUrl may carry a "middleauth+" scheme prefix from the kvstore
  // parser; strip it before passing to new URL() so .origin yields a plain
  // https:// URL the browser can navigate to.
  const rawUrl = graph.info.app!.segmentationUrl.replace(/^middleauth\+/, "");
  const adminOrigin = new URL(rawUrl).origin;
  return `${adminOrigin}/admin/graphs/${graph.info.app!.table}/branches/${branchId}/diff`;
}

export async function readCreateBranchError(error: any): Promise<string> {
  const response: Response | undefined = error?.response;
  if (response === undefined) {
    return error instanceof Error ? error.message : String(error);
  }
  try {
    const body = await response.json();
    const message = body?.error || body?.message || "";
    if (message) return message;
  } catch {
    // Fall through to the status line below.
  }
  return `${response.status} ${response.statusText}`;
}
