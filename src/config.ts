// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Centralized, safety-first configuration. Tuning values live here so they can be
 * adjusted in one place. Per-provider values (auth, network allowlists, endpoints)
 * are declared by each provider and stay isolated from one another.
 */
export const CONFIG = {
  cache: {
    /** Cache time-to-live in milliseconds (default ~2 minutes). */
    ttlMs: 2 * 60 * 1000,
  },
  refresh: {
    /** Background refresh interval in milliseconds. */
    intervalMs: 2 * 60 * 1000,
    /** Non-blocking delay before the first startup refresh, in milliseconds. */
    startupDelayMs: 1500,
  },
  http: {
    /** Per-request timeout in milliseconds. */
    timeoutMs: 10 * 1000,
  },
  statusLine: {
    /** Maximum characters before the status line is truncated. Accounts for
     * `Name/model` prefixes plus quota segments across a few providers. */
    maxLength: 100,
  },
  widget: {
    /** Left indent (terminal cells) for the pinned widget above the editor.
     * 2 cells ≈ 8–18px at typical terminal font sizes. */
    leftPaddingSpaces: 2,
  },
} as const;
