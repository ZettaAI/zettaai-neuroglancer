/**
 * The waves of a general split, as the advanced-mode panel presents them.
 *
 * Keeping the model here, free of any neuroglancer state, is what lets it be
 * tested directly and stops the panel inventing its own numbering.
 */

export interface SplitStage {
  /** The server's wave number, sent as `stop_after`. */
  wave: number;
  label: string;
  title: string;
  /** Whether the server may run this stage more than once in one request. */
  repeats: boolean;
  /** Whether a request can be told to stop after this wave. All of them can. */
  stoppable: boolean;
}

export const SPLIT_STAGES: SplitStage[] = [
  {
    wave: 1,
    label: "Points",
    title:
      "Marks the pieces both colours have to run through, placing points in them. Nothing is cut yet.",
    repeats: false,
    stoppable: true,
  },
  {
    wave: 2,
    label: "Carve",
    title:
      "Splits every piece holding points of both colours, the ones you placed and the ones step 1 added.",
    repeats: false,
    stoppable: true,
  },
  {
    wave: 3,
    label: "Cut",
    title: "The multicut over the carved graph.",
    repeats: false,
    stoppable: true,
  },
];

/** The stages the panel offers as buttons. */
export function stoppableStages(): SplitStage[] {
  return SPLIT_STAGES.filter((stage) => stage.stoppable);
}

/**
 * How a stage's button should behave given where the session stands.
 *
 * A stage behind the one reached is a rewind, which the server serves from its
 * stored snapshot; the stage reached is where the session already is; anything
 * further is a step forward. Naming the three cases here keeps the panel from
 * deciding it with inline comparisons in three places.
 */
export type StageAction = "rewind" | "current" | "advance";

export function stageAction(wave: number, reached: number): StageAction {
  if (reached === 0 || wave > reached) return "advance";
  if (wave === reached) return "current";
  return "rewind";
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
