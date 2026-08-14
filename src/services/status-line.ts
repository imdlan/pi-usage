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

  /** Refresh providers and write the status line. Never throws. */
  async update(service: UsageService, options?: { forceRefresh?: boolean }): Promise<void> {
    try {
      const snaps = await service.refreshAll({ forceRefresh: options?.forceRefresh });
      this.sink.setStatus("pi-usage", formatStatusLine(snaps, this.ctx));
    } catch {
      this.sink.setStatus("pi-usage", "usage unavailable");
    }
  }

  clear(): void {
    this.sink.setStatus("pi-usage", undefined);
  }
}
