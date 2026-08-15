// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createZaiProvider, ZAI_ALLOWED_HOSTS } from "../src/providers/zai.js";
import { UsageErrorCode } from "../src/providers/types.js";
import type { ProviderAuth } from "../src/providers/types.js";

const FIXED = new Date(2025, 4, 14, 10, 30, 45);

function res(status: number, body: unknown, opts: { jsonThrow?: boolean } = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map<string, string>() as unknown as Headers,
    async json(): Promise<unknown> {
      if (opts.jsonThrow) throw new SyntaxError("bad");
      return body;
    },
  } as unknown as Response;
}

type RouteHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

function makeFetch(handler: RouteHandler): typeof fetch {
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    Promise.resolve(handler(typeof input === "string" ? input : String(input), (init ?? {}) as RequestInit));
  return fn as unknown as typeof fetch;
}

const AUTH: ProviderAuth = { baseUrl: "https://api.z.ai/api/anthropic", apiKey: "tok" };

function quotaBody(limits: unknown[]): unknown {
  return { data: { limits } };
}

describe("ZaiProvider - happy path", () => {
  it("parses quotas and models", async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.includes("/quota/limit"))
          return res(200, quotaBody([
            { type: "TOKENS_LIMIT", percentage: 32 },
            {
              type: "TIME_LIMIT",
              percentage: 18,
              currentValue: 5000,
              usage: 28000,
              usageDetails: [
                { toolName: "web_search", currentValue: 3000, usage: 28000 },
                { toolName: "web_reader", currentValue: 2000 },
              ],
            },
          ]));
        if (url.includes("/model-usage"))
          return res(200, { data: [{ model: "glm-4.6", used: 1000, percentage: 5 }] });
        if (url.includes("/tool-usage"))
          return res(200, { data: [{ model: "glm-4.6", count: 50 }] });
        return res(404, {});
      }),
    });

    const snap = await provider.getUsage();
    assert.equal(snap.provider, "zai");
    assert.equal(snap.error, undefined);
    assert.equal(snap.quotas.length, 2);
    const fiveHour = snap.quotas.find((q) => q.id === "five_hour");
    const monthly = snap.quotas.find((q) => q.id === "monthly");
    assert.equal(fiveHour?.percentage, 32);
    assert.equal(monthly?.percentage, 18);
    assert.equal(monthly?.used, 5000);
    assert.equal(monthly?.limit, 28000);
    assert.equal(monthly?.remaining, 23000);
    assert.equal(monthly?.label, "MCP monthly quota");
    assert.equal(monthly?.details?.length, 2);
    const search = monthly?.details?.[0];
    assert.equal(search?.id, "web_search");
    assert.equal(search?.used, 3000);
    assert.equal(search?.limit, 28000);
    assert.equal(search?.remaining, 25000);
    assert.equal(search?.percentage, 10.7);
    const reader = monthly?.details?.[1];
    assert.equal(reader?.used, 2000);
    assert.equal(reader?.limit, 28000);
    assert.ok(snap.models);
    assert.equal(snap.models?.[0]?.model, "glm-4.6");
    assert.equal(snap.models?.[0]?.used, 1000);
  });

  it("dedupes models by name (first wins)", async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.includes("/quota/limit")) return res(200, quotaBody([]));
        if (url.includes("/model-usage")) return res(200, { data: [{ model: "m1", used: 10 }] });
        if (url.includes("/tool-usage")) return res(200, { data: [{ model: "m1", used: 99 }] });
        return res(404, {});
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.models?.length, 1);
    assert.equal(snap.models?.[0]?.used, 10);
  });
});

describe("ZaiProvider - degraded parsing", () => {
  it("empty/missing limits -> no quotas, no error", async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.includes("/quota/limit")) return res(200, { data: {} });
        if (url.includes("usage")) return res(200, { data: [] });
        return res(404, {});
      }),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas, []);
    assert.equal(snap.error, undefined);
    assert.equal(snap.models, undefined);
  });

  it("skips limit items without a known type", async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.includes("/quota/limit"))
          return res(200, quotaBody([{ foo: "bar" }, { type: "UNKNOWN_TYPE", percentage: 7 }]));
        return res(200, { data: [] });
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.quotas.length, 1);
    assert.equal(snap.quotas[0]?.id, "unknown_type");
    assert.equal(snap.quotas[0]?.percentage, 7);
  });

  it("non-array model usage -> no models", async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.includes("/quota/limit")) return res(200, quotaBody([]));
        if (url.includes("usage")) return res(200, { data: "not-an-array" });
        return res(404, {});
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.models, undefined);
    assert.equal(snap.error, undefined);
  });
});

describe("ZaiProvider - failures", () => {
  it("quota 401 -> auth error, no leak", async () => {
    const leak = "body_token_should_not_leak_abc";
    const provider = createZaiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.includes("/quota/limit")) return res(401, { detail: leak });
        return res(200, { data: [] });
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Auth);
    assert.deepEqual(snap.quotas, []);
    assert.equal(JSON.stringify(snap).includes(leak), false);
  });

  it("timeout -> timeout error", { timeout: 2000 }, async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      timeoutMs: 30,
      fetchImpl: makeFetch((_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Timeout);
  });

  it("no auth -> unavailable", async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => undefined,
      now: () => FIXED,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Unavailable);
  });

  it("non-allowlist base url -> allowlist error (no network)", async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => ({ baseUrl: "https://evil.example.com/api/anthropic", apiKey: "tok" }),
      now: () => FIXED,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Allowlist);
  });

  it("never leaks the auth token in the snapshot", async () => {
    const token = "supersecrettokenZ1234567890abc";
    const provider = createZaiProvider({
      resolveAuth: async () => ({ baseUrl: "https://api.z.ai/api/anthropic", apiKey: token }),
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.includes("/quota/limit"))
          return res(200, quotaBody([{ type: "TOKENS_LIMIT", percentage: 40 }]));
        return res(200, { data: [] });
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(JSON.stringify(snap).includes(token), false);
  });
});

describe("ZaiProvider - isAvailable", () => {
  it("true when auth resolves to an allowlisted host", async () => {
    const provider = createZaiProvider({ resolveAuth: async () => AUTH });
    assert.equal(await provider.isAvailable(), true);
  });

  it("false when auth is missing", async () => {
    const provider = createZaiProvider({ resolveAuth: async () => undefined });
    assert.equal(await provider.isAvailable(), false);
  });

  it("false when host is not allowlisted", async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => ({ baseUrl: "https://evil.example.com", apiKey: "tok" }),
    });
    assert.equal(await provider.isAvailable(), false);
  });
});

describe("ZaiProvider - allowlist", () => {
  it("exposes the official host allowlist", () => {
    assert.deepEqual([...ZAI_ALLOWED_HOSTS], ["api.z.ai", "open.bigmodel.cn", "dev.bigmodel.cn"]);
  });
});
