// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekProvider, DEEPSEEK_ALLOWED_HOSTS } from "../src/providers/deepseek.js";
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

const AUTH: ProviderAuth = { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-test" };

const BALANCE_BODY = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    },
  ],
};

describe("DeepSeekProvider - happy path", () => {
  it("parses balance with currency label and breakdown details", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const provider = createDeepSeekProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url, init) => {
        seenUrl = url;
        seenInit = init;
        return res(200, BALANCE_BODY);
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.provider, "deepseek");
    assert.equal(snap.error, undefined);
    assert.equal(seenUrl, "https://api.deepseek.com/user/balance");
    assert.match((seenInit.headers as Record<string, string>).Authorization ?? "", /^Bearer sk-test$/);
    assert.equal(snap.quotas.length, 1);
    const q = snap.quotas[0]!;
    assert.equal(q.id, "balance_cny");
    assert.equal(q.label, "Balance (CNY)");
    assert.equal(q.remaining, 110);
    assert.deepEqual(
      q.details?.map((d) => ({ id: d.id, used: d.used })),
      [
        { id: "granted", used: 10 },
        { id: "topped_up", used: 100 },
      ],
    );
  });

  it("handles multiple currencies", async () => {
    const provider = createDeepSeekProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, {
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "1.50", granted_balance: "1.50" },
            { currency: "USD", total_balance: "2.25", topped_up_balance: "2.25" },
          ],
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas.map((q) => q.id), ["balance_cny", "balance_usd"]);
  });

  it("isAvailable resolves true with auth + allowed host", async () => {
    const provider = createDeepSeekProvider({ resolveAuth: async () => AUTH });
    assert.equal(await provider.isAvailable(), true);
  });
});

describe("DeepSeekProvider - failures", () => {
  it("missing auth fails closed", async () => {
    const provider = createDeepSeekProvider({ resolveAuth: async () => undefined, now: () => FIXED });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Unavailable);
    assert.equal(snap.quotas.length, 0);
  });

  it("throwing auth resolver fails closed", async () => {
    const provider = createDeepSeekProvider({
      resolveAuth: async () => {
        throw new Error("boom");
      },
      now: () => FIXED,
    });
    assert.equal(await provider.isAvailable(), false);
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Unavailable);
  });

  it("non-allowlisted host is rejected", async () => {
    const provider = createDeepSeekProvider({
      resolveAuth: async () => ({ baseUrl: "https://evil.example.com/v1", apiKey: "sk" }),
      now: () => FIXED,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Allowlist);
  });

  it("non-https base url is rejected", async () => {
    const provider = createDeepSeekProvider({
      resolveAuth: async () => ({ baseUrl: "http://api.deepseek.com/v1", apiKey: "sk" }),
      now: () => FIXED,
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.UnsafeUrl);
  });

  it("401 maps to auth_failed", async () => {
    const provider = createDeepSeekProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(401, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Auth);
    assert.equal(snap.error?.httpStatus, 401);
  });

  it("429 maps to rate_limited", async () => {
    const provider = createDeepSeekProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(429, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.RateLimited);
  });

  it("5xx maps to server_error", async () => {
    const provider = createDeepSeekProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(503, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.ServerError);
  });

  it("invalid json maps to invalid_json", async () => {
    const provider = createDeepSeekProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, {}, { jsonThrow: true })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.InvalidJson);
  });

  it("schema mismatch maps to schema_error", async () => {
    const provider = createDeepSeekProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, { is_available: true })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Schema);
  });

  it("allowlist contains only the official host", () => {
    assert.deepEqual([...DEEPSEEK_ALLOWED_HOSTS], ["api.deepseek.com"]);
  });
});
