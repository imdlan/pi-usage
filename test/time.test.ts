// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computePercentage,
  computeRemaining,
  clampPercentage,
  zaiUsageWindow,
  formatZaiDateTime,
  truncate,
  pad2,
} from "../src/utils/time.js";

describe("pad2", () => {
  it("zero-pads single digits", () => {
    assert.equal(pad2(0), "00");
    assert.equal(pad2(5), "05");
    assert.equal(pad2(12), "12");
  });
});

describe("formatZaiDateTime", () => {
  it("formats as yyyy-MM-dd HH:mm:ss (local)", () => {
    assert.equal(formatZaiDateTime(new Date(2025, 4, 14, 10, 30, 45)), "2025-05-14 10:30:45");
  });
});

describe("zaiUsageWindow", () => {
  it("spans yesterday-current-hour to today-current-hour end", () => {
    const w = zaiUsageWindow(new Date(2025, 4, 14, 10, 30, 45));
    assert.equal(w.startTime, "2025-05-13 10:00:00");
    assert.equal(w.endTime, "2025-05-14 10:59:59");
  });
});

describe("computePercentage", () => {
  it("returns percentage with one decimal", () => {
    assert.equal(computePercentage(30, 100), 30);
    assert.equal(computePercentage(33.333, 100), 33.3);
  });
  it("is undefined when inputs are missing or invalid", () => {
    assert.equal(computePercentage(undefined, 100), undefined);
    assert.equal(computePercentage(50, undefined), undefined);
    assert.equal(computePercentage(50, 0), undefined);
    assert.equal(computePercentage(50, -10), undefined);
    assert.equal(computePercentage(Number.NaN, 100), undefined);
  });
});

describe("computeRemaining", () => {
  it("returns remaining, floored at 0", () => {
    assert.equal(computeRemaining(100, 30), 70);
    assert.equal(computeRemaining(100, 150), 0);
  });
  it("is undefined when inputs are missing", () => {
    assert.equal(computeRemaining(undefined, 30), undefined);
    assert.equal(computeRemaining(100, undefined), undefined);
  });
});

describe("clampPercentage", () => {
  it("clamps to [0,100]", () => {
    assert.equal(clampPercentage(150), 100);
    assert.equal(clampPercentage(-5), 0);
    assert.equal(clampPercentage(42), 42);
    assert.equal(clampPercentage(undefined), undefined);
  });
});

describe("truncate", () => {
  it("truncates with ellipsis", () => {
    assert.equal(truncate("abcdef", 5), "abcd…");
    assert.equal(truncate("ab", 5), "ab");
    assert.equal(truncate("abcdef", 0), "");
    assert.equal(truncate("abc", 1), "…");
  });
});
