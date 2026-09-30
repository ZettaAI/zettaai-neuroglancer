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

/**
 * @file The library bar at the top of the filter editor: which filter is being
 * edited, whether it is saved, and the library's own actions.
 */

import { useCallback, useRef, useState } from "react";

import type {
  FilterLibrary,
  LibraryStatus,
} from "#src/datasource/calcada/filter_library.js";
import { FilterPresetNameTakenError } from "#src/datasource/calcada/filter_presets.js";
import { useMenuDismissal } from "#src/datasource/calcada/react/use_menu_dismissal.js";
import { chooseTraceFilter } from "#src/datasource/calcada/trace_filter_choice.js";
import type { ZettaTraceState } from "#src/datasource/calcada/trace_state.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";

const STATUS_WORDS: Record<LibraryStatus, string> = {
  saved: "Saved",
  unsaved: "Unsaved",
  "text-error": "Text error",
  "fix-value": "Fix value",
};
const NEW_FILTER_NAME = "new filter";
const COPY_SUFFIX = " copy";
const DIRTY_MARK = "  •";
const NAME_TAKEN = "Another filter already has that name";

type Naming = { purpose: "rename" | "copy" | "new"; draft: string };
type Mode =
  | { kind: "normal" }
  | { kind: "delete" }
  | ({ kind: "name" } & Naming);

export interface FilterLibraryBarProps {
  library: FilterLibrary;
  state: ZettaTraceState;
  flash: (message: string) => void;
  saving: boolean;
  onSave: () => void;
}

function namingWhy(library: FilterLibrary, naming: Naming): string {
  const current = library.current ?? "";
  if (naming.purpose === "new") return "Name the new filter.";
  if (naming.purpose === "rename") return "";
  return library.isDirty(current)
    ? `Name the new filter. Your unsaved edits go into it; “${current}” stays as it was saved.`
    : `Name the copy of “${current}”.`;
}

