// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

import type { UsageProvider } from "./types.js";

/**
 * Provider registry. Holds constructed {@link UsageProvider} instances keyed by
 * stable id. Construction (and any Pi-specific auth wiring) happens at the Pi
 * layer; the registry is pure bookkeeping so it stays testable in isolation.
 */
export class ProviderRegistry {
  private readonly map = new Map<string, UsageProvider>();

  register(provider: UsageProvider): void {
    this.map.set(provider.id, provider);
  }

  get(id: string): UsageProvider | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  all(): UsageProvider[] {
    return [...this.map.values()];
  }

  ids(): readonly string[] {
    return [...this.map.keys()];
  }
}
