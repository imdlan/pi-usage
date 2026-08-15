// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * DeepSeek Open Platform usage provider.
 *
 * Queries `GET /user/balance` (official API, confirmed structure):
 *   { is_available: boolean,
 *     balance_infos: [{ currency: "CNY"|"USD", total_balance: "110.00",
 *                       granted_balance: "10.00", topped_up_balance: "100.00" }] }
 * Amounts are decimal strings; total = granted + topped-up.
 *
 * Auth comes from the token Pi already holds for a configured DeepSeek
 * provider (resolved via the injected `resolveAuth`, backed by Pi's
 * authorized `getProviderAuth`). This file never reads auth files or env vars.
 *
 * SECURITY: the API key is used only in an Authorization header for the
 * allowlisted HTTPS host. It never reaches snapshots, logs, or errors.
 */

import { CONFIG } from "../config.js";
import { controlledGetJson } from "../utils/http.js";
import { computeRemaining } from "../utils/time.js";
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

/** Official DeepSeek API host allowlist. */
export const DEEPSEEK_ALLOWED_HOSTS = ["api.deepseek.com"] as const;

/** Balance API path (relative to the base URL origin). */
const DEEPSEEK_BALANCE_PATH = "/user/balance";

export interface DeepSeekProviderDeps {
  /** Resolves DeepSeek auth through Pi's authorized `getProviderAuth`. */
  readonly resolveAuth: () => Promise<ProviderAuth | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function toAmount(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isAllowedHost(baseUrl: string): boolean {
  try {
    return (DEEPSEEK_ALLOWED_HOSTS as readonly string[]).includes(new URL(baseUrl).hostname);
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

/** Parse the confirmed `/user/balance` response into one quota per currency. */
export function parseBalance(payload: unknown): UsageQuota[] {
  if (!payload || typeof payload !== "object") return [];
  const infos = (payload as { balance_infos?: unknown }).balance_infos;
  if (!Array.isArray(infos)) return [];
  const out: UsageQuota[] = [];
  for (const raw of infos) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const currency = typeof item.currency === "string" ? item.currency : "";
    const total = toAmount(item.total_balance);
    const granted = toAmount(item.granted_balance);
    const toppedUp = toAmount(item.topped_up_balance);
    if (!currency || total === undefined) continue;
    const details: UsageQuotaDetail[] = [];
    if (granted !== undefined) {
      details.push({ id: "granted", label: "granted", used: granted });
    }
    if (toppedUp !== undefined) {
      details.push({ id: "topped_up", label: "topped up", used: toppedUp });
    }
    out.push({
      id: `balance_${currency.toLowerCase()}`,
      label: `Balance (${currency})`,
      remaining: total,
      details: details.length > 0 ? details : undefined,
    });
  }
  return out;
}

function buildSnapshot(
  now: Date,
  quotas: UsageQuota[],
  error: UsageError | undefined,
): UsageSnapshot {
  const base = { provider: "deepseek" as const, timestamp: now.toISOString(), quotas };
  return error ? { ...base, error } : base;
}

export function createDeepSeekProvider(deps: DeepSeekProviderDeps): UsageProvider {
  const id = "deepseek";
  const name = "DeepSeek";
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
        toUsageError(UsageErrorCode.Unavailable, "no authorized DeepSeek provider configured"),
      );
    }
    if (!isAllowedHost(auth.baseUrl)) {
      return buildSnapshot(
        now,
        [],
        toUsageError(UsageErrorCode.Allowlist, "DeepSeek base url host not allowed"),
      );
    }
    let origin: string;
    try {
      origin = new URL(auth.baseUrl).origin;
    } catch {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.UnsafeUrl, "invalid DeepSeek base url"));
    }

    const res = await controlledGetJson({
      url: `${origin}${DEEPSEEK_BALANCE_PATH}`,
      headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: "application/json" },
      allowlist: DEEPSEEK_ALLOWED_HOSTS as readonly string[],
      timeoutMs,
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    });

    if (!res.ok) return buildSnapshot(now, [], res.error);
    const quotas = parseBalance(res.data);
    if (quotas.length === 0) {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.Schema, "balance response missing fields"));
    }
    return buildSnapshot(now, quotas, undefined);
  }

  return { id, name, isAvailable, getUsage };
}
