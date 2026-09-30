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

import { LoaderCircleIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  BRANCH_CREATE_FOLLOW_LIMIT_MS,
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
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { ListboxOption } from "#src/widget/listbox_dropdown.js";
import {
  CONTROL_SIZE_CLASS,
  SearchableSelect,
} from "#src/widget/react/searchable_select.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export {
  branchOptions,
  defaultParentForNewBranch,
  watchBranchUntilActive,
} from "#src/datasource/calcada/branch_picker_logic.js";

/**
 * A branch-list dropdown, wrapped for the sizing/tooltip this domain wants
 * everywhere it picks a branch by name: shared with its "+ New branch"
 * parent-branch picker so both stay capped to the same width instead of one
 * stretching to fill whatever row it happens to sit in.
 */
function BranchSelect({
  options,
  value,
  onChange,
  onOpen,
  ariaLabel,
}: {
  options: ListboxOption[];
  value: string;
  onChange: (key: string) => void;
  onOpen?: () => void;
  ariaLabel: string;
}) {
  return (
    <span className="neuroglancer-calcada-branch-select">
      <SearchableSelect
        searchable
        options={options}
        value={value}
        onChange={onChange}
        onOpen={onOpen}
        ariaLabel={ariaLabel}
        searchPlaceholder="Search branches"
        emptyText="No branches found."
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
}: {
  graph: CalcadaGraphSource | undefined;
  branchId: WatchableValueInterface<number>;
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
  const [submitting, setSubmitting] = useState(false);
  // The branch a submit handed off to the server's async copy, followed here
  // until it stops being "creating" so the form can stay in its loading state
  // for the whole fork rather than only for the create request itself.
  const [copyingBranchId, setCopyingBranchId] = useState<number | undefined>(
    undefined,
  );

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

  const copyingBranch =
    copyingBranchId === undefined
      ? undefined
      : branches.find((branch) => branch.id === copyingBranchId);
  // A branch missing from the list counts as still copying, not as finished:
  // a refresh can land between the optimistic insert and the server listing
  // the new branch, and dropping the loading state there would flash the form
  // back open mid-fork.
  const copyDone =
    copyingBranch !== undefined && copyingBranch.status !== "creating";
  const creating = submitting || copyingBranchId !== undefined;

  useEffect(() => {
    if (!copyDone) return;
    setCopyingBranchId(undefined);
    setNewBranchName("");
    setFormOpen(false);
  }, [copyDone]);

  // Both watchers give up eventually — the create poll after enough dropped
  // requests, the branch-list watch after its attempt limit — and neither says
  // so. Without this the form would sit disabled for the rest of the session
  // on a copy nobody is following any more; the branch itself is unaffected,
  // and the dropdown still shows it landing.
  useEffect(() => {
    if (copyingBranchId === undefined) return;
    const timer = setTimeout(
      () => setCopyingBranchId(undefined),
      BRANCH_CREATE_FOLLOW_LIMIT_MS,
    );
    return () => clearTimeout(timer);
  }, [copyingBranchId]);

  const onBranchChange = (key: string) => {
    const parsed = Number.parseInt(key, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    if (parsed === branchId.value) return;
    const targetBranch = branches.find((branch) => branch.id === parsed);
    if (targetBranch !== undefined && targetBranch.status === "creating")
      return;
    // The connection empties and refills the segment lists on the branch
    // change itself, carrying over what exists on the new branch. Emptying
    // them here first left it nothing to carry.
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
    if (!formOpen) setParentChoice(undefined);
    setFormOpen(!formOpen);
  };

  const submitCreate = async () => {
    if (graph === undefined || creating) return;
    const name = newBranchName.trim();
    if (name.length === 0) return;
    const originBranchId = graph.branchId.value;
    setSubmitting(true);
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
        setNewBranchName("");
        setFormOpen(false);
      } else {
        watchBranchUntilActive(
          graph,
          newId,
          originBranchId,
          () => unmounted.current,
        );
        // Leave the form open and loading: the copy is still running, and the
        // Create button's spinner is what says so.
        setCopyingBranchId(newId);
      }
      setCreateError("");
      graph.triggerBranchRefresh();
    } finally {
      setSubmitting(false);
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
      />

      <div className="neuroglancer-calcada-branch-new-group">
        <div className="neuroglancer-calcada-branch-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="neuroglancer-calcada-branch-new"
            onClick={toggleForm}
          >
            {formOpen ? <MinusIcon /> : <PlusIcon />}
            New branch
          </Button>

          {graph !== undefined && selectedId !== MAIN_BRANCH_ID && (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              className="calcada-open-diff"
              render={
                <a
                  href={diffUrl(graph, selectedId)}
                  target="_blank"
                  rel="noopener"
                />
              }
            >
              Open diff
            </Button>
          )}
        </div>

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

          <Input
            ref={nameInputRef}
            type="text"
            name="branch_name"
            className={cn(CONTROL_SIZE_CLASS, "min-w-0 flex-1")}
            disabled={creating}
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitCreate();
              }
            }}
          />

          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={creating}
            onClick={(e) => {
              e.preventDefault();
              submitCreate();
            }}
          >
            {creating && <LoaderCircleIcon className="animate-spin" />}
            Create
          </Button>

          <span className="branch-create-error min-w-0 wrap-anywhere text-destructive">
            {createError}
          </span>
        </div>
      </div>
    </>
  );
}
