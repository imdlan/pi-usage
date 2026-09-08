// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Kimi Coding Plan (Kimi For Coding) usage provider.
 *
 * Endpoint: `GET https://api.kimi.com/coding/v1/usages` — the same endpoint the
 * official Kimi Code CLI's built-in `/usage` command queries (MoonshotAI/kimi-cli).
 * It is undocumented but has an official client depending on it, mirroring how
 * the Z.ai adapter derives from the official glm-plan-usage plugin.
 *
 * Confirmed response shape (cross-verified against the official CLI behavior
 * and multiple community quota tools):
 *   {
 *     "usage": { "limit": "100", "used": "26", "remaining": "74",
 *                "resetTime": "2026-08-11T15:53:05Z" },        // weekly quota
 *     "limits": [
 *       { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
 *         "detail": { "limit": "100", "used": "27", "remaining": "73",
 *                     "resetTime": "..." } } ]                  // 5-hour window
 *   }
 *
 * Numbers arrive as numeric STRINGS. Field spelling has drifted across API
 * versions (`used` vs `remaining`, `resetTime` vs `resetAt` vs `reset_at`,
 * `name`/`title` labels), so every parse is defensive and degrades gracefully.
 *
 * SECURITY: the token from `resolveAuth` is used only inside an Authorization
 * header for allowlisted HTTPS hosts. It is never placed on the snapshot, never
 * logged, and never returned in errors.
 */

import { CONFIG } from "../config.js";
import { controlledGetJson } from "../utils/http.js";
import { clampPercentage, computePercentage, computeRemaining } from "../utils/time.js";
import { toUsageError, UsageErrorCode } from "./types.js";
import type {
  ProviderAuth,
  UsageError,
  UsageProvider,
  UsageQuota,
  UsageRefreshOptions,
  UsageSnapshot,
} from "./types.js";

/** Official Kimi Code platform host allowlist. */
export const KIMI_ALLOWED_HOSTS = ["api.kimi.com"] as const;

/** Usage API path (relative to the base URL origin). */
const KIMI_USAGES_PATH = "/coding/v1/usages";

export interface KimiProviderDeps {
  /**
   * Resolves Kimi auth through Pi's authorized `getProviderAuth`. Returns
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

/** Accept numbers and finite numeric strings ("100" -> 100). */
function toCount(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Accept ISO strings (resetTime / resetAt / reset_at) and epoch-ms numbers. */
function toResetIso(...vals: readonly unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v) && v > 1_000_000_000_000) {
      return new Date(v).toISOString();
    }
  }
  return undefined;
}

function toLabel(...vals: readonly unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "quota";
}

