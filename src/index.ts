// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * pi-usage — Pi Coding Agent extension entry point.
 *
 * Wires the Z.ai provider to Pi's authorized auth resolution, registers the
 * `/usage` command, keeps the footer status line updated, and runs a background
 * refresh timer. Everything is session-scoped and cleaned up on shutdown.
 *
 * Security: the Z.ai token is obtained only through Pi's `getProviderAuth`
 * (the authorized path). This file never reads credential files, env vars, or
 * runs shell commands. Failures degrade silently — usage must never break Pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CONFIG } from "./config.js";
import { routeUsageCommand } from "./commands.js";
import { formatProviderDetail, formatStatus, formatSummary } from "./formatters/usage.js";
import type { FormatContext } from "./formatters/usage.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { ProviderAuth, UsageSnapshot } from "./providers/types.js";
import { createZaiProvider, ZAI_ALLOWED_HOSTS } from "./providers/zai.js";
import { StatusLineService } from "./services/status-line.js";
import { UsageService } from "./services/usage-service.js";

const WIDGET_KEY = "pi-usage";

/**
 * Build a Z.ai auth resolver backed by Pi's authorized `getProviderAuth`.
 * Scans configured providers for one whose base URL host is on the Z.ai
 * allowlist and resolves its token. Returns undefined when none is available
 * (fail-closed). Never reads credential files or env vars directly.
 */
function createZaiAuthResolver(ctx: ExtensionContext): () => Promise<ProviderAuth | undefined> {
  const registry = ctx.modelRegistry;
  return async () => {
    let ids: readonly string[];
    try {
      ids = registry.getRegisteredProviderIds();
    } catch {
      return undefined;
    }
    for (const id of ids) {
      const provider = registry.getProvider(id) as { baseUrl?: string } | undefined;
      const baseUrl = provider?.baseUrl;
      if (typeof baseUrl !== "string" || baseUrl.length === 0) continue;
      let host: string;
      try {
        host = new URL(baseUrl).hostname;
      } catch {
        continue;
      }
      if (!(ZAI_ALLOWED_HOSTS as readonly string[]).includes(host)) continue;
      try {
        const auth = (await registry.getProviderAuth(id)) as
          | { auth?: { apiKey?: string } }
          | undefined;
        const apiKey = auth?.auth?.apiKey;
        if (typeof apiKey === "string" && apiKey.length > 0) {
          return { baseUrl, apiKey };
        }
      } catch {
        // Fail-closed for this provider id; continue to the next candidate.
      }
    }
    return undefined;
  };
}

export default function piUsageExtension(pi: ExtensionAPI): void {
  let registry: ProviderRegistry | undefined;
  let service: UsageService | undefined;
  let statusLine: StatusLineService | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;

  function fmtCtx(): FormatContext {
    return { nameOf: (id) => registry?.get(id)?.name ?? id };
  }

  function renderWidget(ctx: ExtensionContext, text: string): void {
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, text.split("\n"));
    } else {
      ctx.ui.notify(text.split("\n")[0] ?? "", "info");
    }
  }

  async function collectCached(): Promise<UsageSnapshot[]> {
    if (!service || !registry) return [];
    const snaps: UsageSnapshot[] = [];
    for (const p of registry.all()) {
      snaps.push(await service.getUsage(p.id));
    }
    return snaps;
  }

  function startBackground(): void {
    const refresh = (): void => {
      if (!service || !statusLine) return;
      void statusLine.update(service, { forceRefresh: true }).catch(() => undefined);
    };
    startupTimer = setTimeout(refresh, CONFIG.refresh.startupDelayMs);
    timer = setInterval(refresh, CONFIG.refresh.intervalMs);
  }

  pi.on("session_start", (_event, ctx) => {
    registry = new ProviderRegistry();
    registry.register(createZaiProvider({ resolveAuth: createZaiAuthResolver(ctx) }));
    service = new UsageService({ registry });
    statusLine = new StatusLineService(
      { setStatus: (k, t) => ctx.ui.setStatus(k, t) },
      fmtCtx(),
    );
    startBackground();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    if (startupTimer) clearTimeout(startupTimer);
    timer = undefined;
    startupTimer = undefined;
    registry = undefined;
    service = undefined;
    statusLine = undefined;
  });

  pi.registerCommand("usage", {
    description: "View AI provider usage and quota: /usage [provider|refresh|status]",
    handler: async (args, ctx) => {
      const ids = registry ? [...registry.ids()] : [];
      const action = routeUsageCommand(args, ids);
      try {
        switch (action.kind) {
          case "summary": {
            renderWidget(ctx, formatSummary(await collectCached(), fmtCtx()));
            return;
          }
          case "detail": {
            if (!service) return;
            renderWidget(ctx, formatProviderDetail(await service.getUsage(action.providerId), fmtCtx()));
            return;
          }
          case "refresh": {
            if (!service || !statusLine) return;
            const snaps = await service.refreshAll({ forceRefresh: true });
            void statusLine.update(service, { forceRefresh: true }).catch(() => undefined);
            renderWidget(ctx, formatSummary(snaps, fmtCtx()));
            return;
          }
          case "status": {
            if (!service) return;
            renderWidget(
              ctx,
              formatStatus(await collectCached(), service.getCacheInfo(), service.getLastRefreshAt(), fmtCtx()),
            );
            return;
          }
          case "unknown": {
            ctx.ui.notify(
              `Unknown provider: ${action.input}. Known: ${ids.length > 0 ? ids.join(", ") : "(none)"}`,
              "warning",
            );
            return;
          }
        }
      } catch {
        ctx.ui.notify("usage query failed; run /usage status for details", "error");
      }
    },
  });
}
