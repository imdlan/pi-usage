// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenRouterProvider, OPENROUTER_ALLOWED_HOSTS } from "../src/providers/openrouter.js";
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

const AUTH: ProviderAuth = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-v1-test" };

const KEY_BODY = {
  data: {
    label: "pi",
    usage: 3.0,
    usage_daily: 1.0,
    usage_weekly: 2.5,
    usage_monthly: 3.0,
    limit: 10,
    limit_remaining: 7,
    limit_reset: "2025-05-15T00:00:00.000Z",
    is_free_tier: false,
    rate_limit: { requests: 20, interval: "10s" },
  },
};

const CREDITS_BODY = { data: { total_credits: 50, total_usage: 12.5 } };

describe("OpenRouterProvider - happy path", () => {
  it("queries both endpoints and merges key + credits quotas", async () => {
    const seenUrls: string[] = [];
    let seenInit: RequestInit = {};
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url, init) => {
        seenUrls.push(url);
        seenInit = init;
        if (url.endsWith("/api/v1/key")) return res(200, KEY_BODY);
        return res(200, CREDITS_BODY);
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.provider, "openrouter");
    assert.equal(snap.error, undefined);
    assert.match((seenInit.headers as Record<string, string>).Authorization ?? "", /^Bearer sk-or-v1-test$/);

    assert.deepEqual(snap.quotas.map((q) => q.id), ["key_limit", "usage_windows", "credits"]);

    const cap = snap.quotas[0]!;
    assert.equal(cap.label, "Key spend cap (USD)");
    assert.equal(cap.limit, 10);
    assert.equal(cap.remaining, 7);
    assert.equal(cap.used, 3);
    assert.equal(cap.percentage, 30);
    assert.equal(cap.resetAt, "2025-05-15T00:00:00.000Z");

    const windows = snap.quotas[1]!;
    assert.equal(windows.label, "Spend (USD)");
    assert.deepEqual(
      windows.details?.map((d) => ({ id: d.id, used: d.used })),
      [
        { id: "daily", used: 1 },
        { id: "weekly", used: 2.5 },
        { id: "monthly", used: 3 },
      ],
    );

    const credits = snap.quotas[2]!;
    assert.equal(credits.used, 12.5);
    assert.equal(credits.limit, 50);
    assert.equal(credits.remaining, 37.5);
    assert.equal(credits.percentage, 25);
  });

  it("works when only credits responds (key endpoint downgraded to fallback)", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.endsWith("/api/v1/key")) return res(500, {});
        return res(200, CREDITS_BODY);
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error, undefined);
    assert.deepEqual(snap.quotas.map((q) => q.id), ["credits"]);
  });

  it("null limit (no spend cap) yields usage windows without key_limit quota", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.endsWith("/api/v1/key"))
          return res(200, { data: { usage: 1, usage_daily: 1, limit: null, is_free_tier: true } });
        return res(200, CREDITS_BODY);
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error, undefined);
    assert.ok(!snap.quotas.some((q) => q.id === "key_limit"));
    assert.ok(snap.quotas.some((q) => q.id === "usage_windows"));
    assert.ok(snap.quotas.some((q) => q.id === "credits"));
  });

  it("isAvailable resolves true with auth + allowed host", async () => {
    const provider = createOpenRouterProvider({ resolveAuth: async () => AUTH });
    assert.equal(await provider.isAvailable(), true);
  });
});

describe("OpenRouterProvider - failures", () => {
  it("missing auth fails closed", async () => {
    const provider = createOpenRouterProvider({ resolveAuth: async () => undefined, now: () => FIXED });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Unavailable);
  });

  it("throwing auth resolver fails closed", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => {
        throw new Error("boom");
      },
      now: () => FIXED,
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Unavailable);
  });

  it("non-allowlisted host is rejected", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => ({ baseUrl: "https://evil.example.com/api/v1", apiKey: "sk" }),
      now: () => FIXED,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Allowlist);
  });

  it("non-https base url is rejected", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => ({ baseUrl: "http://openrouter.ai/api/v1", apiKey: "sk" }),
      now: () => FIXED,
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.UnsafeUrl);
  });

  it("both endpoints failing surfaces the key endpoint error", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => res(url.endsWith("/api/v1/key") ? 401 : 429, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Auth);
    assert.equal(snap.error?.httpStatus, 401);
  });

  it("key endpoint 200 with unparseable payload maps to schema_error", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        if (url.endsWith("/api/v1/key")) return res(200, { data: {} });
        return res(200, CREDITS_BODY);
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Schema);
  });

  it("invalid json maps to invalid_json via fallback error surface", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, {}, { jsonThrow: true })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.InvalidJson);
  });

  it("allowlist contains only the official host", () => {
    assert.deepEqual([...OPENROUTER_ALLOWED_HOSTS], ["openrouter.ai"]);
  });
});
