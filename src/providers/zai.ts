// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Z.ai / GLM Coding Plan usage provider.
 *
 * Endpoint behavior mirrors the official `glm-plan-usage` plugin
 * (zai-org/zai-coding-plugins, plugins/glm-plan-usage):
 *   - Auth comes from the token Pi already holds for the configured Z.ai provider
 *     (resolved via the injected `resolveAuth`, backed by Pi's authorized
 *     `getProviderAuth`). This file never reads auth files or env vars.
 *   - Usage endpoints are derived from the provider base URL origin.
 *   - `quota/limit` is the only response with a confirmed structure:
 *     Coding-Plan windows arrive as `TOKENS_LIMIT` (legacy) or `CREDIT_LIMIT`
 *     (newer credit-billed plans), mapped by `unit × number` window length;
 *     `TIME_LIMIT` is the monthly MCP quota.
 *   - `model-usage` / `tool-usage` are parsed defensively and degrade gracefully.
 *
 * SECURITY: the token from `resolveAuth` is used only inside an Authorization
 * header for allowlisted HTTPS hosts. It is never placed on the snapshot, never
 * logged, and never returned in errors.
 */

import { CONFIG } from "../config.js";
import { controlledGetJson } from "../utils/http.js";
import { clampPercentage, computePercentage, computeRemaining, zaiUsageWindow } from "../utils/time.js";
import { toUsageError, UsageErrorCode } from "./types.js";
import type {
  ModelUsage,
  ProviderAuth,
  UsageError,
  UsageProvider,
  UsageQuota,
  UsageQuotaDetail,
  UsageRefreshOptions,
  UsageSnapshot,
} from "./types.js";

/** Official Z.ai / GLM usage-API host allowlist. */
export const ZAI_ALLOWED_HOSTS = ["api.z.ai", "open.bigmodel.cn", "dev.bigmodel.cn"] as const;

/** Usage API paths (relative to the base URL origin). */
const ZAI_PATHS = {
  modelUsage: "/api/monitor/usage/model-usage",
  toolUsage: "/api/monitor/usage/tool-usage",
  quotaLimit: "/api/monitor/usage/quota/limit",
} as const;

export interface ZaiProviderDeps {
  /**
   * Resolves Z.ai auth through Pi's authorized `getProviderAuth`. Returns
   * `undefined` when no authorized provider is available (fail-closed).
   * Implementations must never read credential files or env vars directly.
   */
  readonly resolveAuth: () => Promise<ProviderAuth | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function toNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toIso(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Z.ai returns reset times as `nextResetTime` epoch-ms (confirmed via the
 * upstream glm-plan-usage plugin); also accept ISO strings defensively. */
function toResetIso(...vals: readonly unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v) && v > 1_000_000_000_000) {
      return new Date(v).toISOString();
    }
  }
  return undefined;
}

function toLabel(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "quota";
}

