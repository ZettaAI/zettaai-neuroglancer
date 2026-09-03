/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ComponentType, PropsWithChildren } from "react";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";

import type { Disposer } from "#src/util/disposable.js";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_SCOPE_CLASSES } from "@/lib/ui_scope";
import "@/styles/globals.css";

const rootsByTarget = new WeakMap<HTMLElement, Root>();

export function mountComponent<T extends object>(
  target: HTMLElement,
  component: ComponentType<T>,
  props: PropsWithChildren<T>,
): Disposer {
  let root = rootsByTarget.get(target);
  if (root === undefined) {
    target.classList.add(...UI_SCOPE_CLASSES);
    root = createRoot(target);
    rootsByTarget.set(target, root);
  }
  root.render(
    createElement(
      TooltipProvider,
      { delay: 500 },
      createElement<T>(component, props),
    ),
  );
  return () => {
    if (rootsByTarget.get(target) !== root) return;
    rootsByTarget.delete(target);
    root.unmount();
  };
}
