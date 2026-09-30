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
 * The topbar Exit-session button is the only NG UI path that ends an edit
 * session, so it is where the embedding host's exit lock has to hold: disabled
 * with the lock's reason as a tooltip a tracer can actually hover, deaf to a
 * click that races the lock, and unable to discard from a confirmation that was
 * already open when the lock engaged. Standalone behaviour (no lock) must stay
 * exactly as it was, including the saving gate, and the lock must never stop
 * the idle "Edit" button from opening the entry modal.
 *
 * Written with `h` rather than JSX so it stays a `.spec.ts` in the node/jsdom
 * project (the workspace globs `*.spec.ts` only). The host is a fake exposing
 * only what the component reads.
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { TopbarEditButton } from "#src/editing/ui/topbar/topbar_edit_button.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Signal } from "#src/util/signal.js";

// The real entry modal needs a live layer manager and metadata source. What is
// under test is only whether the topbar opens it.
vi.mock("#src/editing/ui/session_entry/session_entry.js", async () => {
  const { h: createElement } = await import("preact");
  return {
    SessionEntryModal: ({ open }: { open: boolean }) =>
      open ? createElement("div", { class: "fake-session-entry-modal" }) : null,
  };
});

const LOCK_REASON = "Complete the task to leave the edit session.";

interface FakeHost {
  readonly activeSession: WatchableValue<unknown>;
  readonly saveInProgress: WatchableValue<boolean>;
  readonly exitLockReason: WatchableValue<string | undefined>;
  readonly requestSessionEntry: Signal<(key?: string) => void>;
  readonly discardActive: ReturnType<typeof vi.fn>;
  hasUnsavedEdits(): boolean;
}

/** A session whose live strokes are dirty or not. */
interface FakeSession {
  readonly dirty: { isDirty(): boolean };
}

function createFakeHost(): FakeHost {
  const activeSession = new WatchableValue<unknown>(undefined);
  return {
    activeSession,
    saveInProgress: new WatchableValue(false),
    exitLockReason: new WatchableValue<string | undefined>(undefined),
    requestSessionEntry: new Signal<(key?: string) => void>(),
    discardActive: vi.fn(async () => {}),
    // Only live strokes: the committed and unconfirmed parts of the real
    // predicate are covered in `edit_session_host.spec.ts`.
    hasUnsavedEdits: () =>
      (activeSession.value as FakeSession | undefined)?.dirty.isDirty() ===
      true,
  };
}

function fakeSession(isDirty: boolean): FakeSession {
  return { dirty: { isDirty: () => isDirty } };
}

let container: HTMLDivElement | undefined;

afterEach(() => {
  if (container !== undefined) {
    act(() => render(null, container!));
    container.remove();
    container = undefined;
  }
});

function mount(host: FakeHost) {
  const element = document.createElement("div");
  container = element;
  document.body.appendChild(element);
  act(() =>
    render(
      h(TopbarEditButton, { host: host as unknown as EditSessionHost }),
      element,
    ),
  );
  const wrapper = element.querySelector<HTMLSpanElement>(
    ".neuroglancer-editing-topbar-edit-button-wrap",
  );
  const button = element.querySelector<HTMLButtonElement>(
    ".neuroglancer-editing-topbar-edit-button",
  );
  expect(wrapper).not.toBeNull();
  expect(button).not.toBeNull();
  return { wrapper: wrapper!, button: button! };
}

function confirmDialog(): HTMLElement | null {
  return document.body.querySelector(".neuroglancer-confirm-dialog");
}

function discardAndExitButton(): HTMLButtonElement {
  const confirm = document.body.querySelector<HTMLButtonElement>(
    ".neuroglancer-confirm-dialog-btn-primary",
  );
  expect(confirm?.textContent).toBe("Discard and exit");
  return confirm!;
}

describe("TopbarEditButton without an exit lock", () => {
  it("exits a clean session on click", () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(false);
    const { wrapper, button } = mount(host);

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Exit session");
    expect(wrapper.getAttribute("data-tooltip")).toBe("Exit edit session");

    act(() => button.click());

    expect(host.discardActive).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding unsaved work, then discards on confirm", () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(true);
    const { button } = mount(host);

    act(() => button.click());
    expect(confirmDialog()).not.toBeNull();
    expect(host.discardActive).not.toHaveBeenCalled();

    act(() => discardAndExitButton().click());

    expect(confirmDialog()).toBeNull();
    expect(host.discardActive).toHaveBeenCalledTimes(1);
  });

  it("disables Exit with the saving reason while a save is in flight", () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(false);
    const { wrapper, button } = mount(host);

    act(() => {
      host.saveInProgress.value = true;
    });

    expect(button.disabled).toBe(true);
    expect(wrapper.getAttribute("data-tooltip")).toBe(
      "Can't exit while saving…",
    );

    act(() => {
      host.saveInProgress.value = false;
    });

    expect(button.disabled).toBe(false);
    expect(wrapper.getAttribute("data-tooltip")).toBe("Exit edit session");
  });

  it("does not discard from a confirmation that a save started under", () => {
    // The portal saves for Complete Task / Reset View from outside the iframe,
    // so a save can begin while the confirmation is already open.
    const host = createFakeHost();
    host.activeSession.value = fakeSession(true);
    const { button } = mount(host);
    act(() => button.click());

    act(() => {
      host.saveInProgress.value = true;
    });
    act(() => discardAndExitButton().click());

    expect(confirmDialog()).toBeNull();
    expect(host.discardActive).not.toHaveBeenCalled();
  });

  it("keeps the idle Edit button opening the entry modal", () => {
    const host = createFakeHost();
    const { wrapper, button } = mount(host);

    expect(button.textContent).toBe("Edit");
    expect(wrapper.getAttribute("data-tooltip")).toBe(
      "Open the edit-session entry modal",
    );

    act(() => button.click());

    expect(
      container!.querySelector(".fake-session-entry-modal"),
    ).not.toBeNull();
  });
});

