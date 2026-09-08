## 1. 解析修复

- [x] 1.1 `src/providers/zai.ts`：`parseQuotaLimit` 将 `CREDIT_LIMIT` 并入 Coding-Plan 分支；新增 `unit × number` 分钟数映射辅助（倍率 `{1:1440, 3:60, 5:1, 6:10080}`）：300 → `five_hour`、10080 → `weekly`、其他有效时长 → 通用窗口行（id `window_<n>_<单位>`，label 含时长）；`number` 缺失/非法时沿用旧约定（unit 3 → 5h、unit 6 → 周、其他按类型名兜底）。验证：`npm run typecheck` 通过。
- [x] 1.2 同函数内填充可选计数：`usage` → limit、`currentValue` → used、`remaining` → remaining（`computeRemaining` 兜底）；百分比仍以服务端 `percentage` 为准，缺失时 `computePercentage(currentValue, usage)` 兜底。验证：`npm run typecheck` 通过（单测见 2.x）。

## 2. 测试

- [x] 2.1 `test/zai.test.ts` 新增 `CREDIT_LIMIT` 用例：`unit=3,number=5` → five_hour；`unit=6,number=1` → weekly；`unit=1,number=3` → `window_3_day` 通用行且百分比正常；携带 `usage/currentValue/remaining` 时 Used/Left 列填充、进度条渲染；`CREDIT_LIMIT` 与 `TOKENS_LIMIT`/`TIME_LIMIT` 混现时顺序为 5h → 周 → MCP。验证：`npm test` 通过。
- [x] 2.2 回归守护：现有旧形态断言（无 `number` 的 `TOKENS_LIMIT`、`TIME_LIMIT` MCP、畸形条目容错）全部保持通过，零回归。验证：`npm test` 全绿。

## 3. 文档（双语同步）

- [x] 3.1 `README.md` 与 `README.zh-CN.md` 开发节 Z.ai 适配器段落各补一句：`quota/limit` 的窗口条目含旧版 `TOKENS_LIMIT` 与新版 `CREDIT_LIMIT`（credit 计费套餐），按 `unit × number` 窗口时长映射。验证：两文件对应段落逐句对应。

## 4. 整体验证

- [x] 4.1 `npm run typecheck && npm test` 全量通过。验证：命令退出码 0、fail 计数 0。
- [x] 4.2 对照 `specs/zai-usage/spec.md` 逐条 Requirement 核对场景覆盖（窗口识别、时长映射、旧形态兼容、数值列、确定性顺序）。验证：每条 Requirement 至少一个对应测试。
