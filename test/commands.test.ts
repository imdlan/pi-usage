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

  it("pin -> toggle; pin on/off -> explicit mode", () => {
    assert.deepEqual(routeUsageCommand("pin", IDS), { kind: "pin", mode: "toggle" });
    assert.deepEqual(routeUsageCommand("pin on", IDS), { kind: "pin", mode: "on" });
    assert.deepEqual(routeUsageCommand("pin   off", IDS), { kind: "pin", mode: "off" });
  });

  it("pin with unknown sub-arg -> unknown", () => {
    assert.deepEqual(routeUsageCommand("pin zai", IDS), { kind: "unknown", input: "pin zai" });
  });

  it("known provider id -> detail", () => {
    assert.deepEqual(routeUsageCommand("zai", IDS), { kind: "detail", providerId: "zai" });
  });

  it("unknown provider -> unknown (case-sensitive)", () => {
    assert.deepEqual(routeUsageCommand("ZAI", IDS), { kind: "unknown", input: "ZAI" });
    assert.deepEqual(routeUsageCommand("openai", IDS), { kind: "unknown", input: "openai" });
  });
});
