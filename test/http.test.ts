// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { controlledGetJson } from "../src/utils/http.js";
import { UsageErrorCode } from "../src/providers/types.js";

const ALLOW = ["api.z.ai"];

function makeResponse(
  status: number,
  body: unknown,
  opts: { jsonThrow?: boolean } = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map<string, string>() as unknown as Headers,
    async json(): Promise<unknown> {
      if (opts.jsonThrow) throw new SyntaxError("invalid json");
      return body;
    },
  } as unknown as Response;
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function makeFetch(handler: Handler): typeof fetch {
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    return Promise.resolve(handler(url, (init ?? {}) as RequestInit));
  };
  return fn as unknown as typeof fetch;
}

function errCode(r: { ok: false; error: { code: string } }): string {
  return r.error.code;
}

describe("controlledGetJson - success", () => {
  it("parses a 200 JSON body", async () => {
    const fetchImpl = makeFetch((_url, init) => {
      assert.equal(init.redirect, "error");
      assert.equal(init.method, "GET");
      return makeResponse(200, { limits: [] });
    });
    const r = await controlledGetJson<{ limits: unknown[] }>({
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
      allowlist: ALLOW,
      timeoutMs: 1000,
      fetchImpl,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.data, { limits: [] });
  });

  it("passes headers through", async () => {
    const fetchImpl = makeFetch((_url, init) => {
      const h = init.headers as Record<string, string>;
      assert.equal(h["Authorization"], "tok");
      return makeResponse(200, {});
    });
    await controlledGetJson({
      url: "https://api.z.ai/x",
      headers: { Authorization: "tok" },
      allowlist: ALLOW,
      timeoutMs: 1000,
      fetchImpl,
    });
  });
});

describe("controlledGetJson - HTTP status classification", () => {
  for (const [status, code] of [
    [401, UsageErrorCode.Auth],
    [403, UsageErrorCode.Forbidden],
    [429, UsageErrorCode.RateLimited],
    [500, UsageErrorCode.ServerError],
    [503, UsageErrorCode.ServerError],
    [404, UsageErrorCode.HttpStatus],
  ] as const) {
    it(`classifies ${status} as ${code}`, async () => {
      const r = await controlledGetJson({
        url: "https://api.z.ai/x",
        allowlist: ALLOW,
        timeoutMs: 1000,
        fetchImpl: makeFetch(() => makeResponse(status, {})),
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, code);
    });
  }

  it("does not leak the body into the error message", async () => {
    const leakyToken = "leaky_secret_token_value_987";
    const r = await controlledGetJson({
      url: "https://api.z.ai/x",
      allowlist: ALLOW,
      timeoutMs: 1000,
      fetchImpl: makeFetch(() => makeResponse(401, { detail: leakyToken })),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.message.includes(leakyToken), false);
      assert.equal(r.error.httpStatus, 401);
    }
  });
});

describe("controlledGetJson - transport errors", () => {
  it("invalid JSON -> InvalidJson", async () => {
    const r = await controlledGetJson({
      url: "https://api.z.ai/x",
      allowlist: ALLOW,
      timeoutMs: 1000,
      fetchImpl: makeFetch(() => makeResponse(200, null, { jsonThrow: true })),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, UsageErrorCode.InvalidJson);
  });

  it("timeout -> Timeout", { timeout: 2000 }, async () => {
    const neverResolve: Handler = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const r = await controlledGetJson({
      url: "https://api.z.ai/x",
      allowlist: ALLOW,
      timeoutMs: 30,
      fetchImpl: makeFetch(neverResolve),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, UsageErrorCode.Timeout);
  });

  it("network failure -> Network", async () => {
    const r = await controlledGetJson({
      url: "https://api.z.ai/x",
      allowlist: ALLOW,
      timeoutMs: 1000,
      fetchImpl: makeFetch(() => Promise.reject(new TypeError("fetch failed"))),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, UsageErrorCode.Network);
  });

  it("redirect -> UnsafeUrl", async () => {
    const r = await controlledGetJson({
      url: "https://api.z.ai/x",
      allowlist: ALLOW,
      timeoutMs: 1000,
      fetchImpl: makeFetch(() => Promise.reject(new TypeError("redirect failed"))),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, UsageErrorCode.UnsafeUrl);
  });
});

describe("controlledGetJson - URL validation (no network)", () => {
  it("rejects non-https", async () => {
    const r = await controlledGetJson({
      url: "http://api.z.ai/x",
      allowlist: ALLOW,
      timeoutMs: 1000,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, UsageErrorCode.UnsafeUrl);
  });

  it("rejects non-allowlist host", async () => {
    const r = await controlledGetJson({
      url: "https://evil.example.com/x",
      allowlist: ALLOW,
      timeoutMs: 1000,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, UsageErrorCode.Allowlist);
  });

  it("rejects invalid url", async () => {
    const r = await controlledGetJson({
      url: "not a url",
      allowlist: ALLOW,
      timeoutMs: 1000,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, UsageErrorCode.UnsafeUrl);
  });
});
