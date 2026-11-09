import { afterEach, describe, expect, it } from "vitest";
import { SeedSphereReveal } from "#src/datasource/calcada/trace_cursor/seed_sphere_reveal.js";
import { WatchableValue } from "#src/trackable_value.js";

const KEY_CODE = "KeyJ";

let reveal: SeedSphereReveal | undefined;

afterEach(() => {
  reveal?.dispose();
  reveal = undefined;
  document.body.replaceChildren();
});

function setUp() {
  const revealed = new WatchableValue(false);
  reveal = new SeedSphereReveal(revealed);
  return revealed;
}

function press(
  type: "keydown" | "keyup",
  init: KeyboardEventInit = {},
  target: EventTarget = document.body,
) {
  target.dispatchEvent(
    new KeyboardEvent(type, { code: KEY_CODE, bubbles: true, ...init }),
  );
}

describe("SeedSphereReveal", () => {
  it("reveals the seed sphere while J is held", () => {
    const revealed = setUp();
    press("keydown");
    expect(revealed.value).toBe(true);
    press("keydown", { repeat: true });
    expect(revealed.value).toBe(true);
    press("keyup");
    expect(revealed.value).toBe(false);
  });

  it("ignores other keys and J with a modifier", () => {
    const revealed = setUp();
    press("keydown", { code: "KeyK" });
    press("keydown", { ctrlKey: true });
    press("keydown", { metaKey: true });
    expect(revealed.value).toBe(false);
  });

  it("ignores J typed into a text field", () => {
    const revealed = setUp();
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("keydown", {}, input);
    expect(revealed.value).toBe(false);
  });

  it("hides the sphere when the window loses focus mid-hold", () => {
    const revealed = setUp();
    press("keydown");
    window.dispatchEvent(new Event("blur"));
    expect(revealed.value).toBe(false);
  });

  it("stops listening once disposed", () => {
    const revealed = setUp();
    reveal!.dispose();
    reveal = undefined;
    press("keydown");
    expect(revealed.value).toBe(false);
  });
});
