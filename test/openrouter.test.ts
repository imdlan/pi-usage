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

describe("OpenRouterProvider - happy path", () => {
  it("parses credits envelope and computes remaining/percentage", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url, init) => {
        seenUrl = url;
        seenInit = init;
        return res(200, { data: { total_credits: 10, total_usage: 2.5 } });
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.provider, "openrouter");
    assert.equal(snap.error, undefined);
    assert.equal(seenUrl, "https://openrouter.ai/api/v1/credits");
    assert.match((seenInit.headers as Record<string, string>).Authorization ?? "", /^Bearer sk-or-v1-test$/);
    assert.equal(snap.quotas.length, 1);
    const q = snap.quotas[0]!;
    assert.equal(q.id, "credits");
    assert.equal(q.label, "Credits (USD)");
    assert.equal(q.used, 2.5);
    assert.equal(q.limit, 10);
    assert.equal(q.remaining, 7.5);
    assert.equal(q.percentage, 25);
  });

  it("tolerates missing total_credits (usage only)", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, { data: { total_usage: 3 } })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error, undefined);
    assert.equal(snap.quotas[0]?.used, 3);
    assert.equal(snap.quotas[0]?.limit, undefined);
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

  it("401 maps to auth_failed", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(401, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Auth);
  });

  it("402 maps to http_error (out of credits)", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(402, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.HttpStatus);
    assert.equal(snap.error?.httpStatus, 402);
  });

  it("invalid json maps to invalid_json", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, {}, { jsonThrow: true })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.InvalidJson);
  });

  it("schema mismatch maps to schema_error", async () => {
    const provider = createOpenRouterProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, { data: {} })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Schema);
  });

  it("allowlist contains only the official host", () => {
    assert.deepEqual([...OPENROUTER_ALLOWED_HOSTS], ["openrouter.ai"]);
  });
});
