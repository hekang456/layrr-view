# 01 - 系统总览

## 概述

`layrr-view` 是一个将“页面可视选择”和“AI 源码编辑”串成闭环的本地开发工具。它的目标不是直接在编辑器里聊天改代码，而是让用户在真实运行中的页面上：

- 直接点击某个 UI 元素
- 输入自然语言修改意图
- 让系统自动找到对应源码
- 调用 AI 修改项目文件
- 自动生成 Git 提交
- 支持预览、恢复、回滚整轮修改

从架构上看，它是一套跨浏览器、代理服务、源码定位、AI Agent、Git 版本管理的端到端系统。

## 一句话架构

可以把 `layrr-view` 概括成一句话：

```text
把用户在真实页面上的一次点击和一句自然语言，
转成一次可定位、可执行、可回退的源码修改。
```

这条链路中最关键的不是某个单点模块，而是几个层次的协同：

1. 浏览器中的 Overlay 负责采集用户选择与页面上下文
2. 本地 Node.js 进程负责代理、编排、源码增强与版本控制
3. AI Agent 负责在真实项目目录里执行代码修改
4. Git 负责把每一轮编辑纳入可追踪、可回退的历史

## 整体架构图

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户浏览器                                      │
│                                                                             │
│  ┌──────────────────────┐    ┌──────────────────────────────────────────┐   │
│  │   用户的 Web 应用      │    │         layrr Overlay (IIFE)              │   │
│  │   (React/Vue/...)     │    │                                          │   │
│  │                       │    │  ┌─────────┐ ┌─────────┐ ┌──────────┐  │   │
│  │   被 proxy 反向代理    │    │  │ 元素选择  │ │ 源码定位  │ │ UI 面板   │  │   │
│  │   HTML 中注入 overlay │    │  │ 单选/多选 │ │ 6种策略   │ │ 输入指令  │  │   │
│  │                       │    │  └─────────┘ └─────────┘ └──────────┘  │   │
│  └──────────────────────┘    │           │ WebSocket 通信 │              │   │
│                               └───────────┼──────────────┼──────────────┘   │
└───────────────────────────────────────────┼──────────────┼──────────────────┘
                                            │              │
                                            ▼              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Node.js CLI 进程                                    │
│                                                                             │
│  ┌──────────────────┐   ┌──────────────────┐   ┌───────────────────────┐   │
│  │   proxy.ts        │   │  ws-handler.ts    │   │    cli.ts             │   │
│  │                   │   │                   │   │    (editLoop)         │   │
│  │  HTTP 反向代理     │   │  WS 消息路由      │   │                       │   │
│  │  overlay 注入     │   │  源码解析编排      │   │  等待编辑请求          │   │
│  │  静态资源服务      │◄──│                   │──►│  构建 Prompt          │   │
│  │  WS 双路代理      │   │  ┌─────────────┐ │   │  调用 AI Agent        │   │
│  │                   │   │  │source-mapper│ │   │  Git 自动提交          │   │
│  │                   │   │  │  源码位置增强 │ │   │  通知前端结果          │   │
│  └──────────────────┘   │  └─────────────┘ │   │                       │   │
│                          └──────────────────┘   │  ┌─────────────────┐ │   │
│                                                  │  │ Agent 系统      │ │   │
│  ┌──────────────────┐   ┌──────────────────┐   │  │                 │ │   │
│  │  edit-queue.ts    │   │  version.ts      │   │  │ Claude / Local  │ │   │
│  │                   │   │                   │   │  │ Codex / PiMono │ │   │
│  │  Promise 队列     │◄──│  Git 版本操作     │   │  └─────────────────┘ │   │
│  │  连接 WS ↔ CLI   │   │  preview/revert  │   └───────────────────────┘   │
│  └──────────────────┘   └──────────────────┘                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                          ┌─────────────────────┐
                          │   用户项目源码文件     │
                          │   (被 AI Agent 修改)  │
                          │   + Git 自动提交      │
                          └─────────────────────┘
