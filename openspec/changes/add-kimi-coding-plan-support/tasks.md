## 1. Provider 实现

- [x] 1.1 新建 `src/providers/kimi.ts`：`KIMI_ALLOWED_HOSTS = ["api.kimi.com", "api.kimi.ai"]`、`createKimiProvider(deps)` 工厂（`resolveAuth`/`fetchImpl`/`timeoutMs`/`now` 注入，签名与 deepseek/zai 一致）、`isAvailable`（host allowlist + 非空 key，fail-closed）。验证：`npm run typecheck` 通过。
- [x] 1.2 实现响应解析（导出纯函数供测试）：十进制字符串转数字；`limits[]` 窗口行映射（`TIME_UNIT_*` 枚举折叠，300 分钟 → 5h，id `five_hour`）；顶层 `usage` → `weekly`（`used` 缺省时 `limit - remaining` 推导）；`totalQuota` → `membership`（仅 percentage：`used > 0` → 100，否则 0）；`boosterWallet` → `booster`（定点数 ÷1_000_000，`monthlyChargeLimitEnabled` 时月度上限作 details 子行，无效则省略）；`parallel` 跳过。配额顺序固定：five_hour → weekly → membership → booster。验证：纯函数单测通过。
- [x] 1.3 实现 `getUsage`：追加式 `{baseUrl}/usages`、Bearer 头、`controlledGetJson` + allowlist、失败返回受控错误快照（不抛出）、成功但解析为空返回 schema 错误。验证：错误路径单测通过。

## 2. 注册与渲染接线

- [x] 2.1 `src/index.ts`：导入 `createKimiProvider` 与 `KIMI_ALLOWED_HOSTS`，`session_start` 注册 provider，`PROVIDER_HOSTS` 增加 `kimi` 条目。验证：typecheck 通过；`/usage` 命令的 provider id 列表含 `kimi`（既有 `routeUsageCommand` 逻辑自动生效）。
- [x] 2.2 `src/formatters/usage.ts` 的 `shortLabel` 增加 `id === "weekly"` → `"7d"` 通用分支。验证：formatters 既有测试不回归，新增断言 weekly 短标签。

## 3. 测试

- [x] 3.1 新建 `test/kimi.test.ts`：标准响应映射（frozen 与 healthy 两种实测 fixture 形态：字符串数字、`used` 缺省、`TIME_UNIT_MINUTE`、`resetTime` 小数秒 ISO）、配额顺序、membership 二元百分比、booster 有/无两种路径。验证：`npm test` 通过。
- [x] 3.2 补齐失败与安全测试：401/403/429/5xx 错误码映射、timeout、非 JSON、allowlist 外 host 拒绝发起请求、密钥不出现在快照/错误（redaction）。验证：`npm test` 通过。

## 4. 文档（双语同步）

- [x] 4.1 更新 `README.md`：provider 列表加 Kimi Coding Plan（含 baseUrl/key 要求）、Install 前提、Commands 表加 `/usage kimi`、Security 的 host allowlist 补 `api.kimi.com`/`api.kimi.ai`、诚实性章节将 Kimi 归入 vendor-client-derived 阵营（引用 `MoonshotAI/kimi-code` managed-usage.ts，声明未文档化风险）、示例区补 `/usage kimi` 输出。验证：人工核对章节完整。
- [x] 4.2 同步 `README.zh-CN.md`，结构与 `README.md` 逐节对应，顶部语言切换链接保留。验证：两文件章节一一对应。

## 5. 整体验证

- [x] 5.1 `npm run typecheck && npm test` 全量通过；现有 provider 测试零回归。
- [x] 5.2 对照 `specs/kimi-usage/spec.md` 逐条需求核对场景覆盖（发现、映射、顺序、冻结、钱包、降级、安全）。验证：每条 Requirement 至少一个对应测试或既有机制佐证。
