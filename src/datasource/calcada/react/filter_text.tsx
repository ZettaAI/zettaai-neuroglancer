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
 * @file The filter as text, parsed as you type. The user's own wording and
 * `#` comments are kept while they still say what the tree says.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  DEFAULT_PRINT_WIDTH,
  FilterParseError,
  highlightTokens,
  lineColumn,
  noteFor,
  parseFilterText,
  printFilter,
  reconcileIds,
  sameFilter,
} from "#src/datasource/calcada/candidate_filter_text.js";
import type { GroupNode } from "#src/datasource/calcada/candidate_filter_tree.js";
import type { FilterLibrary } from "#src/datasource/calcada/filter_library.js";

const PARSE_DEBOUNCE_MS = 220;
const TEXT_PADDING_PX = 26;
const MIN_MEASURED_WIDTH_PX = 200;
const FALLBACK_CHAR_WIDTH_PX = 7.5;

const HELP: ReadonlyArray<[string, string]> = [
  [
    "seed size > 20k   both( … )",
    "whose piece a condition is about: a prefix for one condition, or brackets for several. both checks the seed and the candidate each on its own; with “or” inside, they may pass through different options",
  ],
  [
    "a and b   a or b   not (a or b)",
    "ALL of, ANY of, NONE of; “and” binds tighter than “or”. For the seed and the candidate to pass through the same option, set the ANY group to “Each row picks” and give each option Both",
  ],
  [
    "size < 20k   size from 20k to 60k",
    "size in voxels; k = thousand, M = million; from … to includes both ends (“between 20k and 60k” and “in 20k..60k” also work)",
  ],
  [
    "axon >= 10%   dendrite > 80%",
    "percentages need the % sign; also perikaryon, nucleus; < <= > >= (or ≤ ≥)",
  ],
  [
    "no neighbors within 3 hops with ( … )",
    "counts neighbors within 3 hops that have everything inside ( … ); “is”, “are”, “has” also work",
  ],
  [
    "at least 2 neighbors within 1 hop with ( … )",
    "also at most N, exactly N; ( true ) counts every neighbor",
  ],
  [
    "in a part <= 40k attached by <= 2 edges",
    "the piece lies in a part of at most 40k vx that is joined to the rest of the piece graph by at most 2 edges. Catches spines and other small appendages",
  ],
  [
    "( … )   true",
    "a nested group; “true” on its own (or an empty box) means no conditions, so every match passes",
  ],
  [
    "# note",
    "a comment, kept with the filter while the conditions say the same thing. Changing a number, a measure, Seed / Candidate / Both or ALL ↔ ANY keeps it. Changes that restructure the text reprint it without the comment; a message says so and Undo brings it back",
  ],
];

let charWidth = 0;

/** How many monospace characters fit on a line of the text box. */
function columnsOf(textarea: HTMLTextAreaElement | null): number {
  if (textarea === null) return DEFAULT_PRINT_WIDTH;
  if (!charWidth) {
    const context = document.createElement("canvas").getContext("2d");
    if (context) {
      context.font = getComputedStyle(textarea).font;
      charWidth = context.measureText("0").width;
    }
    if (!charWidth) charWidth = FALLBACK_CHAR_WIDTH_PX;
  }
  const width = textarea.clientWidth - TEXT_PADDING_PX;
  return width > MIN_MEASURED_WIDTH_PX
    ? Math.floor(width / charWidth)
    : DEFAULT_PRINT_WIDTH;
}

function statusLine(
  library: FilterLibrary,
  text: string,
  printed: string,
): { ok: boolean; message: string } {
  const error = library.textError;
  if (error !== undefined) {
    const { line, column } = lineColumn(text, error.start);
    return {
      ok: false,
      message: `Line ${line}, column ${column}: ${error.message}`,
    };
  }
  if (library.status === "fix-value") {
    return {
      ok: false,
      message:
        "A number box above holds a value that isn't valid yet, so the text leaves it out.",
    };
  }
  return {
    ok: true,
    message:
      text !== printed && text.includes("#")
        ? "✓ In sync with the conditions. Your comments are kept; Format reprints the text without them."
        : "✓ Text and conditions are in sync",
  };
}