function isAllowedHost(baseUrl: string): boolean {
  try {
    return (ZAI_ALLOWED_HOSTS as readonly string[]).includes(new URL(baseUrl).hostname);
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

/** Unwrap `{ data: ... }` envelopes used by the Z.ai API. */
function unwrapData(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

/** Window-unit multipliers (minutes per unit), cross-confirmed via CodexBar's
 * independent CREDIT_LIMIT parser: unit 1=day, 3=hour, 5=minute, 6=week. */
const PLAN_WINDOW_UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 };

const PLAN_WINDOW_UNIT_NAMES: Record<number, string> = { 1: "day", 3: "hour", 5: "minute", 6: "week" };

/**
 * Map one Coding-Plan window entry (`TOKENS_LIMIT`, or `CREDIT_LIMIT` on newer
 * credit-billed plans; same shape) to a quota row.
 *
 * Window length is `number × unit` minutes: 300 -> the 5-hour window, 10080 ->
 * the weekly window; any other duration degrades to a generic labeled window
 * row. Legacy entries carry no `number` and keep the historical convention
 * (unit 3 -> five-hour, unit 6 -> weekly). Unparseable entries fall back to the
 * raw type name — never an error, never a dropped row.
 *
 * The server-side `percentage` stays authoritative; optional `usage` /
 * `currentValue` / `remaining` counts fill the Used/Left columns when present.
 */
function parsePlanWindow(
  item: Record<string, unknown>,
  type: string,
  pct: number | undefined,
  resetAt: string | undefined,
): UsageQuota {
  const unit = toNum(item.unit);
  const number = toNum(item.number);
  const multiplier = unit !== undefined ? PLAN_WINDOW_UNIT_MINUTES[unit] : undefined;
  const minutes =
    multiplier !== undefined && number !== undefined && number > 0
      ? number * multiplier
      : undefined;

  let id: string;
  let label: string;
  if (minutes === 300) {
    id = "five_hour";
    label = "5-hour quota";
  } else if (minutes === 10080) {
    id = "weekly";
    label = "Weekly quota";
  } else if (minutes !== undefined && unit !== undefined) {
    const name = PLAN_WINDOW_UNIT_NAMES[unit] ?? `unit${unit}`;
    id = `window_${number}_${name}`;
    label = `${number} ${name} window`;
  } else if (unit === undefined || unit === 3) {
    // Legacy shape without `number`: no unit or unit 3 was the five-hour
    // quota in the historical convention (`unit === 6 ? weekly : five_hour`).
    id = "five_hour";
    label = "5-hour quota";
  } else if (unit === 6) {
    id = "weekly";
    label = "Weekly quota";
  } else {
    id = slug(type);
    label = type;
  }

  const limit = toNum(item.usage);
  const used = toNum(item.currentValue);
  const remaining = toNum(item.remaining);
  return {
    id,
    label,
    percentage: pct ?? computePercentage(used, limit),
    used,
    limit,
    remaining: remaining ?? computeRemaining(limit, used),
    resetAt,
  };
}

/** Parse `quota/limit` into generic quotas. Confirmed structure only. */
function parseQuotaLimit(payload: unknown): UsageQuota[] {
  const root = unwrapData(payload);
  if (!root || typeof root !== "object") return [];
  const limits = (root as { limits?: unknown }).limits;
  if (!Array.isArray(limits)) return [];
  const out: UsageQuota[] = [];
  for (const raw of limits) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    const pct = clampPercentage(toNum(item.percentage));
    const resetAt = toResetIso(item.nextResetTime, item.resetAt);
    if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
      out.push(parsePlanWindow(item, type, pct, resetAt));
    } else if (type === "TIME_LIMIT") {
      // Upstream glm-plan-usage labels this "MCP usage(1 Month)": a monthly cap on
      // MCP tool invocations (web search, web reader, repo lookup), not model tokens.
      const used = toNum(item.currentValue);
      const limit = toNum(item.usage);
      out.push({
        id: "monthly",
        label: "MCP monthly quota",
        percentage: pct,
        used,
        limit,
        remaining: computeRemaining(limit, used),
        resetAt,
        details: parseUsageDetails(item.usageDetails, limit),
      });
    } else if (type) {
      out.push({ id: slug(type), label: type, percentage: pct });
    }
  }
  // Deterministic display order regardless of API array order: 5-hour quota
  // first, then weekly, then MCP monthly, then any future quota types in arrival order.
  const rank = (q: UsageQuota) =>
    q.id === "five_hour" ? 0 : q.id === "weekly" ? 1 : q.id === "monthly" ? 2 : 3;
  return out
    .map((q, i) => ({ q, i }))
    .sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i)
    .map(({ q }) => q);
}

/**
 * Defensively parse `usageDetails` — the per-MCP-tool breakdown of the monthly
 * quota. The upstream plugin passes this field through unmodified, so its exact
 * shape is unconfirmed; parse common field variants and degrade to no details.
 * Supports both an array of items and a `{ toolName: {...} }` object map.
 */