function isAllowedHost(baseUrl: string): boolean {
  try {
    return (KIMI_ALLOWED_HOSTS as readonly string[]).includes(new URL(baseUrl).hostname);
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

/** Normalize a `window` descriptor to whole minutes; undefined when unknown. */
function windowMinutes(window: Record<string, unknown>): number | undefined {
  const d = toCount(window.duration);
  if (d === undefined) return undefined;
  const unit = typeof window.timeUnit === "string" ? window.timeUnit.toUpperCase() : "";
  if (unit.includes("HOUR")) return d * 60;
  if (unit.includes("DAY")) return d * 1440;
  if (unit.includes("SECOND")) return Number.isInteger(d / 60) ? d / 60 : undefined;
  return d; // TIME_UNIT_MINUTE and any future/unknown unit: treat as minutes.
}

interface ParsedRow {
  used?: number;
  limit?: number;
  percentage?: number;
  resetAt?: string;
  label?: string;
}

/** Parse one usage row (top-level `usage` or a `limits[]` `detail`), tolerating
 * `used`-less variants by deriving it from `limit - remaining`. */
function parseRow(raw: unknown, defaultLabel?: string): ParsedRow | undefined {
  if (!isRecord(raw)) return undefined;
  const limit = toCount(raw.limit);
  const used = toCount(raw.used) ??
    (limit !== undefined && toCount(raw.remaining) !== undefined
      ? limit - (toCount(raw.remaining) as number)
      : undefined);
  if (used === undefined && limit === undefined) return undefined;
  return {
    used,
    limit,
    percentage: clampPercentage(toCount(raw.percentage)) ?? computePercentage(used, limit),
    resetAt: toResetIso(raw.resetTime, raw.resetAt, raw.reset_at),
    label: toLabel(raw.name, raw.title) ?? defaultLabel,
  };
}

/** Parse the `/usages` payload into generic quotas. Confirmed structure only;
 * unknown shapes yield no quotas rather than guesses. */
function parseUsages(payload: unknown): UsageQuota[] {
  if (!isRecord(payload)) return [];
  const out: UsageQuota[] = [];

  // Top-level `usage` is the weekly (7-day rolling) membership quota.
  const weekly = parseRow(payload.usage, "Weekly quota");
  if (weekly) {
    out.push({
      id: "weekly",
      label: weekly.label ?? "Weekly quota",
      used: weekly.used,
      limit: weekly.limit,
      remaining: computeRemaining(weekly.limit, weekly.used),
      percentage: weekly.percentage,
      resetAt: weekly.resetAt,
    });
  }

  // `limits[]` carries enforced rolling windows; duration 300 minutes is the
  // 5-hour quota. Other windows are shown only when the API names them.
  const limits = payload.limits;
  if (Array.isArray(limits)) {
    for (const raw of limits) {
      if (!isRecord(raw)) continue;
      const detail = isRecord(raw.detail) ? raw.detail : raw;
      const window = isRecord(raw.window) ? raw.window : {};
      const minutes = windowMinutes(window);
      const row = parseRow(detail);
      if (!row) continue;
      if (minutes === 300) {
        out.push({
          id: "five_hour",
          label: "5-hour quota",
          used: row.used,
          limit: row.limit,
          remaining: computeRemaining(row.limit, row.used),
          percentage: row.percentage,
          resetAt: row.resetAt,
        });
      } else if (minutes === undefined && row.label !== undefined) {
        // No window descriptor but a named row: keep it, labeled by the API.
        out.push({
          id: slug(row.label),
          label: row.label,
          used: row.used,
          limit: row.limit,
          remaining: computeRemaining(row.limit, row.used),
          percentage: row.percentage,
          resetAt: row.resetAt,
        });
      }
      // Unnamed unknown windows are dropped: no confirmed semantics to show.
    }
  }

  // Deterministic display order regardless of API array order: 5-hour quota
  // first, then weekly, then any future named windows in arrival order.
  const rank = (q: UsageQuota) =>
    q.id === "five_hour" ? 0 : q.id === "weekly" ? 1 : 2;
  return out
    .map((q, i) => ({ q, i }))
    .sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i)
    .map(({ q }) => q);
}

function buildSnapshot(now: Date, quotas: UsageQuota[], error: UsageError | undefined): UsageSnapshot {
  const base = { provider: "kimi" as const, timestamp: now.toISOString(), quotas };
  return error ? { ...base, error } : base;
}

export function createKimiProvider(deps: KimiProviderDeps): UsageProvider {
  const id = "kimi";
  const name = "Kimi";
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
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.Unavailable, "no authorized Kimi provider configured"));
    }
    if (!isAllowedHost(auth.baseUrl)) {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.Allowlist, "Kimi base url host not allowed"));
    }
    let origin: string;
    try {
      origin = new URL(auth.baseUrl).origin;
    } catch {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.UnsafeUrl, "invalid Kimi base url"));
    }

    // The stored credential is a bare token (OAuth access token or sk-... API
    // key); send it as a Bearer token, tolerating an already-prefixed value.
    const authorization = /^Bearer\s/i.test(auth.apiKey) ? auth.apiKey : `Bearer ${auth.apiKey}`;
    const result = await controlledGetJson({
      url: `${origin}${KIMI_USAGES_PATH}`,
      headers: { Authorization: authorization, Accept: "application/json" },
      timeoutMs,
      allowlist: KIMI_ALLOWED_HOSTS as readonly string[],
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    });

    const quotas = result.ok ? parseUsages(result.data) : [];
    return buildSnapshot(now, quotas, result.ok ? undefined : result.error);
  }

  return { id, name, isAvailable, getUsage };
}
