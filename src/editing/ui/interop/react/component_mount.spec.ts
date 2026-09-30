/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mountComponent } from "#src/editing/ui/interop/react/component_mount.js";
import type { Disposer } from "#src/util/disposable.js";
import { invokeDisposer } from "#src/util/disposable.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Label({ text }: { text: string }) {
  return createElement("span", null, text);
}

let target: HTMLDivElement;
let disposers: Disposer[];

beforeEach(() => {
  target = document.createElement("div");
  document.body.appendChild(target);
  disposers = [];
});

afterEach(() => {
  act(() => {
    for (const disposer of disposers) invokeDisposer(disposer);
  });
  target.remove();
});

describe("mountComponent (react)", () => {
  it("renders the component into the target", () => {
    act(() => {
      disposers.push(mountComponent(target, Label, { text: "one" }));
    });
    expect(target.textContent).toBe("one");
  });

  it("re-renders in place when called again with the same target", () => {
    act(() => {
      disposers.push(mountComponent(target, Label, { text: "one" }));
    });
    const firstSpan = target.querySelector("span");
    act(() => {
      disposers.push(mountComponent(target, Label, { text: "two" }));
    });
    expect(target.textContent).toBe("two");
    expect(target.querySelectorAll("span")).toHaveLength(1);
    expect(target.querySelector("span")).toBe(firstSpan);
  });

  it("unmounts on dispose and allows a fresh mount afterwards", () => {
    let dispose!: Disposer;
    act(() => {
      dispose = mountComponent(target, Label, { text: "one" });
    });
    act(() => invokeDisposer(dispose));
    expect(target.textContent).toBe("");
    act(() => {
      disposers.push(mountComponent(target, Label, { text: "again" }));
    });
    expect(target.textContent).toBe("again");
  });
});
