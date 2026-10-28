/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

export const FIRST_PAGE = 1;

/**
 * One table's page windows: per root a stack of cursors (none is page one),
 * and per page turn the roots it moved, so stepping back undoes exactly that.
 */
export class PageWindows {
  private readonly cursors = new Map<string, string[]>();
  private steps: string[][] = [];

  cursor(key: string): string | undefined {
    return this.cursors.get(key)?.at(-1);
  }

  get page(): number {
    let deepest = 0;
    for (const stack of this.cursors.values()) {
      deepest = Math.max(deepest, stack.length);
    }
    return FIRST_PAGE + deepest;
  }

  get hasPrevious(): boolean {
    return this.steps.length > 0;
  }

  advance(next: ReadonlyMap<string, string>) {
    if (next.size === 0) return;
    for (const [key, cursor] of next) {
      const stack = this.cursors.get(key) ?? [];
      stack.push(cursor);
      this.cursors.set(key, stack);
    }
    this.steps.push([...next.keys()]);
  }

  /** The roots moved back a page. */
  back(): string[] {
    const step = this.steps.pop() ?? [];
    for (const key of step) {
      const stack = this.cursors.get(key);
      stack?.pop();
      if (stack?.length === 0) this.cursors.delete(key);
    }
    return step;
  }

  forget(key: string) {
    this.cursors.delete(key);
    this.steps = this.steps
      .map((step) => step.filter((moved) => moved !== key))
      .filter((step) => step.length > 0);
  }
}
