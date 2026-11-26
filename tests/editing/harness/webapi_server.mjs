/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Launch the REAL web API painting routes (`zetta_utils/web_api/app/painting.py`)
 * against the fixtures' fake-gcs, for the edit-session save e2e (TM-331).
 *
 * The save path under test is the production one end to end: NG's
 * `HttpSaveBackend` posts to `POST /painting/cutout`, and the production
 * handler writes through CloudVolume / `chunk_cas` into fake-gcs (pointed at by
 * `STORAGE_EMULATOR_HOST`). Nothing in the write path is faked.
 *
 * Needs a zetta_utils checkout with its web-api environment:
 *
 *   ZETTA_UTILS_DIR=/path/to/zetta_utils
 *   (cd $ZETTA_UTILS_DIR && uv sync --locked --extra web-api --python 3.13)
 *
 * A missing checkout or environment is a hard error with these instructions —
 * never a silent skip.
 *
 * Isolation from real cloud storage: the process gets a throwaway service
 * account whose `token_uri` points at a closed local port and an empty `HOME`
 * (no CloudVolume secrets), so a request that escaped the emulator could not
 * authenticate against real GCS.
 */

import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STARTUP_TIMEOUT_MS = 120_000;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Resolve the zetta_utils checkout and its web-api `hypercorn`, or throw. */
export function resolveWebApiCheckout(
  zettaUtilsDir = process.env.ZETTA_UTILS_DIR,
) {
  const instructions =
    "The save e2e runs the real web API painting routes. Point ZETTA_UTILS_DIR\n" +
    "at a zetta_utils checkout and install its web-api environment:\n" +
    "  export ZETTA_UTILS_DIR=/path/to/zetta_utils\n" +
    "  (cd $ZETTA_UTILS_DIR && uv sync --locked --extra web-api --python 3.13)";
  if (zettaUtilsDir === undefined || zettaUtilsDir === "") {
    throw new Error(`ZETTA_UTILS_DIR is not set.\n${instructions}`);
  }
  const webApiDir = path.join(zettaUtilsDir, "web_api");
  const paintingModule = path.join(webApiDir, "app", "painting.py");
  if (!existsSync(paintingModule)) {
    throw new Error(
      `no web API painting module at ${paintingModule}.\n${instructions}`,
    );
  }
  const hypercorn = path.join(zettaUtilsDir, ".venv", "bin", "hypercorn");
  if (!existsSync(hypercorn)) {
    throw new Error(
      `no web-api environment at ${path.dirname(hypercorn)}.\n${instructions}`,
    );
  }
  return { zettaUtilsDir, webApiDir, hypercorn };
}

/** A service-account key that can never mint a token (closed `token_uri`). */
function writeUnusableServiceAccount(directory) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const keyPath = path.join(directory, "unusable-service-account.json");
  writeFileSync(
    keyPath,
    JSON.stringify({
      type: "service_account",
      project_id: "demo-zetta",
      private_key_id: "e2e-local",
      private_key: privateKey,
      client_email: "e2e-local@e2e-local.invalid",
      client_id: "0",
      token_uri: "http://127.0.0.1:9/token",
    }),
  );
  return keyPath;
}

/**
 * Start the painting API on a free port, wired to `fakeGcsUrl`. Resolves once
 * `/healthz` answers. `logPath`, when given, receives the server's output.
 */
export async function startPaintingWebApi({ fakeGcsUrl, logPath } = {}) {
  if (fakeGcsUrl === undefined) throw new Error("fakeGcsUrl is required");
  const { webApiDir, hypercorn } = resolveWebApiCheckout();

  const sandbox = mkdtempSync(path.join(os.tmpdir(), "ng-e2e-webapi-"));
  const emptyHome = path.join(sandbox, "home");
  mkdirSync(emptyHome);
  const serviceAccount = writeUnusableServiceAccount(sandbox);

  const port = await findFreePort();
  const child = spawn(
    hypercorn,
    ["webapi_app:app", "--bind", `127.0.0.1:${port}`],
    {
      cwd: webApiDir,
      env: {
        PATH: process.env.PATH,
        HOME: emptyHome,
        PYTHONPATH: `${HERE}${path.delimiter}${webApiDir}`,
        STORAGE_EMULATOR_HOST: fakeGcsUrl,
        GOOGLE_APPLICATION_CREDENTIALS: serviceAccount,
        GOOGLE_CLOUD_PROJECT: "demo-zetta",
        WEB_API_TELEMETRY_ENABLED: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const outputLines = [];
  for (const stream of [child.stdout, child.stderr]) {
    (async () => {
      for await (const line of readline.createInterface({ input: stream })) {
        outputLines.push(line);
        if (process.env.WEBAPI_VERBOSE) console.log(`webapi: ${line}`);
      }
    })();
  }

  const killChild = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  process.once("exit", killChild);

  const url = `http://127.0.0.1:${port}`;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    const exitCode = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 500)),
    ]);
    if (exitCode !== undefined) {
      throw new Error(
        `web API exited (code ${exitCode}) before it was healthy:\n` +
          outputLines.slice(-40).join("\n"),
      );
    }
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      killChild();
      throw new Error(
        `web API not healthy after ${STARTUP_TIMEOUT_MS} ms:\n` +
          outputLines.slice(-40).join("\n"),
      );
    }
  }

  return {
    url,
    /** Everything the server printed so far (for failure reports). */
    output: () => outputLines.join("\n"),
    async [Symbol.asyncDispose]() {
      process.removeListener("exit", killChild);
      if (logPath !== undefined) {
        mkdirSync(path.dirname(logPath), { recursive: true });
        writeFileSync(logPath, outputLines.join("\n"));
      }
      child.kill();
      await exited;
    },
  };
}
