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
import { createRoot } from "react-dom/client";

import type { Disposer } from "#src/util/disposable.js";

export function mountComponent<T extends object>(
  target: HTMLElement,
  component: ComponentType<T>,
  props: PropsWithChildren<T>,
): Disposer {
  const root = createRoot(target);
  root.render(createElement<T>(component, props));
  return () => root.unmount();
}
