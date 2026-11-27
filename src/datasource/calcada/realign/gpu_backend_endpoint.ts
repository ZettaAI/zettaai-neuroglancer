/**
 * @file The GPU web_api endpoint for local realignment. Kept apart from the
 * session-wide backend endpoint: the portal replaces that one with its CPU
 * backend, while field computation needs the GPU service. Authenticates with
 * the viewer's own Google login, whose id_token web_api accepts.
 */

import type { BackendEndpoint } from "#src/editing/backend/backend_endpoint.js";
import { makeGoogleOAuthAuthorize } from "#src/editing/backend/build_time_endpoint.js";

declare let NEUROGLANCER_ZETTA_GPU_BACKEND_URL: string | undefined;
declare let NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP: string | undefined;

export type GpuBackend =
  | { readonly endpoint: BackendEndpoint }
  | { readonly unavailableReason: string };

let memoised: GpuBackend | undefined;

function resolveGpuBackend(): GpuBackend {
  const baseUrl =
    typeof NEUROGLANCER_ZETTA_GPU_BACKEND_URL !== "undefined"
      ? NEUROGLANCER_ZETTA_GPU_BACKEND_URL
      : undefined;
  if (!baseUrl) {
    return {
      unavailableReason: "No GPU backend is configured for this viewer build.",
    };
  }
  const clientId =
    typeof NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP !== "undefined"
      ? NEUROGLANCER_ZETTA_GOOGLE_CLIENT_ID_IAP
      : undefined;
  if (!clientId) {
    return {
      unavailableReason:
        "No Google client id is configured for the GPU backend login.",
    };
  }
  return {
    endpoint: {
      baseUrl,
      authorize: makeGoogleOAuthAuthorize(clientId, {
        trackForLogout: false,
        description: "Zetta GPU",
      }),
    },
  };
}

export function gpuBackend(): GpuBackend {
  memoised ??= resolveGpuBackend();
  return memoised;
}
