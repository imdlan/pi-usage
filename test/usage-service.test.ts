// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "../src/providers/registry.js";
import { UsageService } from "../src/services/usage-service.js";
import { UsageErrorCode } from "../src/providers/types.js";
import type { UsageProvider, UsageSnapshot } from "../src/providers/types.js";

function okSnap(pct: number): UsageSnapshot {
  return {
    provider: "mock",
    timestamp: new Date(0).toISOString(),
    quotas: [{ id: "five_hour", label: "5-hour quota", percentage: pct }],
  };
}

function errSnap(code: UsageErrorCode = UsageErrorCode.Network): UsageSnapshot {
  return {
    provider: "mock",
    timestamp: new Date(0).toISOString(),
    quotas: [],
    error: { code, message: "fail" },
  };
}

interface Mock {
  provider: UsageProvider;
  calls: () => number;
}

/** Provider that returns from a queue (last result repeats); tracks getUsage calls. */
function mockProvider(id: string, results: UsageSnapshot[], opts: { delayMs?: number } = {}): Mock {
  let calls = 0;
  let i = 0;
  const provider: UsageProvider = {
    id,
    name: id.toUpperCase(),
    isAvailable: async () => true,
    getUsage: async () => {
      calls++;
      const idx = Math.min(i, results.length - 1);
      const r = results[idx];
      if (!r) throw new Error("mock misconfigured");
      i++;
      if (opts.delayMs) await new Promise((res) => setTimeout(res, opts.delayMs));
      return r;
    },
  };
  return { provider, calls: () => calls };
}

function makeService(mock: Mock, ttlMs = 1000, now: () => Date = () => new Date(5000)) {
  const registry = new ProviderRegistry();
  registry.register(mock.provider);
  return new UsageService({ registry, ttlMs, now });
}

describe("UsageService - cache hit", () => {
  it("serves a valid cache without calling the provider again", async () => {
    const mock = mockProvider("mock", [okSnap(30)]);
    const svc = makeService(mock);
    const a = await svc.getUsage("mock");
    const b = await svc.getUsage("mock");
    assert.equal(mock.calls(), 1);
    assert.equal(a.quotas[0]?.percentage, 30);
    assert.equal(b.quotas[0]?.percentage, 30);
  });
});

describe("UsageService - cache expiry", () => {
  it("refetches after the TTL elapses", async () => {
    let t = 1000;
    const clock = () => new Date(t);
    const mock = mockProvider("mock", [okSnap(30), okSnap(60)]);
    const svc = makeService(mock, 1000, clock);
    await svc.getUsage("mock");
    t += 2000; // past TTL
    const b = await svc.getUsage("mock");
    assert.equal(mock.calls(), 2);
    assert.equal(b.quotas[0]?.percentage, 60);
  });
});

describe("UsageService - force refresh", () => {
  it("bypasses a valid cache", async () => {
    const mock = mockProvider("mock", [okSnap(30), okSnap(70)]);
    const svc = makeService(mock);
    await svc.getUsage("mock");
    const b = await svc.getUsage("mock", { forceRefresh: true });
    assert.equal(mock.calls(), 2);
    assert.equal(b.quotas[0]?.percentage, 70);
  });

  it("forceRefresh reuses an in-flight request (no duplicate call)", async () => {
    const mock = mockProvider("mock", [okSnap(30)], { delayMs: 20 });
    const svc = makeService(mock);
    const [a, b] = await Promise.all([
      svc.getUsage("mock", { forceRefresh: true }),
      svc.getUsage("mock", { forceRefresh: true }),
    ]);
    assert.equal(mock.calls(), 1);
    assert.deepEqual(a, b);
  });
});

describe("UsageService - failure fallback", () => {
  it("returns the error snapshot when there is no prior good data", async () => {
    const mock = mockProvider("mock", [errSnap(UsageErrorCode.Auth)]);
    const svc = makeService(mock);
    const snap = await svc.getUsage("mock");
    assert.equal(snap.error?.code, UsageErrorCode.Auth);
    assert.equal(snap.stale, undefined);
  });

  it("keeps the last good snapshot and marks it stale on failure", async () => {
    const mock = mockProvider("mock", [okSnap(30), errSnap(UsageErrorCode.Network)]);
    const svc = makeService(mock);
    await svc.getUsage("mock");
    const stale = await svc.getUsage("mock", { forceRefresh: true });
    assert.equal(stale.stale, true);
    assert.equal(stale.error, undefined);
    assert.equal(stale.quotas[0]?.percentage, 30);
  });
});

describe("UsageService - concurrency dedup", () => {
  it("concurrent calls share one in-flight request", async () => {
    const mock = mockProvider("mock", [okSnap(30)], { delayMs: 20 });
    const svc = makeService(mock);
    const [a, b] = await Promise.all([svc.getUsage("mock"), svc.getUsage("mock")]);
    assert.equal(mock.calls(), 1);
    assert.deepEqual(a, b);
  });
});

describe("UsageService - refreshAll & cache info", () => {
  it("refreshes available providers and records last refresh time", async () => {
    const mock = mockProvider("mock", [okSnap(30)]);
    const svc = makeService(mock);
    assert.equal(svc.getLastRefreshAt(), undefined);
    await svc.refreshAll();
    assert.notEqual(svc.getLastRefreshAt(), undefined);
  });

  it("reports cache info", async () => {
    const mock = mockProvider("mock", [okSnap(30), errSnap()]);
    const svc = makeService(mock);
    await svc.getUsage("mock");
    let info = svc.getCacheInfo();
    assert.equal(info[0]?.cached, true);
    assert.equal(info[0]?.hasError, false);
    await svc.getUsage("mock", { forceRefresh: true }); // fails -> stale
    info = svc.getCacheInfo();
    assert.equal(info[0]?.stale, true);
  });

  it("returns unavailable snapshot for unknown provider", async () => {
    const mock = mockProvider("mock", [okSnap(30)]);
    const svc = makeService(mock);
    const snap = await svc.getUsage("nope");
    assert.equal(snap.error?.code, UsageErrorCode.Unavailable);
  });
});
