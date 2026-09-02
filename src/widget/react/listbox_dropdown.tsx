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

import { Check, ChevronDown } from "lucide-react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "#src/editing/ui/editing_theme.css";
import "#src/widget/listbox_dropdown.css";

interface PanelRect {
  width: number;
  /** Cap on the panel's own width; labels ellipsize past this. */
  maxWidth: number;
  /** Cap on the panel's own height; it scrolls internally past this. */
  maxHeight: number;
  /** Set when the panel grows rightward (anchored to the trigger's left edge). */
  left?: number;
  /** Set when the panel grows leftward (anchored to the trigger's right edge). */
  right?: number;
  /** Set when the panel opens downward (anchored below the trigger). */
  top?: number;
  /** Set when the panel flips upward (anchored above the trigger). */
  bottom?: number;
}

export interface ListboxOption {
  readonly key: string;
  readonly label: string;
  /** Shown but not selectable — skipped by keyboard navigation and by commit. */
  readonly disabled?: boolean;
}

function matchesQuery(option: ListboxOption, query: string): boolean {
  return option.label.toLowerCase().includes(query.toLowerCase());
}

/**
 * Nearest index at or after `from` (walking by `step`) whose option is
 * selectable, or -1 when the walk runs off the end without finding one.
 */
function enabledIndexFrom(
  options: readonly ListboxOption[],
  from: number,
  step: number,
): number {
  for (let index = from; index >= 0 && index < options.length; index += step) {
    if (options[index].disabled !== true) return index;
  }
  return -1;
}

function firstEnabledIndex(options: readonly ListboxOption[]): number {
  return Math.max(0, enabledIndexFrom(options, 0, 1));
}

/**
 * Single-select dropdown rendered as a real ARIA listbox: a trigger button
 * showing the current label + chevron, and a portaled popup of options.
 *
 * Keyboard model (the whole point of not using a native control here): Arrow
 * Up/Down, Home and End move a roving highlight *without* committing — the
 * panel stays open so the user can browse — and only Enter / Space / click
 * commit. Escape closes. Focus moves into the panel on open (onto the current
 * selection) and is handed back to the trigger before the panel unmounts on
 * close, so it never escapes a surrounding modal.
 *
 * With `filterable`, the panel instead opens with focus in a search box that
 * narrows the list by substring; the arrow keys still drive the listbox cursor
 * from there, so typing and browsing don't need a focus change.
 */
