// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Renderers for command output and the status line. All output is run through
 * `sanitizeText` as defense in depth, so an accidental secret in any field can
 * never reach the terminal. Rendering never receives credentials — snapshots are
 * safe by construction, but the scrub is belt-and-braces.
 */

import { CONFIG } from "../config.js";
import type { CacheInfo } from "../services/usage-service.js";
import type { UsageQuota, UsageSnapshot } from "../providers/types.js";
import { sanitizeText } from "../utils/sanitize.js";
import { truncate } from "../utils/time.js";

export interface FormatContext {
  /** Resolve a provider id to a display name (e.g. "zai" -> "GLM"). */
  readonly nameOf?: (providerId: string) => string;
}

function nameOf(s: UsageSnapshot, ctx?: FormatContext): string {
  return ctx?.nameOf?.(s.provider) ?? s.provider;
}

function shortLabel(q: UsageQuota): string {
  if (q.id === "five_hour") return "5h";
  if (q.id === "monthly") return "month";
  return q.label;
}

function formatPct(p?: number): string {
  return p === undefined || !Number.isFinite(p) ? "—" : `${Math.round(p)}%`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmtNum(n?: number): string {
  return n === undefined || !Number.isFinite(n) ? "—" : String(n);
}

function isoLabel(iso?: string): string {
  return iso && iso.length > 0 ? `${iso} (UTC)` : "—";
}

/** One provider's compact status-line segment. */
export function providerStatusSegment(s: UsageSnapshot, ctx?: FormatContext): string {
  const name = nameOf(s, ctx);
  if (s.quotas.length > 0) {
    const qs = s.quotas
      .slice(0, 2)
      .map((q) => `${shortLabel(q)} ${formatPct(q.percentage)}`)
      .join(" · ");
    return `${name} · ${qs}`;
  }
  return `${name} · usage unavailable`;
}

/** Full status line across providers, truncated to the configured max length. */
export function formatStatusLine(snapshots: readonly UsageSnapshot[], ctx?: FormatContext): string {
  if (snapshots.length === 0) return "no usage providers available";
  const line = snapshots.map((s) => providerStatusSegment(s, ctx)).join(" | ");
  return sanitizeText(truncate(line, CONFIG.statusLine.maxLength));
}

/** Detailed single-provider view for `/usage <provider>`. */
export function formatProviderDetail(s: UsageSnapshot, ctx?: FormatContext): string {
  const name = nameOf(s, ctx);
  const lines: string[] = [];
  lines.push(`${name} (${s.provider})${s.stale ? "  ·  ⚠ data may be stale" : ""}`);
  lines.push(`refreshed: ${isoLabel(s.timestamp)}`);
  if (s.error) {
    const http = s.error.httpStatus ? ` (HTTP ${s.error.httpStatus})` : "";
    lines.push(`error: ${s.error.code} — ${s.error.message}${http}`);
  }
  lines.push("");

  if (s.quotas.length > 0) {
    lines.push("Quotas:");
    for (const q of s.quotas) {
      let row = `  ${pad(q.label, 18)}${pad(formatPct(q.percentage), 6)}`;
      const parts: string[] = [];
      if (q.used !== undefined) parts.push(`used ${fmtNum(q.used)}`);
      if (q.limit !== undefined) parts.push(`limit ${fmtNum(q.limit)}`);
      if (q.remaining !== undefined) parts.push(`remaining ${fmtNum(q.remaining)}`);
      if (q.resetAt) parts.push(`resets ${isoLabel(q.resetAt)}`);
      if (parts.length > 0) row += `   ${parts.join("  ·  ")}`;
      lines.push(row);
    }
  } else {
    lines.push("Quotas: (none reported)");
  }

  if (s.models && s.models.length > 0) {
    lines.push("");
    lines.push("Models:");
    for (const m of s.models) {
      const pct = m.percentage !== undefined ? `  (${formatPct(m.percentage)})` : "";
      lines.push(`  ${pad(m.model, 24)}${fmtNum(m.used)}${pct}`);
    }
  }
  return sanitizeText(lines.join("\n"));
}

/** Summary across providers for `/usage`. */
export function formatSummary(snapshots: readonly UsageSnapshot[], ctx?: FormatContext): string {
  if (snapshots.length === 0) {
    return [
      "No usage providers available.",
      "Configure a provider in Pi (e.g. Z.ai / GLM) to see usage.",
    ].join("\n");
  }
  const lines = snapshots.map((s) => {
    const head = `${nameOf(s, ctx)} (${s.provider})`;
    if (s.quotas.length > 0) {
      const qs = s.quotas
        .slice(0, 2)
        .map((q) => `${shortLabel(q)} ${formatPct(q.percentage)}`)
        .join(" · ");
      return `${head} — ${qs}${s.stale ? "  ·  ⚠ stale" : ""}`;
    }
    if (s.error) return `${head} — unavailable (${s.error.code})`;
    return `${head} — no quota data`;
  });
  return sanitizeText(lines.join("\n"));
}

/** Status report for `/usage status`. */
export function formatStatus(
  snapshots: readonly UsageSnapshot[],
  cacheInfo: readonly CacheInfo[],
  lastRefreshAt: number | undefined,
  ctx?: FormatContext,
): string {
  const lines: string[] = [];
  lines.push(
    `Last refresh: ${lastRefreshAt !== undefined ? isoLabel(new Date(lastRefreshAt).toISOString()) : "never"}`,
  );
  lines.push("");
  lines.push("Status line: " + (snapshots.length > 0 ? formatStatusLine(snapshots, ctx) : "(empty)"));
  lines.push("");
  lines.push("Providers:");
  for (const c of cacheInfo) {
    const name = ctx?.nameOf?.(c.id) ?? c.id;
    const state = c.hasError ? "error" : c.stale ? "stale" : c.cached ? "ok" : "not cached";
    const fetched = c.fetchedAt !== undefined ? isoLabel(new Date(c.fetchedAt).toISOString()) : "—";
    lines.push(`  ${name} (${c.id}): ${state}, fetched ${fetched}`);
  }
  return sanitizeText(lines.join("\n"));
}
