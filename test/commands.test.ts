// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeUsageCommand } from "../src/commands.js";

const IDS = ["zai"];

describe("routeUsageCommand", () => {
  it("empty/whitespace -> summary", () => {
    assert.deepEqual(routeUsageCommand("", IDS), { kind: "summary" });
    assert.deepEqual(routeUsageCommand("   ", IDS), { kind: "summary" });
    assert.deepEqual(routeUsageCommand(undefined, IDS), { kind: "summary" });
  });

  it("refresh -> refresh", () => {
    assert.deepEqual(routeUsageCommand("refresh", IDS), { kind: "refresh" });
  });

  it("status -> status", () => {
    assert.deepEqual(routeUsageCommand("status", IDS), { kind: "status" });
  });

  it("known provider id -> detail", () => {
    assert.deepEqual(routeUsageCommand("zai", IDS), { kind: "detail", providerId: "zai" });
  });

  it("unknown provider -> unknown (case-sensitive)", () => {
    assert.deepEqual(routeUsageCommand("ZAI", IDS), { kind: "unknown", input: "ZAI" });
    assert.deepEqual(routeUsageCommand("openai", IDS), { kind: "unknown", input: "openai" });
  });
});
