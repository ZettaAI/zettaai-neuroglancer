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

export const MAX_MANIFEST_DOWNLOAD_ATTEMPTS = 3;

export function shouldRetryManifestDownload(
  attemptCount: number,
  maxAttempts: number = MAX_MANIFEST_DOWNLOAD_ATTEMPTS,
): boolean {
  return attemptCount < maxAttempts;
}

export function nextManifestRetryDelayMs(attemptCount: number): number {
  return Math.min(2 ** attemptCount * 1000, 8000);
}
