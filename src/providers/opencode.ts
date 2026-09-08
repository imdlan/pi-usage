// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * OpenCode Go usage provider.
 *
 * Endpoint: `GET https://opencode.ai/zen/go/v1/usage` — the same API key used
 * for the OpenAI-compatible Go endpoints (`/zen/go/v1/chat/completions`,
 * `/zen/go/v1/responses`, documented at https://opencode.ai/docs/go/).
 * The usage path itself is undocumented but the response shape below is
 * cross-reported by subscribers; parsing is defensive and degrades gracefully.
 *
 * Confirmed response shape:
 *   {
 *     "usage": {
 *       "rolling":  { "status": "ok", "percent": 10,
 *                     "resetsAt": "2026-09-08T07:40:24.807Z" },  // rolling 5h ($12)
 *       "weekly":   { ... },                                    // weekly  ($30)
 *       "monthly":  { ... }                                     // monthly ($60)
 *     }
 *   }
 *
 * The API exposes percentages and reset times only — no dollar used/limit
 * numbers — and the documented base limits ($12/$30/$60) vary by model, so
 * Used/Left render as "—" and only the percentage is shown (same convention as
 * Z.ai). The optional `status` field has no documented semantics beyond
 * `ok` and is ignored.
 *
 * SECURITY: the API key from `resolveAuth` is used only inside an Authorization
 * header for allowlisted HTTPS hosts. It is never placed on the snapshot, never
 * logged, and never returned in errors.
 */

import { CONFIG } from "../config.js";
import { controlledGetJson } from "../utils/http.js";
import { clampPercentage } from "../utils/time.js";
import { toUsageError, UsageErrorCode } from "./types.js";
import type {
  ProviderAuth,
  UsageError,
  UsageProvider,
  UsageQuota,
  UsageRefreshOptions,
  UsageSnapshot,
} from "./types.js";

/** Official OpenCode (zen) host allowlist. */
export const OPENCODE_ALLOWED_HOSTS = ["opencode.ai"] as const;

/** Usage API path (relative to the base URL origin; single-host service). */
const OPENCODE_USAGE_PATH = "/zen/go/v1/usage";

export interface OpenCodeProviderDeps {
  /**
   * Resolves OpenCode auth through Pi's authorized `getProviderAuth`. Returns
   * `undefined` when no authorized provider is available (fail-closed).
   * Implementations must never read credential files or env vars directly.
   */
  readonly resolveAuth: () => Promise<ProviderAuth | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Accept finite numbers and numeric strings (10 or "10" -> 10). */
function toCount(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Accept ISO strings (resetsAt / resetAt / reset_at) and epoch-ms numbers. */
function toResetIso(...vals: readonly unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v) && v > 1_000_000_000_000) {
      return new Date(v).toISOString();
    }
  }
  return undefined;
}

function isAllowedHost(baseUrl: string): boolean {
  try {
    return (OPENCODE_ALLOWED_HOSTS as readonly string[]).includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

async function safeResolveAuth(
  resolveAuth: () => Promise<ProviderAuth | undefined>,
): Promise<ProviderAuth | undefined> {
  try {
    return await resolveAuth();
  } catch {
    // Fail-closed: never leak resolver errors.
    return undefined;
  }
}

/** Map a window key (`rolling`/`weekly`/`monthly`) to its generic quota ids
 * and labels, following the 5-hour/weekly/monthly convention of other
 * providers. Unknown keys are kept with a slugged id when the API ever adds
 * new windows. */
const WINDOW_IDS: Readonly<Record<string, { id: string; label: string }>> = {
  rolling: { id: "five_hour", label: "5-hour quota" },
  weekly: { id: "weekly", label: "Weekly quota" },
  monthly: { id: "monthly", label: "Monthly quota" },
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "quota";
}

/** Parse the `/usage` payload into generic quotas. Confirmed structure only;
 * unknown shapes yield no quotas rather than guesses. */
function parseUsage(payload: unknown): UsageQuota[] {
  const root = isRecord(payload) && isRecord(payload.usage) ? payload.usage : undefined;
  if (!root) return [];
  const out: UsageQuota[] = [];
  for (const [key, raw] of Object.entries(root)) {
    if (!isRecord(raw)) continue;
    const known = WINDOW_IDS[key];
    const pct = clampPercentage(toCount(raw.percent) ?? toCount(raw.percentage));
    const resetAt = toResetIso(raw.resetsAt, raw.resetAt, raw.reset_at);
    if (known) {
      // Known semantics: keep when the window carries any signal at all.
      if (pct !== undefined || resetAt !== undefined) {
        out.push({ id: known.id, label: known.label, percentage: pct, resetAt });
      }
    } else if (pct !== undefined) {
      // Unknown window: keep only when the API reports a percentage for it.
      out.push({ id: slug(key), label: key, percentage: pct, resetAt });
    }
  }
  // Deterministic display order regardless of API key order: 5-hour quota
  // first, then weekly, then monthly, then any future windows in arrival order.
  const rank = (q: UsageQuota) =>
    q.id === "five_hour" ? 0 : q.id === "weekly" ? 1 : q.id === "monthly" ? 2 : 3;
  return out
    .map((q, i) => ({ q, i }))
    .sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i)
    .map(({ q }) => q);
}

function buildSnapshot(now: Date, quotas: UsageQuota[], error: UsageError | undefined): UsageSnapshot {
  const base = { provider: "opencode" as const, timestamp: now.toISOString(), quotas };
  return error ? { ...base, error } : base;
}

export function createOpenCodeProvider(deps: OpenCodeProviderDeps): UsageProvider {
  const id = "opencode";
  const name = "OpenCode Go";
  const timeoutMs = deps.timeoutMs ?? CONFIG.http.timeoutMs;

  async function isAvailable(): Promise<boolean> {
    const auth = await safeResolveAuth(deps.resolveAuth);
    return auth !== undefined && auth.apiKey.length > 0 && isAllowedHost(auth.baseUrl);
  }

  async function getUsage(_options?: UsageRefreshOptions): Promise<UsageSnapshot> {
    // The provider always fetches fresh; caching and forceRefresh live in the service layer.
    const now = deps.now?.() ?? new Date();
    const auth = await safeResolveAuth(deps.resolveAuth);
    if (!auth || auth.apiKey.length === 0) {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.Unavailable, "no authorized OpenCode provider configured"));
    }
    if (!isAllowedHost(auth.baseUrl)) {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.Allowlist, "OpenCode base url host not allowed"));
    }
    let origin: string;
    try {
      origin = new URL(auth.baseUrl).origin;
    } catch {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.UnsafeUrl, "invalid OpenCode base url"));
    }

    // The stored credential is the Go API key; send it as a Bearer token,
    // tolerating an already-prefixed value (same convention as Kimi).
    const authorization = /^Bearer\s/i.test(auth.apiKey) ? auth.apiKey : `Bearer ${auth.apiKey}`;
    const result = await controlledGetJson({
      url: `${origin}${OPENCODE_USAGE_PATH}`,
      headers: { Authorization: authorization, Accept: "application/json" },
      timeoutMs,
      allowlist: OPENCODE_ALLOWED_HOSTS as readonly string[],
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    });

    const quotas = result.ok ? parseUsage(result.data) : [];
    return buildSnapshot(now, quotas, result.ok ? undefined : result.error);
  }

  return { id, name, isAvailable, getUsage };
}
