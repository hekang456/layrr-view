# 03 - 后端处理流程

## 概述

`layrr-view` 的后端不是一个远程服务，而是运行在本地命令行进程中的一组服务端模块。它们共同完成以下任务：

- 反向代理用户的 dev server
- 在 HTML 中注入 Overlay 脚本
- 处理浏览器与 CLI 之间的 WebSocket 通信
- 将前端元素信息解析为后端可执行的编辑请求
- 对源码位置做增强解析与兜底搜索
- 连接 AI 编辑主循环与前端结果通知
- 管理 Git 历史预览、恢复、回滚、推送

从职责上看，这一层位于“浏览器采集”和“AI 编辑执行”之间，是整个系统的中间编排层。

## 模块结构

```text
src/
├── cli.ts                    # CLI 主入口，启动所有流程，并运行 editLoop
├── server/
│   ├── proxy.ts             # HTTP 反向代理 + overlay 注入 + WS 升级
│   ├── ws-handler.ts        # WebSocket 消息入口与处理编排
│   ├── edit-queue.ts        # Promise 桥接队列，连接 WS 与 CLI
│   └── version.ts           # Git preview / restore / revert / commit
└── editor/
    └── source-mapper.ts     # 服务端源码解析与上下文增强
```

## 单进程架构

这套后端能力不是多服务拆分，而是集中运行在单个 Node.js 进程里。

```text
┌────────────────────────────────────────────┐
│              layrr-view 进程                  │
│                                            │
│  cli.ts                                    │
│   ├── 启动 proxy.ts                        │
│   ├── 创建 Agent                           │
│   ├── 启动 editLoop                        │
│   └── 管理 Git 初始化与自动提交            │
│                                            │
│  proxy.ts                                  │
│   ├── 反向代理 HTTP                        │
│   ├── 注入 overlay.js                      │
│   ├── 静态资源服务                         │
│   └── WebSocket 升级分发                   │
│                                            │
│  ws-handler.ts                             │
│   ├── 处理前端消息                         │
│   ├── 调用 source-mapper                   │
│   └── push 到 editQueue                    │
│                                            │
│  edit-queue.ts                             │
│   └── 连接 WebSocket handler 与 editLoop   │
│                                            │
│  version.ts                                │
│   └── 提供 Git 版本操作                    │
└────────────────────────────────────────────┘
```

这种单进程方案的优点是：

- 数据流清晰，不需要额外进程间通信
- 共享状态实现简单
- 适合 CLI 临时启动、随用随停的使用方式

它的代价是：模块之间耦合更高，因此必须依赖清晰的数据结构和边界约束。

## `cli.ts`：后端总入口

`cli.ts` 是整个后端运行链的起点。它负责把“本地命令行工具”变成一个真正可工作的编辑系统。

### 启动阶段职责

#### 1. 解析命令行参数

主要参数包括：

- 目标 dev server 端口
- 代理端口
- 项目根目录
- 指定使用的 Agent
- 是否自动打开浏览器

#### 2. 选择并校验 Agent

启动时会根据用户参数或本地配置：

- 解析目标 Agent
- 检查该 Agent 是否可用
- 如果不可用，给出安装或认证提示

#### 3. 初始化 Git 仓库

这是一个非常关键的启动前步骤。CLI 会确认当前项目：

- 是否已经是 Git 仓库
- 是否已有 commit
- 是否存在脏文件

可能的动作包括：

- `git init`
- 创建 `initial commit`
- 如果已有未提交改动，先创建一次 `pre-layrr snapshot`

这一步保证 AI 编辑从一条可回退的版本链上开始，而不是直接在不可追溯的工作区上操作。

#### 4. 启动代理服务器

调用 `startProxy(targetPort, proxyPort, projectRoot)`。

#### 5. 启动浏览器

除非指定 `--no-open`，CLI 会自动打开代理地址。

#### 6. 进入 `editLoop`

进入一个长期运行的循环，等待来自前端的编辑请求。

## `proxy.ts`：代理层

`proxy.ts` 是浏览器看到的“后端入口”。它做的并不只是普通反向代理，而是把用户项目页面改造成一个可编辑页面。

## HTTP 代理职责

### 1. 反向代理到用户 dev server

用户访问的是 `layrr-view` 暴露出的代理端口，但真正业务页面内容来自用户自己的开发服务器。

