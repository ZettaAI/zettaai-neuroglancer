import { afterEach, describe, expect, it, vi } from "vitest";

describe("gpuBackend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("is unavailable without the GPU backend URL", async () => {
    const { gpuBackend } = await import(
      "#src/datasource/calcada/realign/gpu_backend_endpoint.js"
    );
    const backend = gpuBackend();
    expect("unavailableReason" in backend && backend.unavailableReason).toMatch(
      /GPU backend/,
    );
  });

  it("is unavailable without the Google client id", async () => {
    vi.stubGlobal("NEUROGLANCER_ZETTA_GPU_BACKEND_URL", "https://gpu.example");
    const { gpuBackend } = await import(
      "#src/datasource/calcada/realign/gpu_backend_endpoint.js"
    );
    const backend = gpuBackend();
    expect("unavailableReason" in backend && backend.unavailableReason).toMatch(
      /Google client id/,
    );
  });

  it("builds an endpoint at the GPU URL when both are set", async () => {
    vi.stubGlobal("NEUROGLANCER_ZETTA_GPU_BACKEND_URL", "https://gpu.example");
    vi.stubGlobal("NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP", "client-abc");
    const { gpuBackend } = await import(
      "#src/datasource/calcada/realign/gpu_backend_endpoint.js"
    );
    const backend = gpuBackend();
    expect("endpoint" in backend && backend.endpoint.baseUrl).toBe(
      "https://gpu.example",
    );
  });
});
