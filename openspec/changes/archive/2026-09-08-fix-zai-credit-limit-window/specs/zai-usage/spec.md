## Purpose

定义 Z.ai / GLM Coding Plan 配额查询的行为契约：`quota/limit` 响应中的 Coding-Plan 窗口条目（`TOKENS_LIMIT` 与更名后的 `CREDIT_LIMIT`）必须按窗口时长映射为用户可区分的配额行（5 小时 / 周 / 通用时长），使 status line、summary 与 detail 表格不再显示无法分辨的原始类型名。

## ADDED Requirements

### Requirement: Coding-Plan 窗口类型识别

解析器 SHALL 将 `TOKENS_LIMIT` 与 `CREDIT_LIMIT` 条目同等视为 Coding-Plan 窗口；两者均不得以原始类型名（如 `CREDIT_LIMIT`）作为展示标签落入未知类型兜底分支。

#### Scenario: 新版 credit 套餐的两条窗口

- **WHEN** `quota/limit` 返回两条 `CREDIT_LIMIT` 条目（5 小时窗口与周窗口）
- **THEN** 两条分别渲染为可区分的 5 小时与周配额行，均带各自的百分比与进度条

### Requirement: 按 unit × number 窗口时长映射

窗口条目 SHALL 按时长编码映射：分钟数 = `number × unit` 倍率（unit：1=天、3=小时、5=分钟、6=周）。300 分钟映射为 5 小时配额行（id `five_hour`），10080 分钟映射为周配额行（id `weekly`），其他时长 SHALL 生成携带时长的通用窗口行（id `window_<n>_<单位>`，如 `window_3_day`）且不产生错误。

#### Scenario: 300 分钟窗口

- **WHEN** 条目为 `CREDIT_LIMIT` 且 `unit=3`、`number=5`
- **THEN** 映射为 `five_hour` 行，label 为 "5-hour quota"

#### Scenario: 10080 分钟窗口

- **WHEN** 条目为 `CREDIT_LIMIT` 且 `unit=6`、`number=1`
- **THEN** 映射为 `weekly` 行，label 为 "Weekly quota"

#### Scenario: 其他时长窗口

- **WHEN** 条目窗口时长既非 300 也非 10080 分钟（如 `unit=1`、`number=3`）
- **THEN** 生成 id 为 `window_3_day`、label 含时长的通用窗口行，百分比正常渲染

### Requirement: 旧响应形态兼容

无 `number` 字段的旧版 `TOKENS_LIMIT` 条目 SHALL 沿用既有约定（unit 3 → 5 小时、unit 6 → 周）；`TIME_LIMIT` 条目 SHALL 保持既有 MCP 月配额解析不变；完全无法识别窗口时长的条目 SHALL 以类型名生成的行呈现（既有兜底行为），不得抛错或丢弃其他条目。

#### Scenario: 旧版无 number 的条目

- **WHEN** 条目为 `TOKENS_LIMIT` 且仅有 `unit`（3 或 6）与 `percentage`
- **THEN** 分别映射为 `five_hour` 与 `weekly` 行，与既有行为一致

### Requirement: 可选数值列填充

Coding-Plan 窗口条目携带 `usage`（总量）、`currentValue`（已用）、`remaining`（剩余）计数时，SHALL 填入配额行的 used/limit/remaining；仅有 `percentage` 时配额行 SHALL 维持仅百分比与进度条渲染（数值列显示占位符）。

#### Scenario: 携带计数的 credit 条目

- **WHEN** `CREDIT_LIMIT` 条目含 `percentage`、`usage`、`currentValue`、`remaining`
- **THEN** 配额行显示 used/limit/remaining 数值，detail 表格的 Used/Left 列填充

#### Scenario: 仅百分比的旧条目

- **WHEN** `TOKENS_LIMIT` 条目仅含 `percentage`
- **THEN** 配额行仅渲染百分比与进度条，数值列为占位符

### Requirement: 确定性展示顺序

多条窗口行 SHALL 按确定性顺序渲染：5 小时配额在前，其后依次为周配额、MCP 月配额、其他窗口/类型行（按响应内出现顺序）。

#### Scenario: 混合窗口排序

- **WHEN** 响应同时包含 5 小时窗口、周窗口与 `TIME_LIMIT`
- **THEN** 渲染顺序为 5 小时 → 周 → MCP，与响应数组顺序无关