```text
浏览器
-> http://localhost:{proxyPort}
-> proxy.ts
-> http://localhost:{targetPort}
-> 用户 dev server
```

### 2. 注入 Overlay 脚本

当代理响应的 `Content-Type` 是 `text/html` 时，`proxy.ts` 会：

- 读取原始 HTML
- 在 `</body>` 前插入注入脚本
- 删除原始 `content-length` / `content-encoding`
- 返回修改后的 HTML

这一步是整个系统可视编辑能力的起点。

### 3. 提供静态资源

除了转发用户页面，它还要提供 Pair 自己的资源：

- `/__layrr__/overlay.js`
- `/__layrr__/fonts/*`

这些资源不来自用户项目，而来自 `layrr-view` 的构建产物。

### 4. 提供 REST 查询接口

#### `/__layrr__/edit-status`

返回最后一次编辑结果，供前端轮询兜底使用。

#### `/__layrr__/history`

读取 Git 提交历史并返回 JSON，供前端历史面板渲染。

### 5. 鉴权

代理层还承担访问控制：

- 支持访问 token
- 支持 cookie
- 支持 share password

这让本地开发环境被代理出去时仍有基本保护能力。

## WebSocket 升级分流

`proxy.ts` 不只处理 HTTP，还负责 WebSocket upgrade。

### 两类 WebSocket

#### Pair 自己的 WebSocket

路径是：

```text
/__layrr__/ws
```

它连接浏览器 Overlay 与 `ws-handler.ts`。

#### 用户 dev server 的 WebSocket

例如：

- Vite HMR
- webpack dev server
- 其他热更新通道

这些连接不会被 Pair 接管，而是继续透传给原始 dev server。

### 为什么必须区分两类 WS

因为 `layrr-view` 注入页面后，不能破坏用户开发服务器原本的热更新行为。

所以代理层要实现：

```text
if pathname === /__layrr__/ws
  -> 进入 Pair WS 逻辑
else
  -> 透传到 targetPort 的原始 WS
```

这保证了 Overlay 与 HMR 可以并存。

## `ws-handler.ts`：WebSocket 接入与编排层

`ws-handler.ts` 是浏览器消息进入后端的第一站。它不是简单的“收消息转发”，而是一个带编排能力的接入层。

## 连接建立后的初始化

当浏览器连上 Pair WebSocket 后，后端会：

- 保存当前活跃 WS 连接
- 注册 `editQueue.setWsNotifier(...)`

这个 notifier 很关键，因为它建立了“编辑完成后如何把结果送回当前前端”的通道。

## 消息类型

`ws-handler.ts` 需要处理多类消息：

### 编辑相关

- `edit-request`

### 版本相关

- `version-preview`
- `version-restore`
- `version-revert`
- `commit-request`

### 连接状态相关

- `overlay-ready`
- 其他调试或同步类消息

其中最复杂的是 `edit-request`。

## `edit-request` 处理流程

可以把它理解为：

```text
前端元素上下文
-> 服务端格式化
-> 源码位置增强
-> 投递到 editQueue
```

### 单选路径

```text
收到 edit-request(single)
-> 打印调试信息
-> 调用 resolveSource()
-> 生成 PendingEditRequest
-> editQueue.push(request)
```

### 多选路径

```text
收到 edit-request(multi)
-> 打印多元素调试信息
-> 对每个 element 调用 resolveElementInfo()
   -> 内部继续调用 resolveSource()
-> 为每个元素补全 sourceLocation
-> 确定 primaryElement
-> 生成 PendingEditRequest
-> editQueue.push(request)
```

### `resolveElementInfo()` 的作用

前端传来的 `sourceInfo` 还只是“浏览器观察到的候选源码位置”。后端要把它变成真正适合 AI 使用的结构：

- 标准化文件路径
- 读取上下文
- 计算匹配质量
- 补充策略来源

### 为什么 WebSocket handler 不直接调用 Agent

因为系统特意把“消息接入”和“编辑执行”分离开来：

- `ws-handler.ts` 负责把请求整理好
- `cli.ts` 的 `editLoop` 负责串行执行 AI 编辑

这样做的好处是：

- 避免 WebSocket 层直接执行耗时任务
- 保证 AI 编辑严格串行
- 让编辑结果可以统一接入 Git 提交流程

## `edit-queue.ts`：Promise 桥接队列

`edit-queue.ts` 是整个后端里最容易被误解的模块。它不是一个传统缓冲队列，更像一个“单通道 Promise 桥”。

