## Purpose

让配置了 Kimi Coding Plan 的 Pi 用户在扩展内直接查看订阅配额状态（5 小时窗口、每周限额、月度冻结信号、可选加量包钱包），与其他 provider 一致地走"已配置才显示、查询失败优雅降级、密钥永不外泄"的统一契约。

## ADDED Requirements

### Requirement: 按 host allowlist 发现 provider

Kimi 用量查询 SHALL 仅在 Pi 中存在 baseUrl 主机名为 `api.kimi.com` 或 `api.kimi.ai` 且已解析到非空授权密钥的 provider 时可用；不满足时该 provider MUST NOT 出现在任何视图中（summary、status line、pinned widget、detail）。

#### Scenario: 已配置官方端点

- **WHEN** Pi 存在 baseUrl 为 `https://api.kimi.com/coding/v1`（或 `https://api.kimi.ai/coding/v1`）的 provider 且密钥已授权
- **THEN** `kimi` provider 可用并参与所有视图渲染

#### Scenario: 走代理或镜像的配置

- **WHEN** Pi 中 Kimi provider 的 baseUrl 主机名不在 allowlist 内（自建代理、网关、镜像域名）
- **THEN** `kimi` provider 不可用，任何视图不渲染它，也不发起任何网络请求

### Requirement: 查询 `/usages` 并映射为通用配额模型

provider SHALL 向 `{baseUrl}/usages` 发起带 `Authorization: Bearer <key>` 的 GET 请求，并将响应映射为通用快照：`limits[]` 中每个时间窗（含 300 分钟窗口折叠为 5 小时）映射为一个配额行，顶层 `usage` 映射为每周配额行；`parallel` 并发上限 MUST NOT 映射为配额行。

#### Scenario: 标准响应映射

- **WHEN** API 返回包含 `usage`（周配额）与 `limits[]`（300 分钟窗口）的 200 响应
- **THEN** 快照包含每周配额行与 5 小时配额行，均带 used/limit/percentage/reset 信息

### Requirement: 配额顺序固定

快照的配额数组 SHALL 按以下顺序排列：5 小时窗口（可多行）在前，其次每周配额、月度冻结信号、加量包钱包。该顺序决定 summary 与 status line 中前两行的取舍。

#### Scenario: 周配额在前两行

- **WHEN** 5 小时窗口与每周配额同时存在
- **THEN** summary 与 status line 片段按"5h 在前、7d 在后"展示（5h 短标签复用 `five_hour`，每周显示 `7d`）

### Requirement: 月度冻结信号按二元百分比渲染

顶层 `totalQuota` SHALL 映射为独立的月度会员配额行，且仅携带百分比：`used > 0` 视为冻结（100%，红色告警），`used` 缺省或为 0 视为正常（0%）。`totalQuota.remaining` MUST NOT 参与任何用量推导（该字段在冻结与健康状态下恒为相同值，不可信）。

#### Scenario: 冻结状态

- **WHEN** `totalQuota.used` 存在且大于 0
- **THEN** 月度会员行显示 100% 红色进度条，Used/Left 列不显示误导性计数

#### Scenario: 健康状态（used 字段缺省）

- **WHEN** `totalQuota` 中 `used` 字段缺省（月度重置后服务端省略该字段）
- **THEN** 月度会员行显示 0% 绿色进度条

### Requirement: 加量包钱包可选展示

当响应包含 `boosterWallet` 且余额有效时，SHALL 追加加量包钱包配额行：剩余余额作为 remaining，启用了月度消费上限时以子行展示已用/上限；字段缺省或无效时 MUST 静默省略该行。

#### Scenario: 无加量包

- **WHEN** 响应不含 `boosterWallet` 或其余额字段无效
- **THEN** 快照中不出现钱包行，不产生错误

### Requirement: 防御性解析

解析 MUST 容忍官方客户端观察到的字段形态变化：数字为十进制字符串（如 `"100"`）；顶层 `usage` 与窗口 `detail` 的 `used` 字段可缺省，此时以 `limit - remaining` 推导，两者皆缺则置为未知；`timeUnit` 取 `TIME_UNIT_MINUTE` 等 proto 风格枚举值；未知或多余字段 MUST 被忽略而非报错。

#### Scenario: 月度重置后的响应

- **WHEN** 每周配额响应中 `used` 缺省、`limit` 与 `remaining` 存在
- **THEN** 每周配额行的 used 按 `limit - remaining` 推导，不产生 schema 错误

### Requirement: 失败优雅降级

任何查询失败（401/403/429/5xx、超时、网络错误、非 JSON 响应、host 越权）MUST 返回带受控错误码的错误快照而不抛出异常；此前成功过的缓存快照 MUST 保留并以 stale 标记展示；失败 MUST NOT 影响模型请求。

#### Scenario: 密钥失效

- **WHEN** API 返回 401
- **THEN** 视图展示 `auth_failed` 错误状态；若有历史成功快照则标记 stale 并保留展示

### Requirement: 安全边界

密钥 SHALL 仅用于对 allowlist 内 HTTPS host 的 `Authorization` 头，且仅经 Pi 授权的 `getProviderAuth` 解析；密钥 MUST NOT 出现在快照、日志、错误信息或任何序列化输出中；重定向 MUST 被拒绝。

#### Scenario: 密钥不外泄

- **WHEN** 任意查询成功或失败
- **THEN** 快照与错误对象中不含密钥、Authorization 头或原始响应体内容
