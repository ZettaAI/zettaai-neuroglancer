/**
 * @license
 * Copyright 2016 Google Inc.
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

import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import {
  getCredentialsWithStatus,
  monitorAuthPopupWindow,
} from "#src/credentials_provider/interactive_credentials_provider.js";
import { raceWithAbort } from "#src/util/abort.js";
import { removeFromParent } from "#src/util/dom.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { getRandomHexString } from "#src/util/random.js";

export const EMAIL_SCOPE = "email";
export const OPENID_SCOPE = "openid";

export const AUTH_SERVER = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * OAuth2 Token
 */
export interface OAuth2Token {
  accessToken: string;
  /**
   * The OpenID Connect ID token (a signed JWT), present when the `openid` +
   * `email` scopes are requested. Its audience is the OAuth `client_id`, which
   * is what an Identity-Aware Proxy (IAP) validates — so this, not
   * `accessToken`, is the bearer to send to an IAP-protected backend.
   */
  idToken: string;
  expiresIn: string;
  tokenType: string;
  scope: string;
  email: string | undefined;
}

function extractEmailFromIdToken(idToken: string): string {
  const idTokenParts = idToken.split(".");
  try {
    if (idTokenParts.length !== 3) throw new Error("Invalid JWT format");
    const decoded = atob(idTokenParts[1]);
    const parsed = JSON.parse(decoded);
    verifyObject(parsed);
    return verifyObjectProperty(parsed, "email", verifyString);
  } catch (e) {
    throw new Error(`Failed to decode id token: ${e.message}`);
  }
}

// Note: `signal` is guaranteed to be aborted once the operation completes.
function waitForAuthResponseMessage(
  source: Window,
  state: string,
  responseOrigin: string,
  signal: AbortSignal,
): Promise<OAuth2Token> {
  return new Promise((resolve, reject) => {
    window.addEventListener(
      "message",
      (event: MessageEvent) => {
        if (event.origin !== responseOrigin) {
          return;
        }

        if (event.source !== source) return;

        try {
          const obj = verifyObject(event.data);
          const receivedState = verifyObjectProperty(
            obj,
            "state",
            verifyString,
          );
          if (receivedState !== state) {
            throw new Error("invalid state");
          }
          const idToken = verifyObjectProperty(obj, "id_token", verifyString);
          const token: OAuth2Token = {
            accessToken: verifyObjectProperty(
              obj,
              "access_token",
              verifyString,
            ),
            idToken,
            tokenType: verifyObjectProperty(obj, "token_type", verifyString),
            expiresIn: verifyObjectProperty(obj, "expires_in", verifyString),
            scope: verifyObjectProperty(obj, "scope", verifyString),
            email: extractEmailFromIdToken(idToken),
          };
          resolve(token);
        } catch (parseError) {
          reject(
            new Error(
              `Received unexpected authentication response: ${parseError.message}`,
            ),
          );
          console.error("Response received: ", event.data);
        }
      },
      { signal: signal },
    );
  });
}

interface AuthRedirect {
  redirectUri: string;
  responseOrigin: string;
  stateSuffix: string;
}

/**
 * Where Google sends the response. With a `redirectProxyOrigin` other than this
 * page's own, the response lands on the proxy's `google_oauth2_redirect.html`,
 * which forwards it to the origin named in the state — so only the proxy's
 * redirect URI has to be authorized on the OAuth client (e.g. for previews).
 */
function authRedirect(redirectProxyOrigin: string | undefined): AuthRedirect {
  if (
    redirectProxyOrigin === undefined ||
    redirectProxyOrigin === location.origin
  ) {
    return {
      redirectUri: new URL("./google_oauth2_redirect.html", import.meta.url)
        .href,
      responseOrigin: location.origin,
      stateSuffix: "",
    };
  }
  // The proxy must serve this page at its origin root.
  return {
    redirectUri: `${redirectProxyOrigin}/google_oauth2_redirect.html`,
    responseOrigin: redirectProxyOrigin,
    stateSuffix: "." + base64UrlEncode(location.origin),
  };
}

function base64UrlEncode(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeAuthRequestUrl(options: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  nonce?: string;
  approvalPrompt?: "force" | "auto";
  state?: string;
  loginHint?: string;
  authUser?: number;
  includeGrantedScopes?: boolean;
  immediate?: boolean;
  prompt?: string;
}) {
  let url = `${AUTH_SERVER}?client_id=${encodeURIComponent(options.clientId)}`;
  url += `&redirect_uri=${options.redirectUri}`;
  let responseType = "token";
  const { scopes } = options;
  if (scopes.includes("email") && scopes.includes("openid")) {
    responseType = "token%20id_token";
  }
  url += `&response_type=${responseType}`;
  if (options.includeGrantedScopes === true) {
    url += "&include_granted_scopes=true";
  }
  url += `&scope=${encodeURIComponent(scopes.join(" "))}`;
  if (options.state) {
    url += `&state=${options.state}`;
  }
  if (options.loginHint) {
    url += `&login_hint=${encodeURIComponent(options.loginHint)}`;
  }
  if (options.immediate) {
    url += "&immediate=true";
  }
  if (options.prompt !== undefined) {
    url += `&prompt=${encodeURIComponent(options.prompt)}`;
  }
  if (options.nonce !== undefined) {
    url += `&nonce=${options.nonce}`;
  }
  if (options.authUser !== undefined) {
    url += `&authuser=${options.authUser}`;
  }
  return url;
}