export function ListboxDropdown({
  options,
  value,
  onChange,
  onOpen,
  disabled,
  filterable,
  ariaLabel,
}: {
  options: readonly ListboxOption[];
  value: string | undefined;
  onChange: (key: string) => void;
  onOpen?: () => void;
  disabled?: boolean;
  filterable?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<PanelRect | undefined>(undefined);
  const [query, setQuery] = useState("");
  // The keyboard-highlighted ("active") option — the listbox cursor. It moves
  // with the arrow keys independently of the committed selection.
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  // The panel is portaled out of its container so it escapes any `overflow`
  // clipping; `position: fixed` then anchors it to the trigger. Recompute on
  // open and whenever the trigger moves (the host panel scrolls, window resize).
  //
  // A long option list is capped to the space actually available in the
  // viewport and scrolls internally; when the trigger sits low and the list
  // won't fit below, the panel flips to open above it — so it can never run
  // off-screen regardless of where the trigger lands.
  //
  // Width gets the same treatment: the panel is content-sized past the
  // trigger's width, so a long label would otherwise push it off the right
  // viewport edge (the trigger typically sits in the right side panel) and
  // get hard-clipped. The panel is anchored to whichever trigger edge has
  // more viewport space to grow into and capped to that space, so the label
  // ellipsis engages instead. While the content fits the trigger's width the
  // two anchorings are pixel-identical (min-width is the trigger width), so
  // anchoring right never moves a short panel.
  const updateRect = useCallback(() => {
    const node = wrapperRef.current;
    if (node === null) return;
    const triggerRect = node.getBoundingClientRect();
    const triggerGap = 2;
    const viewportMargin = 8;
    const preferredMaxHeight = 320;
    const minHeight = 120;
    const preferredMaxWidth = 480;
    const spaceBelow =
      window.innerHeight - triggerRect.bottom - triggerGap - viewportMargin;
    const spaceAbove = triggerRect.top - triggerGap - viewportMargin;
    // Prefer opening downward; flip up only when the list won't fit below and
    // there is more room above.
    const openUpward =
      spaceBelow < preferredMaxHeight && spaceAbove > spaceBelow;
    const availableHeight = openUpward ? spaceAbove : spaceBelow;
    const maxHeight = Math.min(
      preferredMaxHeight,
      Math.max(minHeight, availableHeight),
    );
    const spaceRightward =
      window.innerWidth - triggerRect.left - viewportMargin;
    const spaceLeftward = triggerRect.right - viewportMargin;
    const anchorRight = spaceLeftward > spaceRightward;
    const maxWidth = Math.min(
      preferredMaxWidth,
      Math.max(triggerRect.width, anchorRight ? spaceLeftward : spaceRightward),
    );
    setRect({
      width: triggerRect.width,
      maxWidth,
      maxHeight,
      left: anchorRight ? undefined : triggerRect.left,
      right: anchorRight ? window.innerWidth - triggerRect.right : undefined,
      top: openUpward ? undefined : triggerRect.bottom + triggerGap,
      bottom: openUpward
        ? window.innerHeight - triggerRect.top + triggerGap
        : undefined,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateRect();

    const onDocPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = wrapperRef.current?.contains(target) ?? false;
      const inPanel = panelRef.current?.contains(target) ?? false;
      if (!inTrigger && !inPanel) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Capture phase catches scrolls on the host body (scroll doesn't bubble).
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, updateRect]);

  const visibleOptions =
    filterable === true && query !== ""
      ? options.filter((option) => matchesQuery(option, query))
      : options;
  // `options` can shrink under an open panel (a branch list refreshes), so the
  // stored cursor is clamped at read time rather than trusted.
  const cursorIndex = Math.min(activeIndex, visibleOptions.length - 1);

  // While filtering, focus belongs to the search box and the cursor is a class
  // rather than real DOM focus; otherwise move real focus to the active option
  // whenever it changes (and once the panel has been measured + mounted). Real
  // focus — rather than aria-activedescendant — keeps the roving-tabindex
  // listbox simple.
  useEffect(() => {
    if (!open || rect === undefined) return;
    if (filterable === true) {
      searchRef.current?.focus();
      optionRefs.current[cursorIndex]?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    optionRefs.current[cursorIndex]?.focus();
  }, [open, rect, cursorIndex, filterable]);

  if (options.length === 0) return null;

  const currentIndex = options.findIndex((option) => option.key === value);
  const current = currentIndex >= 0 ? options[currentIndex] : options[0];
  const summary = current?.label ?? "";

  const commit = (option: ListboxOption | undefined) => {
    if (option === undefined || option.disabled === true) return;
    onChange(option.key);
    setOpen(false);
    // Hand focus back to the trigger *before* the panel unmounts, so the
    // removed option can't drop focus to the global document — keeping
    // keyboard focus inside any surrounding modal.
    triggerRef.current?.focus();
  };

  const toggle = () => {
    if (!open) {
      setQuery("");
      // Open the cursor on the current selection (else the first selectable
      // option).
      setActiveIndex(
        currentIndex >= 0 && options[currentIndex].disabled !== true
          ? currentIndex
          : firstEnabledIndex(options),
      );
      onOpen?.();
    }
    setOpen((wasOpen) => !wasOpen);
  };

  const moveCursor = (step: number) => {
    const next = enabledIndexFrom(visibleOptions, cursorIndex + step, step);
    if (next >= 0) setActiveIndex(next);
  };

  /** Keys the search box and the option list both act on. */
  const handleCursorKey = (e: ReactKeyboardEvent): boolean => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveCursor(1);
        return true;
      case "ArrowUp":
        e.preventDefault();
        moveCursor(-1);
        return true;
      case "Enter":
        e.preventDefault();
        commit(visibleOptions[cursorIndex]);
        return true;
    }
    return false;
  };

  const onPanelKeyDown = (e: ReactKeyboardEvent) => {
    if (handleCursorKey(e)) return;
    switch (e.key) {
      case "Home":
        e.preventDefault();
        setActiveIndex(firstEnabledIndex(visibleOptions));
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(
          Math.max(
            0,
            enabledIndexFrom(visibleOptions, visibleOptions.length - 1, -1),
          ),
        );
        break;
      case " ":
        e.preventDefault();
        commit(visibleOptions[cursorIndex]);
        break;
    }
  };

  const onSearchInput = (e: ChangeEvent<HTMLInputElement>) => {
    const nextQuery = e.currentTarget.value;
    setQuery(nextQuery);
    const nextVisible =
      nextQuery === ""
        ? options
        : options.filter((option) => matchesQuery(option, nextQuery));
    setActiveIndex(firstEnabledIndex(nextVisible));
  };

  const optionRows = visibleOptions.map((option, index) => {
    const isSelected = option.key === value;
    const isDisabled = option.disabled === true;
    const classes = ["neuroglancer-listbox-dropdown-option"];
    if (isDisabled)
      classes.push("neuroglancer-listbox-dropdown-option-disabled");
    if (filterable === true && index === cursorIndex) {
      classes.push("neuroglancer-listbox-dropdown-option-active");
    }
    return (
      <div
        key={option.key}
        ref={(el) => {
          optionRefs.current[index] = el;
        }}
        className={classes.join(" ")}
        role="option"
        aria-selected={isSelected}
        aria-disabled={isDisabled}
        // Roving tabindex: only the active option is in the tab order; arrow
        // keys move focus between options without leaving the listbox.
        tabIndex={index === cursorIndex ? 0 : -1}
        onClick={() => commit(option)}
        onMouseEnter={() => {
          if (!isDisabled) setActiveIndex(index);
        }}
      >
        <span className="neuroglancer-listbox-dropdown-check">
          {isSelected && <Check size={14} aria-hidden="true" />}
        </span>
        <span
          className="neuroglancer-listbox-dropdown-option-label"
          title={option.label}
        >
          {option.label}
        </span>
      </div>
    );
  });

  return (
    <span ref={wrapperRef} className="neuroglancer-listbox-dropdown">
      <button
        ref={triggerRef}
        type="button"
        className="neuroglancer-listbox-dropdown-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={summary}
        onClick={toggle}
      >
        <span className="neuroglancer-listbox-dropdown-summary">{summary}</span>
        <ChevronDown
          className="neuroglancer-listbox-dropdown-caret"
          size={16}
          aria-hidden="true"
        />
      </button>
      {open &&
        rect !== undefined &&
        createPortal(
          <div
            ref={panelRef}
            className="neuroglancer-listbox-dropdown-panel"
            role={filterable === true ? undefined : "listbox"}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            style={{
              minWidth: `${rect.width}px`,
              maxWidth: `${rect.maxWidth}px`,
              maxHeight: `${rect.maxHeight}px`,
              ...(rect.left !== undefined && { left: `${rect.left}px` }),
              ...(rect.right !== undefined && { right: `${rect.right}px` }),
              ...(rect.top !== undefined && { top: `${rect.top}px` }),
              ...(rect.bottom !== undefined && { bottom: `${rect.bottom}px` }),
            }}
            // The panel may be portaled into a modal backdrop whose onClick
            // closes the modal. Stop clicks here so picking an option doesn't
            // bubble out and dismiss the whole dialog.
            onClick={(e) => e.stopPropagation()}
          >
            {filterable === true ? (
              <>
                <input
                  ref={searchRef}
                  type="text"
                  className="neuroglancer-listbox-dropdown-search"
                  placeholder="Search…"
                  aria-label={
                    ariaLabel === undefined ? "Search" : `Search ${ariaLabel}`
                  }
                  value={query}
                  onChange={onSearchInput}
                  // The search box owns every key it sees; the cursor keys are
                  // forwarded to the listbox by hand so browsing works without
                  // leaving the field, and the rest (Space, Home/End) must
                  // reach the input as plain text editing.
                  onKeyDown={(e) => {
                    handleCursorKey(e);
                    e.stopPropagation();
                  }}
                />
                <div role="listbox" aria-label={ariaLabel}>
                  {optionRows}
                </div>
              </>
            ) : (
              optionRows
            )}
          </div>,
          // Portal into the edit-session modal backdrop when there is one (a
          // transform-free `position: fixed` ancestor with no overflow clip) so
          // the panel keeps the modal's CSS-variable tokens and font context.
          // Falls back to <body> for any non-modal usage.
          wrapperRef.current?.closest<HTMLElement>(
            ".neuroglancer-edit-session-entry-modal-backdrop",
          ) ?? document.body,
        )}
    </span>
  );
}
