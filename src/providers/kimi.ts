// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Kimi Coding Plan usage provider (Moonshot AI, subscription coding plan).
 *
 * Queries `GET {baseUrl}/usages` where baseUrl is the configured Kimi coding
 * endpoint (e.g. `https://api.kimi.com/coding/v1`). The endpoint is NOT
 * officially documented; its behavior mirrors the official `kimi-code`
 * client (MoonshotAI/kimi-code, packages/oauth/src/managed-usage.ts):
 *   - `usage` is the weekly plan quota (`resetTime`, numbers as decimal strings).
   - `limits[]` are sliding windows; a 300 `TIME_UNIT_MINUTE` window is the
 *     5-hour quota. Sub-day minute windows fold to whole hours.
 *   - `totalQuota` is a binary monthly-membership freeze signal: `used > 0`
 *     means frozen. Its `remaining` is sticky across frozen/healthy states and
 *     must never be used to derive usage.
 *   - `boosterWallet` (optional) carries booster-pack balance in fixed-point
 *     cents (1e6 per cent) plus an optional monthly spend cap.
 *   - `parallel` is a static concurrency ceiling, not a time-windowed quota —
 *     it is never surfaced.
 *
 * Auth comes from the token Pi already holds for the configured Kimi provider
 * (resolved via the injected `resolveAuth`, backed by Pi's authorized
 * `getProviderAuth`). This file never reads auth files or env vars.
 *
 * SECURITY: the API key is used only in an Authorization header for
 * allowlisted HTTPS hosts. It never reaches snapshots, logs, or errors.
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

/** Official Kimi Coding Plan usage-API host allowlist. Mirrors the strict
 * managed-endpoint match in the official client: proxies, gateways, and
 * mirrors are NOT the managed endpoint and fail closed. */
export const KIMI_ALLOWED_HOSTS = ["api.kimi.com", "api.kimi.ai"] as const;

/** Usage API path appended to the configured base URL (official clients
 * build the usage URL the same way: `${base}/usages`). */
const KIMI_USAGES_SUFFIX = "/usages";

