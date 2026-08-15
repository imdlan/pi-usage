// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  providerStatusSegment,
  formatStatusLine,
  formatProviderDetail,
  formatSummary,
  formatStatus,
  stripAnsi,
} from "../src/formatters/usage.js";
import type { CacheInfo } from "../src/services/usage-service.js";
import type { UsageSnapshot } from "../src/providers/types.js";

const ctx = { nameOf: (id: string) => (id === "zai" ? "GLM" : id) };

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: "zai",
    timestamp: "2025-05-14T10:30:45.000Z",
    quotas: [
      { id: "five_hour", label: "5-hour quota", percentage: 32 },
      {
        id: "monthly",
        label: "MCP monthly quota",
        percentage: 18,
        used: 5000,
        limit: 28000,
        remaining: 23000,
        details: [
          { id: "web_search", label: "web-search", used: 3000, limit: 28000, remaining: 25000, percentage: 10.7 },
          { id: "web_reader", label: "web-reader", used: 2000 },
        ],
      },
    ],
    ...over,
  };
}

describe("status line", () => {
  it("formats quotas compactly", () => {
    assert.equal(providerStatusSegment(snap(), ctx), "GLM · 5h 32% · mcp 18%");
  });

  it("degrades to unavailable when no quotas", () => {
    const s = snap({ quotas: [], error: { code: "auth_failed", message: "x" } });
    assert.equal(providerStatusSegment(s, ctx), "GLM · usage unavailable");
  });

  it("joins multiple providers", () => {
    const line = formatStatusLine([snap(), snap({ provider: "openai" })], {
      nameOf: (id) => (id === "zai" ? "GLM" : id === "openai" ? "OpenAI" : id),
    });
    assert.match(line, /GLM · 5h 32% · mcp 18% \| OpenAI/);
  });

  it("truncates to the configured max length", () => {
    const many = Array.from({ length: 6 }, (_, i) => snap({ provider: `p${i}` }));
    const line = formatStatusLine(many);
    assert.ok(line.length <= 80, `len=${line.length}`);
    assert.ok(line.endsWith("…"));
  });

  it("reports empty when no providers", () => {
    assert.equal(formatStatusLine([]), "no usage providers available");
  });
});

describe("formatProviderDetail", () => {
  it("renders quotas with bar and details", () => {
    const s = snap({ models: [{ model: "glm-4.6", used: 1000, percentage: 5 }] });
    const out = stripAnsi(formatProviderDetail(s, ctx));
    assert.match(out, /5-hour quota/);
    assert.match(out, /MCP monthly quota/);
    assert.match(out, /\[#*-*\]/);
    assert.match(out, /used 5000/);
    assert.match(out, /\/ 28000/);
    assert.match(out, /23000 left/);
    assert.match(out, /web-search/);
    assert.match(out, /Models:/);
    assert.match(out, /glm-4\.6/);
    assert.match(out, /refreshed/);
  });

  it("colorizes by usage level", () => {
    const low = formatProviderDetail(snap(), ctx);
    assert.ok(low.includes("\u001b[32m"), "low usage should be green");
    const hot = formatProviderDetail(
      snap({ quotas: [{ id: "five_hour", label: "5-hour quota", percentage: 95 }] }),
      ctx,
    );
    assert.ok(hot.includes("\u001b[31m"), "high usage should be red");
  });

  it("shows reset time with relative hint", () => {
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    const s = snap({ quotas: [{ id: "five_hour", label: "5-hour quota", percentage: 10, resetAt: future }] });
    const out = stripAnsi(formatProviderDetail(s, ctx));
    assert.match(out, /resets \d{2}-\d{2} \d{2}:\d{2} UTC \(in [\dhm ]+\)/);
  });

  it("marks stale data and shows errors", () => {
    const s = snap({ stale: true, error: { code: "network", message: "boom", httpStatus: undefined } });
    const out = stripAnsi(formatProviderDetail(s, ctx));
    assert.match(out, /⚠ data may be stale/);
    assert.match(out, /error: network — boom/);
  });

  it("degrades percentage and numbers gracefully", () => {
    const s = snap({
      quotas: [{ id: "five_hour", label: "5-hour quota" }],
      models: [{ model: "m1" }],
    });
    const out = stripAnsi(formatProviderDetail(s, ctx));
    assert.match(out, /5-hour quota\s+—/);
    assert.match(out, /m1\s+—/);
  });
});

describe("formatSummary", () => {
  it("lists each provider", () => {
    const out = formatSummary([snap()], ctx);
    assert.match(out, /GLM \(zai\) — 5h 32% · mcp 18%/);
  });

  it("gives guidance when empty", () => {
    const out = formatSummary([]);
    assert.match(out, /No usage providers available/);
  });
});

describe("formatStatus", () => {
  it("reports refresh time and cache state", () => {
    const info: CacheInfo[] = [
      { id: "zai", name: "GLM", fetchedAt: 1747000000000, stale: false, hasError: false, cached: true },
    ];
    const out = formatStatus([snap()], info, 1747000000000, ctx);
    assert.match(out, /Last refresh:/);
    assert.match(out, /Status line:/);
    assert.match(out, /GLM \(zai\): ok/);
  });
});

describe("redaction in output", () => {
  it("scrubs a secret that slips into a name", () => {
    const s = snap();
    const out = formatProviderDetail(s, {
      nameOf: () => "GLM Bearer supersecrettokenABC",
    });
    assert.equal(stripAnsi(out).includes("supersecrettokenABC"), false);
    assert.match(out, /REDACTED/);
  });
});
