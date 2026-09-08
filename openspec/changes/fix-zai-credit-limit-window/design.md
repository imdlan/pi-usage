## Context

`parseQuotaLimit` 现仅识别 `TOKENS_LIMIT`（unit 3 → 5h、unit 6 → 周）与 `TIME_LIMIT`（MCP），其余类型进兜底行。Z.ai 服务端已将新 credit 套餐的窗口条目更名为 `CREDIT_LIMIT`，形状经 CodexBar（`Plugins/zai.js`）与 OpenUsage 独立实现交叉确认：与旧 `TOKENS_LIMIT` 同构，另含 `unit`（1=天、3=小时、5=分钟、6=周）× `number` 的时长编码与可选 `usage`/`currentValue`/`remaining` 计数；上游官方 `glm-plan-usage` 插件尚未适配。现有 zai 测试 fixture 覆盖了带 unit 与不带 unit 的旧形态，必须保持全绿。

## Goals / Non-Goals

**Goals:**

- `CREDIT_LIMIT` 条目正确映射为可区分的 5 小时/周/通用窗口行，status line 恢复 `5h xx% · 7d xx%`（weekly 短标签）语义。
- 旧 `TOKENS_LIMIT` 形态与 `TIME_LIMIT` 行为零变化。
- 可选计数列填充；防御式解析，畸形条目不抛错。

**Non-Goals:**

- credit 套餐峰谷计费（peak/off-peak）展示（CodexBar 的 "Quota rate" 行属新功能，另行考虑）。
- `planName`/套餐名展示、BigModel 团队接口（`type=2/3` 参数）、`model-usage`/`tool-usage` 变更。

## Decisions

1. **`CREDIT_LIMIT` 并入既有 Coding-Plan 分支**（`type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT"`），不新增平行分支。理由：两者字段同构，分叉只会制造双份维护面。
2. **窗口判定以 `number × unit 倍率` 的分钟数为准**（倍率 `{1: 1440, 3: 60, 5: 1, 6: 10080}`）：300 → `five_hour`，10080 → `weekly`，其他 → 通用行（id `window_<n>_<单位>`，label 如 "3 day window"，复用 kimi 适配器同款命名风格）。理由：`unit` 是枚举不是分钟数，旧代码"unit 6 即周"的写法无法表达 "unit 3 × number 5" 这类组合，也无法区分未来新增时长。
3. **旧形态兼容**：`number` 缺失或 ≤0 时沿用旧约定（unit 3 → `five_hour`、unit 6 → `weekly`、其他 → 按类型名兜底行）。理由：存量响应与现有测试 fixture 均无 `number`。
4. **数值填充**：`usage` → limit、`currentValue` → used、`remaining` → remaining（`computeRemaining` 兜底）；百分比仍以服务端 `percentage` 为准，缺失时以 `computePercentage(currentValue, usage)` 推算兜底。理由：服务端百分比是权威展示口径（与现行为一致），计数仅填充数值列；CodexBar 同样以计数做交叉校验而非替代。
5. **排序不动**：既有 `rank`（five_hour → weekly → monthly → 其他按出现序）天然容纳通用窗口行（落入"其他"档）。理由：与用户已确认的跨 provider 顺序约定（5h 在前）一致，无需新逻辑。

## Risks / Trade-offs

- [窗口编码字段结构非官方文档，可能再次变更] → 解析全程防御式：`unit`/`number` 非法或未知倍率时掉回类型名兜底行，不影响其他条目；测试覆盖 300/10080/通用/畸形四类。
- [`CREDIT_LIMIT` 与 `TOKENS_LIMIT` 可能在同一响应混现（灰度期）] → 两种类型走同一映射，混现时各自正确归档，顺序稳定。
- [通用窗口行 id 含时长（如 `window_3_day`），formatter 短标签走 label 兜底] → 可接受：detail 表格显示完整 label，status line 仅在前两行（通用行通常不进前两行）。

## Migration Plan

纯解析层修复，无持久化与接口变更。发布即生效，回滚即还原单文件。

## Open Questions

（无——字段结构已由两个独立实现交叉确认，窗口映射规则在提案阶段与用户对齐。）
