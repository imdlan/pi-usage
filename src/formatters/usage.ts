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
  /** Resolve the currently active model id for a provider, if any.
   * Rendered as `Name/model` so users can see which model is in use. */
  readonly currentModelOf?: (providerId: string) => string | undefined;
}

function nameOf(s: UsageSnapshot, ctx?: FormatContext): string {
  const base = ctx?.nameOf?.(s.provider) ?? s.provider;
  const model = ctx?.currentModelOf?.(s.provider);
  return model ? `${base}/${model}` : base;
}

function shortLabel(q: UsageQuota): string {
  if (q.id === "five_hour") return "5h";
  if (q.id === "monthly") return "MCP";
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

/** Visible length, ignoring ANSI escapes (assumes single-width code points). */
function visLen(s: string): number {
  return stripAnsi(s).length;
}

/** Hard-truncate a possibly-ANSI string to `width` cells, appending an ellipsis. */
function fitToWidth(s: string, width: number): string {
  if (visLen(s) <= width) return s;
  let out = "";
  let len = 0;
  let i = 0;
  let colored = false;
  const budget = Math.max(1, width - 1); // reserve one cell for "…"
  while (i < s.length && len < budget) {
    if (s[i] === "\u001b" && s[i + 1] === "[") {
      const m = /^\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        if (m[0] !== ANSI_RESET) colored = true;
        continue;
      }
    }
    out += s[i];
    len += 1;
    i += 1;
  }
  return out + "…" + (colored ? ANSI_RESET : "");
}

function fmtNum(n?: number): string {
  return n === undefined || !Number.isFinite(n) ? "—" : String(n);
}