```

这张图揭示了 3 个最重要的架构事实：

1. 浏览器端不是独立前端应用，而是被注入到用户页面的 Overlay
2. 后端不是远程服务，而是本地 CLI 进程内部的一组模块
3. 最终被编辑的对象不是 `layrr-view` 自己，而是用户项目的真实源码文件

## 分层模型

为了统一理解整套系统，可以把它拆成 4 层。

### 第 1 层：可视采集层

对应目录：

- `overlay/`

职责：

- 在真实页面上叠加工具栏、面板、高亮框、历史面板
- 让用户通过鼠标选择元素
- 采集 DOM 结构信息、视觉信息、源码候选信息
- 通过 WebSocket 把请求发给后端

这一层解决的是“用户到底想改页面上的哪个元素”。

### 第 2 层：接入与编排层

对应目录：

- `src/server/`
- `src/editor/source-mapper.ts`

职责：

- 反向代理 dev server
- 注入 Overlay
- 区分 Pair 自己的 WebSocket 与用户页面的 HMR WebSocket
- 把前端请求整理成内部可执行结构
- 对源码位置做路径校正、上下文增强和 fallback 搜索

这一层解决的是“页面元素如何变成可执行的编辑请求”。

### 第 3 层：AI 执行层

对应目录：

- `src/agents/`
- `src/cli.ts`

职责：

- 根据结构化请求构建 Prompt
- 选择并调用具体 Agent
- 在项目目录内执行源码修改
- 追踪本轮真正发生变化的文件

这一层解决的是“如何把编辑请求转成真实代码变更”。

### 第 4 层：版本安全层

对应目录：

- `src/server/version.ts`
- `src/cli.ts` 中的 Git 自动提交逻辑

职责：

- 启动时初始化 Git 状态
- 每轮 AI 编辑自动创建 commit
- 提供 preview / restore / revert / commit 能力

这一层解决的是“修改之后如何可追踪、可回退、可预览”。

## 系统边界

理解系统边界非常重要，因为 `layrr-view` 同时接触浏览器、文件系统、AI 和 Git。

### 系统内部

属于 `layrr-view` 自己负责的部分：

- 代理服务器
- Overlay 注入与 UI
- WebSocket 通信
- 源码定位增强
- Prompt 构建
- Agent 调用
- Git 提交流程

### 系统外部依赖

`layrr-view` 所依赖但不拥有的部分：

- 用户自己的 dev server
- 用户自己的项目源码
- 用户本机的 Git 仓库
- 外部 AI CLI 或模型服务

### 为什么这个边界重要

因为很多设计决策都来自这个边界约束：

- 不能破坏用户 dev server 的 HMR
- 不能假设用户页面使用固定框架
- 不能直接信任浏览器拿到的所有源码位置信息
- 不能误提交用户原本的本地改动

## 目录结构

```text
layrr-view/
├── overlay/                      # 浏览器端 Overlay（IIFE bundle）
│   ├── overlay.ts                # 主入口：初始化、事件监听、WS通信、编辑提交
│   ├── source.ts                 # 源码定位：6种策略从 DOM 提取源文件信息
│   ├── state.ts                  # 全局状态管理 + sessionStorage 持久化
│   ├── elements.ts               # DOM 元素创建（工具栏、面板、高亮框、toast）
│   ├── styles.ts                 # CSS 样式注入 + 字体加载
│   ├── constants.ts              # CSS 前缀 + 颜色 token
│   ├── animate.ts                # 基于 motion 库的动画系统
│   ├── history.ts                # 历史版本面板 UI + 事件
│   └── git.ts                    # Revert / Commit WebSocket 操作
│
├── src/                          # Node.js 侧主逻辑
│   ├── cli.ts                    # CLI 主入口：参数解析、Git 初始化、editLoop
│   ├── config.ts                 # Agent 选择持久化 + 交互式选择
│   │
│   ├── agents/                   # AI Agent 系统
│   │   ├── base.ts               # Agent 接口 + 通用辅助函数
│   │   ├── index.ts              # Agent 注册表 + 工厂函数
│   │   ├── prompt.ts             # Prompt 构建（单选 / 多选）
│   │   ├── claude.ts             # Claude Code CLI Agent
│   │   ├── codex.ts              # Codex CLI Agent
│   │   ├── pi-mono.ts            # Pi Mono SDK Agent
│   │   └── local/                # Local Agent（内置完整工具集）
│   │       ├── config.ts         # 运行时配置
│   │       ├── runtime.ts        # Agentic loop 执行器
│   │       └── tools.ts          # 本地工具实现
│   │
│   ├── server/                   # 服务端核心
│   │   ├── proxy.ts              # HTTP 反向代理 + overlay 注入 + WS 代理
│   │   ├── ws-handler.ts         # WebSocket 消息路由 + 源码解析编排
│   │   ├── edit-queue.ts         # 编辑队列（连接 WS ↔ CLI）
│   │   └── version.ts            # Git 版本操作（preview / revert / commit）
│   │
│   └── editor/                   # 源码增强与编辑辅助
│       └── source-mapper.ts      # 源码位置解析 + context 增强 + 全局搜索 fallback
│
├── scripts/
│   └── build.ts                  # 构建脚本：esbuild(overlay) + tsc(server)
│
└── dist/                         # 构建产物
    ├── cli.js                    # Node CLI 入口 (ESM)
    ├── overlay.js                # 浏览器端 IIFE bundle
    └── fonts/                    # Lucide 图标 + Geist Mono 字体
