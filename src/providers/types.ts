// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Generic, provider-agnostic usage data model.
 *
 * The core types deliberately avoid baking in any specific provider's concepts
 * (no "5-hour" or "weekly" fields). Each provider maps its own API response into
 * these shapes. See {@link UsageProvider} for the contract every provider implements.
 *
 * SECURITY: none of these types may carry credentials (keys, tokens, cookies,
 * Authorization headers, or raw HTTP bodies). They are safe to render, log, and
 * persist. Credential material is confined to {@link ProviderAuth}, which is held
 * in memory only and never serialized.
 */

/** A single quota window (e.g. a 5-hour quota, a monthly quota). */
export interface UsageQuota {
  /** Stable identifier, e.g. `five_hour`, `monthly`. */
  readonly id: string;
  /** Human-readable label, e.g. "5-hour quota". */
  readonly label: string;
  /** Amount already consumed, when known. */
  readonly used?: number;
  /** Total allowance, when known. */
  readonly limit?: number;
  /** Remaining allowance, when known. */
  readonly remaining?: number;
  /** Consumption percentage on a 0-100 scale, when known. */
  readonly percentage?: number;
  /** ISO-8601 (UTC) reset timestamp, when known. */
  readonly resetAt?: string;
}

/** Per-model usage, when a provider exposes model-level breakdowns. */
export interface ModelUsage {
  readonly model: string;
  readonly quotas?: UsageQuota[];
  readonly used?: number;
  readonly limit?: number;
  readonly percentage?: number;
}

/** Sanitized, diagnostic-only error attached to a snapshot. Never holds secrets. */
export interface UsageError {
  /** Stable, controlled error code (see {@link UsageErrorCode}). */
  readonly code: string;
  /** Short, safe, redacted description. */
  readonly message: string;
  /** HTTP status code when the failure came from an HTTP response. */
  readonly httpStatus?: number;
}

/** A normalized, provider-agnostic usage result. Safe to render and persist. */
export interface UsageSnapshot {
  /** Provider id (matches {@link UsageProvider.id}). */
  readonly provider: string;
  /** ISO-8601 timestamp marking when the snapshot was produced. */
  readonly timestamp: string;
  readonly quotas: UsageQuota[];
  readonly models?: ModelUsage[];
  readonly error?: UsageError;
  /**
   * True when this snapshot is a retained previous success shown after a refresh
   * failed. Consumers should indicate the data may be out of date.
   */
  readonly stale?: boolean;
}

/** Options accepted by {@link UsageProvider.getUsage}. */
export interface UsageRefreshOptions {
  /**
   * Bypass a still-valid cache and fetch fresh data. This never bypasses
   * timeouts, error handling, or in-flight request deduplication.
   */
  readonly forceRefresh?: boolean;
}

/**
 * Contract implemented by every provider in isolation. Each provider owns its own
 * auth resolution, network allowlist, parsing, redaction, and failure boundaries.
 * Providers must not share, read, or fall back to another provider's credentials.
 */
export interface UsageProvider {
  /** Stable provider id, e.g. `zai`. Also used as the `/usage <id>` argument. */
  readonly id: string;
  /** Display name, e.g. "GLM". */
  readonly name: string;
  /** Whether the provider has authorized auth available and can be queried. */
  isAvailable(): Promise<boolean>;
  /** Fetch (or return cached) usage. Should never throw; failures are snapshots. */
  getUsage(options?: UsageRefreshOptions): Promise<UsageSnapshot>;
}

/**
 * Resolved auth material for a provider, obtained ONLY through Pi's authorized
 * `getProviderAuth` API. Held in memory; never logged, serialized, or rendered.
 */
export interface ProviderAuth {
  /** Provider API base URL, e.g. `https://api.z.ai/api/anthropic`. */
  readonly baseUrl: string;
  /** Authorization token Pi resolved for the provider. */
  readonly apiKey: string;
}

/** Controlled, stable error codes used across all providers and layers. */
export const UsageErrorCode = {
  /** No authorized provider/auth available — fail-closed. */
  Unavailable: "unavailable",
  /** Request exceeded the timeout. */
  Timeout: "timeout",
  /** Network-level failure (DNS, connection, TLS). */
  Network: "network",
  /** HTTP 401 — authentication failed. */
  Auth: "auth_failed",
  /** HTTP 403 — forbidden. */
  Forbidden: "forbidden",
  /** HTTP 429 — rate limited. */
  RateLimited: "rate_limited",
  /** HTTP 5xx — server error. */
  ServerError: "server_error",
  /** Other non-2xx HTTP status. */
  HttpStatus: "http_error",
  /** Response body was not valid JSON. */
  InvalidJson: "invalid_json",
  /** JSON parsed but required fields were missing/invalid. */
  Schema: "schema_error",
  /** Request URL/host violated the provider allowlist. */
  Allowlist: "allowlist_violation",
  /** Non-HTTPS URL or unsafe redirect. */
  UnsafeUrl: "unsafe_url",
} as const;

export type UsageErrorCode = (typeof UsageErrorCode)[keyof typeof UsageErrorCode];

/** Helper to build a sanitized {@link UsageError}. */
export function toUsageError(
  code: UsageErrorCode,
  message: string,
  httpStatus?: number,
): UsageError {
  return httpStatus === undefined ? { code, message } : { code, message, httpStatus };
}
