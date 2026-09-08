// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKimiProvider, KIMI_ALLOWED_HOSTS } from "../src/providers/kimi.js";
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

const AUTH: ProviderAuth = { baseUrl: "https://api.kimi.com/coding", apiKey: "tok" };

/** Confirmed response shape from the official CLI's /usage endpoint. */
function usageBody(): unknown {
  return {
    usage: {
      limit: "100",
      used: "26",
      remaining: "74",
      resetTime: "2026-08-11T15:53:05.519605Z",
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "27", remaining: "73", resetTime: "2026-08-08T14:53:05.519605Z" },
      },
    ],
  };
}

describe("KimiProvider - happy path", () => {
  it("parses weekly and 5-hour quotas from string numbers", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url) => res(200, usageBody())),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.provider, "kimi");
    assert.equal(snap.error, undefined);
    assert.deepEqual(snap.quotas.map((q) => q.id), ["five_hour", "weekly"]);
    const fiveHour = snap.quotas[0];
    assert.equal(fiveHour?.label, "5-hour quota");
    assert.equal(fiveHour?.used, 27);
    assert.equal(fiveHour?.limit, 100);
    assert.equal(fiveHour?.remaining, 73);
    assert.equal(fiveHour?.percentage, 27);
    assert.equal(fiveHour?.resetAt, "2026-08-08T14:53:05.519605Z");
    const weekly = snap.quotas[1];
    assert.equal(weekly?.label, "Weekly quota");
    assert.equal(weekly?.used, 26);
    assert.equal(weekly?.limit, 100);
    assert.equal(weekly?.remaining, 74);
    assert.equal(weekly?.percentage, 26);
    assert.equal(weekly?.resetAt, "2026-08-11T15:53:05.519605Z");
  });

  it("derives used from limit - remaining when used is missing", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, {
          usage: { limit: "1000", remaining: "610" },
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
              detail: { limit: "100", remaining: "100", resetTime: "2026-07-31T17:01:45Z" },
            },
          ],
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas.map((q) => q.id), ["five_hour", "weekly"]);
    assert.equal(snap.quotas[1]?.used, 390);
    assert.equal(snap.quotas[1]?.percentage, 39);
    assert.equal(snap.quotas[0]?.used, 0);
    assert.equal(snap.quotas[0]?.percentage, 0);
  });

  it("recognizes the 5-hour window across timeUnit variants", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, {
          usage: { limit: "100", used: "10" },
          limits: [
            { window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "50", used: "5" } },
          ],
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas.map((q) => q.id), ["five_hour", "weekly"]);
  });

  it("sends the token as a Bearer header and queries the official endpoint", async () => {
    let seenAuth = "";
    let seenUrl = "";
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url, init) => {
        seenUrl = url;
        seenAuth = (init.headers as Record<string, string>)["Authorization"] ?? "";
        return res(200, usageBody());
      }),
    });
    await provider.getUsage();
    assert.equal(seenUrl, "https://api.kimi.com/coding/v1/usages");
    assert.equal(seenAuth, "Bearer tok");
  });

  it("does not double the Bearer prefix when the token already carries one", async () => {
    let seenAuth = "";
    const provider = createKimiProvider({
      resolveAuth: async () => ({ baseUrl: AUTH.baseUrl, apiKey: "Bearer tok" }),
      now: () => FIXED,
      fetchImpl: makeFetch((_url, init) => {
        seenAuth = (init.headers as Record<string, string>)["Authorization"] ?? "";
        return res(200, usageBody());
      }),
    });
    await provider.getUsage();
    assert.equal(seenAuth, "Bearer tok");
  });
});

