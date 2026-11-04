/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticateGoogleOAuth2 } from "#src/util/google_oauth2.js";

const PROXY_ORIGIN = "https://neuroglancer-dev.example";

function idTokenFor(email: string) {
  return `header.${btoa(JSON.stringify({ email }))}.signature`;
}

function openPopup() {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const popup = frame.contentWindow!;
  const open = vi.fn((_url?: string | URL) => popup);
  vi.stubGlobal("open", open);
  return { popup, open, frame };
}

function requestedUrl(open: ReturnType<typeof openPopup>["open"]) {
  return new URL(String(open.mock.calls[0][0]));
}

function respond(popup: Window, origin: string, state: string) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source: popup,
      data: {
        state,
        id_token: idTokenFor("dev@zetta.ai"),
        access_token: "access",
        token_type: "Bearer",
        expires_in: "3600",
        scope: "openid email",
      },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("authenticateGoogleOAuth2 redirect", () => {
  it("returns to this page's own redirect page without a proxy", async () => {
    const { popup, open } = openPopup();

    const login = authenticateGoogleOAuth2(
      { clientId: "client", scopes: ["openid", "email"] },
      new AbortController().signal,
    );
    const url = requestedUrl(open);
    const state = url.searchParams.get("state")!;
    respond(popup, location.origin, state);

    const redirectUri = new URL(url.searchParams.get("redirect_uri")!);
    expect(redirectUri.origin).toBe(location.origin);
    expect(redirectUri.pathname).toMatch(/\/google_oauth2_redirect\.html$/);
    expect(state).toMatch(/^[0-9a-f]+$/);
    await expect(login).resolves.toMatchObject({ email: "dev@zetta.ai" });
  });

  it("returns to the proxy's redirect page and names this origin in the state", async () => {
    const { popup, open } = openPopup();

    const login = authenticateGoogleOAuth2(
      {
        clientId: "client",
        scopes: ["openid", "email"],
        redirectProxyOrigin: PROXY_ORIGIN,
      },
      new AbortController().signal,
    );
    const url = requestedUrl(open);
    const state = url.searchParams.get("state")!;
    respond(popup, PROXY_ORIGIN, state);

    expect(url.searchParams.get("redirect_uri")).toBe(
      `${PROXY_ORIGIN}/google_oauth2_redirect.html`,
    );
    const [, encodedOrigin] = state.split(".");
    expect(atob(encodedOrigin.replace(/-/g, "+").replace(/_/g, "/"))).toBe(
      location.origin,
    );
    await expect(login).resolves.toMatchObject({ email: "dev@zetta.ai" });
  });

  it("ignores a response from its own origin while proxied", async () => {
    const { popup, open } = openPopup();
    const abort = new AbortController();

    const login = authenticateGoogleOAuth2(
      {
        clientId: "client",
        scopes: ["openid", "email"],
        redirectProxyOrigin: PROXY_ORIGIN,
      },
      abort.signal,
    );
    respond(
      popup,
      location.origin,
      requestedUrl(open).searchParams.get("state")!,
    );
    abort.abort(new Error("no proxied response"));

    await expect(login).rejects.toThrow("no proxied response");
  });

  it("treats a proxy equal to this origin as no proxy", async () => {
    const { popup, open } = openPopup();

    const login = authenticateGoogleOAuth2(
      {
        clientId: "client",
        scopes: ["openid", "email"],
        redirectProxyOrigin: location.origin,
      },
      new AbortController().signal,
    );
    const state = requestedUrl(open).searchParams.get("state")!;
    respond(popup, location.origin, state);

    expect(state).toMatch(/^[0-9a-f]+$/);
    await expect(login).resolves.toMatchObject({ email: "dev@zetta.ai" });
  });
});
