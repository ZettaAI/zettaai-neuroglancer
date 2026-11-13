import type { TraceEndPromptView } from "#src/datasource/calcada/trace_end_controller.js";

export type TracePromptKeyAction =
  | "reject-candidate"
  | "accept-candidate"
  | "skip-candidate"
  | "ambiguous-candidate"
  | "exit-trace";

export type TraceKeyHandler =
  | "uncertain"
  | "certain"
  | "deeper"
  | "back"
  | "dismiss"
  | "reject"
  | "accept"
  | "skip"
  | "ambiguous"
  | "cancel";

interface TraceKeyRoute {
  onOpenPrompt: TraceKeyHandler;
  /** Esc reaches a prompt that is still checking; the arrows do not. */
  onCheckingPrompt?: TraceKeyHandler;
  onTrace?: TraceKeyHandler;
}

const TRACE_KEY_ROUTES: Record<TracePromptKeyAction, TraceKeyRoute> = {
  "reject-candidate": { onOpenPrompt: "uncertain", onTrace: "reject" },
  "accept-candidate": { onOpenPrompt: "certain", onTrace: "accept" },
  "skip-candidate": { onOpenPrompt: "deeper", onTrace: "skip" },
  "ambiguous-candidate": { onOpenPrompt: "back", onTrace: "ambiguous" },
  "exit-trace": {
    onOpenPrompt: "dismiss",
    onCheckingPrompt: "dismiss",
    onTrace: "cancel",
  },
};

export function traceKeyHandler(
  action: TracePromptKeyAction,
  promptPhase: TraceEndPromptView["phase"] | undefined,
): TraceKeyHandler | undefined {
  const route = TRACE_KEY_ROUTES[action];
  switch (promptPhase) {
    case "open":
      return route.onOpenPrompt;
    case "checking":
      return route.onCheckingPrompt ?? route.onTrace;
    default:
      return route.onTrace;
  }
}