## 核心结构

它内部维护的关键状态很少：

- `waitingResolver`
- `wsNotifier`
- `lastResult`
- `projectRoot`

### `waitingResolver`

当 `cli.ts` 正在等待下一个编辑请求时，`waitForNext()` 会返回一个 Promise，并把它的 resolver 存起来。

### `push()`

当 `ws-handler.ts` 接收到编辑请求后，会调用 `push(request)`。如果此时存在 `waitingResolver`，则立即 resolve，对应的 `editLoop` 被唤醒。

### 这种模型意味着什么

```text
CLI 先等待
-> WS 到来时投递
-> Promise resolve
-> 进入编辑执行
```

它没有通用消息队列那种“可积压多个请求”的缓冲语义，而是更偏向：

- 单消费者
- 单等待状态
- 串行编辑

### 为什么这样设计

系统希望同一时刻只执行一个 AI 编辑，因为：

- 多个 Agent 同时改文件容易冲突
- Git 自动提交要求顺序清晰
- 前端可视编辑的用户心智也是“一次做一件事”

## 编辑结果通知

`edit-queue.ts` 不只负责传请求，也负责传结果。

### `notifyComplete(success, message)`

它会完成两件事：

1. 把结果写入 `lastResult`
2. 调用 `wsNotifier` 主动向前端发消息

这就是为什么前端既能通过 WS 收到结果，也能通过 `/__layrr__/edit-status` 轮询补拉到结果。

## `source-mapper.ts`：服务端源码位置增强

前端已经做了一轮源码定位，但后端仍然需要 `source-mapper.ts`。这个模块的目标不是重复定位，而是把前端结果变成“适合 AI 读取和编辑”的上下文。

## 输出结构

后端输出的是 `SourceLocation`，而不是前端原始的 `SourceInfo`。

```typescript
SourceLocation = {
  filePath,
  line,
  column?,
  context,
  sourceMatchQuality,
  sourceStrategy?,
}
```

这里新增的核心字段是：

- `context`: 用于 prompt 的代码上下文
- `sourceMatchQuality`: 描述可信度

## 三级解析策略

### 第一层：直接使用前端 `sourceInfo`

如果前端已经提供 `file + line`，后端会优先沿用。

但这并不意味着“直接信任然后结束”，还要继续做路径和上下文增强。

### 第二层：`enhanceContext()`

这是服务端最关键的增强逻辑。它的核心目标是避免只拿到一个“组件签名位置”或“定义位置”，而拿不到真正渲染目标文本的上下文。

常见增强动作包括：

#### 1. 文本直接命中检测

如果当前上下文已经包含目标文本，直接认为定位足够好。

#### 2. Wrapper 组件识别

如果当前命中的是：

```text
const SomeComponent = (...) => ...
```

而不是实际 JSX 渲染位置，则尝试继续向附近查找 `<SomeComponent ... />` 或对应渲染片段。

#### 3. 向下搜索目标文本

如果当前行附近没有真正显示内容，会沿文件向下搜索匹配文本。

#### 4. 自定义标签搜索

对非通用标签，会尝试根据标签名继续搜索其渲染位置。

#### 5. 跳出签名区域

如果当前上下文落在：

- import
- interface
- type
- props 定义

这一类签名区域，会尽量继续向下查找真正渲染区域。

### 第三层：全局搜索 fallback

如果前端完全没有 `sourceInfo`，或者已有信息无效，后端会退化到跨文件搜索。

搜索逻辑并不是纯文本 grep，而是带有启发式排序和评分：

- 优先搜索 `src/`
- 支持多种源码后缀
- 根据页面、布局、组件目录做优先级排序
- 根据文本命中、标签命中、class 命中来打分

最终返回得分最优的候选文件和行号。

## 匹配质量 `sourceMatchQuality`

这个字段在整个链路中很重要，它让后续 Prompt 知道当前源码定位到底有多可信。

### 三种质量

#### `precise`

说明定位高度可信，通常来自：

- 精确的前端调试属性
- 精确命中的源码位置

在这种情况下，prompt 可以更简洁，因为文件和上下文已经足够可靠。

#### `fallback`

说明定位有一定可信度，但仍存在误差风险，可能来自：

- 运行时内部结构
- 上下文增强后的近似位置

这种情况下，prompt 更需要附加辅助上下文，AI 也应先阅读再修改。

