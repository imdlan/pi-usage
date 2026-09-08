// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Status line controller. Renders the compact usage line into Pi's footer via
 * `setStatus`. Updates are best-effort and never throw — a failure to refresh
 * must not disturb the model or the UI.
 */

import type { FormatContext } from "../formatters/usage.js";
import { formatStatusLine } from "../formatters/usage.js";
import type { UsageService } from "./usage-service.js";

export interface StatusLineSink {
  setStatus(key: string, text: string | undefined): void;
}

export class StatusLineService {
  private readonly sink: StatusLineSink;
  private readonly ctx: FormatContext | undefined;

  constructor(sink: StatusLineSink, ctx?: FormatContext) {
    this.sink = sink;
    this.ctx = ctx;
  }

  /**
   * Refresh providers and write the status line. Never throws.
   *
   * When `options.activeId` is given, only that provider is refreshed and
   * rendered — the status line follows the currently active model instead of
   * querying every configured provider. When omitted, all available providers
   * are refreshed and rendered (fallback for active models that do not map to
   * any supported usage provider).
   */
  async update(
    service: UsageService,
    options?: { forceRefresh?: boolean; activeId?: string },
  ): Promise<void> {
    try {
      const snaps =
        options?.activeId !== undefined
          ? [await service.getUsage(options.activeId, { forceRefresh: options?.forceRefresh })]
          : await service.refreshAll({ forceRefresh: options?.forceRefresh });
      this.sink.setStatus("pi-usage", formatStatusLine(snaps, this.ctx));
    } catch {
      this.sink.setStatus("pi-usage", "usage unavailable");
    }
  }

  clear(): void {
    this.sink.setStatus("pi-usage", undefined);
  }
}