```

这份目录结构可以看出一个明显特点：浏览器端与 Node 端没有混在一起，而是天然分成 `overlay/` 与 `src/` 两个世界。

## 核心数据流

虽然模块很多，但主链路其实非常集中。

```text
页面 DOM
-> Overlay 采集元素上下文
-> WebSocket edit-request
-> ws-handler.ts
-> source-mapper.ts
-> PendingEditRequest
-> buildPrompt()
-> Agent.applyEdit()
-> 工作区文件变化
-> git commit
-> edit-result
-> 前端反馈
```

### 这条链的关键点

#### 页面视角

用户面对的是“页面元素”，不是“文件路径”。

#### 系统视角

系统必须把“页面元素”翻译成“源码文件 + 行号 + 上下文 + 修改意图”。

#### 执行视角

Agent 面对的不是 DOM，而是一段结构化 Prompt 和真实项目目录。

#### 安全视角

所有修改最终都必须落入 Git 历史，才能支持回退。

## 模块依赖关系

从依赖方向上看，系统主要分成两棵树：浏览器端树和 Node 端树。

```text
cli.ts （主入口）
├── config.ts
├── agents/index.ts ──┬── claude.ts ──── prompt.ts + base.ts
│                     ├── codex.ts ───── prompt.ts + base.ts
│                     ├── local runtime ─ prompt.ts + local/runtime.ts
│                     │                   └── local/tools.ts
│                     │                   └── local/config.ts
│                     └── pi-mono.ts ─── prompt.ts
├── server/proxy.ts
│   └── ws-handler.ts
│       ├── edit-queue.ts
│       ├── version.ts
│       └── editor/source-mapper.ts
└── server/edit-queue.ts

