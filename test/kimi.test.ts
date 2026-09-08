// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKimiProvider, KIMI_ALLOWED_HOSTS, parseUsages } from "../src/providers/kimi.js";
import { UsageErrorCode } from "../src/providers/types.js";
import type { ProviderAuth, UsageSnapshot } from "../src/providers/types.js";

const FIXED = new Date(2026, 7, 15, 9, 43, 0);

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

const AUTH: ProviderAuth = { baseUrl: "https://api.kimi.com/coding/v1", apiKey: "sk-kimi-test" };

/** Live fixture shape (overseas plan, healthy account): string numbers,
 * `resetTime` with fractional seconds, proto-style `TIME_UNIT_*` enums. */
const HEALTHY_BODY = {
  user: { userId: "u1", region: "REGION_OVERSEA", membership: "basic" },
  usage: { limit: "1000", used: "40", resetTime: "2026-08-20T09:59:07.479363Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "1", resetTime: "2026-08-15T13:59:07.479363Z" },
    },
  ],
  parallel: { limit: "20" },
  totalQuota: { limit: "100", remaining: "99" },
  authentication: { method: "METHOD_ACCESS_TOKEN", scope: "FEATURE_CODING" },
  subType: "TYPE_PURCHASE",
};

/** Frozen account shape: `totalQuota.used` present and > 0 (monthly
 * membership total reached, coding quota frozen). */
const FROZEN_BODY = {
  usage: { limit: "1000", used: "1000", resetTime: "2026-08-20T09:59:07.479363Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "100", resetTime: "2026-08-15T13:59:07.479363Z" },
    },
  ],
  totalQuota: { limit: "100", used: "1", remaining: "99" },
};

describe("KimiProvider - happy path", () => {
  it("parses the healthy fixture into 5h + weekly + membership rows in order", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url, init) => {
        seenUrl = url;
        seenInit = init;
        return res(200, HEALTHY_BODY);
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.provider, "kimi");
    assert.equal(snap.error, undefined);
    assert.equal(seenUrl, "https://api.kimi.com/coding/v1/usages");
    assert.match((seenInit.headers as Record<string, string>).Authorization ?? "", /^Bearer sk-kimi-test$/);
    assert.deepEqual(snap.quotas.map((q) => q.id), ["five_hour", "weekly", "membership"]);

    const fiveHour = snap.quotas[0]!;
    assert.equal(fiveHour.label, "5-hour limit");
    assert.equal(fiveHour.used, 1);
    assert.equal(fiveHour.limit, 100);
    assert.equal(fiveHour.percentage, 1);
    assert.equal(fiveHour.resetAt, "2026-08-15T13:59:07.479363Z");

    const weekly = snap.quotas[1]!;
    assert.equal(weekly.label, "Weekly limit");
    assert.equal(weekly.used, 40);
    assert.equal(weekly.limit, 1000);
    assert.equal(weekly.percentage, 4);
    assert.equal(weekly.resetAt, "2026-08-20T09:59:07.479363Z");

    const membership = snap.quotas[2]!;
    assert.equal(membership.label, "Monthly membership");
    assert.equal(membership.percentage, 0);
    assert.equal(membership.used, undefined);
    assert.equal(membership.limit, undefined);
    assert.equal(membership.remaining, undefined);
  });

  it("maps the frozen fixture to a red 100% membership row", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, FROZEN_BODY)),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error, undefined);
    const membership = snap.quotas.find((q) => q.id === "membership")!;
    assert.equal(membership.percentage, 100);
    assert.equal(membership.used, undefined);
    assert.equal(membership.remaining, undefined);
  });

  it("derives the canonical usage URL from the origin (trailing-slash base url)", async () => {
    let seenUrl = "";
    const provider = createKimiProvider({
      resolveAuth: async () => ({ baseUrl: "https://api.kimi.ai/coding/v1/", apiKey: "sk-kimi-test" }),
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        seenUrl = url;
        return res(200, HEALTHY_BODY);
      }),
    });
    await provider.getUsage();
    assert.equal(seenUrl, "https://api.kimi.ai/coding/v1/usages");
  });

  it("requests /coding/v1/usages when the configured base url lacks /v1 (Pi built-in kimi-coding entry)", async () => {
    let seenUrl = "";
    const provider = createKimiProvider({
      resolveAuth: async () => ({ baseUrl: "https://api.kimi.com/coding", apiKey: "sk-kimi-test" }),
      now: () => FIXED,
      fetchImpl: makeFetch((url) => {
        seenUrl = url;
        return res(200, HEALTHY_BODY);
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error, undefined);
    assert.equal(seenUrl, "https://api.kimi.com/coding/v1/usages");
  });

  it("isAvailable resolves true for official hosts with auth", async () => {
    for (const host of ["api.kimi.com", "api.kimi.ai"]) {
      const provider = createKimiProvider({
        resolveAuth: async () => ({ baseUrl: `https://${host}/coding/v1`, apiKey: "sk-kimi-test" }),
      });
      assert.equal(await provider.isAvailable(), true, host);
    }
  });

  it("isAvailable resolves false for proxy/mirror hosts", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => ({ baseUrl: "https://kimi.proxy.example.com/coding/v1", apiKey: "sk-kimi-test" }),
    });
    assert.equal(await provider.isAvailable(), false);
  });

  it("allowlist contains only the official managed hosts", () => {
    assert.deepEqual([...KIMI_ALLOWED_HOSTS], ["api.kimi.com", "api.kimi.ai"]);
  });
});

