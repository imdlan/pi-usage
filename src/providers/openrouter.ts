// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * OpenRouter usage provider.
 *
 * Queries `GET /api/v1/credits` with the provider's standard API key
 * (sk-or-v1-...). Confirmed response shape (OpenRouter docs / SDK types):
 *   { data: { total_credits: number, total_usage: number } }  // USD amounts
 * Balance = total_credits - total_usage. Values are cached ~60s upstream.
 *
 * SECURITY: the API key is used only in an Authorization header for the
 * allowlisted HTTPS host. It never reaches snapshots, logs, or errors.
 */

import { CONFIG } from "../config.js";
import { controlledGetJson } from "../utils/http.js";
import { computePercentage, computeRemaining } from "../utils/time.js";
import { toUsageError, UsageErrorCode } from "./types.js";
import type {
  ProviderAuth,
  UsageError,
  UsageProvider,
  UsageQuota,
  UsageRefreshOptions,
  UsageSnapshot,
} from "./types.js";

/** Official OpenRouter API host allowlist. */
export const OPENROUTER_ALLOWED_HOSTS = ["openrouter.ai"] as const;

/** Credits API path (relative to the base URL origin). */
const OPENROUTER_CREDITS_PATH = "/api/v1/credits";

export interface OpenRouterProviderDeps {
  /** Resolves OpenRouter auth through Pi's authorized `getProviderAuth`. */
  readonly resolveAuth: () => Promise<ProviderAuth | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function toNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isAllowedHost(baseUrl: string): boolean {
  try {
    return (OPENROUTER_ALLOWED_HOSTS as readonly string[]).includes(new URL(baseUrl).hostname);
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
    return undefined;
  }
}

/** Parse the credits response `{ data: { total_credits, total_usage } }`. */
export function parseCredits(payload: unknown): UsageQuota[] {
  const root =
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data: unknown }).data
      : payload;
  if (!root || typeof root !== "object") return [];
  const item = root as Record<string, unknown>;
  const credits = toNum(item.total_credits);
  const usage = toNum(item.total_usage);
  if (credits === undefined && usage === undefined) return [];
  const remaining = computeRemaining(credits, usage);
  return [
    {
      id: "credits",
      label: "Credits (USD)",
      used: usage,
      limit: credits,
      remaining,
      percentage: computePercentage(usage, credits),
    },
  ];
}

function buildSnapshot(
  now: Date,
  quotas: UsageQuota[],
  error: UsageError | undefined,
): UsageSnapshot {
  const base = { provider: "openrouter" as const, timestamp: now.toISOString(), quotas };
  return error ? { ...base, error } : base;
}

export function createOpenRouterProvider(deps: OpenRouterProviderDeps): UsageProvider {
  const id = "openrouter";
  const name = "OpenRouter";
  const timeoutMs = deps.timeoutMs ?? CONFIG.http.timeoutMs;

  async function isAvailable(): Promise<boolean> {
    const auth = await safeResolveAuth(deps.resolveAuth);
    return auth !== undefined && auth.apiKey.length > 0 && isAllowedHost(auth.baseUrl);
  }

  async function getUsage(_options?: UsageRefreshOptions): Promise<UsageSnapshot> {
    const now = deps.now?.() ?? new Date();
    const auth = await safeResolveAuth(deps.resolveAuth);
    if (!auth || auth.apiKey.length === 0) {
      return buildSnapshot(
        now,
        [],
        toUsageError(UsageErrorCode.Unavailable, "no authorized OpenRouter provider configured"),
      );
    }
    if (!isAllowedHost(auth.baseUrl)) {
      return buildSnapshot(
        now,
        [],
        toUsageError(UsageErrorCode.Allowlist, "OpenRouter base url host not allowed"),
      );
    }
    let origin: string;
    try {
      origin = new URL(auth.baseUrl).origin;
    } catch {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.UnsafeUrl, "invalid OpenRouter base url"));
    }

    const res = await controlledGetJson({
      url: `${origin}${OPENROUTER_CREDITS_PATH}`,
      headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: "application/json" },
      allowlist: OPENROUTER_ALLOWED_HOSTS as readonly string[],
      timeoutMs,
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    });

    if (!res.ok) return buildSnapshot(now, [], res.error);
    const quotas = parseCredits(res.data);
    if (quotas.length === 0) {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.Schema, "credits response missing fields"));
    }
    return buildSnapshot(now, quotas, undefined);
  }

  return { id, name, isAvailable, getUsage };
}
