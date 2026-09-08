// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "../src/providers/registry.js";
import { StatusLineService } from "../src/services/status-line.js";
import type { StatusLineSink } from "../src/services/status-line.js";
import { UsageService } from "../src/services/usage-service.js";
import { UsageErrorCode } from "../src/providers/types.js";
import type { UsageProvider, UsageSnapshot } from "../src/providers/types.js";

function snap(id: string, pct: number): UsageSnapshot {
  return {
    provider: id,
    timestamp: new Date(0).toISOString(),
    quotas: [{ id: "five_hour", label: "5-hour quota", percentage: pct }],
  };
}

interface Mock {
  provider: UsageProvider;
  calls: () => number;
}

function mockProvider(id: string, pct: number): Mock {
  let calls = 0;
  const provider: UsageProvider = {
    id,
    name: id.toUpperCase(),
    isAvailable: async () => true,
    getUsage: async () => {
      calls++;
      return snap(id, pct);
    },
  };
  return { provider, calls: () => calls };
}

function makeHarness(mocks: readonly Mock[]) {
  const registry = new ProviderRegistry();
  for (const m of mocks) registry.register(m.provider);
  const service = new UsageService({ registry, ttlMs: 60_000 });
  const written: (string | undefined)[] = [];
  const sink: StatusLineSink = {
    setStatus: (_key, text) => {
      written.push(text);
    },
  };
  const statusLine = new StatusLineService(sink, {
    nameOf: (id) => registry.get(id)?.name ?? id,
  });
  return { service, statusLine, written };
}

describe("StatusLineService - active provider scoping", () => {
  it("queries and renders only the active provider when activeId is given", async () => {
    const glm = mockProvider("zai", 24);
    const kimi = mockProvider("kimi", 40);
    const { service, statusLine, written } = makeHarness([glm, kimi]);

    await statusLine.update(service, { activeId: "kimi" });

    assert.equal(glm.calls(), 0); // 未配置的活跃 provider 不应被访问
    assert.equal(kimi.calls(), 1);
    assert.equal(written.length, 1);
    assert.match(written[0] ?? "", /^KIMI · 5h 40%$/);
    assert.ok(!(written[0] ?? "").includes("ZAI"));
  });

  it("falls back to all available providers when activeId is omitted", async () => {
    const glm = mockProvider("zai", 24);
    const kimi = mockProvider("kimi", 40);
    const { service, statusLine, written } = makeHarness([glm, kimi]);

    await statusLine.update(service);

    assert.equal(glm.calls(), 1);
    assert.equal(kimi.calls(), 1);
    assert.match(written[0] ?? "", /ZAI · 5h 24% \| KIMI · 5h 40%/);
  });

  it("renders an error snapshot for the active provider instead of hiding it", async () => {
    const failing: UsageProvider = {
      id: "kimi",
      name: "KIMI",
      isAvailable: async () => true,
      getUsage: async () => ({
        provider: "kimi",
        timestamp: new Date(0).toISOString(),
        quotas: [],
        error: { code: UsageErrorCode.Network, message: "boom" },
      }),
    };
    const glm = mockProvider("zai", 24);
    const { service, statusLine, written } = makeHarness([glm, { provider: failing, calls: () => 0 }]);

    await statusLine.update(service, { activeId: "kimi" });

    assert.equal(written[0], "KIMI · usage unavailable");
  });

  it("never throws when the service fails; writes a generic fallback", async () => {
    const broken: UsageProvider = {
      id: "zai",
      name: "ZAI",
      isAvailable: async () => true,
      getUsage: async () => {
        throw new Error("boom");
      },
    };
    const { service, statusLine, written } = makeHarness([{ provider: broken, calls: () => 0 }]);

    await statusLine.update(service, { activeId: "zai" });

    assert.equal(written[0], "usage unavailable");
  });
});