#### `server search`

说明完全依赖后端启发式搜索。

它是最弱的一种定位质量，需要 AI 更积极地搜索和确认实现位置。

## `version.ts`：Git 版本操作层

`version.ts` 负责把前端的版本操作请求转成具体 Git 命令。

## 支持的操作

### `preview`

作用：切到某个历史提交进行只读预览。

实现方式：

```text
记录 originalBranch
-> 发送 WS 结果
-> git checkout <hash> --detach
```

### `restore`

作用：从预览态恢复到原始分支。

实现方式：

```text
检查 originalBranch
-> 发送 WS 结果
-> git checkout <originalBranch>
-> 清空 originalBranch
```

### `revert`

作用：真正回滚到某个历史版本。

实现方式：

```text
切回原始分支
-> 发送 WS 结果
-> git reset --hard <hash>
-> 清空 originalBranch
```

### `commit`

作用：把当前 HEAD 推送到远程。

实现方式：

```text
git push -u origin HEAD
-> 发送 commit-result
```

## 为什么要先发 WS 再执行 Git

这是 `version.ts` 最关键的设计点之一。

原因是：

- `checkout`、`reset` 可能触发文件系统变化
- dev server 监听到变化后会刷新页面
- 页面刷新时，当前 WebSocket 连接可能断开

如果先执行 Git，再试图通知前端，消息很可能来不及送达。

所以流程必须是：

```text
先通知前端结果
-> 再执行 Git
-> 前端刷新后基于 sessionStorage 恢复状态
```

## `cli.ts` 中的 `editLoop`

后端处理的终点不是 `ws-handler.ts`，而是 `cli.ts` 中的 `editLoop`。它承担了“真正执行编辑”的角色。

### 执行流程

```text
while (true)
-> await editQueue.waitForNext()
-> 打印当前请求信息
-> 快照当前脏文件集合
-> buildPrompt(request)
-> agent.applyEdit(request)
-> 比较编辑前后文件变化
-> 若有新增变化
   -> git add
   -> git commit "[layrr] <instruction>"
-> 通过 editQueue.notifyComplete() 通知前端
```

### 为什么先做工作区快照

因为项目可能在 Pair 之外本来就有未提交改动。

`editLoop` 通过记录编辑前后的脏文件集合，只提交 AI 本轮新增的修改，而尽量不误提交用户原本未提交的本地变更。

这一步保证了自动提交行为更精确，也降低了对用户工作区的侵入性。

### 自动提交格式

提交信息通常是：

```text
[layrr] <用户指令摘要>
```

这使历史记录清晰区分：

- 哪些提交来自用户手写
- 哪些提交来自 Pair 驱动的 AI 编辑

## 后端完整时序

下面给出从前端发起编辑到后端准备好 AI 执行请求的完整后端时序。

```text
浏览器 Overlay
-> proxy.ts (/__layrr__/ws upgrade)
-> ws-handler.ts
-> handleEditRequest()
-> source-mapper.ts resolveSource()
-> 构造 PendingEditRequest
-> edit-queue.ts push()
-> cli.ts editLoop 被唤醒
-> 进入 Agent 执行阶段
```

## 错误处理与兜底

后端这一层设计了多种兜底：

### 1. HTML 注入失败兜底

如果不是 HTML 响应，代理就不注入，只做透传。

### 2. WS 断连兜底

前端仍可通过 `/__layrr__/edit-status` 获取最后结果。

### 3. 源码定位失败兜底

前端失败后，服务端用搜索继续兜底。

### 4. Git 操作刷新兜底

先发消息，再执行 checkout/reset，避免刷新前消息丢失。

### 5. 工作区污染兜底

通过前后快照差分，尽量只提交当前这轮 AI 产生的修改。

## 后端架构总结

后端层的核心作用不是“替前端渲染 UI”，也不是“仅仅调用 AI”，而是作为整个系统的中间调度中心，完成三件最重要的事：

1. 把普通网页变成可采集、可编辑的网页
2. 把浏览器观察到的元素信息转换成高可信的源码上下文
3. 把 AI 编辑执行放进可串行、可回滚、可追踪的流程里

从整体上看，这一层决定了系统是否：

- 能稳定接入用户页面
- 能把前端采集转成真实可执行请求
- 能在 Git 和 AI 之间形成安全闭环

因此它既是技术中间层，也是整个产品可靠性的核心。
