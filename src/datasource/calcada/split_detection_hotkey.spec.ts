import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SPLIT_DETECTION_TOGGLE = "calcada-toggle-split-detection";

const keybinds: Record<string, unknown> = JSON.parse(
  readFileSync("config/custom-keybinds.json", "utf8"),
);

describe("split error detection hotkey", () => {
  it("is ?, which nothing else binds", () => {
    expect(keybinds["shift+slash"]).toBe(SPLIT_DETECTION_TOGGLE);
  });

  it("leaves E to Neuroglancer's rotation", () => {
    expect(keybinds["keye"]).toBeUndefined();
  });
});