function parseUsageDetails(payload: unknown, parentLimit?: number): UsageQuotaDetail[] {
  let entries: unknown[];
  let keys: (string | undefined)[] | undefined;
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (payload && typeof payload === "object") {
    const map = payload as Record<string, unknown>;
    keys = Object.keys(map);
    entries = Object.values(map);
  } else {
    return [];
  }
  const out: UsageQuotaDetail[] = [];
  entries.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const item = raw as Record<string, unknown>;
    const label =
      toLabel(item.toolName ?? item.name ?? item.tool ?? item.type ?? item.model) ??
      (keys ? keys[i] : undefined);
    if (!label) return;
    // Top-level TIME_LIMIT maps `currentValue` -> used and `usage` -> limit.
    // Follow the same convention inside details, then fall back to other keys.
    const used = toNum(item.currentValue ?? item.used ?? item.count);
    const limit =
      item.currentValue !== undefined ? toNum(item.usage) : toNum(item.limit ?? item.usage);
    const effLimit = limit ?? (used !== undefined ? parentLimit : undefined);
    const pct = clampPercentage(toNum(item.percentage)) ?? computePercentage(used, effLimit);
    const detail: UsageQuotaDetail = {
      id: slug(label),
      label,
      used,
      limit: effLimit,
      remaining: computeRemaining(effLimit, used),
      percentage: pct,
    };
    out.push(detail);
  });
  return out;
}

/** Defensively parse model/tool usage. Unknown shapes yield no models. */
function parseModelUsage(payload: unknown): ModelUsage[] {
  const arr = unwrapData(payload);
  if (!Array.isArray(arr)) return [];
  const out: ModelUsage[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.model !== "string") continue;
    const used = toNum(item.used ?? item.tokens ?? item.count ?? item.usage);
    const percentage = toNum(item.percentage);
    out.push(used !== undefined || percentage !== undefined ? { model: item.model, used, percentage } : { model: item.model });
  }
  return out;
}

function dedupeModels(models: readonly ModelUsage[]): ModelUsage[] {
  const seen = new Map<string, ModelUsage>();
  for (const m of models) {
    const prev = seen.get(m.model);
    if (!prev) seen.set(m.model, m);
  }
  return [...seen.values()];
}

function buildSnapshot(
  now: Date,
  quotas: UsageQuota[],
  models: ModelUsage[] | undefined,
  error: UsageError | undefined,
): UsageSnapshot {
  const base = { provider: "zai" as const, timestamp: now.toISOString(), quotas };
  if (models && models.length > 0) return { ...base, models };
  if (error) return { ...base, error };
  return base;
}

export function createZaiProvider(deps: ZaiProviderDeps): UsageProvider {
  const id = "zai";
  const name = "GLM";
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
      return buildSnapshot(now, [], undefined, toUsageError(UsageErrorCode.Unavailable, "no authorized Z.ai provider configured"));
    }
    if (!isAllowedHost(auth.baseUrl)) {
      return buildSnapshot(now, [], undefined, toUsageError(UsageErrorCode.Allowlist, "Z.ai base url host not allowed"));
    }
    let origin: string;
    try {
      origin = new URL(auth.baseUrl).origin;
    } catch {
      return buildSnapshot(now, [], undefined, toUsageError(UsageErrorCode.UnsafeUrl, "invalid Z.ai base url"));
    }

    const headers = {
      Authorization: auth.apiKey,
      "Accept-Language": "en-US,en",
      "Content-Type": "application/json",
    };
    const win = zaiUsageWindow(now);
    const query = new URLSearchParams({ startTime: win.startTime, endTime: win.endTime }).toString();
    const reqOpts = {
      headers,
      allowlist: ZAI_ALLOWED_HOSTS as readonly string[],
      timeoutMs,
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    } as const;

    const [modelRes, toolRes, quotaRes] = await Promise.all([
      controlledGetJson({ url: `${origin}${ZAI_PATHS.modelUsage}?${query}`, ...reqOpts }),
      controlledGetJson({ url: `${origin}${ZAI_PATHS.toolUsage}?${query}`, ...reqOpts }),
      controlledGetJson({ url: `${origin}${ZAI_PATHS.quotaLimit}`, ...reqOpts }),
    ]);

    const quotas = quotaRes.ok ? parseQuotaLimit(quotaRes.data) : [];
    const rawModels = [
      ...(modelRes.ok ? parseModelUsage(modelRes.data) : []),
      ...(toolRes.ok ? parseModelUsage(toolRes.data) : []),
    ];
    const models = rawModels.length > 0 ? dedupeModels(rawModels) : undefined;

    // The quota endpoint carries the headline numbers; its failure is a hard error.
    // model/tool failures only affect the optional models section.
    const error = quotaRes.ok ? undefined : quotaRes.error;
    return buildSnapshot(now, quotas, models, error);
  }

  return { id, name, isAvailable, getUsage };
}