/** `年-月-日 时:分:秒` in local time; single canonical format everywhere. */
function fmtTime(iso?: string): string {
  if (!iso || iso.length === 0) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Format a epoch-milliseconds timestamp. */
function fmtEpoch(ms: number): string {
  return fmtTime(new Date(ms).toISOString());
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

/**
 * Detailed single-provider view for `/usage <provider>`, rendered as an ASCII
 * table. The provider name and refresh time form a centered, two-line spanning
 * header; every quota block and its sub-rows are separated by horizontal rules.
 * When `width` is given, optional columns are dropped and title lines that no
 * longer fit are omitted entirely. The layout is provider-agnostic: any future
 * provider renders the same table with its own name in the header. */
export function formatProviderDetail(
  s: UsageSnapshot,
  ctx?: FormatContext,
  width?: number,
): string {
  const lines: string[] = [];

  if (s.quotas.length > 0) {
    lines.push(...renderUsageTable(s, ctx, width));
  } else {
    const name = nameOf(s, ctx);
    const stale = s.stale ? "  " + yellow("⚠ data may be stale") : "";
    lines.push(`${name}${stale}`);
    lines.push(dim(`refreshed ${fmtTime(s.timestamp)}`));
    if (s.error) {
      const http = s.error.httpStatus ? ` (HTTP ${s.error.httpStatus})` : "";
      lines.push(red(`error: ${s.error.code} — ${s.error.message}${http}`));
    }
    lines.push("");
    lines.push(dim("Quotas: (none reported)"));
  }

  if (s.models && s.models.length > 0) {
    lines.push("");
    const current = ctx?.currentModelOf?.(s.provider);
    lines.push(current ? "Models (* = current):" : "Models:");
    for (const m of s.models) {
      const mark = current !== undefined && m.model === current ? "*" : " ";
      const pct = m.percentage !== undefined ? `  (${formatPct(m.percentage)})` : "";
      lines.push(`  ${mark} ${pad(m.model, 24)}${fmtNum(m.used)}${pct}`);
    }
  }
  return sanitizeText(
    width === undefined ? lines.join("\n") : lines.map((l) => fitToWidth(l, width)).join("\n"),
  );
}

// --- ASCII table renderer -------------------------------------------------

interface TableRow {
  /** Cell per column; missing cells render as empty. */
  readonly cells: readonly string[];
}

interface ColumnSpec {
  readonly title: string;
  /** Drop order under narrow widths; lower is dropped sooner. Required if omitted. */
  readonly optional?: number;
}

/** Pad to a visible width, ignoring ANSI escapes. */
function visPad(s: string, n: number): string {
  const len = visLen(s);
  return len >= n ? s : s + " ".repeat(n - len);
}

/** Render a bordered ASCII table: `|` columns, `+`/`-` rules, a header row,
 * and a horizontal rule after every row block. Dims the border lines. */
function renderAsciiTable(
  columns: readonly ColumnSpec[],
  rows: readonly TableRow[],
  width: number | undefined,
  /** Spanning rows rendered above the column header, each centered. Lines
   * that would not fit the table width are omitted (responsive). */
  titleLines: readonly string[] = [],
): string[] {
  const natural = columns.map((c, i) =>
    Math.max(visLen(c.title), ...rows.map((r) => visLen(r.cells[i] ?? ""))),
  );
  const total = (ws: readonly number[]): number => ws.filter((w) => w > 0).reduce((acc, w) => acc + w + 3, 1);

  // Drop optional columns (lowest optional value first) until the table fits.
  let active = columns.map((_, i) => i);
  if (width !== undefined) {
    while (total(active.map((i) => natural[i] ?? 0)) > width) {
      const drop = columns
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => active.includes(i) && c.optional !== undefined)
        .sort((a, b) => (a.c.optional ?? 0) - (b.c.optional ?? 0))[0];
      if (!drop) break;
      active = active.filter((i) => i !== drop.i);
    }
  }
  let widths: number[] = natural.map((w, i) => (active.includes(i) ? w : 0));

  // Still too wide: shrink the first (label) column; cells hard-truncate.
  if (width !== undefined && total(widths) > width) {
    const others = widths.filter((w) => w > 0).reduce((acc, w) => acc + w + 3, 1) - (widths[0] ?? 0) - 3;
    widths = widths.map((w, i) => (i === 0 ? Math.max(3, width - others - 3) : w));
  }

  const border = dim("+" + active.map((i) => "-".repeat((widths[i] ?? 0) + 2)).join("+") + "+");
  const vbar = dim("|");
  const renderRow = (cells: readonly string[]): string =>
    active.map((i) => `${vbar} ${visPad(fitToWidth(cells[i] ?? "", widths[i] ?? 0), widths[i] ?? 0)} `).join("") + vbar;

  // Centered spanning title rows across the full table width.
  const tableWidth = total(widths);
  const inner = tableWidth - 2;
  const renderSpan = (text: string): string => {
    const len = visLen(text);
    const left = Math.floor((inner - len) / 2);
    return `${vbar}${" ".repeat(Math.max(0, left))}${text}${" ".repeat(Math.max(0, inner - len - Math.max(0, left)))}${vbar}`;
  };
  const titles = titleLines.filter((t) => t.length > 0).filter((t) => width === undefined || visLen(t) <= inner);

  const out: string[] = [border];
  for (const t of titles) out.push(renderSpan(t));
  if (titles.length > 0) out.push(border);
  out.push(renderRow(columns.map((c) => c.title)), border);
  for (const r of rows) out.push(renderRow(r.cells), border);
  return out;
}

const USAGE_COLUMNS: readonly ColumnSpec[] = [
  { title: "Quota" },
  { title: "Usage", optional: 4 },
  { title: "Pct" },
  { title: "Used", optional: 3 },
  { title: "Left", optional: 2 },
  { title: "Resets", optional: 1 },
];

function quotaRowCells(label: string, q: UsageQuota): string[] {
  let used = "—";
  if (q.used !== undefined && q.limit !== undefined) used = `${fmtNum(q.used)} / ${fmtNum(q.limit)}`;
  else if (q.used !== undefined) used = `used ${fmtNum(q.used)}`;
  else if (q.limit !== undefined) used = `limit ${fmtNum(q.limit)}`;
  return [
    label,
    q.percentage !== undefined ? bar(q.percentage) : "—",
    pctColor(q.percentage)(formatPct(q.percentage).padStart(3)),
    dim(used),
    q.remaining !== undefined ? dim(fmtNum(q.remaining)) : "—",
    q.resetAt ? dim(fmtTime(q.resetAt)) : "—",
  ];
}

function detailRowCells(d: UsageQuotaDetail): string[] {
  let used = "—";
  if (d.used !== undefined && d.limit !== undefined) used = `${fmtNum(d.used)} / ${fmtNum(d.limit)}`;
  else if (d.used !== undefined) used = `used ${fmtNum(d.used)}`;
  else if (d.limit !== undefined) used = `limit ${fmtNum(d.limit)}`;
  return [
    dim(`  ${d.label}`),
    d.percentage !== undefined ? bar(d.percentage) : "—",
    pctColor(d.percentage)(formatPct(d.percentage).padStart(3)),
    dim(used),
    d.remaining !== undefined ? dim(fmtNum(d.remaining)) : "—",
    "—",
  ];
}

/** Build the quota table: the provider name and refresh time form a centered
 * two-line spanning header; one row per quota and one indented row per
 * sub-item, each separated from the next by a horizontal rule. */
function renderUsageTable(s: UsageSnapshot, ctx: FormatContext | undefined, width: number | undefined): string[] {
  const name = nameOf(s, ctx);
  const stale = s.stale ? " ⚠ data may be stale" : "";
  const titles = [`${name}${yellow(stale)}`, dim(`refreshed ${fmtTime(s.timestamp)}`)];
  if (s.error) {
    const http = s.error.httpStatus ? ` (HTTP ${s.error.httpStatus})` : "";
    titles.push(red(`error: ${s.error.code} — ${s.error.message}${http}`));
  }
  const rows: TableRow[] = [];
  for (const q of s.quotas) {
    rows.push({ cells: quotaRowCells(q.label, q) });
    for (const d of q.details ?? []) rows.push({ cells: detailRowCells(d) });
  }
  return renderAsciiTable(USAGE_COLUMNS, rows, width, titles);
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
        .map((q) => {
          const seg = `${shortLabel(q)} ${formatPct(q.percentage)}`;
          return q.resetAt ? `${seg} ${dim(fmtTime(q.resetAt))}` : seg;
        })
        .join(" · ");
      return `${head} — ${qs}${s.stale ? "  ·  ⚠ stale" : ""}`;
    }
    if (s.error) return `${head} — unavailable (${s.error.code})`;
    return `${head} — no quota data`;
  });
  return sanitizeText(lines.join("\n"));
}

