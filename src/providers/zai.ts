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
 *   - `quota/limit` is the only response with a confirmed structure
 *     (`TOKENS_LIMIT` = 5-hour quota, `TIME_LIMIT` = monthly quota).
 *   - `model-usage` / `tool-usage` are parsed defensively and degrade gracefully.
 *
 * SECURITY: the token from `resolveAuth` is used only inside an Authorization
 * header for allowlisted HTTPS hosts. It is never placed on the snapshot, never
 * logged, and never returned in errors.
 */

import { CONFIG } from "../config.js";
import { controlledGetJson } from "../utils/http.js";
import { clampPercentage, computeRemaining, zaiUsageWindow } from "../utils/time.js";
import { toUsageError, UsageErrorCode } from "./types.js";
import type {
  ModelUsage,
  ProviderAuth,
  UsageError,
  UsageProvider,
  UsageQuota,
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
    if (type === "TOKENS_LIMIT") {
      out.push({ id: "five_hour", label: "5-hour quota", percentage: pct, resetAt: toIso(item.resetAt) });
    } else if (type === "TIME_LIMIT") {
      const used = toNum(item.currentValue);
      const limit = toNum(item.usage);
      out.push({
        id: "monthly",
        label: "Monthly quota",
        percentage: pct,
        used,
        limit,
        remaining: computeRemaining(limit, used),
      });
    } else if (type) {
      out.push({ id: slug(type), label: type, percentage: pct });
    }
  }
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
