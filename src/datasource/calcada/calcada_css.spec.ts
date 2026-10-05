import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync("src/datasource/calcada/calcada.css", "utf8");

describe("calcada.css", () => {
  // The production build lowers :is() to :-webkit-any(), which Chrome scores
  // as a class: the filter editor's base input rule then outranked the text
  // box's own and drew its text over the highlighted copy.
  it("uses no :is(), whose specificity the production build changes", () => {
    expect(stylesheet).not.toMatch(/:is\(/);
  });
});