export function FilterLibraryBar({
  library,
  state,
  flash,
  saving,
  onSave,
}: FilterLibraryBarProps) {
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "normal" });
  const [moreOpen, setMoreOpen] = useState(false);
  const moreAnchor = useRef<HTMLSpanElement>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  useMenuDismissal(moreOpen, moreAnchor, closeMore);
  const [nameError, setNameError] = useState("");
  const current = library.current;
  const tracePresetId = useWatchable(state.filterPresetId);
  const usedByTrace =
    current !== undefined && tracePresetId === library.presetId(current);

  const startNaming = (purpose: Naming["purpose"]) => {
    setMoreOpen(false);
    setNameError("");
    const draft =
      purpose === "rename"
        ? (current ?? "")
        : library.uniqueName(
            purpose === "copy" ? `${current}${COPY_SUFFIX}` : NEW_FILTER_NAME,
          );
    setMode({ kind: "name", purpose, draft });
  };

  const confirmName = async (naming: Naming) => {
    const name = naming.draft.trim();
    if (!name) return setNameError("The name can’t be empty");
    const taken = library.names.some(
      (other) =>
        other !== current && other.toLowerCase() === name.toLowerCase(),
    );
    if (taken || (naming.purpose !== "rename" && name === current)) {
      return setNameError(NAME_TAKEN);
    }
    setPending(true);
    try {
      if (naming.purpose === "rename") {
        if (name !== current) await library.rename(name);
      } else if (naming.purpose === "copy") {
        await library.saveAsNew(name);
      } else {
        await library.createNew(name);
      }
      setMode({ kind: "normal" });
    } catch (e) {
      setNameError(
        e instanceof FilterPresetNameTakenError ? NAME_TAKEN : String(e),
      );
    } finally {
      setPending(false);
    }
  };

  const confirmDelete = async () => {
    const gone = current;
    if (gone === undefined) return;
    setPending(true);
    try {
      await library.remove();
    } catch (e) {
      flash(`Delete failed: ${e}`);
      return;
    } finally {
      setPending(false);
    }
    if (usedByTrace) chooseTraceFilter(state, library, undefined);
    setMode({ kind: "normal" });
    flash(`Deleted “${gone}”.`);
  };

  if (mode.kind === "name") {
    const why = namingWhy(library, mode);
    return (
      <div className="calcada-filter-bar calcada-filter-rename">
        {why && <div className="calcada-filter-muted">{why}</div>}
        <label className="calcada-filter-muted" htmlFor="calcada-filter-name">
          Name
        </label>
        <input
          id="calcada-filter-name"
          className="calcada-filter-name-input"
          autoFocus
          value={mode.draft}
          onChange={(event) =>
            setMode({ ...mode, draft: event.currentTarget.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") void confirmName(mode);
            if (event.key === "Escape") setMode({ kind: "normal" });
          }}
        />
        <button
          type="button"
          className="calcada-filter-button primary"
          disabled={pending}
          onClick={() => void confirmName(mode)}
        >
          {mode.purpose === "rename" ? "Rename" : "Use this name"}
        </button>
        <button
          type="button"
          className="calcada-filter-button"
          onClick={() => setMode({ kind: "normal" })}
        >
          Cancel
        </button>
        {nameError && (
          <span className="calcada-filter-warning" role="alert">
            {nameError}
          </span>
        )}
      </div>
    );
  }

  const status = library.status;
  return (
    <>
      <div className="calcada-filter-bar">
        <select
          className="calcada-filter-library-select"
          aria-label="Filter to edit"
          title={current}
          disabled={library.names.length === 0}
          value={current ?? ""}
          onChange={(event) => library.select(event.currentTarget.value)}
        >
          {library.names.length === 0 && <option value="">No filters</option>}
          {library.names.map((name) => (
            <option key={name} value={name}>
              {name}
              {library.isDirty(name) ? DIRTY_MARK : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`calcada-filter-button${library.canSave() ? " primary" : ""}`}
          disabled={saving || !library.canSave()}
          title={
            library.textError
              ? "Fix the error in the text first"
              : "Save (Ctrl+S)"
          }
          onClick={onSave}
        >
          Save
        </button>
        <button
          type="button"
          className="calcada-filter-button"
          disabled={
            current === undefined ||
            !library.isDirty(current) ||
            library.textError !== undefined
          }
          onClick={() => library.revert()}
        >
          Revert
        </button>
        {current !== undefined && (
          <span
            className={`calcada-filter-status ${status === "saved" ? "clean" : "dirty"}`}
          >
            {STATUS_WORDS[status]}
          </span>
        )}
        <span className="calcada-filter-bar-right">
          <button
            type="button"
            className="calcada-filter-button"
            disabled={current === undefined}
            title="Save your edits as a new filter; this one stays as saved"
            onClick={() => startNaming("copy")}
          >
            Save as new…
          </button>
          <button
            type="button"
            className="calcada-filter-button"
            onClick={() => startNaming("new")}
          >
            + New
          </button>
          <span ref={moreAnchor} className="calcada-filter-menu-anchor">
            <button
              type="button"
              className="calcada-filter-button"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-label="More actions"
              title="Rename or delete"
              disabled={current === undefined}
              onClick={() => setMoreOpen(!moreOpen)}
            >
              ⋯
            </button>
            {moreOpen && (
              <div className="calcada-filter-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => startNaming("rename")}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    setMoreOpen(false);
                    setMode({ kind: "delete" });
                  }}
                >
                  Delete…
                </button>
              </div>
            )}
          </span>
        </span>
      </div>
      {mode.kind === "delete" && current !== undefined && (
        <div className="calcada-filter-confirm" role="alertdialog">
          <span>
            Delete “{current}”?
            {usedByTrace
              ? " The Trace tab uses it and will switch to no filter."
              : ""}
          </span>
          <button
            type="button"
            className="calcada-filter-button danger"
            disabled={pending}
            onClick={() => void confirmDelete()}
          >
            Delete
          </button>
          <button
            type="button"
            className="calcada-filter-button"
            onClick={() => setMode({ kind: "normal" })}
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
