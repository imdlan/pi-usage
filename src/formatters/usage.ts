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
import type { UsageQuota, UsageQuotaDetail, UsageSnapshot } from "../providers/types.js";
import { sanitizeText } from "../utils/sanitize.js";
import { clampPercentage, pad2, truncate } from "../utils/time.js";

export interface FormatContext {
  /** Resolve a provider id to a display name (e.g. "zai" -> "GLM"). */
  readonly nameOf?: (providerId: string) => string;
}

function nameOf(s: UsageSnapshot, ctx?: FormatContext): string {
  return ctx?.nameOf?.(s.provider) ?? s.provider;
}

function shortLabel(q: UsageQuota): string {
  if (q.id === "five_hour") return "5h";
  if (q.id === "monthly") return "mcp";
  return q.label;
}

function formatPct(p?: number): string {
  return p === undefined || !Number.isFinite(p) ? "—" : `${Math.round(p)}%`;
}

/** Terminal bar like [#####-----], `width` cells, 10% per cell. */
function bar(p: number | undefined, width = 10): string {
  if (p === undefined || !Number.isFinite(p)) return " ".repeat(width + 2);
  const pct = clampPercentage(p) ?? 0;
  const filled = Math.round((pct / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function pctColor(p: number | undefined): (s: string) => string {
  if (p === undefined || !Number.isFinite(p)) return (s) => s;
  if (p >= 90) return red;
  if (p >= 70) return yellow;
  return green;
}

const ANSI_GREEN = "\u001b[32m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RED = "\u001b[31m";
const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";

function green(s: string): string {
  return ANSI_GREEN + s + ANSI_RESET;
}
function yellow(s: string): string {
  return ANSI_YELLOW + s + ANSI_RESET;
}
function red(s: string): string {
  return ANSI_RED + s + ANSI_RESET;
}
function dim(s: string): string {
  return ANSI_DIM + s + ANSI_RESET;
}

/** Strip ANSI escapes (used by tests and length math). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmtNum(n?: number): string {
  return n === undefined || !Number.isFinite(n) ? "—" : String(n);
}

function detailParts(d: UsageQuotaDetail): string {
  const parts: string[] = [];
  if (d.used !== undefined && d.limit !== undefined) parts.push(`used ${fmtNum(d.used)} / ${fmtNum(d.limit)}`);
  else {
    if (d.used !== undefined) parts.push(`used ${fmtNum(d.used)}`);
    if (d.limit !== undefined) parts.push(`limit ${fmtNum(d.limit)}`);
  }
  if (d.remaining !== undefined) parts.push(`${fmtNum(d.remaining)} left`);
  return parts.length > 0 ? dim(parts.join("  ·  ")) : "";
}

function isoLabel(iso?: string): string {
  return iso && iso.length > 0 ? `${iso} (UTC)` : "—";
}

/** `2025-05-14T10:30:45.000Z (UTC)` -> `05-14 10:30 UTC` (keeps UTC). */
function shortIso(iso?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso ?? "");
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC` : isoLabel(iso);
}

function localIso(iso?: string): string {
  if (!iso || iso.length === 0) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return isoLabel(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} local`;
}

/** Human-ish relative time: "in 2h 13m" / "3m ago", or undefined. */
function relativeIso(iso?: string, now: Date = new Date()): string | undefined {
  if (!iso || iso.length === 0) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const diffMin = Math.round((t - now.getTime()) / 60000);
  const abs = Math.abs(diffMin);
  if (abs < 1) return diffMin >= 0 ? "now" : "now";
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const span = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
  return diffMin >= 0 ? `in ${span}` : `${span} ago`;
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
  lines.push(`${name}${s.stale ? "  " + yellow("⚠ data may be stale") : ""}`);
  lines.push(dim(`refreshed ${localIso(s.timestamp)}`));
  if (s.error) {
    const http = s.error.httpStatus ? ` (HTTP ${s.error.httpStatus})` : "";
    lines.push(red(`error: ${s.error.code} — ${s.error.message}${http}`));
  }
  lines.push("");

  if (s.quotas.length > 0) {
    for (const q of s.quotas) {
      const color = pctColor(q.percentage);
      lines.push(
        `  ${pad(q.label, 18)}${bar(q.percentage)} ${color(formatPct(q.percentage))}`,
      );
      const parts: string[] = [];
      if (q.used !== undefined && q.limit !== undefined) parts.push(`used ${fmtNum(q.used)} / ${fmtNum(q.limit)}`);
      else {
        if (q.used !== undefined) parts.push(`used ${fmtNum(q.used)}`);
        if (q.limit !== undefined) parts.push(`limit ${fmtNum(q.limit)}`);
      }
      if (q.remaining !== undefined) parts.push(`${fmtNum(q.remaining)} left`);
      const rel = relativeIso(q.resetAt);
      if (q.resetAt) parts.push(`resets ${shortIso(q.resetAt)}${rel ? ` (${rel})` : ""}`);
      if (parts.length > 0) lines.push(`  ${" ".repeat(18 + 12 + 1)}${dim(parts.join("  ·  "))}`);
      if (q.details && q.details.length > 0) {
        for (const d of q.details) {
          const seg = `      ${pad(d.label, 18)}${bar(d.percentage, 8)} ${color(formatPct(d.percentage))}`;
          const dp = detailParts(d);
          lines.push(dp ? `${seg}  ${dp}` : seg);
        }
      }
    }
  } else {
    lines.push(dim("Quotas: (none reported)"));
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
