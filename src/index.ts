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
import { createDeepSeekProvider, DEEPSEEK_ALLOWED_HOSTS } from "./providers/deepseek.js";
import { createOpenRouterProvider, OPENROUTER_ALLOWED_HOSTS } from "./providers/openrouter.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { ProviderAuth, UsageSnapshot } from "./providers/types.js";
import { createZaiProvider, ZAI_ALLOWED_HOSTS } from "./providers/zai.js";
import { StatusLineService } from "./services/status-line.js";
import { UsageService } from "./services/usage-service.js";

const WIDGET_KEY = "pi-usage";

/** Map usage provider id -> the hosts its Pi provider entry may point at.
 * Used both for auth resolution and for active-model matching. */
const PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  zai: ZAI_ALLOWED_HOSTS,
  deepseek: DEEPSEEK_ALLOWED_HOSTS,
  openrouter: OPENROUTER_ALLOWED_HOSTS,
};

/**
 * Build a host-allowlist auth resolver backed by Pi's authorized
 * `getProviderAuth`.
 *
 * Candidate providers are discovered from the FULL model catalog via
 * `getAll()`, NOT from `getRegisteredProviderIds()`. The latter only lists
 * providers registered by *extensions*, so a normally-configured provider
 * (e.g. `zai-coding-cn` or a custom DeepSeek entry), which is registered
 * through models config + catalog cache, is never listed and the resolver
 * would silently miss it.
 *
 * Every model carries both its `provider` id and `baseUrl`, which is enough to
 * locate any configured provider whose host is on the allowlist (fail-closed).
 * Returns undefined when none is available. Never reads credential files or
 * env vars directly.
 */
