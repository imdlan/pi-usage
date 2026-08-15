# pi-usage

A [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) extension that shows **AI provider usage and quota** inside Pi — via `/usage` commands and a compact status line.

Currently supports **Z.ai / GLM Coding Plan**; architected to add more providers (OpenAI, Anthropic, OpenRouter) without touching the core.

```
/usage
GLM/glm-4.7 (zai) — 5h 32% 2026-08-15 11:43:00 · MCP 18% 2026-08-27 09:43:00

/usage zai
+-------------------+--------------+-----+--------------+-------+---------------------+
|                                         GLM/glm-4.7                                         |
|                              refreshed 2026-08-15 09:43:00                                |
+-------------------+--------------+-----+--------------+-------+---------------------+
| Quota             | Usage        | Pct | Used         | Left  | Resets              |
+-------------------+--------------+-----+--------------+-------+---------------------+
| MCP monthly quota | [##--------] | 18% | 180 / 1000   | 820   | 2026-08-27 09:43:00 |
|   web-search      | [##--------] | 22% | 220 / 1000   | 780   | —                   |
| 5-hour quota      | [###-------] | 32% | 5000 / 28000 | 23000 | 2026-08-15 11:43:00 |
+-------------------+--------------+-----+--------------+-------+---------------------+

Models (* = current):
  * glm-4.7                  5000  (32%)
    glm-4.6                   800  (5%)

status line
GLM/glm-4.7 · 5h 32% · MCP 18%

/usage pin
┌─ pinned above the editor ────────────────────────────────┐
│ GLM/glm-4.7 (zai) — 5h 32% 2026-08-15 11:43:00 · MCP 18% …    │
└──────────────────────────────────────────────────────────┘
```

## Install

```bash
pi install npm:@imdlan/pi-usage
```

Also available from git or a local clone:

```bash
pi install git:github.com/imdlan/pi-usage
pi install ./path/to/pi-usage
```

Update with `pi update --extensions`; remove with `pi remove npm:@imdlan/pi-usage`.

### Requirements

- Node.js 20+
- A configured Z.ai provider in Pi whose base URL points at an official Z.ai / GLM endpoint (e.g. `https://api.z.ai/api/anthropic`) and whose API key resolves to your GLM Coding Plan token.

## Commands

| Command | Behavior |
| --- | --- |
| `/usage` | Usage summary for all available providers, with each quota's reset time (`2026-08-15 11:43:00`, local time) when known. |
| `/usage zai` | Detailed Z.ai / GLM usage as a responsive ASCII table: 5-hour quota, MCP monthly quota with per-tool breakdown, per-model usage, reset times. |
| `/usage refresh` | Force-refresh, ignoring the cache. Keeps the last good snapshot on failure. |
| `/usage status` | Status line content, last refresh, cache state, provider availability. |
| `/usage pin` | Toggle the summary widget pinned above the editor, auto-refreshed every background cycle (~2 min). `pin on` / `pin off` set the state explicitly. |

### Pinned widget

By default the summary only appears when you run `/usage`. Run `/usage pin` (or `pin on`) to keep it **pinned above the editor** — the same multi-line summary as `/usage`, kept in sync by the background refresh (no extra API calls; it re-renders from cache). `/usage pin off` (or `pin` again) removes it. Pin state is per-session and resets on Pi restart. Note the pinned widget occupies ~1 line per provider at the top of the chat area.

The detail table is width-aware: narrow terminals drop optional columns (`Resets` → `Left` → `Used` → `Usage` bar), then truncate labels — never overflowing. The status line refreshes in the background every 2 minutes (cache TTL: 2 minutes) and degrades to `GLM · usage unavailable` when data is unavailable. It never blocks the UI or model requests.

### Current model indicator

Wherever the provider name appears, the **currently active model id** is appended as `Name/model` (e.g. `GLM/glm-4.7`) — in the footer status line, the `/usage` summary, the pinned widget, and the detail table header. In the detail view's `Models` list, the current model is marked with `*`. The indicator follows model switches made via `/model`, cycling (`Ctrl+P`), or session restore, and only shows for providers that actually own the active model.

## Security & privacy

- **Read-only**: only queries usage; never modifies provider state.
- **No secrets handled**: credentials resolve through Pi's authorized provider auth API (`getProviderAuth`). Never reads `auth.json`, `.env`, `~/.ssh`, or credential files; never runs subprocesses; fails closed when auth is unavailable.
- **Locked-down networking**: HTTPS only, per-provider host allowlist (Z.ai: `api.z.ai`, `open.bigmodel.cn`, `dev.bigmodel.cn`), redirects rejected.
- **No telemetry**; all output is sanitized — keys, tokens, cookies, and `Authorization` headers are never displayed.

## Development

```bash
npm install
npm run typecheck   # strict tsc
npm test            # node:test via tsx
```

Runtime dependencies: **zero** (Node built-ins + Pi Extension API only). Layout:

```
src/
  index.ts            # Pi entry: commands, lifecycle, status line
  config.ts           # defaults (TTL, timeout, allowlists)
  providers/          # types, registry, zai adapter
  services/           # refresh/cache, status line
  formatters/         # command output, ASCII table renderer
  utils/              # controlled fetch, time math, redaction
test/                 # unit, provider, cache, command, security tests
```

Adding a provider: implement `UsageProvider` in `src/providers/<name>.ts` with its own auth strategy, allowlist, and redaction rules; register it in `registry.ts`; add tests (missing fields, 401/403/429/5xx, timeout, allowlist, redaction).

### Publish

```bash
npm publish          # @imdlan/pi-usage, public scoped package
```

Pi loads the TypeScript entry directly (via `jiti`), so no build step is needed.

## Z.ai integration notes

The Z.ai adapter mirrors the official [`glm-plan-usage`](https://github.com/zai-org/zai-coding-plugins) plugin: it derives usage endpoints from the configured base URL origin and queries `model-usage`, `tool-usage`, and `quota/limit` (`TOKENS_LIMIT` = 5-hour quota, `TIME_LIMIT` = MCP monthly quota). These endpoints may change without notice; parsing is isolated in `src/providers/zai.ts`.

## License

[Apache-2.0](./LICENSE). Copyright © 2026 imdlan.
