import { webcrypto } from "node:crypto";
import type { JSDOM } from "jsdom";

declare let jsdom: JSDOM;

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
});

// jsdom does not implement WebGL. Modules such as `src/webgl/shader.ts` read
// `WebGL2RenderingContext` enum constants at *module-evaluation* time, so any
// node-environment test that transitively imports them (e.g. the kvstore
// suites, which pull in datasource completions) fails to even collect. These
// tests never touch the GPU, so a no-op stand-in that lets the constant reads
// resolve to `undefined` is enough to import the module graph.
if (!("WebGL2RenderingContext" in globalThis)) {
  Object.defineProperty(globalThis, "WebGL2RenderingContext", {
    value: class WebGL2RenderingContext {},
    configurable: true,
    writable: true,
  });
}

// jsdom implements no layout, so it ships no `ResizeObserver` either. Components
// that watch their own box for overflow (`src/widget/react/truncated_label.tsx`)
// construct one on mount, which would throw during render. A no-op stand-in is
// enough: every element measures 0 in jsdom, so there is nothing to observe —
// the overflow-dependent behavior is covered by the browser suites instead.
if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    configurable: true,
    writable: true,
  });
}

for (const name of [
  /*"DOMParser", "XPathResult", "navigator"*/
] as const) {
  Object.defineProperty(globalThis, name, {
    value: jsdom.window[name],
  });
}
