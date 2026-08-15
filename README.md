# pi-usage

[English](./README.md) | [简体中文](./README.zh-CN.md)

A [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) extension that shows **AI provider usage and quota** inside Pi.

Currently supports **Z.ai / GLM Coding Plan**; architected to add more providers without touching the core.

```
/usage
GLM/glm-5.3 (zai) — 5h 32% 2026-08-15 11:43:00 · MCP 18% 2026-08-27 09:43:00

/usage zai
+-------------------+--------------+-----+--------------+-------+---------------------+
|                                         GLM/glm-5.3                                         |
|                              refreshed 2026-08-15 09:43:00                                |
+-------------------+--------------+-----+--------------+-------+---------------------+
| Quota             | Usage        | Pct | Used         | Left  | Resets              |
+-------------------+--------------+-----+--------------+-------+---------------------+
| MCP monthly quota | [##--------] | 18% | 180 / 1000   | 820   | 2026-08-27 09:43:00 |
|   web-search      | [##--------] | 22% | 220 / 1000   | 780   | —                   |
| 5-hour quota      | [###-------] | 32% | 5000 / 28000 | 23000 | 2026-08-15 11:43:00 |
+-------------------+--------------+-----+--------------+-------+---------------------+

Models (* = current):
  * glm-5.3                  5000  (32%)
    glm-5.2                   800  (5%)

status line (always auto-refreshed every 2 min)
GLM/glm-5.3 · 5h 32% · MCP 18%

/usage pin (widget pinned above the editor, auto-refreshed)
┌─ pinned above the editor ────────────────────────────────┐
│ GLM/glm-5.3 (zai) — 5h 32% 2026-08-15 11:43:00 · MCP 18% …    │
└──────────────────────────────────────────────────────────┘
```

## Install

```bash
pi install npm:@imdlan/pi-usage
```

Update with `pi update --extensions`; remove with `pi remove npm:@imdlan/pi-usage`.

Requires Node.js 20+ and a configured Z.ai provider in Pi (base URL at an official Z.ai / GLM endpoint, API key resolving to your GLM Coding Plan token).

## Commands

| Command | Behavior | Auto-refresh? |
| --- | --- | --- |
| `/usage` | Usage summary for all providers, with quota reset times (local time). | ❌ One-time snapshot |
| `/usage zai` | Detailed Z.ai usage table: 5-hour quota, MCP monthly quota with per-tool breakdown, per-model usage. | ❌ |
| `/usage refresh` | Force-refresh from the API, then render the summary. Keeps the last good snapshot on failure. | ❌ Renders once |
| `/usage status` | Status line content, last refresh, cache state. | ❌ |
| `/usage pin` | Pin the summary widget above the editor. `pin on` / `pin off` set it explicitly; `pin` toggles. | ✅ Every ~2 min |

**Key difference**: plain `/usage` is a static snapshot. Only a pinned widget (`/usage pin`) stays fresh, re-rendered from cache every background cycle (~2 min, no extra API calls). Pin state is per-session. The footer status line is always auto-refreshed regardless.

The detail table is width-aware: narrow terminals drop optional columns (`Resets` → `Left` → `Used` → `Usage` bar), never overflowing.

## Current model indicator

Wherever the provider name appears, the active model id is appended as `Name/model` (e.g. `GLM/glm-5.3`) — footer, summary, pinned widget, and detail table header. It follows model switches via `/model`, cycling (`Ctrl+P`), or session restore.

## Security & privacy

- **Read-only**: only queries usage.
- **No secrets handled**: auth resolves through Pi's `getProviderAuth`; never reads credential files or runs subprocesses.
- **Locked-down networking**: HTTPS only, host allowlist (`api.z.ai`, `open.bigmodel.cn`, `dev.bigmodel.cn`), redirects rejected.
- **No telemetry**; all output sanitized.

## Development

```bash
npm install
npm run typecheck   # strict tsc
npm test            # node:test via tsx
```

Zero runtime dependencies (Node built-ins + Pi Extension API). Pi loads the TypeScript entry directly — no build step.

Adding a provider: implement `UsageProvider` in `src/providers/<name>.ts` (auth strategy, allowlist, redaction rules), register in `registry.ts`, add tests (401/403/429/5xx, timeout, allowlist, redaction).

The Z.ai adapter mirrors the official [`glm-plan-usage`](https://github.com/zai-org/zai-coding-plugins) plugin: endpoints derived from the configured base URL origin (`model-usage`, `tool-usage`, `quota/limit`). Parsing is isolated in `src/providers/zai.ts`.

## License

[Apache-2.0](./LICENSE). Copyright © 2026 imdlan.