export function FilterText({
  library,
  flash,
}: {
  library: FilterLibrary;
  flash: (message: string) => void;
}) {
  const name = library.current;
  const tree = name === undefined ? undefined : library.tree(name);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [open, setOpen] = useState(true);
  const [columns, setColumns] = useState(DEFAULT_PRINT_WIDTH);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The tree this box last wrote; any other tree came from elsewhere and
  // replaces what was typed.
  const ownTree = useRef<GroupNode | undefined>(undefined);

  useEffect(() => {
    if (tree !== ownTree.current) setDraft(undefined);
  }, [tree]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const measure = () => setColumns(columnsOf(textarea));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);

  const printed =
    tree === undefined || tree.children.length === 0
      ? ""
      : printFilter(tree, columns);
  const text =
    draft ??
    library.textDraft ??
    (tree === undefined ? "" : (noteFor(tree) ?? printed));

  const apply = (value: string) => {
    clearTimeout(timer.current);
    // Read now, not when the key was pressed: the tree may have moved since.
    const tree = name === undefined ? undefined : library.tree(name);
    if (tree === undefined) return;
    let root: GroupNode;
    try {
      root = parseFilterText(value);
    } catch (e) {
      if (!(e instanceof FilterParseError)) throw e;
      library.setTextError(e, value);
      return;
    }
    library.setTextError(undefined);
    const reprinted =
      root.children.length === 0 ? "" : printFilter(root, columns);
    // Kept only when it carries comments; pure re-formatting is not worth saving.
    const note = value !== reprinted && value.includes("#") ? value : undefined;
    if (!sameFilter(root, tree)) {
      reconcileIds(tree, root);
      if (note !== undefined) root.note = note;
      library.edit(() => root, "text edit");
    } else if (tree.note !== note) {
      library.setNote(note);
    } else {
      return;
    }
    ownTree.current = library.tree(name!);
  };

  const format = () => {
    setDraft(undefined);
    library.setTextError(undefined);
    if (tree?.note !== undefined) library.setNote(undefined);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    flash("Copied");
  };

  // Tall enough for its wrapped lines too: the highlighted copy under it
  // cannot scroll with it.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`;
  }, [text, columns]);

  const error = library.textError;
  const status = statusLine(library, text, printed);
  const lines = text.split("\n").length;

  return (
    <div className="calcada-filter-section calcada-filter-text">
      <div className="calcada-filter-section-head">
        <button
          type="button"
          className="calcada-filter-icon calcada-filter-toggle"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} text`}
          onClick={() => setOpen(!open)}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="calcada-filter-section-title">Text</span>
        <span className="calcada-filter-push" />
        <button
          type="button"
          className="calcada-filter-link"
          disabled={tree === undefined}
          onClick={format}
        >
          Format
        </button>
        <button
          type="button"
          className="calcada-filter-link"
          disabled={tree === undefined}
          onClick={() => void copy()}
        >
          Copy
        </button>
        <button
          type="button"
          className="calcada-filter-link"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen(!helpOpen)}
        >
          {helpOpen ? "Hide syntax" : "Syntax"}
        </button>
      </div>
      <div className="calcada-filter-text-body" hidden={!open}>
        {helpOpen && (
          <div className="calcada-filter-help">
            <div>
              <b>Terms</b> · The <i>seed</i> and the <i>candidate</i> are the
              two pieces of a match, as the Trace tab shows them. <i>Size</i> is
              a piece’s size in voxels. <i>Neighbors</i> are pieces that touch
              it in the piece graph; a <i>hop</i> is one step to a touching
              piece; an <i>edge</i> is one touching pair. A <i>part</i> is a
              connected set of pieces that contains this piece.
            </div>
            {HELP.map(([code, meaning]) => (
              <div key={code}>
                <code>{code}</code>
                <span>{meaning}</span>
              </div>
            ))}
          </div>
        )}
        <div className={`calcada-filter-code${error ? " error" : ""}`}>
          <pre aria-hidden="true">
            {highlightTokens(text, error).map((run, index) => (
              <span
                key={index}
                className={`calcada-filter-token ${run.cls}${run.error ? " error" : ""}`}
              >
                {run.text}
              </span>
            ))}
            {text.endsWith("\n") || text === "" ? " " : ""}
          </pre>
          <textarea
            ref={textareaRef}
            spellCheck={false}
            autoComplete="off"
            aria-label="Filter as text"
            rows={Math.max(1, lines)}
            disabled={tree === undefined}
            placeholder={
              tree === undefined
                ? "No filter selected"
                : "No conditions yet, so every match passes. Type one, like: both size > 20k"
            }
            value={text}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft(value);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => apply(value), PARSE_DEBOUNCE_MS);
            }}
            onBlur={() => {
              if (draft !== undefined) apply(draft);
            }}
          />
        </div>
        <div
          className={`calcada-filter-parse${status.ok ? " ok" : " bad"}`}
          role="status"
        >
          {tree === undefined ? "" : status.message}
        </div>
      </div>
    </div>
  );
}
