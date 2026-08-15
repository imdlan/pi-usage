# pi-usage Project Instructions

## Bilingual README

- 本项目维护双语文档：`README.md`（英文）与 `README.zh-CN.md`（简体中文）。
- 两个文件的内容必须保持同步：任何改动 README 的会话都需同时更新两个版本。
- 结构逐节对应；代码块、命令、路径、配置项和 API 名称保留英文，描述性内容按各自语言书写。
- 两个文件顶部保留语言切换链接 `[English](./README.md) | [简体中文](./README.zh-CN.md)`。

## Conventions

- 回复与文档说明默认使用简体中文，技术术语保留英文。
- 修改前先运行 `npm run typecheck` 与 `npm test` 通过现有基线；改动后再次验证。
- 代码风格遵循现有约定：strict TypeScript、零运行时依赖（Node 内置 + Pi Extension API）。

## Git push（沙盒环境专用）

- `~/.ssh` 被 pi 沙盒策略保护，SSH 推送不可用；沙盒内 `ls ~/.ssh` 报 `Operation not permitted` 或显示空目录是预期行为，不代表密钥不存在。
- DNS 不通，需显式走沙盒 HTTP 代理；凭证用 credential store（PAT 已存于 `~/.git-credentials`，勿读勿改）。可用命令：

```bash
GIT_TERMINAL_PROMPT=0 git -c credential.helper=store \
  -c http.https://github.com.proxy="$HTTPS_PROXY" \
  push https://imdlan@github.com/imdlan/pi-usage.git main
```

- 带 tag 时把 `push` 后加 `--follow-tags`。推送属于手动操作，不属于 npm 发布流程。
