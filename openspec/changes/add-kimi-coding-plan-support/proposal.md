## Why

pi-usage 目前支持 Z.ai、DeepSeek、OpenRouter 三家，但使用 Kimi Coding Plan（Moonshot AI 订阅制编码方案）的 Pi 用户无法查看自己的配额状态（5 小时窗口、每周限额、月度冻结信号），只能登录网页控制台人工查看。扩展的多 provider 设计天然预留了接入位，新增一个 provider 即可补齐这块空白。

## What Changes

- 新增 `src/providers/kimi.ts`：实现 `UsageProvider`，查询 `GET {baseUrl}/usages`（Kimi Coding Plan，host 限定 `api.kimi.com` / `api.kimi.ai`）。
  - 端点未官方文档化，以官方开源客户端 `MoonshotAI/kimi-code`（`managed-usage.ts`）的解析行为为参照，与 Z.ai 适配器引用 `glm-plan-usage` 同构。
  - 映射：`limits[]`（300 分钟窗口）→ 5h 配额、`usage` → 每周配额、`totalQuota` → 月度冻结信号（二元，仅百分比行）、`boosterWallet` → 可选加量包钱包行；`parallel` 并发上限跳过。
  - 防御性解析：十进制字符串数字、`used` 缺省时以 `limit - remaining` 推导、`TIME_UNIT_*` proto 枚举折叠、字段缺省容错。
- 注册：`src/index.ts` 注册 provider 并在 `PROVIDER_HOSTS` 增加 `kimi` 条目（host allowlist 认证解析与活动模型匹配自动生效）。
- 渲染：`src/formatters/usage.ts` 的 `shortLabel` 增加 `weekly` → `7d` 通用 id 短标签（非 provider 特判）。
- 测试：新增 `test/kimi.test.ts`，覆盖 401/403/429/5xx、timeout、allowlist、redaction、冻结/健康两种响应形态。
- 文档：`README.md` 与 `README.zh-CN.md` 双语同步更新（provider 列表、诚实性章节将 Kimi 归入 vendor-client-derived 阵营、`/usage kimi` 示例、allowlist host 说明）。

不做的（Non-goals）：Moonshot 开放平台 PAYG 余额（`api.moonshot.ai/.cn` 的 `/v1/users/me/balance`）不在本次范围；`parallel` 并发上限不作为配额展示。

## Capabilities

### New Capabilities

- `kimi-usage`: Kimi Coding Plan 用量查询能力 —— 认证解析（host allowlist fail-closed）、`/usages` 端点调用、响应到通用 `UsageSnapshot` 的防御性映射（含冻结信号与可选钱包）、错误降级与脱敏边界。

### Modified Capabilities

（无 —— 项目尚无主 specs，现有 provider 行为未建立 spec 基线，本次不追溯。）

## Impact

- **代码**：`src/providers/kimi.ts`（新增）、`src/index.ts`（注册 + `PROVIDER_HOSTS`）、`src/formatters/usage.ts`（`shortLabel` 一处通用分支）。
- **测试**：`test/kimi.test.ts`（新增）；现有测试不受影响（formatter 改动为纯增量分支）。
- **依赖**：无新增运行时依赖（维持零依赖约束）。
- **安全面**：新增 2 个 allowlist host（`api.kimi.com`、`api.kimi.ai`）；认证仍只经 Pi `getProviderAuth`，密钥不入快照/日志/错误。
- **文档**：README.md、README.zh-CN.md 双语同步。