describe("KimiProvider - degraded parsing", () => {
  it("empty object -> no quotas, no error", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, {})),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas, []);
    assert.equal(snap.error, undefined);
  });

  it("reset field drift (resetAt / reset_at) is tolerated", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, {
          usage: { limit: "100", used: "26", resetAt: "2026-08-11T15:53:05Z" },
          limits: [
            { detail: { limit: "100", used: "27", reset_at: "2026-08-08T14:53:05Z" }, window: { duration: 300 } },
          ],
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.quotas[1]?.resetAt, "2026-08-11T15:53:05Z");
    assert.equal(snap.quotas[0]?.resetAt, "2026-08-08T14:53:05Z");
  });

  it("a limit row without a window descriptor is kept only when named", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, {
          limits: [
            { detail: { limit: "10", used: "1" } },
            { detail: { name: "Monthly limit", limit: "300", used: "12" } },
          ],
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas.map((q) => q.id), ["monthly_limit"]);
    assert.equal(snap.quotas[0]?.label, "Monthly limit");
    assert.equal(snap.quotas[0]?.percentage, 4);
  });

  it("unknown unnamed windows are dropped; limits without detail parse inline", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, {
          usage: { limit: "100", used: "26" },
          limits: [
            { window: { duration: 1440, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "9", used: "1" } },
            { limit: "7", used: "2" }, // no window, no name
          ],
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas.map((q) => q.id), ["weekly"]);
  });

  it("rows without any numeric field are ignored", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, { usage: { name: "Weekly limit" }, limits: [{ detail: {} }] })),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas, []);
    assert.equal(snap.error, undefined);
  });
});

describe("KimiProvider - failures", () => {
  it("401 -> auth error, no body leak", async () => {
    const leak = "body_token_should_not_leak_abc";
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(401, { detail: leak })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Auth);
    assert.deepEqual(snap.quotas, []);
    assert.equal(JSON.stringify(snap).includes(leak), false);
  });

  it("429 -> rate limited; 502 -> server error", async () => {
    for (const [status, code] of [
      [429, UsageErrorCode.RateLimited],
      [502, UsageErrorCode.ServerError],
    ] as const) {
      const provider = createKimiProvider({
        resolveAuth: async () => AUTH,
        now: () => FIXED,
        fetchImpl: makeFetch(() => res(status, {})),
      });
      const snap = await provider.getUsage();
      assert.equal(snap.error?.code, code);
      assert.equal(snap.error?.httpStatus, status);
    }
  });

  it("invalid json -> invalid_json error", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, undefined, { jsonThrow: true })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.InvalidJson);
  });

  it("timeout -> timeout error", { timeout: 2000 }, async () => {
    const provider = createKimiProvider({
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
    const provider = createKimiProvider({
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
    const provider = createKimiProvider({
      resolveAuth: async () => ({ baseUrl: "https://evil.example.com/coding", apiKey: "tok" }),
      now: () => FIXED,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Allowlist);
  });

  it("never leaks the auth token in the snapshot", async () => {
    const token = "supersecrettokenK1234567890abc";
    const provider = createKimiProvider({
      resolveAuth: async () => ({ baseUrl: "https://api.kimi.com/coding", apiKey: token }),
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, usageBody())),
    });
    const snap = await provider.getUsage();
    assert.equal(JSON.stringify(snap).includes(token), false);
  });
});

describe("KimiProvider - isAvailable", () => {
  it("true when auth resolves to an allowlisted host", async () => {
    const provider = createKimiProvider({ resolveAuth: async () => AUTH });
    assert.equal(await provider.isAvailable(), true);
  });

  it("false when auth is missing", async () => {
    const provider = createKimiProvider({ resolveAuth: async () => undefined });
    assert.equal(await provider.isAvailable(), false);
  });

  it("false when host is not allowlisted", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => ({ baseUrl: "https://evil.example.com", apiKey: "tok" }),
    });
    assert.equal(await provider.isAvailable(), false);
  });
});

describe("KimiProvider - allowlist", () => {
  it("exposes the official host allowlist", () => {
    assert.deepEqual([...KIMI_ALLOWED_HOSTS], ["api.kimi.com"]);
  });
});
