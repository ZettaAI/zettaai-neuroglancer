import { describe, expect, it } from "vitest";
import { traceKeyHandler } from "#src/datasource/calcada/trace_prompt_keys.js";

describe("traceKeyHandler", () => {
  it("←/→/↓/↑ and Esc act on the prompt while it is open", () => {
    expect(traceKeyHandler("reject-candidate", "open")).toBe("uncertain");
    expect(traceKeyHandler("accept-candidate", "open")).toBe("certain");
    expect(traceKeyHandler("skip-candidate", "open")).toBe("deeper");
    expect(traceKeyHandler("ambiguous-candidate", "open")).toBe("back");
    expect(traceKeyHandler("exit-trace", "open")).toBe("dismiss");
  });

  it("←/→/↓/↑ and Esc act on the trace when no prompt is shown", () => {
    expect(traceKeyHandler("reject-candidate", undefined)).toBe("reject");
    expect(traceKeyHandler("accept-candidate", undefined)).toBe("accept");
    expect(traceKeyHandler("skip-candidate", undefined)).toBe("skip");
    expect(traceKeyHandler("ambiguous-candidate", undefined)).toBe("ambiguous");
    expect(traceKeyHandler("exit-trace", undefined)).toBe("cancel");
  });

  it("while the prompt is checking the arrows still act on the trace", () => {
    expect(traceKeyHandler("reject-candidate", "checking")).toBe("reject");
    expect(traceKeyHandler("accept-candidate", "checking")).toBe("accept");
    expect(traceKeyHandler("skip-candidate", "checking")).toBe("skip");
    expect(traceKeyHandler("ambiguous-candidate", "checking")).toBe(
      "ambiguous",
    );
    expect(traceKeyHandler("exit-trace", "checking")).toBe("dismiss");
  });
});