describe("TopbarEditButton with an exit lock", () => {
  it("disables Exit in place and puts the lock reason on the wrapper", () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(false);
    const { wrapper, button } = mount(host);

    act(() => {
      host.exitLockReason.value = LOCK_REASON;
    });

    expect(button.disabled).toBe(true);
    // Same label and the button is still the wrapper's (and so the topbar's
    // first) child: locking must not move or relabel the anchor.
    expect(button.textContent).toBe("Exit session");
    expect(wrapper.firstElementChild).toBe(button);
    expect(container!.firstElementChild).toBe(wrapper);
    expect(wrapper.getAttribute("data-tooltip")).toBe(LOCK_REASON);
  });

  it("shows the lock reason rather than the saving reason when both apply", () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(false);
    host.saveInProgress.value = true;
    host.exitLockReason.value = LOCK_REASON;
    const { wrapper, button } = mount(host);

    expect(button.disabled).toBe(true);
    expect(wrapper.getAttribute("data-tooltip")).toBe(LOCK_REASON);

    act(() => {
      host.saveInProgress.value = false;
    });

    expect(button.disabled).toBe(true);
    expect(wrapper.getAttribute("data-tooltip")).toBe(LOCK_REASON);
  });

  it("ignores a click that races the lock before the button re-renders", async () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(false);
    const { button } = mount(host);

    // Outside `act`, the re-render is still queued: the button is enabled on
    // screen, so the click reaches the handler, which must re-read the lock.
    host.exitLockReason.value = LOCK_REASON;
    expect(button.disabled).toBe(false);
    button.click();
    await act(async () => {});

    expect(host.discardActive).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
  });

  it("does not open the confirmation for unsaved work while locked", async () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(true);
    const { button } = mount(host);

    host.exitLockReason.value = LOCK_REASON;
    button.click();
    await act(async () => {});

    expect(confirmDialog()).toBeNull();
    expect(host.discardActive).not.toHaveBeenCalled();
  });

  it("closes an open confirmation when the lock engages", () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(true);
    const { button } = mount(host);
    act(() => button.click());
    expect(confirmDialog()).not.toBeNull();

    act(() => {
      host.exitLockReason.value = LOCK_REASON;
    });

    expect(confirmDialog()).toBeNull();
    expect(host.discardActive).not.toHaveBeenCalled();

    // Unlocking does not bring the confirmation back.
    act(() => {
      host.exitLockReason.value = undefined;
    });
    expect(confirmDialog()).toBeNull();
  });

  it("cannot discard from a confirmation the lock engaged under", async () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(true);
    const { button } = mount(host);
    act(() => button.click());
    const confirm = discardAndExitButton();

    // Click before the lock's re-render closes the dialog.
    host.exitLockReason.value = LOCK_REASON;
    confirm.click();
    await act(async () => {});

    expect(host.discardActive).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
  });

  it("re-enables Exit once unlocked", () => {
    const host = createFakeHost();
    host.activeSession.value = fakeSession(false);
    host.exitLockReason.value = LOCK_REASON;
    const { wrapper, button } = mount(host);
    expect(button.disabled).toBe(true);

    act(() => {
      host.exitLockReason.value = undefined;
    });

    expect(button.disabled).toBe(false);
    expect(wrapper.getAttribute("data-tooltip")).toBe("Exit edit session");
    act(() => button.click());
    expect(host.discardActive).toHaveBeenCalledTimes(1);
  });

  it("keeps the idle Edit button enabled and opening the entry modal", () => {
    const host = createFakeHost();
    host.exitLockReason.value = LOCK_REASON;
    const { wrapper, button } = mount(host);

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Edit");
    expect(wrapper.getAttribute("data-tooltip")).toBe(
      "Open the edit-session entry modal",
    );

    act(() => button.click());

    expect(
      container!.querySelector(".fake-session-entry-modal"),
    ).not.toBeNull();
  });
});
