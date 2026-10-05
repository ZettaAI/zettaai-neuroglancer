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
 * @file The roots a trace's edits retired: ids the graph no longer has, which
 * must not be put back on screen. Undo is the one thing that revives them, so
 * each accept remembers what it retired and its undo takes exactly that back.
 */

export class RetiredRoots {
  private readonly roots = new Set<bigint>();
  private readonly byAccept: bigint[][] = [];

  has(id: bigint): boolean {
    return this.roots.has(id);
  }

  retire(ids: Iterable<bigint>) {
    for (const id of ids) this.roots.add(id);
  }

  retireAccept(ids: readonly bigint[]) {
    this.byAccept.push([...ids]);
    this.retire(ids);
  }

  undoAccept() {
    for (const id of this.byAccept.pop() ?? []) this.roots.delete(id);
  }

  clear() {
    this.roots.clear();
    this.byAccept.length = 0;
  }
}
