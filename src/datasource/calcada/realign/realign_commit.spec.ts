// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  appliedFieldKey,
  commitDoneMessage,
  commitProgressMessage,
  encodeField,
  latestRequestGate,
  parseCommitRows,
  parseRealignHistory,
  parseRootMap,
  pollCommit,
  residualErrors,
  sectionCount,
  skippedRealignLabel,
  skippedRealignsSummary,
} from "#src/datasource/calcada/realign/realign_commit.js";

function uniformField(width: number, height: number, dx: number, dy: number) {
  const data = new Float32Array(2 * width * height);
  data.fill(dx, 0, width * height);
  data.fill(dy, width * height);
  return { data, shape: [2, height, width, 1] };
}

describe("sectionCount", () => {
  it("spreads the largest displacement so neighbours differ by at most d_max", () => {
    expect(sectionCount(uniformField(2, 2, 3, 4), 1)).toBe(5);
    expect(sectionCount(uniformField(2, 2, 3, 4), 2)).toBe(3);
    expect(sectionCount(uniformField(2, 2, 0, 0), 1)).toBe(1);
  });
});

describe("residualErrors", () => {
  it("is zero when the field pulls the reference end exactly to the moving end", () => {
    const field = uniformField(8, 8, 2, -1);
    expect(
      residualErrors(field, [{ id: "a", start: [3, 6], end: [4, 4] }]),
    ).toEqual([0]);
  });

  it("is the remaining distance otherwise", () => {
    const field = uniformField(8, 8, 0, 0);
    expect(
      residualErrors(field, [{ id: "a", start: [0, 3], end: [4, 0] }]),
    ).toEqual([5]);
  });
});

