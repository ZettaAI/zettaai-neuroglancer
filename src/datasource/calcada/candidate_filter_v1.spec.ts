import { describe, expect, it } from "vitest";
import {
  legacyFilterTree,
  migrateV1,
} from "#src/datasource/calcada/candidate_filter_v1.js";

describe("migrateV1", () => {
  it("turns and/or groups and sided conditions into v2 nodes", () => {
    const migrated = migrateV1({
      v: 1,
      root: {
        kind: "group",
        op: "or",
        children: [
          {
            kind: "condition",
            field: { side: "both", measure: "share", class: "axon" },
            cmp: ">=",
            value: 0.8,
          },
          {
            kind: "group",
            op: "and",
            children: [
              {
                kind: "condition",
                field: { side: "candidate", measure: "voxels" },
                cmp: "<=",
                value: 5000,
              },
              {
                kind: "condition",
                field: { measure: "score" },
                cmp: ">=",
                value: 0.5,
              },
            ],
          },
        ],
      },
    });
    expect(migrated).toEqual({
      kind: "group",
      op: "any",
      children: [
        { kind: "cond", field: "axon", op: ">=", value: 80, target: "both" },
        {
          kind: "group",
          op: "all",
          children: [
            {
              kind: "cond",
              field: "size",
              op: "<=",
              value: 5000,
              target: "candidate",
            },
            { kind: "cond", field: "score", op: ">=", value: 0.5 },
          ],
        },
      ],
    });
  });

  it("refuses other versions and malformed trees", () => {
    expect(migrateV1({ v: 2, root: {} })).toBeUndefined();
    expect(
      migrateV1({ v: 1, root: { kind: "group", op: "xor", children: [] } }),
    ).toBeUndefined();
    expect(migrateV1("garbage")).toBeUndefined();
  });
});

describe("legacyFilterTree", () => {
  it("rebuilds the old fixed form as one ALL group", () => {
    const tree = legacyFilterTree({
      minScore: 0.5,
      seedMinVoxels: 0,
      candidateMinVoxels: 2000,
      seedClass: "axon",
      seedMinFraction: 0.8,
      candidateClass: "any",
      candidateMinFraction: 0.8,
    });
    expect(tree).toEqual({
      kind: "group",
      op: "all",
      children: [
        { kind: "cond", field: "score", op: ">=", value: 0.5 },
        { kind: "cond", field: "axon", op: ">=", value: 80, target: "seed" },
        {
          kind: "cond",
          field: "size",
          op: ">=",
          value: 2000,
          target: "candidate",
        },
      ],
    });
  });

  it("is empty for the old defaults", () => {
    const tree = legacyFilterTree({
      minScore: 0,
      seedMinVoxels: 0,
      candidateMinVoxels: 0,
      seedClass: "any",
      seedMinFraction: 0.8,
      candidateClass: "any",
      candidateMinFraction: 0.8,
    });
    expect(tree.children).toEqual([]);
  });
});
