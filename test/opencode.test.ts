// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeProvider, OPENCODE_ALLOWED_HOSTS } from "../src/providers/opencode.js";
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

const AUTH: ProviderAuth = { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "tok" };

/** Confirmed response shape from the issue report. */
function usageBody(): unknown {
  return {
    usage: {
      rolling: { status: "ok", percent: 10, resetsAt: "2026-09-08T07:40:24.807Z" },
      weekly: { status: "ok", percent: 6, resetsAt: "2026-09-14T00:00:00.807Z" },
      monthly: { status: "ok", percent: 6, resetsAt: "2026-10-04T15:04:56.807Z" },
    },
  };
}

describe("OpenCodeProvider - happy path", () => {
  it("parses rolling/weekly/monthly windows with deterministic order", async () => {
    const provider = createOpenCodeProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, usageBody())),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.provider, "opencode");
    assert.equal(snap.error, undefined);
    assert.deepEqual(snap.quotas.map((q) => q.id), ["five_hour", "weekly", "monthly"]);
    const fiveHour = snap.quotas[0];
    assert.equal(fiveHour?.label, "5-hour quota");
    assert.equal(fiveHour?.percentage, 10);
    assert.equal(fiveHour?.resetAt, "2026-09-08T07:40:24.807Z");
    assert.equal(fiveHour?.used, undefined);
    assert.equal(fiveHour?.limit, undefined);
    const weekly = snap.quotas[1];
    assert.equal(weekly?.label, "Weekly quota");
    assert.equal(weekly?.percentage, 6);
    const monthly = snap.quotas[2];
    assert.equal(monthly?.label, "Monthly quota");
    assert.equal(monthly?.resetAt, "2026-10-04T15:04:56.807Z");
  });

  it("sends the API key as a Bearer header and queries the documented endpoint", async () => {
    let seenAuth = "";
    let seenUrl = "";
    const provider = createOpenCodeProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch((url, init) => {
        seenUrl = url;
        seenAuth = (init.headers as Record<string, string>)["Authorization"] ?? "";
        return res(200, usageBody());
      }),
    });
    await provider.getUsage();
    assert.equal(seenUrl, "https://opencode.ai/zen/go/v1/usage");
    assert.equal(seenAuth, "Bearer tok");
  });

  it("does not double the Bearer prefix when the token already carries one", async () => {
    let seenAuth = "";
    const provider = createOpenCodeProvider({
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

  it("percent arrives as numeric string is tolerated", async () => {
    const provider = createOpenCodeProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, {
          usage: {
            rolling: { status: "ok", percent: "42", resetsAt: "2026-09-08T07:40:24Z" },
          },
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.quotas[0]?.percentage, 42);
  });
});

describe("OpenCodeProvider - degraded parsing", () => {
  it("empty object -> no quotas, no error", async () => {
    const provider = createOpenCodeProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, {})),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas, []);
    assert.equal(snap.error, undefined);
  });

  it("reset field drift (resetAt / reset_at) is tolerated", async () => {
    const provider = createOpenCodeProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, {
          usage: {
            weekly: { status: "ok", percent: 6, resetAt: "2026-09-14T00:00:00Z" },
            monthly: { status: "ok", percent: 6, reset_at: "2026-10-04T15:04:56Z" },
          },
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.quotas[0]?.resetAt, "2026-09-14T00:00:00Z");
    assert.equal(snap.quotas[1]?.resetAt, "2026-10-04T15:04:56Z");
  });

  it("unknown windows are kept slugged only when a percentage exists", async () => {
    const provider = createOpenCodeProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, {
          usage: {
            rolling: { status: "ok", percent: 10 },
            daily: { status: "ok", percent: 3, resetsAt: "2026-09-09T00:00:00Z" },
            mystery: { status: "ok" },
          },
        }),
      ),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas.map((q) => q.id), ["five_hour", "daily"]);
    assert.equal(snap.quotas[1]?.label, "daily");
  });

  it("windows without any numeric field are ignored", async () => {
    const provider = createOpenCodeProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, { usage: { rolling: { status: "ok" } } })),
    });
    const snap = await provider.getUsage();
    assert.deepEqual(snap.quotas, []);
    assert.equal(snap.error, undefined);
  });

  it("out-of-range percentages are clamped", async () => {
    const provider = createOpenCodeProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() =>
        res(200, { usage: { rolling: { percent: 150 }, monthly: { percent: -3 } } }),
      ),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.quotas[0]?.percentage, 100);
    assert.equal(snap.quotas[1]?.percentage, 0);
  });
});

describe("OpenCodeProvider - failures", () => {
  it("401 -> auth error, no body leak", async () => {
    const leak = "body_token_should_not_leak_abc";
    const provider = createOpenCodeProvider({
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
      const provider = createOpenCodeProvider({
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
    const provider = createOpenCodeProvider({
      resolveAuth: async () => AUTH,
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, undefined, { jsonThrow: true })),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.InvalidJson);
  });

  it("timeout -> timeout error", { timeout: 2000 }, async () => {
    const provider = createOpenCodeProvider({
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
    const provider = createOpenCodeProvider({
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
    const provider = createOpenCodeProvider({
      resolveAuth: async () => ({ baseUrl: "https://evil.example.com/zen/go/v1", apiKey: "tok" }),
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
    const provider = createOpenCodeProvider({
      resolveAuth: async () => ({ baseUrl: "https://opencode.ai/zen/go/v1", apiKey: token }),
      now: () => FIXED,
      fetchImpl: makeFetch(() => res(200, usageBody())),
    });
    const snap = await provider.getUsage();
    assert.equal(JSON.stringify(snap).includes(token), false);
  });
});

describe("OpenCodeProvider - isAvailable", () => {
  it("true when auth resolves to an allowlisted host", async () => {
    const provider = createOpenCodeProvider({ resolveAuth: async () => AUTH });
    assert.equal(await provider.isAvailable(), true);
  });

  it("false when auth is missing", async () => {
    const provider = createOpenCodeProvider({ resolveAuth: async () => undefined });
    assert.equal(await provider.isAvailable(), false);
  });

  it("false when host is not allowlisted", async () => {
    const provider = createOpenCodeProvider({
      resolveAuth: async () => ({ baseUrl: "https://evil.example.com", apiKey: "tok" }),
    });
    assert.equal(await provider.isAvailable(), false);
  });
});

describe("OpenCodeProvider - allowlist", () => {
  it("exposes the official host allowlist", () => {
    assert.deepEqual([...OPENCODE_ALLOWED_HOSTS], ["opencode.ai"]);
  });
});