describe("encodeField", () => {
  it("gzips the float32 field", async () => {
    const field = uniformField(1, 1, 1.5, -2);
    const zipped = await encodeField(field);
    const plain = await new Response(
      new Response(zipped).body!.pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    expect(new Float32Array(plain)).toEqual(Float32Array.from([1.5, -2]));
  });
});

describe("latestRequestGate", () => {
  it("only the most recent request is current", () => {
    const gate = latestRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

describe("appliedFieldKey", () => {
  it("differs between branches for the same box and arrows", () => {
    const selection = {
      box: { x0: 0, y0: 0, x1: 4, y1: 4, z: 3 },
      referenceSection: 2,
      lines: [
        {
          id: "a",
          start: [1, 1] as [number, number],
          end: [0, 0] as [number, number],
        },
      ],
      rejected: [],
    };
    expect(appliedFieldKey(selection, 3)).not.toBe(
      appliedFieldKey(selection, 5),
    );
    expect(appliedFieldKey(selection, 3)).toBe(appliedFieldKey(selection, 3));
  });

  it("differs when the reference section moves", () => {
    const selection = {
      box: { x0: 0, y0: 0, x1: 4, y1: 4, z: 3 },
      referenceSection: 2,
      lines: [],
      rejected: [],
    };
    expect(appliedFieldKey(selection, 3)).not.toBe(
      appliedFieldKey({ ...selection, referenceSection: 5 }, 3),
    );
  });
});

describe("commitProgressMessage", () => {
  it("names the section progress and the pieces the commit cuts at the seam", () => {
    expect(commitProgressMessage(1, 3, 12)).toBe(
      "Writing section 1 of 3 (12 pieces cut at the seam)…",
    );
  });
});

describe("commitDoneMessage", () => {
  it("names the sections the commit changed and the pieces it cut at the seam", () => {
    expect(commitDoneMessage(7, 2)).toBe(
      "Changes 7 sections and cuts 2 pieces at the seam.",
    );
  });
});

describe("parseRootMap", () => {
  it("parses decimal strings into bigints, keys included", () => {
    expect(parseRootMap({ "12345678901234567890": ["1", "2"] })).toEqual(
      new Map([[12345678901234567890n, [1n, 2n]]]),
    );
  });

  it("is empty for no root map", () => {
    expect(parseRootMap(undefined)).toEqual(new Map());
  });

  it("treats a JSON null root_map (a zero-touched-piece commit) like no root map", () => {
    expect(parseRootMap(null)).toEqual(new Map());
  });
});

describe("pollCommit", () => {
  const noSleep = async () => {};

  it("rides out transient status failures", async () => {
    let calls = 0;
    const seen: number[] = [];
    const outcome = await pollCommit(
      async () => {
        calls++;
        if (calls <= 2) throw new Error("503");
        if (calls === 3)
          return { status: "running", sectionsDone: 1, sectionsTotal: 2 };
        return { status: "done" };
      },
      {
        onProgress: (status) => seen.push(status.sectionsDone ?? 0),
        sleep: noSleep,
      },
    );
    expect(outcome.status).toBe("done");
    expect(seen).toEqual([1]);
  });

  it("gives up after repeated failures", async () => {
    await expect(
      pollCommit(
        async () => {
          throw new Error("down");
        },
        { onProgress: () => {}, sleep: noSleep },
      ),
    ).rejects.toThrow("down");
  });
});

describe("parseCommitRows", () => {
  it("maps calcada's snake_case rows, blocked_by only where present", () => {
    expect(
      parseCommitRows({
        commits: [
          {
            operation_id: 12,
            box: [50, 50, 150, 150],
            z0: 12,
            sections: 4,
            status: "completed",
            undoable: true,
          },
          {
            operation_id: 11,
            box: [0, 0, 100, 100],
            z0: 10,
            sections: 5,
            status: "completed",
            undoable: false,
            blocked_by: 12,
          },
        ],
      }),
    ).toEqual([
      {
        operationId: 12,
        box: [50, 50, 150, 150],
        z0: 12,
        sections: 4,
        status: "completed",
        undoable: true,
      },
      {
        operationId: 11,
        box: [0, 0, 100, 100],
        z0: 10,
        sections: 5,
        status: "completed",
        undoable: false,
        blockedBy: 12,
      },
    ]);
  });

  it("is empty when the branch has no commits", () => {
    expect(parseCommitRows({ commits: [] })).toEqual([]);
    expect(parseCommitRows({})).toEqual([]);
  });
});

describe("parseRealignHistory", () => {
  it("maps the commits and the realigns merges into the branch skipped", () => {
    expect(
      parseRealignHistory({
        commits: [],
        skipped: [
          {
            merge_operation_id: 21,
            source_branch_id: 5,
            operation_id: 12,
            region: [10, 4, 1, 30, 24, 2],
            conflicts_with: 20,
          },
        ],
      }),
    ).toEqual({
      commits: [],
      skipped: [
        {
          mergeOperationId: 21,
          sourceBranchId: 5,
          operationId: 12,
          region: [10, 4, 1, 30, 24, 2],
          conflictsWith: 20,
        },
      ],
    });
  });

  it("is empty when the server sends neither list", () => {
    expect(parseRealignHistory({})).toEqual({ commits: [], skipped: [] });
  });
});

describe("skipped realign text", () => {
  it("names the realign, its branch, its region and the target change", () => {
    expect(
      skippedRealignLabel({
        mergeOperationId: 21,
        sourceBranchId: 5,
        operationId: 12,
        region: [10, 4, 1, 30, 24, 3],
        conflictsWith: 20,
      }),
    ).toBe(
      "#12 from branch 5 · z 1–2 · 10,4 → 30,24 · target changed it in #20",
    );
  });

  it("says the target's segmentation changed, not '#0', when the conflict is not a target operation", () => {
    expect(
      skippedRealignLabel({
        mergeOperationId: 21,
        sourceBranchId: 5,
        operationId: 12,
        region: [10, 4, 1, 30, 24, 3],
        conflictsWith: 0,
      }),
    ).toBe(
      "#12 from branch 5 · z 1–2 · 10,4 → 30,24 · target segmentation changed",
    );
  });

  it("says why they were skipped and what to do", () => {
    expect(skippedRealignsSummary(1)).toBe(
      "1 realign was skipped on merge because the target changed those regions since its branch was forked. Realign it again on a new branch.",
    );
    expect(skippedRealignsSummary(3)).toBe(
      "3 realigns were skipped on merge because the target changed those regions since their branch was forked. Realign them again on a new branch.",
    );
  });
});