function createHostAuthResolver(
  ctx: ExtensionContext,
  allowedHosts: readonly string[],
): () => Promise<ProviderAuth | undefined> {
  const registry = ctx.modelRegistry;
  return async () => {
    let models: readonly { provider: string; baseUrl: string }[];
    try {
      models = registry.getAll();
    } catch {
      return undefined;
    }
    // First-seen order, deduped by provider id. Keep only models whose host is
    // on the Z.ai allowlist so we never touch a non-Z.ai provider's auth.
    const seen = new Set<string>();
    const candidates: { providerId: string; baseUrl: string }[] = [];
    for (const m of models) {
      if (!m || typeof m.provider !== "string" || typeof m.baseUrl !== "string") continue;
      if (seen.has(m.provider)) continue;
      let host: string;
      try {
        host = new URL(m.baseUrl).hostname;
      } catch {
        continue;
      }
      if (!(allowedHosts as readonly string[]).includes(host)) continue;
      seen.add(m.provider);
      candidates.push({ providerId: m.provider, baseUrl: m.baseUrl });
    }
    for (const { providerId, baseUrl } of candidates) {
      try {
        const auth = (await registry.getProviderAuth(providerId)) as
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
  /** Session UI context; valid between session_start and session_shutdown. */
  let uiCtx: ExtensionContext | undefined;
  /** Whether the summary widget is pinned above the editor and kept fresh. */
  let pinned = false;
  /** Currently active model, tracked via model_select (set/cycle/restore).
   * Includes the model's baseUrl so provider matching can fall back to host
   * allowlist comparison — the usage registry id (`zai`) does not equal Pi's
   * provider entry id (`zai-coding-cn`). */
  let currentModel: { provider: string; id: string; baseUrl?: string } | undefined;

  /** Resolve a model's baseUrl from the full catalog (first match on
   * provider id + model id). The event payload does not guarantee baseUrl. */
  function lookupBaseUrl(ctx: ExtensionContext, provider: string, id: string): string | undefined {
    try {
      const m = ctx.modelRegistry.getAll().find(
        (m) => m.provider === provider && m.id === id,
      );
      return m && typeof m.baseUrl === "string" ? m.baseUrl : undefined;
    } catch {
      return undefined;
    }
  }

  /** Resolve the active model id for a usage provider id. Matches the exact
   * Pi provider id first, then falls back to a host-allowlist match so an entry
   * like `zai-coding-cn` maps onto the `zai` usage provider. */
  function activeModelFor(providerId: string): string | undefined {
    if (!currentModel) return undefined;
    if (currentModel.provider === providerId) return currentModel.id;
    const hosts = PROVIDER_HOSTS[providerId];
    if (!hosts || currentModel.baseUrl === undefined) return undefined;
    let host: string;
    try {
      host = new URL(currentModel.baseUrl).hostname;
    } catch {
      return undefined;
    }
    return hosts.includes(host) ? currentModel.id : undefined;
  }

  function fmtCtx(): FormatContext {
    return {
      nameOf: (id) => registry?.get(id)?.name ?? id,
      currentModelOf: activeModelFor,
    };
  }

  /** Render the widget from a width-aware builder. The custom component
   * re-runs `render(width)` on terminal resize, so the layout stays responsive. */
  function renderWidget(build: (width?: number) => string): void {
    const ctx = uiCtx;
    if (!ctx) return;
    if (ctx.hasUI) {
      const pad = CONFIG.widget.leftPaddingSpaces;
      ctx.ui.setWidget(WIDGET_KEY, () => ({
        render: (width: number) =>
          build(Math.max(0, width - pad))
            .split("\n")
            .map((l) => " ".repeat(pad) + l),
        invalidate: () => {},
      }));
    } else {
      ctx.ui.notify(build().split("\n")[0] ?? "", "info");
    }
  }

  /** Remove the widget entirely (used when unpinning and on shutdown). */
  function clearWidget(): void {
    const ctx = uiCtx;
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // Best-effort; a failing clear must never break shutdown.
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
      void (async () => {
        await statusLine.update(service, { forceRefresh: true }).catch(() => undefined);
        // Keep the pinned widget in sync from the freshly written cache.
        if (pinned) {
          const snaps = await collectCached().catch(() => []);
          if (pinned && snaps.length > 0) {
            renderWidget(() => formatSummary(snaps, fmtCtx()));
          }
        }
      })();
    };
    startupTimer = setTimeout(refresh, CONFIG.refresh.startupDelayMs);
    timer = setInterval(refresh, CONFIG.refresh.intervalMs);
  }

  pi.on("session_start", (event, ctx) => {
    uiCtx = ctx;
    // Seed the active model from ctx.model — model_select for the initial
    // session restore may have fired before this extension finished loading.
    const m = ctx.model;
    if (m && typeof m.provider === "string" && typeof m.id === "string") {
      currentModel = {
        provider: m.provider,
        id: m.id,
        baseUrl:
          typeof m.baseUrl === "string" ? m.baseUrl : lookupBaseUrl(ctx, m.provider, m.id),
      };
    }
    registry = new ProviderRegistry();
    registry.register(createZaiProvider({ resolveAuth: createHostAuthResolver(ctx, ZAI_ALLOWED_HOSTS) }));
    registry.register(
      createDeepSeekProvider({ resolveAuth: createHostAuthResolver(ctx, DEEPSEEK_ALLOWED_HOSTS) }),
    );
    registry.register(
      createOpenRouterProvider({ resolveAuth: createHostAuthResolver(ctx, OPENROUTER_ALLOWED_HOSTS) }),
    );
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
    pinned = false;
    clearWidget();
    uiCtx = undefined;
    currentModel = undefined;
    registry = undefined;
    service = undefined;
    statusLine = undefined;
  });

  // Track the active model so the footer, summary, and detail views can show
  // `Name/model`. Re-render from cache on change so the footer follows switches
  // made via /model, cycling (Ctrl+P), or session restore.
  pi.on("model_select", (event, ctx) => {
    currentModel = {
      provider: event.model.provider,
      id: event.model.id,
      baseUrl:
        typeof event.model.baseUrl === "string"
          ? event.model.baseUrl
          : lookupBaseUrl(ctx, event.model.provider, event.model.id),
    };
    if (!service || !statusLine) return;
    void (async () => {
      await statusLine.update(service).catch(() => undefined);
      if (pinned) {
        const snaps = await collectCached().catch(() => []);
        if (pinned && snaps.length > 0) {
          renderWidget(() => formatSummary(snaps, fmtCtx()));
        }
      }
    })();
  });

  pi.registerCommand("usage", {
    description: "View AI provider usage and quota: /usage [provider|refresh|status|pin]",
    handler: async (args, ctx) => {
      const ids = registry ? [...registry.ids()] : [];
      const action = routeUsageCommand(args, ids);
      try {
        switch (action.kind) {
          case "summary": {
            const snaps = await collectCached();
            renderWidget(() => formatSummary(snaps, fmtCtx()));
            return;
          }
          case "detail": {
            if (!service) return;
            const s = await service.getUsage(action.providerId);
            renderWidget((width) => formatProviderDetail(s, fmtCtx(), width));
            return;
          }
          case "refresh": {
            if (!service || !statusLine) return;
            const snaps = await service.refreshAll({ forceRefresh: true });
            void statusLine.update(service, { forceRefresh: true }).catch(() => undefined);
            renderWidget(() => formatSummary(snaps, fmtCtx()));
            return;
          }
          case "status": {
            if (!service) return;
            const snaps = await collectCached();
            const info = service.getCacheInfo();
            const last = service.getLastRefreshAt();
            renderWidget((width) => formatStatus(snaps, info, last, fmtCtx(), width));
            return;
          }
          case "pin": {
            const enable =
              action.mode === "on" || (action.mode === "toggle" && !pinned);
            pinned = enable;
            if (enable) {
              const snaps = await collectCached();
              renderWidget(() => formatSummary(snaps, fmtCtx()));
              ctx.ui.notify("usage widget pinned (updates every refresh)", "info");
            } else {
              clearWidget();
              ctx.ui.notify("usage widget unpinned", "info");
            }
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
