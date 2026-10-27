/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { RefCounted } from "#src/util/disposable.js";
import { verifyStringArray } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

export class CalcadaAnnotationTablesState
  extends RefCounted
  implements Trackable
{
  readonly changed = new NullarySignal();
  private ticked_: readonly string[] = [];

  get ticked(): readonly string[] {
    return this.ticked_;
  }

  setTicked(names: readonly string[]) {
    const unique = [...new Set(names)];
    if (
      unique.length === this.ticked_.length &&
      unique.every((name, i) => name === this.ticked_[i])
    ) {
      return;
    }
    this.ticked_ = unique;
    this.changed.dispatch();
  }

  tick(name: string) {
    this.setTicked([...this.ticked_, name]);
  }

  untick(...names: string[]) {
    this.setTicked(this.ticked_.filter((name) => !names.includes(name)));
  }

  reset() {
    this.setTicked([]);
  }

  toJSON() {
    return this.ticked_.length === 0 ? undefined : [...this.ticked_];
  }

  restoreState(value: unknown) {
    if (value === undefined || value === null) {
      this.reset();
      return;
    }
    this.setTicked(verifyStringArray(value));
  }
}
