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
