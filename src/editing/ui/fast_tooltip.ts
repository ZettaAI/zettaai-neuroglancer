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
 * Shared, fast-appearing hover tooltip for the edit-session UI.
 *
 * Rather than wiring a component per call site, this installs a single
 * delegated listener on the document: any element carrying a `data-tooltip`
 * attribute gets a hint bubble after a short {@link SHOW_DELAY_MS} delay —
 * much snappier than the OS-controlled native `title` delay (~0.5–1.5s).
 *
 * The bubble is `position: fixed` and lives on `<body>`, so it escapes the
 * `overflow: hidden` clipping contexts of the entry modal and tool panels (a
 * pure-CSS `::after` tooltip cannot). Call {@link installFastTooltips} once
 * during edit-UI bootstrap; it is idempotent.
 *
 * An element may also carry `data-shortcut`, a space-separated list of event
 * identifiers (see `key_chord_format.ts`). The tooltip's first line then becomes
 * a title with the key caps beside it and any further lines become its detail.
 */

import "#src/editing/ui/fast_tooltip.css";

import { makeKeyChips } from "#src/ui/key_chips.js";
import { preferredChord } from "#src/ui/key_chord_format.js";

const SHOW_DELAY_MS = 150;
/** Moving along a row of buttons within this time shows the next hint at once. */
const SKIP_DELAY_WINDOW_MS = 400;
/** Minimum gap kept between the bubble and the viewport edges. */
const VIEWPORT_MARGIN = 6;
/** Gap between the anchor element and the bubble. */
const ANCHOR_GAP = 6;

let installed = false;
let bubble: HTMLDivElement | null = null;
/** Element the bubble is currently anchored to (or scheduled to show for). */
let anchor: Element | null = null;
let showTimer = 0;
let lastHiddenAt = Number.NEGATIVE_INFINITY;

function getBubble(): HTMLDivElement {
  if (bubble === null) {
    bubble = document.createElement("div");
    bubble.className = "neuroglancer-fast-tooltip";
    bubble.setAttribute("role", "tooltip");
    document.body.appendChild(bubble);
  }
  return bubble;
}

function fillBubble(
  el: HTMLDivElement,
  text: string,
  shortcut: string | null,
  pairShortcut: string | null,
): void {
  const chord =
    shortcut === null ? undefined : preferredChord(shortcut.split(" "));
  if (chord === undefined) {
    el.textContent = text;
    return;
  }
  const pairChord =
    pairShortcut === null ? undefined : preferredChord(pairShortcut.split(" "));
  const [title, ...details] = text.split("\n");
  const titleRow = document.createElement("div");
  titleRow.className = "neuroglancer-fast-tooltip-title";
  const keys = document.createElement("span");
  keys.className = "neuroglancer-key-chips";
  keys.append(makeKeyChips(chord));
  if (pairChord !== undefined) keys.append(" / ", makeKeyChips(pairChord));
  titleRow.append(title, keys);
  el.replaceChildren(titleRow);
  if (details.length > 0) {
    const detail = document.createElement("div");
    detail.className = "neuroglancer-fast-tooltip-detail";
    detail.textContent = details.join("\n");
    el.appendChild(detail);
  }
}

/** Position the bubble below `target` (flipping above if it would overflow). */
function place(target: Element, text: string): void {
  const el = getBubble();
  fillBubble(
    el,
    text,
    target.getAttribute("data-shortcut"),
    target.getAttribute("data-shortcut-pair"),
  );
  el.classList.add("visible");

  const tip = el.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  let left = r.left + r.width / 2 - tip.width / 2;
  left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(left, vw - tip.width - VIEWPORT_MARGIN),
  );

  let top = r.bottom + ANCHOR_GAP;
  const overflowsBottom = top + tip.height > vh - VIEWPORT_MARGIN;
  const fitsAbove = r.top - ANCHOR_GAP - tip.height >= VIEWPORT_MARGIN;
  if (overflowsBottom && fitsAbove) {
    top = r.top - ANCHOR_GAP - tip.height;
  }

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function clearTimer(): void {
  if (showTimer !== 0) {
    clearTimeout(showTimer);
    showTimer = 0;
  }
}

function hide(): void {
  clearTimer();
  anchor = null;
  if (bubble !== null && bubble.classList.contains("visible")) {
    bubble.classList.remove("visible");
    lastHiddenAt = performance.now();
  }
}

function scheduleShow(target: Element): void {
  const text = target.getAttribute("data-tooltip");
  if (text === null || text === "") return;
  anchor = target;
  clearTimer();
  if (performance.now() - lastHiddenAt < SKIP_DELAY_WINDOW_MS) {
    place(target, text);
    return;
  }
  showTimer = window.setTimeout(() => {
    showTimer = 0;
    // The anchor may have changed or detached during the delay.
    if (anchor === target && target.isConnected) place(target, text);
  }, SHOW_DELAY_MS);
}

function nearestTooltip(node: EventTarget | null): Element | null {
  return node instanceof Element ? node.closest("[data-tooltip]") : null;
}

function onPointerOver(e: PointerEvent): void {
  const target = nearestTooltip(e.target);
  if (target === null || target === anchor) return;
  scheduleShow(target);
}

function onPointerOut(e: PointerEvent): void {
  if (anchor === null) return;
  // Ignore moves that stay within the anchored element (onto its children).
  const related = e.relatedTarget as Node | null;
  if (related !== null && anchor.contains(related)) return;
  hide();
}

function onFocusIn(e: FocusEvent): void {
  const target = nearestTooltip(e.target);
  if (target !== null) scheduleShow(target);
}

function onKeyDown(e: KeyboardEvent): void {
  // Closes the hint without moving the pointer. The key still reaches the
  // viewer: the hint is not modal, so Esc keeps its usual meaning there too.
  if (e.key === "Escape") hide();
}

/**
 * Install the delegated tooltip listeners. Idempotent — safe to call from
 * multiple bootstrap paths.
 */
export function installFastTooltips(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", hide, true);
  // A click, scroll, resize, or window blur all invalidate the anchored
  // position — cheapest to just dismiss.
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", hide);
  window.addEventListener("blur", hide);
}
