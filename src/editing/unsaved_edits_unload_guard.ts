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
 * @file The viewer's `beforeunload` guard against losing unsaved edits on a
 * reload, a tab close or the WebGL-restore reload.
 */

export const UNSAVED_EDITS_UNLOAD_MESSAGE =
  "You have edits that are not confirmed saved. They may be lost if you leave.";

/**
 * Warn on reload/close while `host` has unsaved edits: unsaved strokes in the
 * open session, in-memory committed patches, or saves not yet confirmed
 * durable (see `EditSessionHost.hasUnsavedEdits`). Modern browsers ignore the
 * custom message and show their own generic prompt; `preventDefault` and
 * setting `returnValue` are what trigger it. Returns the disposer.
 */
export function installUnsavedEditsUnloadGuard(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  host: { hasUnsavedEdits(): boolean },
): () => void {
  const handler = (event: Event) => {
    if (!host.hasUnsavedEdits()) return;
    const beforeUnload = event as BeforeUnloadEvent;
    beforeUnload.preventDefault();
    beforeUnload.returnValue = UNSAVED_EDITS_UNLOAD_MESSAGE;
  };
  target.addEventListener("beforeunload", handler);
  return () => target.removeEventListener("beforeunload", handler);
}
