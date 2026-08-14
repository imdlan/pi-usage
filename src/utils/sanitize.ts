// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 imdlan

/**
 * Redaction utilities — defense in depth. Anything that may reach logs, command
 * output, the status line, an error, or a test fixture passes through here.
 *
 * The regexes below describe what to REMOVE. They are never used to extract,
 * print, or persist secrets. Real secret handling is avoided upstream (credentials
 * are obtained only via Pi's authorized `getProviderAuth` and never serialized);
 * this layer exists so an accidental leak in a message is still scrubbed.
 */

const REDACTED = "[REDACTED]";
const TIMEOUT_SENTINEL = "pi-usage-timeout";
/** Exported only so callers can re-use the same sentinel for internal timeouts. */
export const INTERNAL_TIMEOUT_SENTINEL = TIMEOUT_SENTINEL;

interface ScrubRule {
  readonly re: RegExp;
  readonly replacement: string;
}

// Order matters: multiline/broad first, narrower last.
const SCRUB_RULES: readonly ScrubRule[] = [
  // PEM private key blocks (may span newlines)
  {
    re: /-----BEGIN (?:[A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]*?)PRIVATE KEY-----/g,
    replacement: `${REDACTED} PEM`,
  },
  // .env-style "KEY=value" where KEY looks like a secret name
  {
    re: /(^|[\r\n\t ;,])(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|client[_-]?secret)["']?\s*[:=]\s*"?[^\s"',;\r\n]+/gim,
    replacement: `$1$2=${REDACTED}`,
  },
  // Authorization / Proxy-Authorization header
  {
    re: /\b(?:proxy-)?authorization\s*[:=]\s*[^\r\n;,]+/gi,
    replacement: `authorization: ${REDACTED}`,
  },
  // Cookie / Set-Cookie
  {
    re: /\b(?:set-)?cookie\s*[:=]\s*[^\r\n]+/gi,
    replacement: `cookie: ${REDACTED}`,
  },
  // Bearer tokens
  {
    re: /\bbearer\s+[A-Za-z0-9._\-+=/]+/gi,
    replacement: `bearer ${REDACTED}`,
  },
  // Common API key prefixes
  {
    re: /\bsk-(?:ant-|or-|proj-|live-|test-)?[A-Za-z0-9_\-]{12,}/g,
    replacement: REDACTED,
  },
  // JWT (three base64url segments)
  {
    re: /\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\b/g,
    replacement: REDACTED,
  },
];

/** Scrub likely-secret fragments from arbitrary text. */
export function sanitizeText(input: string): string {
  let out = input;
  for (const rule of SCRUB_RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, rule.replacement);
  }
  return out;
}

/**
 * Returns true if `input` contains the exact secret value. Used by tests and by
 * runtime assertions to prove a value did not leak. Empty secrets never match.
 */
export function containsSecretValue(input: string, secret: string): boolean {
  if (secret.length === 0) return false;
  return input.includes(secret);
}