overlay.ts（浏览器端，独立 bundle）
├── source.ts
├── state.ts
├── elements.ts
├── styles.ts
├── constants.ts
├── animate.ts
├── history.ts
└── git.ts
```

这棵依赖树说明：

- `cli.ts` 是整个 Node 侧的根入口
- `overlay.ts` 是整个浏览器侧的根入口
- `prompt.ts` 是所有 Agent 的共享公共点
- `ws-handler.ts` 是浏览器消息进入后端后的核心汇聚点

## 单进程架构

`layrr-view` 运行时是单个 Node.js 进程，同时承担三个角色：

1. HTTP 代理服务器
2. WebSocket 服务入口
3. AI 编辑主循环

```text
┌─────── 单个 Node.js 进程 ───────┐
│                                   │
│  HTTP Server (proxy.ts)           │
│    ├── 反向代理 dev server        │
│    ├── 注入 overlay.js            │
│    └── WS 升级 → ws-handler.ts    │
│                                   │
│  editLoop (cli.ts)                │
│    ├── 阻塞等待 editQueue         │
│    ├── 调用 AI Agent              │
│    └── Git commit                 │
│                                   │
│  editQueue (edit-queue.ts)        │
│    └── 连接 WS handler ↔ CLI      │
└───────────────────────────────────┘
```

### 为什么采用单进程

优点：

- 启动简单
- 状态共享直接
- 不需要引入额外消息中间件
- 更适合 CLI 的临时使用方式

代价：

- 模块之间边界必须清晰
- 公共类型和调用链必须稳定
- 长耗时逻辑要谨慎编排，避免阻塞错误蔓延

### `edit-queue` 的作用

单进程并不意味着所有逻辑都写在一起，`edit-queue.ts` 在这里承担了关键解耦作用：

- WebSocket 层负责接入请求
- `cli.ts` 负责串行执行编辑
- 两者通过 Promise resolver 桥接

这让系统在保持单进程的同时，仍然具备清晰的请求流向。

## 构建系统

`layrr-view` 的构建不是单一路径，而是浏览器端和服务端分别构建。

```text
┌── scripts/build.ts ──┐
│                       │
│  1. esbuild           │    overlay/*.ts -> dist/overlay.js (IIFE)
│  2. tsc               │    src/*.ts -> dist/*.js (ESM)
│  3. copy fonts        │    overlay/fonts/ -> dist/fonts/
│  4. chmod 755         │    dist/cli.js (可执行)
└───────────────────────┘
```

### 为什么拆成两条构建路径

#### Overlay 侧

浏览器脚本需要：

- 尽量单文件
- 直接通过 `<script>` 执行
- 不依赖模块加载器

所以用 `esbuild` 打成 IIFE。

#### Server 侧

Node 端更适合保留模块边界和 TypeScript 类型结构，所以使用 `tsc` 输出 ESM。

### 构建产物

最终关键产物有三个：

- `dist/cli.js`
- `dist/overlay.js`
- `dist/fonts/*`

其中 `dist/overlay.js` 会被代理注入到用户页面；`dist/cli.js` 则是用户实际运行的命令行入口。

## 设计原则

整套架构背后有几个持续出现的设计原则。

### 1. 零侵入

不要求用户修改项目源码集成 SDK，也不要求用户手动插入调试 UI。Overlay 通过代理注入进入页面。

### 2. 真实页面优先

用户是在已经运行起来的真实页面上选元素，而不是在抽象组件树里选节点。

### 3. 双端协同定位

源码定位不是完全靠前端，也不是完全靠后端，而是：

- 前端先拿尽可能精确的运行时信息
- 后端再补路径、上下文和 fallback 搜索

### 4. 串行执行编辑

同一时刻只处理一个编辑请求，保证：

- 文件修改顺序清晰
- Git 历史清晰
- AI 编辑不会并发冲突

### 5. 版本安全优先

AI 编辑不是直接覆盖工作区，而是被纳入 Git 管理，具备：

- 自动 commit
- preview
- restore
- revert

## 与各子文档的关系

这份总览文档回答的是“整个系统是什么样”，而不是每个细节怎么实现。后续文档分别沿不同方向展开：

- `00-source-reading-process.md`
  - 记录源码研读路径与调用链追踪方法
- `02-frontend-overlay.md`
  - 详细展开浏览器端注入、选择、多选、源码定位、WS 协议
- `03-backend-processing.md`
  - 详细展开代理、WS 编排、源码增强、Git 操作、editLoop
- `04-ai-agent-system.md`
  - 详细展开 Prompt、Agent 抽象与 4 种实现
- `05-data-flow.md`
  - 用时序与流程视角把整套系统串起来

因此，这份 `01-overview.md` 的定位是整套文档的“地图页”。

## 系统总览总结

`layrr-view` 最核心的价值不是“调用 AI 改代码”这么简单，而是把以下几件事做成了一条完整工程链：

1. 在真实页面里准确选中用户关心的 UI
2. 把页面元素稳定映射到源码上下文
3. 把上下文翻译成 AI 可执行的编辑任务
4. 把修改纳入可追踪、可回退的 Git 生命周期

最终形成的不是单一功能，而是一种新的开发交互模式：

```text
从“在编辑器里找代码再改”
变成“先在页面里点中目标，再让系统反向找到代码并修改”
```

这也是整套架构成立的根本原因。
