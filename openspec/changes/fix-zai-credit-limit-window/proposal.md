## Why

Z.ai 服务端将新版（credit 计费）Coding Plan 的配额条目类型从 `TOKENS_LIMIT` 更名为 `CREDIT_LIMIT`，现有 `parseQuotaLimit` 不识别该类型，两条窗口条目（5 小时窗口 + 周窗口）全部落入未知类型兜底分支，status line 与 summary 渲染为两段无法区分的 `CREDIT_LIMIT xx%`，detail 表格也无法标注哪个是 5 小时窗口、哪个是周窗口。上游官方 `glm-plan-usage` 插件同样未适配（原样透传），字段结构经 CodexBar 与 OpenUsage 两个独立实现交叉确认。

## What Changes

- `src/providers/zai.ts` 的 `parseQuotaLimit`：`CREDIT_LIMIT` 与 `TOKENS_LIMIT` 走同一 Coding-Plan 窗口分支。
- 窗口判定从单一 `unit` 枚举升级为 `unit × number` 分钟数编码（unit：1=天、3=小时、5=分钟、6=周；300 分钟 → 5 小时窗口，10080 分钟 → 周窗口），其他时长生成可区分的通用窗口行（如 `3 day window`，id `window_3_day`）。
- 旧响应兼容：无 `number` 字段的旧 `TOKENS_LIMIT` 条目沿用旧约定（unit 3 → 5h、unit 6 → 周）；`TIME_LIMIT`（MCP 月配额）解析不变。
- 数值增强：`CREDIT_LIMIT` 条目携带 `usage`/`currentValue`/`remaining` 计数时填入配额行的 used/limit/remaining（detail 表格的 Used/Left 列与进度条随之填充；仅有 percentage 时维持现状只显示百分比与进度条）。
- 测试：`test/zai.test.ts` 新增 `CREDIT_LIMIT` 用例（300 分钟 5h、10080 分钟周、通用时长、数值列、旧形态回归）；现有断言零回归。
- 文档：`README.md` / `README.zh-CN.md` 开发节补充一句 CREDIT_LIMIT 适配说明（双语同步）。

## Capabilities

### New Capabilities

- `zai-usage`: Z.ai / GLM Coding Plan 用量查询行为契约 —— `quota/limit` 响应中 Coding-Plan 窗口条目（`TOKENS_LIMIT` 与 `CREDIT_LIMIT`）按 `unit × number` 窗口时长映射为可区分的配额行（5 小时/周/通用），`TIME_LIMIT` 映射为 MCP 月配额，未知类型优雅降级。

### Modified Capabilities

（无 —— 项目主 specs 尚未建立，`kimi-usage` 变更尚未归档，无可修改的既有 spec。）

## Impact

- **代码**：`src/providers/zai.ts`（仅 `parseQuotaLimit` 及其窗口映射辅助函数）。
- **测试**：`test/zai.test.ts` 新增用例；现有 135+ 测试零回归（旧 fixture 形态全部保留）。
- **依赖**：无新增。
- **文档**：README.md / README.zh-CN.md 开发节各一句。
- **风险面**：窗口映射基于 CodexBar/OpenUsage 交叉确认的字段结构，非官方文档；解析保持防御式，未知时长不报错、只生成通用标签行。
