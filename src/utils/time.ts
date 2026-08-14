// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Time and numeric helpers shared across providers and formatters.
 *
 * `zaiUsageWindow` mirrors the official glm-plan-usage time window logic so the
 * Z.ai adapter queries the same range as the upstream plugin.
 */

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a Date as `yyyy-MM-dd HH:mm:ss` (local time, matching upstream). */
export function formatZaiDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

export interface ZaiWindow {
  readonly startTime: string;
  readonly endTime: string;
}

/**
 * Official glm-plan-usage window: yesterday at the current hour (HH:00:00) to
 * today at the current hour end (HH:59:59).
 */
export function zaiUsageWindow(now: Date = new Date()): ZaiWindow {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
    now.getHours(),
    0,
    0,
    0,
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    59,
    59,
    999,
  );
  return { startTime: formatZaiDateTime(start), endTime: formatZaiDateTime(end) };
}

/** Current UTC timestamp in ISO-8601. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Consumption percentage (0-100) with one decimal, or undefined when unknown. */
export function computePercentage(used?: number, limit?: number): number | undefined {
  if (used === undefined || limit === undefined) return undefined;
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return undefined;
  if (limit <= 0) return undefined;
  return Math.round((used / limit) * 1000) / 10;
}

/** Remaining allowance, floored at 0, or undefined when unknown. */
export function computeRemaining(limit?: number, used?: number): number | undefined {
  if (limit === undefined || used === undefined) return undefined;
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return undefined;
  return Math.max(0, limit - used);
}

/** Clamp a percentage to [0,100]; pass through undefined. */
export function clampPercentage(p?: number): number | undefined {
  if (p === undefined || !Number.isFinite(p)) return undefined;
  return Math.max(0, Math.min(100, p));
}

/** Truncate text to `max` characters, appending an ellipsis when truncated. */
export function truncate(text: string, max: number): string {
  if (max < 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, max);
  return text.slice(0, max - 1) + "…";
}