// A proxied response page is cross-origin even on success, so it gets this long
// to post its message before the iframe counts as failed.
const PROXIED_IMMEDIATE_RESPONSE_GRACE_MS = 2000;

function createAuthIframe(
  url: string,
  abortController: AbortController,
  proxied: boolean,
): Window {
  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.style.display = "none";
  iframe.addEventListener(
    "load",
    () => {
      if (iframe.contentDocument == null) {
        // Error received
        const fail = () =>
          abortController.abort(new Error("Immediate authentication failed"));
        if (proxied) {
          const timer = setTimeout(fail, PROXIED_IMMEDIATE_RESPONSE_GRACE_MS);
          abortController.signal.addEventListener(
            "abort",
            () => clearTimeout(timer),
            { once: true },
          );
        } else {
          fail();
        }
      }
    },
    { signal: abortController.signal },
  );
  document.body.appendChild(iframe);
  abortController.signal.addEventListener("abort", () => {
    removeFromParent(iframe);
  });
  return iframe.contentWindow!;
}

/**
 * Obtain a Google OAuth2 authentication token.
 * @return A Promise that resolves to an authentication token.
 */
export async function authenticateGoogleOAuth2(
  options: {
    clientId: string;
    scopes: string[];
    approvalPrompt?: "force" | "auto";
    loginHint?: string;
    immediate?: boolean;
    authUser?: number;
    /** OAuth `prompt` (e.g. `select_account`, `login`) to force re-auth. */
    prompt?: "login" | "select_account" | "consent";
    /** Origin whose redirect page receives the response; see {@link authRedirect}. */
    redirectProxyOrigin?: string;
  },
  signal: AbortSignal,
) {
  const redirect = authRedirect(options.redirectProxyOrigin);
  const proxied = redirect.responseOrigin !== location.origin;
  const state = getRandomHexString() + redirect.stateSuffix;
  const nonce = getRandomHexString();
  const url = makeAuthRequestUrl({
    state,
    nonce,
    clientId: options.clientId,
    redirectUri: redirect.redirectUri,
    scopes: options.scopes,
    approvalPrompt: options.approvalPrompt,
    loginHint: options.loginHint,
    immediate: options.immediate,
    authUser: options.authUser,
    prompt: options.prompt,
  });
  const abortController = new AbortController();
  signal = AbortSignal.any([abortController.signal, signal]);
  try {
    let source: Window;
    if (options.immediate) {
      source = createAuthIframe(url, abortController, proxied);
    } else {
      const newWindow = open(url);
      if (newWindow === null) {
        throw new Error("Failed to create authentication popup window");
      }
      monitorAuthPopupWindow(newWindow, abortController);
      source = newWindow!;
    }
    return await raceWithAbort(
      waitForAuthResponseMessage(
        source,
        state,
        redirect.responseOrigin,
        abortController.signal,
      ),
      signal,
    );
  } finally {
    abortController.abort();
  }
}

export class GoogleOAuth2CredentialsProvider extends CredentialsProvider<OAuth2Token> {
  constructor(
    public options: {
      clientId: string;
      scopes: string[];
      description: string;
      /** OAuth `prompt` forwarded to each auth request (e.g. `select_account`). */
      prompt?: "login" | "select_account" | "consent";
      /** Forwarded to {@link authenticateGoogleOAuth2}. */
      redirectProxyOrigin?: string;
    },
  ) {
    super();
  }

  get = makeCredentialsGetter(async (options) => {
    using _span = new ProgressSpan(options.progressListener, {
      message: `Requesting ${this.options.description} OAuth2 access token`,
    });
    return await getCredentialsWithStatus(
      {
        description: this.options.description,
        supportsImmediate: true,
        get: (signal, immediate) =>
          authenticateGoogleOAuth2(
            {
              clientId: this.options.clientId,
              scopes: this.options.scopes,
              immediate: immediate,
              authUser: 0,
              // `prompt` (e.g. `select_account`) requires user interaction, so
              // it is incompatible with the silent `immediate` attempt — sending
              // it there makes Google reject the request as `invalid_request`.
              // Apply it only to the interactive attempt.
              prompt: immediate ? undefined : this.options.prompt,
              redirectProxyOrigin: this.options.redirectProxyOrigin,
            },
            signal,
          ),
      },
      options.signal,
    );
  });
}
