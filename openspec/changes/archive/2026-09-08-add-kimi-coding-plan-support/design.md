## Context

扩展已有三个 provider（zai/deepseek/openrouter），共享同一契约：`UsageProvider`（`isAvailable` + `getUsage`）、host-allowlist 认证解析器（扫描 Pi 模型目录 + `getProviderAuth`，fail-closed）、受控 HTTP（`controlledGetJson`：HTTPS、allowlist、拒绝重定向、超时）、以及完全通用的 formatter（仅按 quota `id` 做短标签分支）。新增 provider 的既有路径见 README"Adding a provider"一节。

Kimi Coding Plan 的用量端点 `GET {baseUrl}/usages` 未官方文档化，但有官方开源客户端背书：`MoonshotAI/kimi-code` 的 `packages/oauth/src/managed-usage.ts`（TypeScript，含完整解析与归一化逻辑）与 `MoonshotAI/kimi-cli` 的 `usage.py`（Python，形态较旧）。响应特征：数字为十进制字符串、`timeUnit` 为 `TIME_UNIT_*` proto 枚举、周配额窗口缺省由客户端补齐、月度重置后 `used` 字段整体缺省、`totalQuota.remaining` 恒为 99 不可信。社区已有多个独立实现（quotas crate、axonhub 等）交叉印证了端点与形态。

## Goals / Non-Goals

**Goals:**

- 与现有 provider 完全同构的接入：独立文件、独立 allowlist、独立解析、独立测试，零共享状态。
- 解析逻辑与官方 `kimi-code` 客户端行为对齐（字符串数字、缺省字段、枚举折叠），对形态漂移优雅降级。
- 渲染零 provider 特判：所有映射在 provider 内完成，formatter 仅增加 `weekly → 7d` 一条通用 id 分支。

**Non-Goals:**

- Moonshot PAYG 余额（`api.moonshot.ai/.cn` 的 `/v1/users/me/balance`）——另行变更。
- OAuth 设备流——Pi 侧密钥解析已由 `getProviderAuth` 覆盖（API key 即可）。
- `parallel` 并发上限展示——静态天花板，非时间窗用量。
- 对响应形态做主动多区域适配——仅按官方客户端的防御式写法容错。

## Decisions

1. **以官方 `kimi-code` 的 `managed-usage.ts` 为唯一参照**（而非 kimi-cli 或社区实现）。理由：与 Z.ai 适配器引用 `glm-plan-usage` 的既有先例完全同构——厂商自家开源客户端最能代表当前真实形态；kimi-cli 的解析注释显示其文档形态（`reset_at`、`"MINUTE"`）落后于实测（`resetTime`、`TIME_UNIT_MINUTE`）。替代方案（kimi-cli 为准）被否：形态陈旧且为 Python 惯用写法。

2. **URL 采用 canonical path（origin + `/coding/v1/usages`）**。原决策为追加式 `{baseUrl}/usages`，其前提"Pi 中 Kimi provider 的 baseUrl 天然含 `/coding/v1` 路径段"后被实测证伪：Pi 内置 `kimi-coding` 条目的 baseUrl 是 `https://api.kimi.com/coding`（无 `/v1`），追加式得到 `/coding/usages` → 404（官方客户端对该状态码的提示即 "Usage endpoint not available"）。修正：仅从配置的 baseUrl 取 origin（host 已被 allowlist 锁定），路径固定为官方客户端的 canonical 形态——与 `kimiCodeUsageUrl()` 的 `${base}/usages`（base 恒为 `/coding/v1`）语义一致。

3. **Allowlist 锁死 `api.kimi.com` / `api.kimi.ai`**。官方客户端对"受管端点"的判定（`isManagedKimiCodeBaseUrl`）同样排除代理/网关/镜像——对非官方 host 的 `/usages` schema 无法信任，fail-closed 与全扩展安全基线一致。

4. **quota id 命名：`five_hour`（复用）/ `weekly` / `membership` / `booster`**。`five_hour` 复用是因为 Kimi 的 300 分钟窗口语义上就是 5 小时配额，白捡 formatter 现有 `5h` 短标签；**刻意避开 `monthly`**——该 id 在 formatter `shortLabel` 中被 Z.ai 的 MCP 月配额占用（渲染为 "MCP"），复用会产生错误语义。周配额 id 取 `weekly`，formatter 增加通用分支渲染 `7d`。

5. **顺序：5h 在前、weekly 随后**（用户决策）。与 Z.ai 现有顺序（5h → monthly）一致，status line 片段语义对齐。`membership`/`booster` 排在后，正常情况下不进入 summary/status line 的 `slice(0, 2)` 窗口（可接受：冻结状态更多是 detail 视图信息；若 `limits[]` 为空，membership 会自然前移暴露，属期望行为）。

6. **冻结信号只填 percentage**（用户决策）：`used > 0 → 100`（红），`used` 缺省或 0 → `0`（绿），不填 used/limit/remaining。替代方案（`0/1` 计数行）被否：`1 / 1` 对用户不可读，且 `limit` 原始值（如 100）无展示意义。**绝不**用 `totalQuota.remaining` 推导用量——实测它在冻结与健康状态下恒为 99。

7. **`used` 推导链：`used ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)`**。对齐官方客户端"remaining 权威、used 可缺省"的观察（月度重置后 `usage.used` 整体缺省）。

8. **booster 钱包 render-if-present**（用户决策）：`balance.amountLeft`（定点数，÷1_000_000 折算）作 remaining，`monthlyChargeLimitEnabled` 时以 details 子行展示月度已用/上限；币种入 label（如 `Booster wallet (USD)`）。数字格式沿用 formatter 现有的裸数字渲染（同 DeepSeek 余额行为），不新增货币格式化。

## Risks / Trade-offs

- [未文档化端点可能无预警变更] → 解析全程防御式、字段缺省静默降级；失败走既有 `usage unavailable` 路径；README 诚实性章节明确归入 vendor-client-derived 阵营并声明风险。
- [区域/套餐间响应形态差异（`.com` 与 `.ai`、frozen 与 healthy fixture 已见分化）] → 测试同时覆盖 frozen/healthy 两种实测形态；未知字段一律忽略。
- [`membership` 冻结状态在 5h + weekly 齐全时不进 status line] → 接受。冻结时 API 请求本身会开始失败（403 冻结错误），错误状态会经由既有 stale/error 机制浮出。
- [定点数折算（÷1_000_000）对钱包金额的精度损失] → 仅用于展示，官方客户端同样折算；折算后 < 1 分按 1 分处理（沿用官方 `fixedPointToCents` 语义）。

## Migration Plan

纯增量变更，无数据迁移。发布后仅当用户配置了官方 Kimi host 的 provider 时，`kimi` 才出现在视图中；回滚即移除扩展更新，无持久化状态受影响。

## Open Questions

（无——探索阶段已定：范围仅 Coding Plan；顺序 5h 在前；冻结百分比行；booster render-if-present。）
