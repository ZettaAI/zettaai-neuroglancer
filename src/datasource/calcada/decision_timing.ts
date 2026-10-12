/**
 * Times a proofreader's decisions within one trace session.
 *
 * `thinkMs` runs from a candidate appearing to the decision, minus time the
 * tab spent hidden. `waitMs` runs from the previous action — a decision or a
 * seed placement — to the candidate appearing: time spent waiting on us, so
 * hidden time is not removed from it.
 */
export interface DecisionTiming {
  thinkMs: number;
  waitMs: number;
  sessionId: string;
}

export class DecisionClock {
  readonly sessionId: string;
  private lastActionAt: number;
  private shownLineId: bigint | undefined;
  private shownAt: number;
  private waitMs = 0;
  private hiddenMs = 0;
  private hiddenSince: number | undefined;

  constructor(
    private readonly now: () => number = () => performance.now(),
    sessionId: string = crypto.randomUUID(),
  ) {
    this.sessionId = sessionId;
    this.lastActionAt = now();
    this.shownAt = this.lastActionAt;
  }

  markAction() {
    this.lastActionAt = this.now();
  }

  markShown(lineId: bigint) {
    if (lineId === this.shownLineId) return;
    const now = this.now();
    this.shownLineId = lineId;
    this.shownAt = now;
    this.waitMs = now - this.lastActionAt;
    this.hiddenMs = 0;
    if (this.hiddenSince !== undefined) this.hiddenSince = now;
  }

  setHidden(hidden: boolean) {
    const now = this.now();
    if (hidden && this.hiddenSince === undefined) {
      this.hiddenSince = now;
    } else if (!hidden && this.hiddenSince !== undefined) {
      this.hiddenMs += now - this.hiddenSince;
      this.hiddenSince = undefined;
    }
  }

  decide(): DecisionTiming {
    const now = this.now();
    const hidden =
      this.hiddenMs +
      (this.hiddenSince === undefined ? 0 : now - this.hiddenSince);
    this.lastActionAt = now;
    this.shownLineId = undefined;
    return {
      thinkMs: Math.max(0, Math.round(now - this.shownAt - hidden)),
      waitMs: Math.max(0, Math.round(this.waitMs)),
      sessionId: this.sessionId,
    };
  }
}
