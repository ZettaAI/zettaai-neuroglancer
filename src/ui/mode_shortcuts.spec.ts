/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest";

import { ModeShortcutRegistry } from "#src/ui/mode_shortcuts.js";

const mode = (id: string, priority: number) => ({
  id,
  title: id,
  priority,
  shortcuts: [],
});

describe("ModeShortcutRegistry", () => {
  it("has no current mode until one is published", () => {
    expect(new ModeShortcutRegistry().current).toBeUndefined();
  });

  it("shows the highest priority mode and falls back when it is withdrawn", () => {
    const registry = new ModeShortcutRegistry();
    registry.publish(mode("brush", 1));
    const withdrawTrace = registry.publish(mode("trace", 2));
    expect(registry.current?.id).toBe("trace");
    withdrawTrace();
    expect(registry.current?.id).toBe("brush");
  });

  it("keeps one entry per id, so two layers make one strip", () => {
    const registry = new ModeShortcutRegistry();
    const withdrawFirst = registry.publish(mode("trace", 2));
    const second = mode("trace", 2);
    registry.publish(second);
    withdrawFirst();
    expect(registry.current).toBe(second);
  });

  it("signals each change", () => {
    const registry = new ModeShortcutRegistry();
    const listener = vi.fn();
    registry.changed.add(listener);
    registry.publish(mode("trace", 2))();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
