import { describe, expect, it } from "vitest";
import {
  shouldRetryManifestDownload,
  nextManifestRetryDelayMs,
  MAX_MANIFEST_DOWNLOAD_ATTEMPTS,
} from "#src/datasource/calcada/manifest_retry.js";

describe("shouldRetryManifestDownload", () => {
  it("allows retries below the max attempt count", () => {
    expect(shouldRetryManifestDownload(0)).toBe(true);
    expect(shouldRetryManifestDownload(MAX_MANIFEST_DOWNLOAD_ATTEMPTS - 1)).toBe(true);
  });
  it("stops retrying at the max attempt count", () => {
    expect(shouldRetryManifestDownload(MAX_MANIFEST_DOWNLOAD_ATTEMPTS)).toBe(false);
  });
});

describe("nextManifestRetryDelayMs", () => {
  it("grows exponentially and caps at 8s", () => {
    expect(nextManifestRetryDelayMs(0)).toBe(1000);
    expect(nextManifestRetryDelayMs(1)).toBe(2000);
    expect(nextManifestRetryDelayMs(2)).toBe(4000);
    expect(nextManifestRetryDelayMs(10)).toBe(8000);
  });
});
