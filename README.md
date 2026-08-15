# pi-usage

A [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) extension that shows **usage and quota for multiple AI providers** directly inside Pi — via `/usage` commands and a compact status line.

It is built around a generic provider abstraction so new providers can be added without touching the core. **Z.ai / GLM Coding Plan** is the first fully implemented provider; OpenAI, Anthropic, and OpenRouter are reserved as future integration points.

> Read-only and privacy-first: this extension only **queries** usage. It never modifies provider state, never stores or uploads credentials, and never collects telemetry.

---

## Features

- **`/usage`** — summary of every configured & available provider.
- **`/usage <provider>`** — detailed view for one provider (e.g. `/usage zai`), including per-quota and per-model numbers and reset times when the API exposes them.
- **`/usage refresh`** — bypass the cache and refresh all available providers immediately.
- **`/usage status`** — show the current status line, last successful refresh, cache state, and per-provider availability.
- **Non-blocking status line** — async refresh at startup and on a background timer, with safe degradation when data is unavailable.

## Supported providers

| Provider | Status |
| --- | --- |
| **Z.ai / GLM Coding Plan** | Implemented (first release) |
| OpenAI | Reserved — integration structure only |
| Anthropic | Reserved — integration structure only |
| OpenRouter | Reserved — integration structure only |

## How it works

### Authentication (no secrets handled)

For each provider, pi-usage resolves credentials **through Pi's own authorized provider auth API** (`getProviderAuth`), which Pi uses to resolve your configured API keys, stored credentials, and env interpolation. The extension:

- **Never reads** `~/.pi/agent/auth.json`, `.env`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, or any other credential file.
- **Never scans** your home, project, or Pi config directory for credentials.
- **Never runs** shell commands or subprocesses.
- **Fails closed** when no authorized provider/auth is available — it reports that the provider is unavailable instead of trying to guess or fall back.

### Networking

- All requests use **HTTPS only**, restricted to each provider's officially confirmed usage-API host allowlist.
- Requests reject arbitrary URLs, non-HTTPS targets, and cross-origin redirects.
- Each provider's auth, allowlist, and error handling are isolated; one provider cannot touch another's credentials or responses.

### Privacy

- No telemetry, no uploading of code, prompts, sessions, or file paths.
- Logs, command output, status line, errors, and tests are sanitized — API keys, tokens, cookies, `Authorization` headers, and full HTTP bodies are never displayed.

---

## Requirements

- Pi Coding Agent
- Node.js 20+
- A configured Z.ai provider in Pi whose base URL points at an official Z.ai / GLM endpoint (e.g. `https://api.z.ai/api/anthropic`) and whose API key resolves to your GLM Coding Plan token.

## Installation

### As a Pi package (recommended)

```bash
pi install git:github.com/imdlan/pi-usage
```

Update with `pi update --extensions`. Remove with `pi remove git:github.com/imdlan/pi-usage`.

### From a local clone

```bash
git clone https://github.com/imdlan/pi-usage.git
pi install ./path/to/pi-usage
```

Pi loads the TypeScript entry directly (via `jiti`), so no build step is required.

## Commands

| Command | Behavior |
| --- | --- |
| `/usage` | Usage summary for all available providers; actionable guidance when none are available. |
| `/usage zai` | Detailed Z.ai / GLM Coding Plan usage (5-hour quota, MCP monthly quota with per-tool breakdown, per-model usage, reset times). |
| `/usage refresh` | Force-refresh all available providers, ignoring the cache. Keeps the last good snapshot if a refresh fails. |
| `/usage status` | Show status line content, last refresh time, cache state, and provider availability. |

Output is formatted for the terminal and never contains keys, tokens, cookies, or `Authorization` headers.

## Status line

A compact line is written to Pi's footer, for example:

```
GLM · 5h 32% · mcp 18%
```

When data is unavailable it degrades to:

```
GLM · usage unavailable
```

The status line never blocks model requests, commands, or the UI.

## Configuration

Defaults are centralized and tuned for safety. Notable defaults:

- Cache TTL: **5 minutes**
- Request timeout: **10 seconds**
- Background refresh interval: **5 minutes**
- Network allowlist: per provider (Z.ai: `api.z.ai`, `open.bigmodel.cn`, `dev.bigmodel.cn`)

The extension does **not** accept plaintext keys, arbitrary URLs, or any configuration that could weaken its security boundaries.

## Development

```bash
npm install              # dev dependencies (typescript, tsx, @types/node, pi types)
npm run typecheck        # strict tsc, no emit
npm test                # node:test via tsx
```

If your npm mirror restricts the `@earendil-works` scope, install the Pi type
package from the official registry instead:
`npm install --registry=https://registry.npmjs.org`.

Runtime dependencies: **zero**. The extension uses only Node.js built-ins (`fetch`, `AbortController`) and the Pi Extension API. Dev dependencies are documented above.

### Project layout

```
src/
  index.ts              # Pi entry: commands, lifecycle, status line, timers
  config.ts             # Centralized defaults (TTL, timeout, allowlists)
  providers/
    types.ts            # Generic Provider / Snapshot / Quota model
    registry.ts         # Provider registration & discovery
    zai.ts              # Z.ai / GLM adapter (official endpoint logic)
  services/
    usage-service.ts    # refresh, cache, dedup, stale fallback
    status-line.ts      # status line rendering & update strategy
  formatters/
    usage.ts            # command + status text formatting
  utils/
    http.ts             # controlled fetch: timeout, HTTPS, allowlist, redirect-reject
    time.ts             # time windows, ISO display, percentage/remaining math
    sanitize.ts         # redaction & error normalization
test/                   # unit, provider, cache, command, and security tests
```

### Adding a provider

1. Create `src/providers/<name>.ts` implementing `UsageProvider`.
2. Declare its own auth strategy, HTTPS allowlist, parsing, and redaction rules — isolated from other providers.
3. Register it in `src/providers/registry.ts`.
4. Add tests (normal, missing fields, invalid JSON, 401/403/429/5xx, timeout) plus allowlist and redaction coverage.

Do not assume a new provider shares Z.ai's quota windows or data model.

## Contributing

Contributions are welcome. Please:

- Keep runtime dependencies at zero.
- Keep TypeScript `strict` passing and all tests green, including the security suite (secret scanning, allowlist, redaction, malicious-config).
- Never commit credentials, real API responses, or anything containing a key/token/cookie.

## Z.ai integration basis & disclaimer

The Z.ai implementation mirrors the behavior of the official [`glm-plan-usage`](https://github.com/zai-org/zai-coding-plugins) plugin (`plugins/glm-plan-usage`): it derives usage endpoints from the configured base URL origin, authenticates via the token Pi already holds, and queries `model-usage`, `tool-usage`, and `quota/limit`.

- These endpoints and response fields **may change** without notice. Parsing is concentrated in `src/providers/zai.ts` so it can be updated in one place.
- The extension **does not store or upload keys**. It only reads usage through Pi's authorized provider auth and the official usage endpoints.
- Only `quota/limit` has a confirmed, structured shape (`TOKENS_LIMIT` = 5-hour quota, `TIME_LIMIT` = MCP monthly quota, i.e. the monthly cap on MCP tool invocations). Its `usageDetails` field (per-tool monthly breakdown) is parsed defensively. `model-usage` / `tool-usage` are parsed defensively and degrade gracefully when their fields are absent.

## License

[Apache-2.0](./LICENSE). Copyright © 2026 imdlan.
