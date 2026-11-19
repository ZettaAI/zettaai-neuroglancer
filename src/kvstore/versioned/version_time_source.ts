/**
 * @license
 * Copyright 2026 Zetta AI.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Data source objects (mesh, skeleton, annotation sources) that can be read
 * at a past time (TM-521).
 *
 * A data source is loaded once and may be shared by several layers, so it is
 * never changed in place. Instead a source in a bucket with object versioning
 * registers how to make a sibling source reading the same data at a given
 * time; each layer asks for the sibling of its own chosen time.
 */

import type { Disposable, Owned } from "#src/util/disposable.js";

type SiblingAtVersionTime = (time: number) => Disposable;

const siblingsAtVersionTime = new WeakMap<Disposable, SiblingAtVersionTime>();

/** Lets `source` be read at a past time through `getSibling`. */
export function registerSiblingAtVersionTime<T extends Disposable>(
  source: T,
  getSibling: (time: number) => Owned<T>,
) {
  if (!siblingsAtVersionTime.has(source)) {
    siblingsAtVersionTime.set(source, getSibling);
  }
}

/**
 * New reference to the sibling of `source` reading the data at `time`, owned
 * by the caller; `undefined` without a time or when `source` cannot be read
 * at a past time (the caller then uses `source` itself, showing the latest
 * data).
 */
export function siblingAtVersionTime<T extends Disposable>(
  source: T,
  time: number | undefined,
): Owned<T> | undefined {
  if (time === undefined) return undefined;
  const getSibling = siblingsAtVersionTime.get(source);
  return getSibling === undefined ? undefined : (getSibling(time) as T);
}
