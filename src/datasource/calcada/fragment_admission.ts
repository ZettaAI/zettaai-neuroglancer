/**
 * @license
 * Copyright 2024 Google Inc.
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
 * Latches a fragment chunk's download-slot charge for the lifetime of one
 * download. The chunk queue reads `downloadSlots` live at BOTH the charge
 * (enter DOWNLOADING) and release (leave DOWNLOADING) transitions, so any
 * input that can change mid-download (batch support flipping from undefined
 * once the first POST resolves, a frag-location arriving from a manifest)
 * would make charge != release and permanently leak queue capacity. The
 * first computed value per (chunk, fragmentId) is therefore reused until the
 * chunk is recycled for a different fragment.
 */
export class FragmentAdmissionLatch {
  private latch = new WeakMap<
    object,
    { fragmentId: string; slots: number | undefined }
  >();

  get(
    chunk: object,
    fragmentId: string,
    decide: () => number | undefined,
  ): number | undefined {
    const entry = this.latch.get(chunk);
    if (entry !== undefined && entry.fragmentId === fragmentId) {
      return entry.slots;
    }
    const slots = decide();
    this.latch.set(chunk, { fragmentId, slots });
    return slots;
  }
}