/** Status report for `/usage status`, rendered as a bordered ASCII table. */
export function formatStatus(
  snapshots: readonly UsageSnapshot[],
  cacheInfo: readonly CacheInfo[],
  lastRefreshAt: number | undefined,
  ctx?: FormatContext,
  width?: number,
): string {
  const columns: readonly ColumnSpec[] = [
    { title: "Provider" },
    { title: "State", optional: 1 },
    { title: "Fetched", optional: 2 },
  ];
  const rows: TableRow[] = cacheInfo.map((c) => {
    const name = ctx?.nameOf?.(c.id) ?? c.id;
    const state = c.hasError ? "error" : c.stale ? "stale" : c.cached ? "ok" : "not cached";
    const fetched = c.fetchedAt !== undefined ? fmtEpoch(c.fetchedAt) : "—";
    return { cells: [`${name} (${c.id})`, state, fetched] };
  });
  const titles = [
    "Usage status",
    `last refresh ${lastRefreshAt !== undefined ? fmtEpoch(lastRefreshAt) : "never"}`,
    `status line  ${snapshots.length > 0 ? formatStatusLine(snapshots, ctx) : "(empty)"}`,
  ];
  const models = snapshots
    .map((s) => (ctx?.currentModelOf?.(s.provider) ? `${nameOf(s, ctx)}` : undefined))
    .filter((v): v is string => v !== undefined);
  if (models.length > 0) {
    titles.push(`current model ${models.join(" | ")}`);
  }
  if (rows.length === 0) {
    return sanitizeText(titles.join("\n") + "\n\nNo providers registered.");
  }
  return sanitizeText(renderAsciiTable(columns, rows, width, titles).join("\n"));
}
