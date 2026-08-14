// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { controlledGetJson } from "../src/utils/http.js";
import { UsageErrorCode } from "../src/providers/types.js";
import { createZaiProvider, ZAI_ALLOWED_HOSTS } from "../src/providers/zai.js";
import { formatStatusLine, formatProviderDetail } from "../src/formatters/usage.js";
import type { ProviderAuth } from "../src/providers/types.js";

// ---- helpers -------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const SRC_FILES = walk(join(process.cwd(), "src"));

function readSrc(): string {
  return SRC_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
}

function res(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map<string, string>() as unknown as Headers,
    async json(): Promise<unknown> {
      return body;
    },
  } as unknown as Response;
}

function makeFetch(handler: (url: string) => Response): typeof fetch {
  return ((input: string | URL | Request) =>
    Promise.resolve(res(200, {}).constructor && handler(typeof input === "string" ? input : String(input)))) as unknown as typeof fetch;
}

// ---- 1. source secret scan ----------------------------------------------

describe("security - no real secrets in source", () => {
  const src = readSrc();

  it("has no PEM private key blocks", () => {
    assert.equal(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{20,}-----END/.test(src), false);
  });

  it("has no real-looking API keys", () => {
    assert.equal(/\bsk-(?:ant-|or-|proj-|live-|test-)?[A-Za-z0-9_\-]{20,}\b/.test(src), false);
  });

  it("has no real-looking JWTs", () => {
    assert.equal(/\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b/.test(src), false);
  });

  it("has no Authorization: Bearer <long token> literals", () => {
    assert.equal(/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._\-]{20,}/i.test(src), false);
  });
});

// ---- 2. privilege boundary: no credential reads, no shell ----------------

describe("security - privilege boundary", () => {
  const src = readSrc();

  it("never reads environment variables for credentials", () => {
    assert.equal(/process\.env/.test(src), false);
  });

  it("never reads the filesystem to obtain credentials", () => {
    assert.equal(/from\s+["']node:fs["']|require\(["']fs["']\)|readFileSync|readFile\(|readdirSync|createReadStream/.test(src), false);
  });

  it("never imports shell/subprocess or calls pi.exec", () => {
    assert.equal(/child_process|execSync|spawnSync|execFileSync|pi\.exec\(/.test(src), false);
  });

  it("emits no build artifacts (noEmit)", () => {
    assert.equal(existsSync(join(process.cwd(), "dist")), false);
  });
});

// ---- 3. network allowlist ------------------------------------------------

describe("security - network allowlist", () => {
  it("rejects an arbitrary non-allowlisted host without network", async () => {
    const r = await controlledGetJson({
      url: "https://attacker.example.com/exfil",
      allowlist: [...ZAI_ALLOWED_HOSTS],
      timeoutMs: 1000,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, UsageErrorCode.Allowlist);
  });

  it("rejects non-https", async () => {
    const r = await controlledGetJson({
      url: "http://api.z.ai/x",
      allowlist: [...ZAI_ALLOWED_HOSTS],
      timeoutMs: 1000,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, UsageErrorCode.UnsafeUrl);
  });

  it("zai allowlist is isolated from other providers", () => {
    const others = ["api.openai.com", "api.anthropic.com", "openrouter.ai"];
    for (const host of others) {
      assert.equal((ZAI_ALLOWED_HOSTS as readonly string[]).includes(host), false);
    }
  });
});

// ---- 4. full-chain redaction (provider -> formatter) ---------------------

describe("security - full-chain redaction", () => {
  const token = "supersecrettokenZ1234567890abcdefXYZ";
  const auth: ProviderAuth = { baseUrl: "https://api.z.ai/api/anthropic", apiKey: token };

  function providerWithToken() {
    return createZaiProvider({
      resolveAuth: async () => auth,
      now: () => new Date(2025, 4, 14, 10, 30, 0),
      fetchImpl: makeFetch((url) => {
        if (url.includes("/quota/limit"))
          return res(200, { data: { limits: [{ type: "TOKENS_LIMIT", percentage: 32 }] } });
        return res(200, { data: [] });
      }),
    });
  }

  it("token never reaches the status line", async () => {
    const snap = await providerWithToken().getUsage();
    const line = formatStatusLine([snap], { nameOf: () => "GLM" });
    assert.equal(line.includes(token), false);
  });

  it("token never reaches the detail output", async () => {
    const snap = await providerWithToken().getUsage();
    const out = formatProviderDetail(snap, { nameOf: () => "GLM" });
    assert.equal(out.includes(token), false);
  });

  it("an auth-failure error never echoes a token from the response body", async () => {
    const leaked = "body_token_should_not_leak_1234567890";
    const provider = createZaiProvider({
      resolveAuth: async () => auth,
      now: () => new Date(2025, 4, 14, 10, 30, 0),
      fetchImpl: makeFetch((url) => {
        if (url.includes("/quota/limit")) return res(401, { detail: leaked, token: leaked });
        return res(200, { data: [] });
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(JSON.stringify(snap).includes(leaked), false);
    assert.equal(JSON.stringify(snap).includes(token), false);
  });
});

// ---- 5. fail-closed -------------------------------------------------------

describe("security - fail-closed on missing auth", () => {
  it("returns unavailable without any network call", async () => {
    const provider = createZaiProvider({
      resolveAuth: async () => undefined,
      fetchImpl: makeFetch(() => {
        throw new Error("must not be called");
      }),
    });
    const snap = await provider.getUsage();
    assert.equal(snap.error?.code, UsageErrorCode.Unavailable);
  });
});
