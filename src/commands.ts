// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Slash-command routing for `/usage`. Pure and testable — the Pi entry point
 * maps the resolved action onto service calls and formatters.
 */

export type UsageAction =
  | { readonly kind: "summary" }
  | { readonly kind: "detail"; readonly providerId: string }
  | { readonly kind: "refresh" }
  | { readonly kind: "status" }
  | { readonly kind: "pin"; readonly mode: "on" | "off" | "toggle" }
  | { readonly kind: "unknown"; readonly input: string };

/**
 * Parse the `/usage <arg>` argument. Provider matching is case-sensitive and
 * must match a registered provider id exactly.
 */
export function routeUsageCommand(
  input: string | undefined,
  knownIds: readonly string[],
): UsageAction {
  const arg = (input ?? "").trim();
  if (arg === "") return { kind: "summary" };
  const [head, ...rest] = arg.split(/\s+/);
  if (head === "refresh") return { kind: "refresh" };
  if (head === "status") return { kind: "status" };
  if (head === "pin") {
    const sub = rest[0];
    if (sub === undefined) return { kind: "pin", mode: "toggle" };
    if (sub === "on" || sub === "off") return { kind: "pin", mode: sub };
    return { kind: "unknown", input: arg };
  }
  if (knownIds.includes(arg)) return { kind: "detail", providerId: arg };
  return { kind: "unknown", input: arg };
}
