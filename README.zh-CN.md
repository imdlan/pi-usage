# pi-usage

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个 [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 扩展，在 Pi 内部显示 **AI 供应商用量与配额**。

支持 **Z.ai / GLM Coding Plan**、**DeepSeek** 和 **OpenRouter**。仅在 Pi 中配置了对应供应商时才会出现。

> **关于 API 稳定性的诚实说明**：本扩展会主动调用各供应商的用量查询接口。
>
> - **DeepSeek**（`GET /user/balance`）与 **OpenRouter**（`GET /api/v1/credits`）为**官方公开文档接口**——稳定，但字段仍可能演进。
> - **Z.ai** 接口（`model-usage`、`tool-usage`、`quota/limit`）**无官方文档**：参照官方 `glm-plan-usage` 插件推导，可能随时变更。
> - **暂不支持 OpenAI / Anthropic / Google Gemini**：其用量 API 需要组织级 **admin key**（不会用作对话 provider 的 key），且 Gemini 没有任何基于 API key 的配额查询接口。市面上显示 Claude Code 订阅额度的插件是解析本地日志实现的——pi-usage 刻意不采用（绝不读取本地文件）。
>
> 接口失效时优雅降级（`usage unavailable`），不影响模型请求。

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

status line（始终每 2 分钟自动刷新）
GLM/glm-5.3 · 5h 32% · MCP 18%

/usage pin（固定在编辑器上方的 widget，自动刷新）
┌─ pinned above the editor ────────────────────────────────┐
│ GLM/glm-5.3 (zai) — 5h 32% 2026-08-15 11:43:00 · MCP 18% …    │
└──────────────────────────────────────────────────────────┘
```

## 安装

```bash
pi install npm:@imdlan/pi-usage
```

用 `pi update --extensions` 更新；用 `pi remove npm:@imdlan/pi-usage` 卸载。

需要 Node.js 20+，并在 Pi 中配置至少一个受支持的供应商：

- **Z.ai / GLM Coding Plan** — base URL 指向官方 Z.ai / GLM 端点，API key 解析到你的 GLM Coding Plan token。
- **DeepSeek** — base URL 指向 `https://api.deepseek.com`，普通 API key。
- **OpenRouter** — base URL 指向 `https://openrouter.ai`，普通 `sk-or-v1-...` key。

## 命令

| 命令 | 行为 | 自动刷新？ |
| --- | --- | --- |
| `/usage` | 所有供应商的用量摘要，含配额重置时间（本地时间）。 | ❌ 一次性快照 |
| `/usage zai` | Z.ai 详细用量表：5 小时配额、MCP 月度配额（含分工具明细）、分模型用量。 | ❌ |
| `/usage deepseek` | DeepSeek 按币种余额（CNY/USD），含赠送/充值明细。 | ❌ |
| `/usage openrouter` | OpenRouter 积分：已购总额、已用、剩余（USD）。 | ❌ |
| `/usage refresh` | 强制从 API 拉取最新数据后渲染摘要。失败时保留最后一次有效快照。 | ❌ 仅渲染一次 |
| `/usage status` | 状态栏内容、上次刷新时间、缓存状态。 | ❌ |
| `/usage pin` | 将摘要 widget 固定在编辑器上方。`pin on` / `pin off` 显式设置；`pin` 切换。 | ✅ 约每 2 分钟 |

**关键区别**：普通 `/usage` 是静态快照。只有固定 widget（`/usage pin`）会保持最新，每个后台周期（约 2 分钟）从缓存重渲染（无额外 API 调用）。固定状态仅限当前会话。底部状态栏无论如何都始终自动刷新。

明细表格宽度自适应：窄终端依次省略可选列（`Resets` → `Left` → `Used` → `Usage` 进度条），绝不溢出。

## 当前模型指示

凡显示供应商名称处，均追加当前活跃模型 id，格式 `Name/model`（如 `GLM/glm-5.3`）—— 状态栏、摘要、固定 widget、明细表头。跟随 `/model`、循环切换（`Ctrl+P`）或会话恢复的模型切换。

## 安全与隐私

- **只读**：仅查询用量。
- **不接触密钥**：凭据通过 Pi 的 `getProviderAuth` 解析；绝不读取凭据文件或运行子进程。
- **网络严格受限**：仅 HTTPS，host 白名单（`api.z.ai`、`open.bigmodel.cn`、`dev.bigmodel.cn`），拒绝重定向。
- **无遥测**；输出全部脱敏。

## 开发

```bash
npm install
npm run typecheck   # strict tsc
npm test            # node:test via tsx
```

运行时零依赖（Node 内置 + Pi Extension API）。Pi 直接加载 TypeScript 入口，无需构建。

添加供应商：在 `src/providers/<name>.ts` 实现 `UsageProvider`（认证策略、白名单、脱敏规则），在 `registry.ts` 注册并在 `index.ts` 的 `PROVIDER_HOSTS` 登记，添加测试（401/403/429/5xx、超时、白名单、脱敏）。

Z.ai 适配器参照官方 [`glm-plan-usage`](https://github.com/zai-org/zai-coding-plugins) 插件实现：端点从配置的 base URL origin 推导（`model-usage`、`tool-usage`、`quota/limit`）。解析逻辑隔离在 `src/providers/zai.ts`。

## 许可证

[Apache-2.0](./LICENSE). Copyright © 2026 imdlan.
