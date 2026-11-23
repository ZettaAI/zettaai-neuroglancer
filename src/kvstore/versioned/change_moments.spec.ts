/**
 * @license
 * Copyright 2026 Zetta AI.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, test } from "vitest";

import {
  groupChangeMoments,
  neighbourMoment,
} from "#src/kvstore/versioned/change_moments.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe("change moments", () => {
  test("writes of one save become one moment at its last write", () => {
    // One save writes its chunks milliseconds apart.
    expect(groupChangeMoments([0, 7, 53, 3 * MINUTE, 3 * MINUTE + 31])).toEqual(
      [3 * MINUTE + 31, 53],
    );
  });

  test("saves a few seconds apart stay separate moments", () => {
    // Real saves by hand, 6-9 s apart.
    const saves = [0, 9 * SECOND, 16 * SECOND, 22 * SECOND];
    expect(groupChangeMoments(saves)).toEqual([...saves].reverse());
  });

  test("a long save stays one moment while its writes keep coming", () => {
    const writes = Array.from({ length: 30 }, (_, i) => i * SECOND);
    expect(groupChangeMoments(writes)).toEqual([29 * SECOND]);
  });

  test("unsorted and repeated times", () => {
    expect(groupChangeMoments([MINUTE, 0, MINUTE, 0])).toEqual([MINUTE, 0]);
  });

  test("no writes, no moments", () => {
    expect(groupChangeMoments([])).toEqual([]);
  });
});

describe("previous / next moment", () => {
  const moments = [30, 20, 10];

  test("older from the latest data is the newest moment", () => {
    expect(neighbourMoment(moments, undefined, "older")).toBe(30);
  });

  test("older and newer between moments", () => {
    expect(neighbourMoment(moments, 20, "older")).toBe(10);
    expect(neighbourMoment(moments, 20, "newer")).toBe(30);
    // A time between moments (typed by hand).
    expect(neighbourMoment(moments, 25, "older")).toBe(20);
    expect(neighbourMoment(moments, 25, "newer")).toBe(30);
  });

  test("newer than the newest moment is the latest data", () => {
    expect(neighbourMoment(moments, 30, "newer")).toBeUndefined();
  });

  test("nothing older than the first moment, nothing newer than latest", () => {
    expect(neighbourMoment(moments, 10, "older")).toBeNull();
    expect(neighbourMoment(moments, undefined, "newer")).toBeNull();
  });
});
