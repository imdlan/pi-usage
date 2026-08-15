// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * OpenRouter usage provider.
 *
 * Queries two official documented endpoints with the provider's standard API
 * key (sk-or-v1-...):
 *
 * 1. `GET /api/v1/key` (primary) — per-key spend cap and usage windows:
 *    { data: { label, usage, usage_daily, usage_weekly, usage_monthly,
 *              limit, limit_remaining, limit_reset, is_free_tier, rate_limit } }
 *    All amounts in USD. `limit` is null when no per-key spend cap is set.
 *
 * 2. `GET /api/v1/credits` (fallback) — account balance:
 *    { data: { total_credits, total_usage } }  // USD; values cached ~60s
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
  UsageQuotaDetail,
  UsageRefreshOptions,
  UsageSnapshot,
} from "./types.js";

/** Official OpenRouter API host allowlist. */
export const OPENROUTER_ALLOWED_HOSTS = ["openrouter.ai"] as const;

const OPENROUTER_KEY_PATH = "/api/v1/key";
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

/** Parse the `/api/v1/key` payload into per-key spend cap + usage windows. */
export function parseKeyPayload(payload: unknown): UsageQuota[] {
  const root =
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data: unknown }).data
      : payload;
  if (!root || typeof root !== "object") return [];
  const d = root as Record<string, unknown>;

  const quotas: UsageQuota[] = [];
  const limit = toNum(d.limit);
  const remaining = toNum(d.limit_remaining);
  const resetAt = typeof d.limit_reset === "string" && d.limit_reset.length > 0 ? d.limit_reset : undefined;
  if (limit !== undefined) {
    quotas.push({
      id: "key_limit",
      label: "Key spend cap (USD)",
      used: remaining !== undefined ? Math.max(0, limit - remaining) : undefined,
      limit,
      remaining,
      percentage: remaining !== undefined ? computePercentage(Math.max(0, limit - remaining), limit) : undefined,
      resetAt,
    });
  }
  const daily = toNum(d.usage_daily);
  const weekly = toNum(d.usage_weekly);
  const monthly = toNum(d.usage_monthly);
  if (daily !== undefined || weekly !== undefined || monthly !== undefined) {
    const details: UsageQuotaDetail[] = [];
    if (daily !== undefined) details.push({ id: "daily", label: "today", used: daily });
    if (weekly !== undefined) details.push({ id: "weekly", label: "this week", used: weekly });
    if (monthly !== undefined) details.push({ id: "monthly", label: "this month", used: monthly });
    quotas.push({ id: "usage_windows", label: "Spend (USD)", details });
  }
  return quotas;
}

/** Parse the `/api/v1/credits` payload: `{ data: { total_credits, total_usage } }`. */
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
  return [
    {
      id: "credits",
      label: "Credits (USD)",
      used: usage,
      limit: credits,
      remaining: computeRemaining(credits, usage),
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

    const reqOpts = {
      headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: "application/json" },
      allowlist: OPENROUTER_ALLOWED_HOSTS as readonly string[],
      timeoutMs,
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    } as const;

    const [keyRes, creditsRes] = await Promise.all([
      controlledGetJson({ url: `${origin}${OPENROUTER_KEY_PATH}`, ...reqOpts }),
      controlledGetJson({ url: `${origin}${OPENROUTER_CREDITS_PATH}`, ...reqOpts }),
    ]);

    const keyQuotas = keyRes.ok ? parseKeyPayload(keyRes.data) : [];
    const creditQuotas = creditsRes.ok ? parseCredits(creditsRes.data) : [];

    // `/key` carries the headline numbers (spend cap + usage windows); its
    // failure is a hard error unless `/credits` still produced data.
    if (keyRes.ok && keyQuotas.length === 0) {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.Schema, "key response missing fields"));
    }
    const quotas = [...keyQuotas, ...creditQuotas];
    if (quotas.length > 0) return buildSnapshot(now, quotas, undefined);
    // Both unavailable or empty: prefer the key endpoint's error.
    const err: UsageError | undefined = !keyRes.ok ? keyRes.error : creditsRes.ok ? undefined : creditsRes.error;
    return buildSnapshot(now, [], err ?? toUsageError(UsageErrorCode.Schema, "no usage data returned"));
  }

  return { id, name, isAvailable, getUsage };
}
