/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const REDIRECT_PAGE = readFileSync(
  path.resolve("src/util/google_oauth2_redirect.html"),
  "utf8",
);
const PROXY_PAGE =
  "https://neuroglancer-dev.research.zetta.ai/google_oauth2_redirect.html";
const PREVIEW_ORIGIN =
  "https://neuroglancer-pr-277-349854005841.us-east1.run.app";

function encode(origin: string) {
  return btoa(origin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function loadRedirectPage(state: string) {
  const postMessage = vi.fn();
  new JSDOM(REDIRECT_PAGE, {
    url: `${PROXY_PAGE}#state=${encodeURIComponent(state)}&id_token=token`,
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      Object.defineProperty(window, "opener", { value: { postMessage } });
    },
  });
  return postMessage;
}

describe("google_oauth2_redirect.html", () => {
  it("posts an unproxied response to its own origin", () => {
    const postMessage = loadRedirectPage("cafe");

    expect(postMessage).toHaveBeenCalledWith(
      { state: "cafe", id_token: "token" },
      "https://neuroglancer-dev.research.zetta.ai",
    );
  });

  it.each([
    PREVIEW_ORIGIN,
    "https://neuroglancer-pr-277-hhtsusnvoq-ue.a.run.app",
    "https://portal.research.zetta.ai",
    "https://portal-dev.research.zetta.ai",
    "https://portal-pr-12-349854005841.us-east1.run.app",
    "https://portal-pr-12-hhtsusnvoq-ue.a.run.app",
    "https://portal-pr-12.research.zetta.ai",
  ])("forwards a response to the preview %s named in the state", (origin) => {
    const state = `cafe.${encode(origin)}`;

    expect(loadRedirectPage(state)).toHaveBeenCalledWith(
      { state, id_token: "token" },
      origin,
    );
  });

  it.each([
    "https://evil.example",
    `${PREVIEW_ORIGIN}.evil.example`,
    PREVIEW_ORIGIN.replace("https:", "http:"),
    "https://neuroglancer-pr-x-349854005841.us-east1.run.app",
    "https://portal.research.zetta.ai.evil.example",
    "https://portal-staging.research.zetta.ai",
  ])("refuses to post to %s", (origin) => {
    expect(loadRedirectPage(`cafe.${encode(origin)}`)).not.toHaveBeenCalled();
  });

  it("refuses a state whose origin is not base64", () => {
    expect(loadRedirectPage("cafe.!!!")).not.toHaveBeenCalled();
  });
});
