/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest";

import {
  installUnsavedEditsUnloadGuard,
  UNSAVED_EDITS_UNLOAD_MESSAGE,
} from "#src/editing/unsaved_edits_unload_guard.js";

function install(hasUnsavedEdits: () => boolean) {
  const target = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const dispose = installUnsavedEditsUnloadGuard(target, { hasUnsavedEdits });
  expect(target.addEventListener).toHaveBeenCalledTimes(1);
  const [type, handler] = target.addEventListener.mock.calls[0];
  expect(type).toBe("beforeunload");
  const fireBeforeUnload = () => {
    const event = { preventDefault: vi.fn(), returnValue: "" };
    handler(event);
    return event;
  };
  return { target, handler, dispose, fireBeforeUnload };
}

describe("installUnsavedEditsUnloadGuard", () => {
  it("asks before unloading while there are unsaved edits", () => {
    const { fireBeforeUnload } = install(() => true);

    const event = fireBeforeUnload();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toBe(UNSAVED_EDITS_UNLOAD_MESSAGE);
  });

  it("lets the page unload when everything is saved", () => {
    const { fireBeforeUnload } = install(() => false);

    const event = fireBeforeUnload();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.returnValue).toBe("");
  });

  it("checks for unsaved edits at unload time, not at install time", () => {
    let unsaved = false;
    const { fireBeforeUnload } = install(() => unsaved);

    unsaved = true;

    expect(fireBeforeUnload().preventDefault).toHaveBeenCalledTimes(1);
  });

  it("removes the same handler when disposed", () => {
    const { target, handler, dispose } = install(() => true);

    dispose();

    expect(target.removeEventListener).toHaveBeenCalledWith(
      "beforeunload",
      handler,
    );
  });
});
