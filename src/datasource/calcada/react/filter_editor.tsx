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
 * @file The filter editor column: the library bar over the filter as a tree
 * and as text, kept in sync both ways.
 */

import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type { FilterLibrary } from "#src/datasource/calcada/filter_library.js";
import { FilterConditions } from "#src/datasource/calcada/react/filter_conditions.js";
import { FilterLibraryBar } from "#src/datasource/calcada/react/filter_library_bar.js";
import { FilterText } from "#src/datasource/calcada/react/filter_text.js";
import { chooseTraceFilter } from "#src/datasource/calcada/trace_filter_choice.js";
import type { ZettaTraceState } from "#src/datasource/calcada/trace_state.js";
import { useSignalRerender } from "#src/editing/ui/interop/react/use_signal_rerender.js";
import { useWatchable } from "#src/editing/ui/interop/react/use_watchable.js";

const FLASH_MS = 2200;

export interface FilterEditorProps {
  library: FilterLibrary;
  state: ZettaTraceState;
}

function useFlash(): [string | undefined, (message: string) => void] {
  const [message, setMessage] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (next: string) => {
    setMessage(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(undefined), FLASH_MS);
  };
  return [message, show];
}

function TraceBadge({ library, state }: FilterEditorProps) {
  const tracePresetId = useWatchable(state.filterPresetId);
  const current = library.current;
  if (current === undefined) return null;
  if (tracePresetId !== library.presetId(current)) {
    return (
      <button
        type="button"
        className="calcada-filter-link"
        onClick={() => chooseTraceFilter(state, library, current)}
      >
        Use in Trace
      </button>
    );
  }
  return (
    <span className="calcada-filter-badge">
      {library.isDirty(current)
        ? "Trace uses the saved version"
        : "Used by Trace"}
    </span>
  );
}

export function FilterEditor({ library, state }: FilterEditorProps) {
  useSignalRerender(library.changed);
  const [flash, showFlash] = useFlash();
  const [saving, setSaving] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  // A number being typed or text waiting to be parsed is part of what the
  // user means to save: leaving the field commits it first.
  const commitFocused = () => {
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      sectionRef.current?.contains(focused)
    ) {
      focused.blur();
    }
  };

  const save = async () => {
    commitFocused();
    if (library.textError) {
      return showFlash("Fix the error in the text before saving");
    }
    const name = library.current;
    if (!library.canSave()) {
      if (name !== undefined) showFlash(`“${name}” is already saved`);
      return;
    }
    setSaving(true);
    try {
      await library.save();
      showFlash(`Saved “${name}”`);
    } catch (e) {
      showFlash(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const undo = () => {
    const label = library.undo();
    if (label) showFlash(`Undid ${label}`);
  };
  const redo = () => {
    const label = library.redo();
    if (label) showFlash(`Redid ${label}`);
  };

  // The text box keeps its own undo; everywhere else the keys act on the filter.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void save();
    } else if (key === "z" && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
  };

  return (
    <section
      ref={sectionRef}
      className="calcada-filter-editor"
      aria-label="Filter editor"
      onKeyDown={onKeyDown}
    >
      <div className="calcada-filter-editor-head">
        <span className="calcada-filter-editor-title">Filter editor</span>
        <TraceBadge library={library} state={state} />
        <span className="calcada-filter-push" />
        <button
          type="button"
          className="calcada-filter-button"
          disabled={!library.canUndo}
          title="Undo the last filter edit (Ctrl+Z)"
          onClick={undo}
        >
          ↶ Undo edit
        </button>
        <button
          type="button"
          className="calcada-filter-button"
          disabled={!library.canRedo}
          title="Redo (Ctrl+Shift+Z)"
          onClick={redo}
        >
          ↷ Redo edit
        </button>
        <button
          type="button"
          className="calcada-filter-close"
          aria-label="Close filter editor"
          title="Close"
          onClick={() => {
            state.filterEditor.visible = false;
          }}
        >
          ×
        </button>
      </div>
      {library.loadError !== undefined && (
        <div className="calcada-filter-stale" role="alert">
          Could not load your filters: {library.loadError}{" "}
          <button
            type="button"
            className="calcada-filter-button"
            onClick={() => void library.load().catch(() => {})}
          >
            Retry
          </button>
        </div>
      )}
      <FilterLibraryBar
        library={library}
        state={state}
        flash={showFlash}
        saving={saving}
        onSave={() => void save()}
      />
      <FilterConditions library={library} flash={showFlash} />
      <FilterText library={library} flash={showFlash} />
      {flash !== undefined && (
        <div className="calcada-filter-flash" role="status">
          {flash}
        </div>
      )}
    </section>
  );
}
