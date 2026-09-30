/**
 * The waves of a general split, as the advanced-mode panel presents them.
 *
 * Keeping the model here, free of any neuroglancer state, is what lets it be
 * tested directly and stops the panel inventing its own numbering.
 */

export interface SplitStage {
  /**
   * The server's wave number, sent as `stop_after` — except for a stage marked
   * `clientOnly`, whose number only orders it in the panel.
   */
  wave: number;
  label: string;
  title: string;
  /** Whether the server may run this stage more than once in one request. */
  repeats: boolean;
  /** Whether a request can be told to stop after this wave. */
  stoppable: boolean;
  /** A stage the panel runs by itself, with no request behind it. */
  clientOnly?: boolean;
}

export const SPLIT_STAGES: SplitStage[] = [
  {
    wave: 1,
    label: "Points",
    title:
      "Shows the points the split would add, on the pieces both sides run through. Writes nothing.",
    repeats: false,
    stoppable: true,
  },
  {
    wave: 2,
    label: "Carve",
    title:
      "Carves every piece holding both colours and writes the result, leaving the segment whole. Undoable on its own.",
    repeats: false,
    stoppable: true,
  },
  {
    wave: 3,
    label: "Cut",
    title: "The multicut over what step 2 wrote. Undoable on its own.",
    repeats: false,
    stoppable: true,
  },
  {
    wave: 4,
    label: "Clear",
    title:
      "Removes the points — the ones placed by hand and the ones the split added. Until then they stay on screen, so the cut can be judged against what was asked for. Clearing changes nothing that was written.",
    repeats: false,
    stoppable: false,
    clientOnly: true,
  },
];

/** The stages the panel offers as buttons. */
export function panelStages(): SplitStage[] {
  return SPLIT_STAGES.filter((stage) => stage.stoppable || stage.clientOnly);
}

/** The stages a request can be told to stop after. */
export function stoppableStages(): SplitStage[] {
  return SPLIT_STAGES.filter((stage) => stage.stoppable);
}

/**
 * Whether the panel should let a stage be pressed.
 *
 * The stages are a sequence, and only the next one in it is offered. Letting any
 * of them be pressed at any time invited a step to run on a graph the step
 * before it had not prepared — step 3 over a carve that never happened, or a
 * carve replayed onto pieces its own last run superseded.
 *
 * Clear is the exception: it acts on what is on screen, so it is available
 * whenever there is anything to clear, including as a way out of a half-stepped
 * session.
 */
export function stageEnabled(
  wave: number,
  reached: number,
  hasSomethingToClear: boolean,
): boolean {
  const stage = SPLIT_STAGES.find((s) => s.wave === wave);
  if (stage === undefined) return false;
  if (stage.clientOnly) return hasSomethingToClear;
  return wave === reached + 1;
}

/** Why a stage cannot be pressed, for its tooltip. */
export function stageBlockedReason(
  wave: number,
  reached: number,
): string | undefined {
  const stage = SPLIT_STAGES.find((s) => s.wave === wave);
  if (stage === undefined || stage.clientOnly) return undefined;
  if (wave > reached + 1) {
    const next = SPLIT_STAGES.find((s) => s.wave === reached + 1);
    return `Run step ${reached + 1}${next ? ` (${next.label})` : ""} first.`;
  }
  if (wave <= reached) {
    return "Already run. Clear to start over.";
  }
  return undefined;
}

/**
 * What to tell the proofreader about a stage that ran.
 *
 * The repeating stage reports which round it is on, because "Recover" firing
 * three times otherwise looks like the panel is stuck.
 */
export function stageSummary(wave: number, round: number): string {
  const stage = SPLIT_STAGES.find((s) => s.wave === wave);
  if (stage === undefined) return `Stage ${wave}`;
  if (stage.repeats && round > 0) return `${stage.label} (round ${round + 1})`;
  return stage.label;
}

/**
 * What the panel looked like before a step ran its edit, kept so undoing that
 * edit can put the panel back where the step found it.
 *
 * `carved` is the handoff step 3 consumes. This model never looks inside it; it
 * only insists that undoing the cut hands the same object back, because Cut
 * offered without it answers "Run step 2 first".
 */
export interface SplitStepUndo<CarvedState> {
  /** The edit this step pushed onto the graph's undo stack. */
  operationId: number;
  stage: number;
  carved: CarvedState | undefined;
  pointsOutliveSplit: boolean;
  status: string;
}

/**
 * The state to restore now that `revertedOperationId` has been undone, or
 * undefined when that undo reverted something else.
 *
 * The undo stack belongs to the whole graph — merges and the older multicut
 * push onto it too — so a stepped session may only rewind when the edit that
 * came back is one of its own. Steps are reverted newest first, so only the
 * newest entry can match: an older one matching would claim a stage whose own
 * edit is still in place.
 */
export function splitStepUndone<CarvedState>(
  history: SplitStepUndo<CarvedState>[],
  revertedOperationId: number,
): SplitStepUndo<CarvedState> | undefined {
  const newest = history.at(-1);
  if (newest === undefined) return undefined;
  return newest.operationId === revertedOperationId ? newest : undefined;
}