export interface KimiProviderDeps {
  /** Resolves Kimi auth through Pi's authorized `getProviderAuth`. */
  readonly resolveAuth: () => Promise<ProviderAuth | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/** Accept decimal-string or finite-number fields (server sends `"100"`). */
function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/** Reset timestamp: `resetTime` confirmed; accept documented variants. */
function toResetIso(...vals: readonly unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Normalize `TIME_UNIT_MINUTE` (proto-style enum) to `minute`; the bare
 * `MINUTE` spelling seen in older clients is accepted defensively. */
function normalizeTimeUnit(raw: unknown): "minute" | "hour" | "day" | "week" | undefined {
  if (typeof raw !== "string") return undefined;
  const unit = raw.startsWith("TIME_UNIT_") ? raw.slice("TIME_UNIT_".length) : raw;
  switch (unit.toLowerCase()) {
    case "minute":
      return "minute";
    case "hour":
      return "hour";
    case "day":
      return "day";
    case "week":
      return "week";
    default:
      return undefined;
  }
}

/** Fold whole-hour minute windows (300 minutes -> 5 hours), mirroring the
 * official client so windows render as "5-hour", not "300-minute". */
function foldWindow(
  duration: number,
  unit: "minute" | "hour" | "day" | "week",
): { duration: number; unit: "minute" | "hour" | "day" | "week" } {
  if (unit === "minute" && duration >= 60 && duration % 60 === 0) {
    return { duration: duration / 60, unit: "hour" };
  }
  return { duration, unit };
}

/** `used` is authoritative when present; monthly resets omit it entirely, so
 * derive from `limit - remaining` next; otherwise unknown. */
function deriveUsed(raw: Record<string, unknown>): number | undefined {
  const used = toNum(raw.used);
  if (used !== undefined) return used;
  const limit = toNum(raw.limit);
  const remaining = toNum(raw.remaining);
  if (limit !== undefined && remaining !== undefined) {
    return Math.max(0, limit - remaining);
  }
  return undefined;
}

/** Parse one `limits[]` entry into a windowed quota row. The confirmed
 * 300-minute window is the 5-hour quota (`five_hour`); any other window gets
 * a stable derived id. Unrecognized windows are skipped. */
function parseLimitRow(raw: unknown): UsageQuota | undefined {
  if (!isRecord(raw)) return undefined;
  const detail = raw.detail;
  if (!isRecord(detail)) return undefined;
  const win = isRecord(raw.window) ? raw.window : undefined;
  const duration = toNum(win?.duration);
  const unit = normalizeTimeUnit(win?.timeUnit);
  const used = deriveUsed(detail);
  const limit = toNum(detail.limit);
  if (duration === undefined || unit === undefined) return undefined;
  if (used === undefined && limit === undefined) return undefined;

  const folded = foldWindow(duration, unit);
  const resetAt = toResetIso(detail.resetTime, detail.resetAt, detail.reset_at);
  const isFiveHour = folded.unit === "hour" && folded.duration === 5;
  const label = isFiveHour
    ? "5-hour limit"
    : `${folded.duration} ${folded.unit} limit`;
  return {
    id: isFiveHour ? "five_hour" : `window_${folded.duration}_${folded.unit}`,
    label,
    used,
    limit,
    remaining: computeRemaining(limit, used),
    percentage: computePercentage(used, limit),
    resetAt,
  };
}

/** Parse the top-level weekly quota. The backend omits its window; the
 * official client synthesizes one week, which is the confirmed semantics. */
function parseWeekly(raw: unknown): UsageQuota | undefined {
  if (!isRecord(raw)) return undefined;
  const used = deriveUsed(raw);
  const limit = toNum(raw.limit);
  if (used === undefined && limit === undefined) return undefined;
  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : undefined;
  return {
    id: "weekly",
    label: name ?? "Weekly limit",
    used,
    limit,
    remaining: computeRemaining(limit, used),
    percentage: computePercentage(used, limit),
    resetAt: toResetIso(raw.resetTime, raw.resetAt, raw.reset_at),
  };
}

/**
 * Binary monthly-membership freeze signal. `used > 0` means the Kimi
 * membership's monthly total is reached and coding quota is frozen: render
 * 100% (red alert bar). Missing or zero `used` is healthy: 0%. Only the
 * percentage is reported — `totalQuota.remaining` is sticky across states and
 * would fabricate misleading Used/Left counts.
 */
function parseMembership(raw: unknown): UsageQuota | undefined {
  if (!isRecord(raw)) return undefined;
  const used = toNum(raw.used);
  return {
    id: "membership",
    label: "Monthly membership",
    percentage: used !== undefined && used > 0 ? 100 : 0,
    resetAt: toResetIso(raw.resetTime, raw.resetAt, raw.reset_at),
  };
}

/** Fixed-point (1e6 per cent) to cents, floor tiny residues at 1 cent.
 * Mirrors the official client's conversion. */
function fixedPointToCents(value: number): number {
  const cents = value / 1_000_000;
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}

/** Parse the optional booster-pack wallet. Invalid or missing fields are
 * silently omitted; a valid wallet renders balance as remaining, consumed
 * amount as used, and — when a monthly spend cap is enabled — a sub-row
 * with the cap. Monetary values render in major currency units. */
function parseBooster(raw: unknown): UsageQuota | undefined {
  if (!isRecord(raw)) return undefined;
  const balance = raw.balance;
  if (!isRecord(balance) || balance.type !== "BOOSTER") return undefined;
  const amount = toNum(balance.amount);
  if (amount === undefined || amount <= 0) return undefined;
  const totalCents = fixedPointToCents(amount);
  const amountLeft = toNum(balance.amountLeft);
  const balanceCents = amountLeft !== undefined ? fixedPointToCents(amountLeft) : 0;

  const monthlyLimit = isRecord(raw.monthlyChargeLimit) ? raw.monthlyChargeLimit : undefined;
  const monthlyUsed = isRecord(raw.monthlyUsed) ? raw.monthlyUsed : undefined;
  const currency =
    (typeof monthlyLimit?.currency === "string" && monthlyLimit.currency.length > 0
      ? monthlyLimit.currency
      : typeof monthlyUsed?.currency === "string" && monthlyUsed.currency.length > 0
        ? monthlyUsed.currency
        : "USD");
  const capEnabled = raw.monthlyChargeLimitEnabled === true;
  const capCents = toNum(monthlyLimit?.priceInCents);
  const capUsedCents = toNum(monthlyUsed?.priceInCents);

  const details: UsageQuotaDetail[] = [];
  if (capEnabled && capCents !== undefined && capCents > 0) {
    const capUsed = capUsedCents !== undefined ? capUsedCents / 100 : undefined;
    const cap = capCents / 100;
    details.push({
      id: "monthly_cap",
      label: "monthly cap",
      used: capUsed,
      limit: cap,
      remaining: computeRemaining(cap, capUsed),
      percentage: computePercentage(capUsed, cap),
    });
  }

  const total = totalCents / 100;
  const remaining = balanceCents / 100;
  const used = Math.max(0, total - remaining);
  return {
    id: "booster",
    label: `Booster wallet (${currency})`,
    used,
    limit: total,
    remaining,
    percentage: computePercentage(used, total),
    details: details.length > 0 ? details : undefined,
  };
}

/**
 * Parse the confirmed `/usages` payload into generic quotas in the fixed
 * display order: 5-hour window(s) first, then weekly, then the monthly
 * membership freeze signal, then the optional booster wallet. Unknown fields
 * are ignored; nothing usable yields an empty array (schema error upstream).
 */
export function parseUsages(payload: unknown): UsageQuota[] {
  if (!isRecord(payload)) return [];
  const out: UsageQuota[] = [];
  if (Array.isArray(payload.limits)) {
    for (const raw of payload.limits) {
      const q = parseLimitRow(raw);
      if (q) out.push(q);
    }
  }
  const weekly = parseWeekly(payload.usage);
  if (weekly) out.push(weekly);
  const membership = parseMembership(payload.totalQuota);
  if (membership) out.push(membership);
  const booster = parseBooster(payload.boosterWallet);
  if (booster) out.push(booster);
  return out;
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

function buildSnapshot(
  now: Date,
  quotas: UsageQuota[],
  error: UsageError | undefined,
): UsageSnapshot {
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
    const now = deps.now?.() ?? new Date();
    const auth = await safeResolveAuth(deps.resolveAuth);
    if (!auth || auth.apiKey.length === 0) {
      return buildSnapshot(
        now,
        [],
        toUsageError(UsageErrorCode.Unavailable, "no authorized Kimi provider configured"),
      );
    }
    if (!isAllowedHost(auth.baseUrl)) {
      return buildSnapshot(
        now,
        [],
        toUsageError(UsageErrorCode.Allowlist, "Kimi base url host not allowed"),
      );
    }
    let base: string;
    try {
      // Usage URL is `{baseUrl}/usages` (official client semantics): the
      // configured base must be the full coding endpoint, e.g.
      // `https://api.kimi.com/coding/v1` -> `.../coding/v1/usages`.
      base = `${new URL(auth.baseUrl).toString().replace(/\/+$/, "")}`;
    } catch {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.UnsafeUrl, "invalid Kimi base url"));
    }

    const res = await controlledGetJson({
      url: `${base}${KIMI_USAGES_SUFFIX}`,
      headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: "application/json" },
      allowlist: KIMI_ALLOWED_HOSTS as readonly string[],
      timeoutMs,
      fetchImpl: deps.fetchImpl,
      signal: deps.signal,
    });

    if (!res.ok) return buildSnapshot(now, [], res.error);
    const quotas = parseUsages(res.data);
    if (quotas.length === 0) {
      return buildSnapshot(now, [], toUsageError(UsageErrorCode.Schema, "usage response missing fields"));
    }
    return buildSnapshot(now, quotas, undefined);
  }

  return { id, name, isAvailable, getUsage };
}
