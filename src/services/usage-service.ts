// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Usage service: per-provider caching, in-flight request deduplication, and
 * stale-snapshot fallback on failure.
 *
 * Design notes:
 * - Each provider has its own cache entry: last good snapshot, fetched time,
 *   and the in-flight promise (for dedup).
 * - `forceRefresh` bypasses a valid cache but never bypasses dedup, timeouts,
 *   or error handling.
 * - On a failed refresh, the last good snapshot is returned marked `stale=true`.
 *   If there is no prior good data, the error snapshot is returned instead.
 * - The provider layer always fetches fresh; this service is the only cache.
 */

import { CONFIG } from "../config.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { toUsageError, UsageErrorCode } from "../providers/types.js";
import type { UsageProvider, UsageRefreshOptions, UsageSnapshot } from "../providers/types.js";

interface CacheEntry {
  snapshot?: UsageSnapshot;
  fetchedAt?: number;
  inflight?: Promise<UsageSnapshot>;
}

export interface CacheInfo {
  readonly id: string;
  readonly name: string;
  readonly fetchedAt?: number;
  readonly stale?: boolean;
  readonly hasError: boolean;
  readonly cached: boolean;
}

export interface UsageServiceDeps {
  readonly registry: ProviderRegistry;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export class UsageService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly registry: ProviderRegistry;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private lastRefreshAt?: number;

  constructor(deps: UsageServiceDeps) {
    this.registry = deps.registry;
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? CONFIG.cache.ttlMs;
  }

  private entry(id: string): CacheEntry {
    let e = this.cache.get(id);
    if (!e) {
      e = {};
      this.cache.set(id, e);
    }
    return e;
  }

  private isFresh(entry: CacheEntry): boolean {
    if (!entry.snapshot || entry.snapshot.error) return false;
    if (entry.fetchedAt === undefined) return false;
    return this.now().getTime() - entry.fetchedAt <= this.ttlMs;
  }

  /** Get usage for one provider, using the cache when valid. Never throws. */
  async getUsage(id: string, options?: UsageRefreshOptions): Promise<UsageSnapshot> {
    const provider = this.registry.get(id);
    if (!provider) {
      return {
        provider: id,
        timestamp: this.now().toISOString(),
        quotas: [],
        error: toUsageError(UsageErrorCode.Unavailable, `unknown provider: ${id}`),
      };
    }
    return this.fetchWithCache(provider, options?.forceRefresh === true);
  }

  private fetchWithCache(provider: UsageProvider, force: boolean): Promise<UsageSnapshot> {
    const entry = this.entry(provider.id);
    if (!force && this.isFresh(entry) && entry.snapshot) {
      return Promise.resolve(entry.snapshot);
    }
    // Dedup: reuse an in-flight request instead of issuing a duplicate.
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async (): Promise<UsageSnapshot> => {
      try {
        const snap = await provider.getUsage({ forceRefresh: force });
        if (snap.error) {
          // Failure: keep the last good snapshot, mark it stale (and reflect it in
          // the cache so status reporting is accurate). With no prior good data,
          // cache the error snapshot so isFresh() will retry on the next call.
          if (entry.snapshot) {
            const stale = { ...entry.snapshot, stale: true };
            entry.snapshot = stale;
            return stale;
          }
          entry.snapshot = snap;
          return snap;
        }
        entry.snapshot = snap;
        entry.fetchedAt = this.now().getTime();
        return snap;
      } finally {
        entry.inflight = undefined;
      }
    })();
    return entry.inflight;
  }

  /** Providers that currently have authorized auth. Checked live so a
   * provider configured mid-session appears immediately. Used to filter what
   * is rendered: unconfigured providers never surface as "unavailable" noise. */
  async availableProviders(): Promise<UsageProvider[]> {
    const available: UsageProvider[] = [];
    for (const p of this.registry.all()) {
      try {
        if (await p.isAvailable()) available.push(p);
      } catch {
        // A provider that errors on availability is simply skipped.
      }
    }
    return available;
  }

  /** Refresh every available provider. Used by startup and the background timer. */
  async refreshAll(options?: UsageRefreshOptions): Promise<UsageSnapshot[]> {
    const available = await this.availableProviders();
    const results = await Promise.all(available.map((p) => this.getUsage(p.id, options)));
    this.lastRefreshAt = this.now().getTime();
    return results;
  }

  getLastRefreshAt(): number | undefined {
    return this.lastRefreshAt;
  }

  /** Cache state per provider. Pass `ids` to restrict the report to a subset
   * (e.g. only available providers) — mirrors what the UI actually renders. */
  getCacheInfo(ids?: readonly string[]): CacheInfo[] {
    const all = this.registry.all();
    const list = ids === undefined ? all : all.filter((p) => ids.includes(p.id));
    return list.map((p) => {
      const entry = this.cache.get(p.id);
      return {
        id: p.id,
        name: p.name,
        fetchedAt: entry?.fetchedAt,
        stale: entry?.snapshot?.stale,
        hasError: Boolean(entry?.snapshot?.error),
        cached: Boolean(entry?.snapshot),
      };
    });
  }
}
