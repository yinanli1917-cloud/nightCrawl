# gstack 逆向学习笔记索引

> 目标：师夷长技以制夷——完整吸收 gstack 的设计精华，自建 X Playwright MCP
> 日期：2026-03-21

## 学习笔记

| 文件 | 主题 | 行数 |
|------|------|------|
| [01-architecture.md](01-architecture.md) | 整体架构：daemon 模型、Bun 选型、安全模型、模板系统、测试三层 | ~400 |
| [02-skill-patterns.md](02-skill-patterns.md) | 四大 Skill 范式：行为约束 / 多阶段工作流 / 交互对话 / CEO 审查 | ~400 |
| [03-browser-engine.md](03-browser-engine.md) | 浏览器引擎：HTTP daemon、BrowserManager、Cookie 导入、@ref 系统 | ~300 |

## 源码位置

学习用仓库：`/tmp/gstack-study/`（clone 自 https://github.com/garrytan/gstack）

## 下一步

- [ ] 安装 Bun + 正式安装 gstack
- [ ] 自建 X Playwright MCP（复用 daemon 架构 + Arc cookie 导入）
