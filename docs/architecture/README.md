# layrr-view 架构文档

本文档详细描述 layrr-view 的系统架构、各模块设计与完整数据流。

## 文档索引

| 文档                                                   | 内容                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [00 - 研读源码过程](./00-source-reading-process.md)    | 记录架构文档产出前的源码研读方法、阅读顺序、关键调用链追踪、字段梳理与验证方式                            |
| [01 - 系统总览](./01-overview.md)                      | 整体架构图、目录结构、模块依赖、单进程架构、构建系统                                                      |
| [02 - 前端 Overlay 采集系统](./02-frontend-overlay.md) | IIFE 注入机制、DOM 元素选择（单选/多选）、6 种源码定位策略、WebSocket 通信、状态管理、UI 组件与动画       |
| [03 - 后端处理流程](./03-backend-processing.md)        | HTTP 反向代理、HTML 注入、WS 消息路由、源码位置解析（三级策略）、编辑队列 Promise 机制、Git 版本操作      |
| [04 - AI Agent 系统](./04-ai-agent-system.md)          | Agent 接口设计、4 种 Agent 实现对比、Prompt 构建（单选/多选模板）、Local Agent Agentic Loop、8 种本地工具 |
| [05 - 完整数据流与流程图](./05-data-flow.md)           | 端到端数据流、启动流程、编辑请求生命周期、版本管理流程、错误处理与 fallback 链                            |

## 技术栈

| 层           | 技术                                                            |
| ------------ | --------------------------------------------------------------- |
| 前端 Overlay | TypeScript + esbuild IIFE + motion 动画库 + element-source      |
| 服务端       | Node.js + TypeScript (ESM) + http-proxy                         |
| WebSocket    | ws 库（双通道：overlay WS + HMR 透传）                          |
| AI Agent     | Claude Code CLI / Codex CLI / Pi Mono SDK / Local Anthropic SDK |
| 版本控制     | Git（自动 commit + preview/revert/restore）                     |
| 构建         | esbuild (overlay) + tsc (server) + scripts/build.ts             |

## 核心设计理念

1. **零侵入注入** — 通过 HTTP 反向代理在 `</body>` 前注入 overlay，不修改用户项目代码
2. **点击即定位** — 6 种源码定位策略 + 3 级服务端解析，将 DOM 元素映射到源码文件:行号
3. **AI 编辑闭环** — 用户选择元素 → 输入指令 → AI 修改源码 → Git 自动提交 → 前端刷新
4. **安全可回退** — 每次 AI 编辑自动 Git commit，支持 preview/revert/restore 任意版本
