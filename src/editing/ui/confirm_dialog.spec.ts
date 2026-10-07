/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Where focus lands when a confirm dialog opens.
 *
 * The save-conflict dialog renders no Cancel, so every control in it is a real
 * answer and one of them discards the user's painting. Giving any of them focus
 * makes Enter an answer the user never chose — and the dialog they see most
 * often is the one raised by chunks whose baseline could not be checked, where
 * the likeliest truth is that nobody touched them at all.
 *
 * Written with `h` rather than JSX so it stays a `.spec.ts` in the node/jsdom
 * project (the workspace globs `*.spec.ts` only).
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { ConfirmDialog } from "#src/editing/ui/confirm_dialog.js";

let container: HTMLDivElement | undefined;

afterEach(() => {
  if (container !== undefined) {
    render(null, container);
    container.remove();
    container = undefined;
  }
});

function openDialog(props: Record<string, unknown>): void {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    render(
      h(ConfirmDialog, {
        open: true,
        title: "Someone else edited this region",
        message: "…",
        confirmLabel: "Take theirs",
        onConfirm: () => {},
        onCancel: () => {},
        ...props,
      }),
      container!,
    );
  });
}

describe("ConfirmDialog focus", () => {
  it("focuses no answer when there is no Cancel to fall back on", () => {
    openDialog({
      hideCancelButton: true,
      secondaryActions: [
        { label: "Take mine", destructive: true, onClick: () => {} },
      ],
    });

    expect(document.activeElement?.tagName).not.toBe("BUTTON");
  });

  /**
   * Focus still has to leave the page behind, or the modal is not a modal:
   * Escape and the focus trap both need it inside the dialog.
   */
  it("still moves focus into the dialog", () => {
    openDialog({ hideCancelButton: true });

    const dialog = document.querySelector(".neuroglancer-confirm-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);
  });
});