describe("KimiProvider - defensive parsing", () => {
  it("derives used from limit - remaining when used is absent", () => {
    const quotas = parseUsages({
      usage: { limit: "1000", remaining: "600", resetTime: "2026-08-20T09:59:07Z" },
    });
    assert.equal(quotas.length, 1);
    assert.equal(quotas[0]!.id, "weekly");
    assert.equal(quotas[0]!.used, 400);
    assert.equal(quotas[0]!.remaining, 600);
    assert.equal(quotas[0]!.percentage, 40);
  });

  it("folds 300-minute windows to 5 hours and derives stable ids for others", () => {
    const quotas = parseUsages({
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "1" },
        },
        {
          window: { duration: 1440, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "200", remaining: "100" },
        },
      ],
    });
    assert.deepEqual(quotas.map((q) => q.id), ["five_hour", "window_24_hour"]);
    assert.equal(quotas[1]!.label, "24 hour limit");
    assert.equal(quotas[1]!.used, 100);
  });

  it("membership never derives usage from the sticky remaining field", () => {
    const quotas = parseUsages({ totalQuota: { limit: "100", used: "1", remaining: "99" } });
    const membership = quotas[0]!;
    assert.equal(membership.percentage, 100);
    assert.equal(membership.used, undefined);
    assert.equal(membership.remaining, undefined);
    assert.equal(membership.limit, undefined);
  });

  it("parses booster wallet with monthly cap details when present", () => {
    const quotas = parseUsages({
      boosterWallet: {
        balance: { type: "BOOSTER", amount: 4_200_000_000, amountLeft: 2_100_000_000 },
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimit: { priceInCents: 5_000, currency: "USD" },
        monthlyUsed: { priceInCents: 1_000, currency: "USD" },
      },
    });
    assert.equal(quotas.length, 1);
    const booster = quotas[0]!;
    assert.equal(booster.id, "booster");
    assert.equal(booster.label, "Booster wallet (USD)");
    // Fixed point 1e6 per cent: amountLeft 2_100_000_000 -> 2100 cents -> 21.0.
    assert.equal(booster.remaining, 21);
    assert.equal(booster.used, 21);
    assert.equal(booster.limit, 42);
    const cap = booster.details?.[0]!;
    assert.equal(cap.id, "monthly_cap");
    assert.equal(cap.used, 10);
    assert.equal(cap.limit, 50);
  });

  it("omits invalid or missing booster wallets silently", () => {
    assert.deepEqual(parseUsages({ usage: { limit: "10", used: "1" } }).map((q) => q.id), ["weekly"]);
    assert.deepEqual(parseUsages({ boosterWallet: { balance: { type: "OTHER", amount: "100" } } }), []);
    assert.deepEqual(parseUsages({ boosterWallet: { balance: { type: "BOOSTER", amount: "0" } } }), []);
  });

  it("skips unknown windows and ignores unknown fields", () => {
    const quotas = parseUsages({
      usage: { limit: "10", used: "1", futureField: { nested: true } },
      limits: [{ window: { duration: 7, timeUnit: "TIME_UNIT_FORTNIGHT" }, detail: { limit: "1", used: "1" } }],
      newTopLevelThing: 42,
    });
    assert.deepEqual(quotas.map((q) => q.id), ["weekly"]);
  });

  it("yields no quotas for empty or malformed payloads", () => {
    assert.deepEqual(parseUsages({}), []);
    assert.deepEqual(parseUsages(null), []);
    assert.deepEqual(parseUsages("nope"), []);
  });
});

describe("KimiProvider - failures", () => {
  it("missing auth fails closed", async () => {
    const provider = createKimiProvider({ resolveAuth: async () => undefined, now: () => FIXED });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Unavailable);
    assert.equal(snap.quotas.length, 0);
  });

  it("throwing auth resolver fails closed", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => {
        throw new Error("boom");
      },
      now: () => FIXED,
    });
    assert.equal(await provider.isAvailable(), false);
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Unavailable);
  });

  it("non-allowlisted host is rejected without any request", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => ({ baseUrl: "https://kimi.proxy.example.com/coding/v1", apiKey: "sk-kimi-test" }),
      now: () => FIXED,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Allowlist);
  });

  it("non-https base url is rejected", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => ({ baseUrl: "http://api.kimi.com/coding/v1", apiKey: "sk-kimi-test" }),
      now: () => FIXED,
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.UnsafeUrl);
  });

  it("401 maps to auth_failed", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(401, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Auth);
    assert.equal(snap.error?.httpStatus, 401);
  });

  it("403 maps to forbidden", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(403, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Forbidden);
  });

  it("429 maps to rate_limited", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(429, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.RateLimited);
  });

  it("5xx maps to server_error", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(503, {})),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.ServerError);
  });

  it("network failure maps to network", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Network);
  });

  it("timeout maps to timeout", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => {
        throw new Error("request timed out");
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Timeout);
  });

  it("invalid json maps to invalid_json", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, {}, { jsonThrow: true })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.InvalidJson);
  });

  it("payload without usable fields maps to schema_error", async () => {
    const provider = createKimiProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, { authentication: { method: "METHOD_ACCESS_TOKEN" } })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Schema);
  });
});

describe("KimiProvider - redaction", () => {
  it("never leaks the api key into snapshots or errors", async () => {
    const seen: (UsageSnapshot | undefined)[] = [];
    for (const body of [
      () => res(200, HEALTHY_BODY),
      () => res(401, {}),
      () => res(200, {}, { jsonThrow: true }),
    ]) {
      const provider = createKimiProvider({
        resolveAuth: async () => AUTH,
        now: () => FIXED,
        fetchImpl: makeFetch(() => body()),
      });
      const snap = await provider.getUsage();
      seen.push(snap);
      assert.equal(JSON.stringify(snap).includes("sk-kimi-test"), false);
    }
    assert.equal(seen.length, 3);
  });
});
