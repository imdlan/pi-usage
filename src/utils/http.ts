// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Controlled HTTP client for usage queries.
 *
 * Security properties:
 * - HTTPS only; non-HTTPS URLs are rejected.
 * - Host must be in the caller-supplied allowlist (per provider).
 * - Redirects are rejected (`redirect: "error"`) so a response cannot redirect
 *   to a non-allowlist host.
 * - Non-2xx responses are classified into controlled error codes WITHOUT reading
 *   the body (a body could echo back secrets or tokens).
 * - Failures never embed the raw request/response; only HTTP status and a short,
 *   safe description are kept.
 *
 * `fetch` is injectable so tests never touch the network.
 */

import { toUsageError, UsageErrorCode } from "../providers/types.js";
import type { UsageError } from "../providers/types.js";
import { INTERNAL_TIMEOUT_SENTINEL } from "./sanitize.js";

export interface HttpSuccess<T> {
  readonly ok: true;
  readonly status: number;
  readonly data: T;
}
export interface HttpFailure {
  readonly ok: false;
  readonly error: UsageError;
}
export type HttpResult<T> = HttpSuccess<T> | HttpFailure;

export interface ControlledFetchOptions {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs: number;
  readonly allowlist: readonly string[];
  /** Injectable fetch; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Optional caller abort signal (e.g. session shutdown). */
  readonly signal?: AbortSignal;
}

type Json = unknown;

function fail(error: UsageError): HttpFailure {
  return { ok: false, error };
}

function validateUrl(url: string, allowlist: readonly string[]): UsageError | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return toUsageError(UsageErrorCode.UnsafeUrl, "invalid url");
  }
  if (parsed.protocol !== "https:") {
    return toUsageError(UsageErrorCode.UnsafeUrl, "non-https url rejected");
  }
  if (!allowlist.includes(parsed.hostname)) {
    return toUsageError(UsageErrorCode.Allowlist, "host not in allowlist");
  }
  return undefined;
}

function classifyHttpStatus(status: number): UsageError {
  switch (status) {
    case 401:
      return toUsageError(UsageErrorCode.Auth, "authentication failed", status);
    case 403:
      return toUsageError(UsageErrorCode.Forbidden, "forbidden", status);
    case 429:
      return toUsageError(UsageErrorCode.RateLimited, "rate limited", status);
    default:
      if (status >= 500) return toUsageError(UsageErrorCode.ServerError, "server error", status);
      return toUsageError(UsageErrorCode.HttpStatus, `http ${status}`, status);
  }
}

/**
 * Perform a controlled GET and parse the body as JSON. Never throws; failures are
 * returned as {@link HttpFailure}.
 */
export async function controlledGetJson<T = Json>(
  opts: ControlledFetchOptions,
): Promise<HttpResult<T>> {
  const urlError = validateUrl(opts.url, opts.allowlist);
  if (urlError) return fail(urlError);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(INTERNAL_TIMEOUT_SENTINEL)),
    opts.timeoutMs,
  );
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const fetchImpl = opts.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(opts.url, {
      method: "GET",
      headers: opts.headers ?? {},
      signal: controller.signal,
      redirect: "error",
    });
  } catch (err) {
    if (controller.signal.aborted) {
      const timedOut = String(controller.signal.reason ?? "").includes(INTERNAL_TIMEOUT_SENTINEL);
      return timedOut
        ? fail(toUsageError(UsageErrorCode.Timeout, "request timed out"))
        : fail(toUsageError(UsageErrorCode.Network, "request aborted"));
    }
    const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase();
    if (msg.includes("redirect")) {
      return fail(toUsageError(UsageErrorCode.UnsafeUrl, "redirect rejected"));
    }
    if (msg.includes("timed out") || msg.includes("timeout")) {
      return fail(toUsageError(UsageErrorCode.Timeout, "request timed out"));
    }
    return fail(toUsageError(UsageErrorCode.Network, "network request failed"));
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 200 && response.status < 300) {
    try {
      const data = (await response.json()) as T;
      return { ok: true, status: response.status, data };
    } catch {
      return fail(toUsageError(UsageErrorCode.InvalidJson, "invalid json response"));
    }
  }
  // Non-2xx: never read the body into a message (it could leak secrets).
  return fail(classifyHttpStatus(response.status));
}
