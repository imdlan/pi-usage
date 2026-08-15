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
    assert.equal(providerStatusSegment(snap(), ctx), "GLM · 5h 32% · MCP 18%");
  });

  it("degrades to unavailable when no quotas", () => {
    const s = snap({ quotas: [], error: { code: "auth_failed", message: "x" } });
    assert.equal(providerStatusSegment(s, ctx), "GLM · usage unavailable");
  });

  it("joins multiple providers", () => {
    const line = formatStatusLine([snap(), snap({ provider: "openai" })], {
      nameOf: (id) => (id === "zai" ? "GLM" : id === "openai" ? "OpenAI" : id),
    });
    assert.match(line, /GLM · 5h 32% · MCP 18% \| OpenAI/);
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
  it("renders quotas as an ASCII table with rules between blocks", () => {
    const s = snap({ models: [{ model: "glm-4.6", used: 1000, percentage: 5 }] });
    const out = stripAnsi(formatProviderDetail(s, ctx));
    assert.match(out, /MCP monthly quota/);
    assert.match(out, /5-hour quota/);
    assert.match(out, /\| Quota\s+\|/);
    assert.match(out, /\[#*-*\]/);
    assert.match(out, /5000 \/ 28000/);
    assert.match(out, /23000/);
    assert.match(out, /web-search/);
    assert.match(out, /Models:/);
    assert.match(out, /glm-4\.6/);
    assert.match(out, /refreshed/);
    // Provider name is a centered spanning title row above the column header.
    assert.match(out, /\|\s+GLM\s+\|/);
    // Every table line has matching borders and equal visible width.
    const tableLines = out.split("\n").filter((l) => l.trim().startsWith("|"));
    assert.ok(tableLines.length > 0);
    const widths = new Set(tableLines.map((l) => l.length));
    assert.equal(widths.size, 1, `table rows must share one width: ${[...widths]}`);
    // mcp, its sub-items, and 5h are each separated by horizontal rules.
    const ruleCount = out.split("\n").filter((l) => /^\+-+\+/.test(l)).length;
    assert.ok(ruleCount >= 5, `expected >=5 rules, got ${ruleCount}`);
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
    assert.match(out, /\d{2}-\d{2} \d{2}:\d{2} UTC \(in [\dhm ]+\)/);
  });

  it("marks stale data and shows errors", () => {
    const s = snap({ stale: true, error: { code: "network", message: "boom", httpStatus: undefined } });
    const out = stripAnsi(formatProviderDetail(s, ctx));
    assert.match(out, /⚠ data may be stale/);
    assert.match(out, /error: network — boom/);
  });

  it("header is provider-agnostic and works for future providers", () => {
    const s = snap({ provider: "openai", quotas: [{ id: "weekly", label: "Weekly quota", percentage: 40 }] });
    const out = stripAnsi(formatProviderDetail(s, { nameOf: (id) => (id === "openai" ? "OpenAI" : id) }, 80));
    assert.match(out, /\|\s+OpenAI\s+\|/);
    assert.match(out, /Weekly quota/);
    assert.match(out, /\| Quota\s+\| Usage\s+\| Pct /);
  });

  it("degrades percentage and numbers gracefully", () => {
    const s = snap({
      quotas: [{ id: "five_hour", label: "5-hour quota" }],
      models: [{ model: "m1" }],
    });
    const out = stripAnsi(formatProviderDetail(s, ctx));
    assert.match(out, /5-hour quota\s+\| —/);
    assert.match(out, /m1\s+—/);
  });

  it("adapts to narrow terminals by dropping columns, never overflowing", () => {
    const s = snap();
    const wide = stripAnsi(formatProviderDetail(s, ctx, 120));
    assert.match(wide, /\| Resets\s+\|/);
    assert.match(wide, /5000 \/ 28000/);
    assert.match(wide, /\| 23000\s+\|/);
    // Medium: Resets and Left dropped, Used and full labels kept.
    const mid = stripAnsi(formatProviderDetail(s, ctx, 62));
    assert.ok(!mid.includes("Resets"), "Resets column should drop at 62 cols");
    assert.ok(!/23000/.test(mid), "Left column should drop at 62 cols");
    assert.match(mid, /5000 \/ 28000/);
    assert.match(mid, /MCP monthly quota/);
    // Narrow: Usage bar column also dropped, percentages stay, labels truncate.
    const narrow = stripAnsi(formatProviderDetail(s, ctx, 40));
    assert.ok(!/\[#-/.test(narrow), "bar column should drop at 40 cols");
    assert.match(narrow, /MCP/);
    assert.match(narrow, /18%/);
    // Very narrow: header drops its refreshed suffix too.
    const tiny = stripAnsi(formatProviderDetail(s, ctx, 30));
    assert.ok(!tiny.includes("refreshed"), "refreshed should drop from the header at 30 cols");
    // Every line respects the width budget.
    for (const line of [...narrow.split("\n"), ...tiny.split("\n")]) {
      assert.ok(line.length <= 40, `line too long (${line.length}): ${line}`);
    }
    // All table rows share one width (no ragged columns).
    for (const text of [wide, mid, narrow, tiny]) {
      const rows = text.split("\n").filter((l) => l.trim().startsWith("|"));
      assert.equal(new Set(rows.map((l) => l.length)).size, 1);
    }
  });
});

describe("formatSummary", () => {
  it("lists each provider", () => {
    const out = formatSummary([snap()], ctx);
    assert.match(out, /GLM \(zai\) — 5h 32% · MCP 18%/);
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
