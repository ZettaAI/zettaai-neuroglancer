/** @jsxImportSource react */
/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useRef, useState } from "react";

import {
  BRANCH_PICKER_TITLE,
  branchOptions,
  defaultParentForNewBranch,
  diffUrl,
  MAIN_BRANCH_ID,
  NO_BRANCHES,
  pollBranchCreate,
  readCreateBranchError,
  watchBranchUntilActive,
} from "#src/datasource/calcada/branch_picker_logic.js";
import type { CalcadaGraphSource } from "#src/datasource/calcada/frontend.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";
import type { SegmentationUserLayerGroupState } from "#src/layer/segmentation/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { ListboxOption } from "#src/widget/react/listbox_dropdown.js";
import { ListboxDropdown } from "#src/widget/react/listbox_dropdown.js";

export {
  branchOptions,
  defaultParentForNewBranch,
  watchBranchUntilActive,
} from "#src/datasource/calcada/branch_picker_logic.js";

/**
 * A branch-list `ListboxDropdown`, wrapped for the sizing/tooltip this domain
 * wants everywhere it picks a branch by name: shared with its "+ New branch"
 * parent-branch picker so both stay capped to the same width instead of one
 * stretching to fill whatever row it happens to sit in.
 */
function BranchSelect({
  options,
  value,
  onChange,
  onOpen,
  ariaLabel,
  title,
}: {
  options: ListboxOption[];
  value: string;
  onChange: (key: string) => void;
  onOpen?: () => void;
  ariaLabel: string;
  title?: string;
}) {
  return (
    <span className="neuroglancer-calcada-branch-select" title={title}>
      <ListboxDropdown
        options={options}
        value={value}
        onChange={onChange}
        onOpen={onOpen}
        filterable
        ariaLabel={ariaLabel}
      />
    </span>
  );
}

/**
 * The Calcada "Branch" layer control: a searchable branch dropdown plus the
 * inline "+ New branch" form and the "Open diff" link.
 */
export function CalcadaBranchPicker({
  graph,
  branchId,
  segmentationGroupState,
}: {
  graph: CalcadaGraphSource | undefined;
  branchId: WatchableValueInterface<number>;
  segmentationGroupState: SegmentationUserLayerGroupState;
}) {
  const selectedId = useWatchable(branchId);
  const branches = useWatchable(graph?.branches ?? NO_BRANCHES);

  const [formOpen, setFormOpen] = useState(false);
  // undefined means "follow the default parent"; a string is the user's own
  // pick, kept across branch-list refreshes while the form stays open.
  const [parentChoice, setParentChoice] = useState<string | undefined>(
    undefined,
  );
  const [newBranchName, setNewBranchName] = useState("");
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (formOpen) nameInputRef.current?.focus();
  }, [formOpen]);

  const options = branchOptions(branches, selectedId);

  const onBranchChange = (key: string) => {
    const parsed = Number.parseInt(key, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    if (parsed === branchId.value) return;
    const targetBranch = branches.find((branch) => branch.id === parsed);
    if (targetBranch !== undefined && targetBranch.status === "creating")
      return;
    // Drop selected segments synchronously before switching — the
    // branchId.changed listener also clears, but doing it here too
    // suppresses the "Could not fetch root: piece not found" spam
    // that would otherwise fire from any in-flight selectedSegments
    // changes referencing pieces local to the previous branch.
    segmentationGroupState.selectedSegments.clear();
    segmentationGroupState.visibleSegments.clear();
    segmentationGroupState.segmentEquivalences.clear();
    branchId.value = parsed;
  };

  const parentOptions: ListboxOption[] = [
    { key: String(MAIN_BRANCH_ID), label: "from: main" },
    ...branches
      .filter((branch) => branch.status === "active")
      .map((branch) => ({
        key: String(branch.id),
        label: `from: ${branch.name}`,
      })),
  ];
  const defaultParentValue = String(
    graph === undefined ? MAIN_BRANCH_ID : defaultParentForNewBranch(graph),
  );
  const hasParentOption = (value: string) =>
    parentOptions.some((option) => option.key === value);
  const preferredParent = parentChoice ?? defaultParentValue;
  const parentValue = hasParentOption(preferredParent)
    ? preferredParent
    : hasParentOption(defaultParentValue)
      ? defaultParentValue
      : String(MAIN_BRANCH_ID);

  const toggleForm = () => {
    setFormOpen((wasOpen) => {
      if (!wasOpen) setParentChoice(undefined);
      return !wasOpen;
    });
  };

  const submitCreate = async () => {
    if (graph === undefined) return;
    const name = newBranchName.trim();
    if (name.length === 0) return;
    const originBranchId = graph.branchId.value;
    setCreating(true);
    try {
      const parsedParentId = Number.parseInt(parentValue, 10);
      const resolvedParentId = Number.isFinite(parsedParentId)
        ? parsedParentId
        : defaultParentForNewBranch(graph);
      let response: Response;
      try {
        response = await graph.createBranch(name, resolvedParentId);
      } catch (e: any) {
        setCreateError(await readCreateBranchError(e));
        return;
      }
      let body: any = {};
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      const newId = body?.branch_id;
      const newName = body?.branch_name;
      if (typeof newId !== "number" || typeof newName !== "string") {
        setCreateError("Invalid response from server");
        return;
      }
      const newStatus =
        typeof body?.status === "string" ? body.status : "active";
      graph.branches.value = [
        ...graph.branches.value,
        {
          id: newId,
          name: newName,
          status: newStatus,
          parentId: resolvedParentId,
          progress: newStatus === "creating" ? 0 : undefined,
        },
      ];
      const operationId = body?.operation_id;
      if (newStatus === "creating" && typeof operationId === "number") {
        void pollBranchCreate(
          graph,
          newId,
          operationId,
          () => unmounted.current,
        );
      }
      if (newStatus === "active") {
        graph.branchId.value = newId;
      } else {
        watchBranchUntilActive(
          graph,
          newId,
          originBranchId,
          () => unmounted.current,
        );
      }
      setNewBranchName("");
      setFormOpen(false);
      setCreateError("");
      graph.triggerBranchRefresh();
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <BranchSelect
        options={options}
        value={String(selectedId)}
        onChange={onBranchChange}
        onOpen={() => graph?.triggerBranchRefresh()}
        ariaLabel="Branch"
        title={BRANCH_PICKER_TITLE}
      />

      <div className="neuroglancer-calcada-branch-new-group">
        <button
          type="button"
          className="neuroglancer-calcada-branch-new"
          onClick={toggleForm}
        >
          + New branch
        </button>

        <div
          className="neuroglancer-calcada-branch-create-form"
          style={{ display: formOpen ? undefined : "none" }}
        >
          <BranchSelect
            options={parentOptions}
            value={parentValue}
            onChange={setParentChoice}
            ariaLabel="Parent branch"
          />

          <input
            ref={nameInputRef}
            type="text"
            name="branch_name"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitCreate();
              }
            }}
          />

          <button
            type="submit"
            disabled={creating}
            onClick={(e) => {
              e.preventDefault();
              submitCreate();
            }}
          >
            Create
          </button>

          <span className="branch-create-error">{createError}</span>
        </div>
      </div>

      {graph !== undefined && selectedId !== MAIN_BRANCH_ID && (
        <a
          className="calcada-open-diff"
          href={diffUrl(graph, selectedId)}
          target="_blank"
          rel="noopener"
        >
          Open diff
        </a>
      )}
    </>
  );
}
