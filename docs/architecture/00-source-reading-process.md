# 00 - 研读源码过程

## 文档目的

这份文档不描述最终系统设计本身，而是记录在为 `layrr-view` 输出架构文档前，如何系统化地研读源码、拆分模块、追踪调用链、确认关键数据结构，以及如何把零散实现整理成可复用的架构认知。

它主要回答 4 个问题：

1. 研读源码时先看什么，后看什么
2. 每一轮阅读的目标是什么
3. 哪些文件是关键入口，哪些文件是配套实现
4. 如何把“前端采集 -> 后端处理 -> AI 编辑 -> 前端反馈”串成完整链路

## 研读原则

研读阶段遵循以下原则：

### 1. 先找入口，再找实现

不从局部工具函数开始看，而是优先定位：

- 浏览器端入口：`overlay/overlay.ts`
- Node 进程入口：`src/cli.ts`
- 网络入口：`src/server/proxy.ts`
- AI 调用入口：`src/agents/index.ts`

先明确“系统从哪里启动、消息从哪里流入、编辑从哪里触发”，再下钻到内部模块。

### 2. 先看主流程，再补细节

优先建立粗粒度流程图：

```text
用户页面 -> overlay 注入 -> 元素选择 -> WebSocket -> server 解析 -> editQueue
-> CLI editLoop -> buildPrompt -> Agent -> 修改源码 -> Git commit -> 前端结果通知
```

在主链路清楚之后，再补：

- 源码定位策略
- 多选模式数据结构
- Git 历史与回滚
- Local Agent 的工具执行循环

### 3. 先确认数据结构，再判断模块职责

很多模块间关系不是靠函数名，而是靠共享的数据结构串起来的。研读时优先确认：

- `PendingEditRequest`
- `ElementEditInfo`
- `SelectionContextInfo`
- `SourceInfo`
- `SourceLocation`
- `Agent`

这些类型确定之后，才能看清楚前后端传递的最小信息集是什么。

### 4. 先追调用链，再决定是否需要修改公共代码

对于公共模块，不只看定义，还要追踪：

- 谁构造这个数据
- 谁消费这个数据
- 修改后会影响哪些路径

这样才能避免“只改了一处格式，但上游/下游仍依赖旧字段”的问题。

## 研读阶段划分

整个源码研读分为 5 个阶段。

### 第一阶段：建立系统边界

目标是回答：`layrr-view` 到底是一个什么形态的系统。

这一阶段主要看：

- `src/cli.ts`
- `src/server/proxy.ts`
- `overlay/overlay.ts`
- `scripts/build.ts`
- `docs/architecture/01-overview.md` 对应需要覆盖的结构

结论是：

1. `layrr-view` 不是一个传统前后端分离服务，而是一个单 Node.js 进程的 CLI
2. 这个进程同时承担 HTTP 代理、WebSocket 服务、编辑主循环三种职责
3. 浏览器端并不是独立前端应用，而是被注入到用户 dev-server 页面里的 IIFE Overlay
4. 最终真正被修改的是用户项目源码，不是 `layrr-view` 自己的运行时代码

### 第二阶段：研读前端采集链路

目标是回答：浏览器端是如何完成“选择元素 + 收集上下文 + 发请求”的。

这一阶段按以下顺序看：

1. `overlay/overlay.ts`
2. `overlay/source.ts`
3. `overlay/state.ts`
4. `overlay/elements.ts`
5. `overlay/styles.ts`
6. `overlay/animate.ts`
7. `overlay/history.ts`
8. `overlay/git.ts`
9. `overlay/constants.ts`

重点不是把每一行代码都看完，而是按问题拆解：

#### 问题 A：Overlay 如何进入用户页面

从 `src/server/proxy.ts` 的 HTML 注入逻辑反向看 `overlay/overlay.ts` 的 IIFE 启动。

确认点：

- 注入位置是 HTML 的 `</body>` 前
- 注入内容包含：
  - `window.__PAIR_WS_PORT__`
  - `/<prefix>/__layrr__/overlay.js`
- Overlay 依赖 WebSocket 端口才能连接后端

#### 问题 B：用户怎样从“浏览页面”进入“编辑页面”

主要看 `setMode()`、全局键盘事件和工具栏按钮。

确认点：

- `browse` / `edit` 两种模式
- `Cmd+K` / `Alt+K` 切换
- `Escape` 退出
- 进入 `edit` 模式后，hover 高亮、点击选择、面板展开同时生效

#### 问题 C：单选和多选如何区分

主要看点击事件分支和 `selectedEl` / `selectedEls` 的关系。

确认点：

- 无 `Shift` 点击走单选
- `Shift + Click` 走多选
- `selectedEls` 按选择顺序保留全部元素
- 最后一个被选择的元素会成为主元素 `selectedEl`

这个阶段也解释了“为什么最后元素为主元素”：

- 它不是独立于多选集合的另一份实体
- 本质上是多选集合中的焦点元素
- 它让后续 prompt 构造或 UI 聚焦时可以有一个默认参照对象

#### 问题 D：前端能拿到哪些元素信息

主要看 `source.ts` 和 `overlay.ts` 中发送 payload 的构造逻辑。

确认点：

- 元素基础字段：`tagName`、`className`、`textContent`、`selector`
- 结构字段：`breadcrumb`、`tagLabel`
- 位置字段：`rect`
- 辅助字段：`accessibleLabel`
- 源码字段：`sourceInfo`
- 多选上下文：`selectionContext`

#### 问题 E：源码定位是怎么做的

这一阶段重点看 `overlay/source.ts`。

要确认的不是“函数怎么写”，而是“策略链怎么组织”：

1. LocatorJS data 属性
2. LocatorJS ID + `window.__LOCATOR_DATA__`
3. React Inspector
4. Vue Inspector
5. `element-source`
6. React Fiber / Vue runtime fallback

结论：

- 浏览器端的源码定位是“尽量在前端就拿到精确信息”
- 服务端的 `source-mapper.ts` 负责二次增强和兜底，不是完全替代前端定位

### 第三阶段：研读后端处理链路

目标是回答：浏览器发来的消息如何被接收、解析、排队、处理。

这一阶段按以下顺序看：

1. `src/server/proxy.ts`
2. `src/server/ws-handler.ts`
3. `src/server/edit-queue.ts`
4. `src/editor/source-mapper.ts`
5. `src/server/version.ts`
6. `src/cli.ts`

#### 问题 A：代理服务器做了哪些事

主要看 `startProxy()`。

确认点：

- 不是单纯静态服务器，而是反向代理
- 对 HTML 响应做脚本注入
- 提供 `/__layrr__/overlay.js`
- 提供 `/__layrr__/history`
- 提供 `/__layrr__/edit-status`
- 处理字体资源请求
- 区分 layrr 自己的 WebSocket 和 dev-server 的 HMR WebSocket

#### 问题 B：WebSocket handler 到底是路由器还是处理器

主要看 `handleWsConnection()` 和 `handleEditRequest()`。

结论是两者兼有：

- 它负责消息类型分发
- 也负责把前端字段整理成后端内部可处理的请求对象
- 还负责调用 `resolveSource()` 做服务端源码增强

这说明它不是一个纯协议层，而是“接入层 + 编排层”。

#### 问题 C：编辑请求为何能从 WS 走到 CLI 主循环

关键文件是 `edit-queue.ts`。

这一阶段要确认的核心不是队列 API，而是它的并发模型：

- `waitForNext()` 在 CLI 中阻塞等待
- `push()` 在 WS handler 中投递请求
- 两者通过 Promise resolver 桥接
- 同一时刻只允许一个等待中的消费者

结论：

- 这不是一个传统带缓存的消息队列
- 而是一个单等待者、单请求通道的 Promise 桥
- 设计目标是保证编辑请求严格串行执行

#### 问题 D：服务端源码增强到底增强了什么

主要看 `src/editor/source-mapper.ts`。

这个模块需要拆成 3 层理解：

1. 使用前端提供的 `sourceInfo`
2. 通过 `enhanceContext()` 修正上下文和行号
3. 前端定位不到时，使用全局搜索 fallback

研读重点：

- `precise` / `fallback` / `server search` 三种匹配质量
- `contextLooksLikeSignature` 对 prompt 的影响
- wrapper 组件、签名区域、文本下钻搜索等启发式规则

#### 问题 E：Git 版本能力如何接入前端

主要看 `version.ts`。

确认点：

- `preview` 通过 `git checkout <hash> --detach`
- `restore` 切回原始分支
- `revert` 是 `git reset --hard <hash>`
- `commit` 是 `git push -u origin HEAD`

这里还要特别确认一个实现细节：

- 为什么很多操作是“先发送 WS 响应，再执行 Git 命令”

答案是：

- 因为 checkout 或 reset 可能触发 dev-server 重载
- 一旦页面重载，前端 WS 会断开
- 所以必须先把结果通知发出去，再执行真正的切换

### 第四阶段：研读 AI Agent 链路

目标是回答：编辑请求在进入 CLI 主循环后，如何被转成 prompt，再交给不同 Agent 执行。

这一阶段按以下顺序看：

1. `src/agents/base.ts`
2. `src/agents/index.ts`
3. `src/agents/prompt.ts`
4. `src/agents/claude.ts`
5. `src/agents/codex.ts`
6. `src/agents/pi-mono.ts`
7. `src/agents/local/config.ts`
8. `src/agents/local/runtime.ts`
9. `src/agents/local/tools.ts`

#### 问题 A：Agent 抽象层有多薄

先看 `Agent` 接口。

确认结论：

- 公共接口非常薄，核心就是 `applyEdit(request)`
- 这意味着大部分差异都在具体 Agent 的执行方式里，而不在统一抽象层里

#### 问题 B：Prompt 真正依赖哪些字段

这一阶段要重点看 `buildPrompt()`，因为它决定前面采集的数据哪些真的会进入 AI 上下文。

研读重点：

- 单选模板和多选模板的结构差异
- `selectionContext` 怎样影响 prompt
- `sourceMatchQuality` 怎样影响提示语气
- 精确定位时哪些信息是冗余的

这一阶段也是后续做“精简多选 prompt 字段”的依据。

#### 问题 C：4 种 Agent 的差异在哪里

不是简单记录“有 4 个 Agent”，而是拆成实现方式：

- Claude：本地 CLI 子进程
- Codex：本地 CLI 子进程
- Pi Mono：SDK / session 方式
- Local：自建 agentic loop + 内置工具系统

#### 问题 D：Local Agent 为什么值得单独展开

因为 `local/runtime.ts` 与 `local/tools.ts` 不只是一个 provider 适配器，而是一个完整的本地智能体运行时。

需要确认：

- 迭代循环如何终止
- 工具调用如何执行
- 消息如何压缩
- 输出过长如何持久化
- todo 提醒如何插入

### 第五阶段：追踪关键调用链与公共代码影响

目标是回答：如果要改某个公共字段或公共 prompt 格式，影响范围到底有多大。

这个阶段是“架构认知”转向“可安全修改”的关键一步。

重点追踪了以下调用链。

#### 调用链 1：`buildPrompt()`

需要确认：

- 谁调用它
- 修改 prompt 模板是否需要改调用处

追踪结果：

- `buildPrompt()` 的调用方是各个 Agent 的 `applyEdit()`
- 只要函数签名不变，调用方通常不需要跟着修改
- 真正需要谨慎的是输入数据结构是否仍然完整

#### 调用链 2：`PendingEditRequest`

需要确认：

- 前端哪些字段会进入这个请求
- 后端哪些模块会继续消费这些字段

追踪结果：

- `ws-handler.ts` 负责构造
- `edit-queue.ts` 负责转运
- `cli.ts` 负责消费
- `prompt.ts` 和各 Agent 负责使用

这条链决定了删减字段时必须明确“是前端冗余、后端冗余，还是 prompt 冗余”。

#### 调用链 3：`primaryElement`

需要确认：

- 它是不是一份必要的独立信息
- 还是 `elements[]` 中最后一个元素的重复表达

追踪结果：

- 它的语义是“多选中的焦点元素”
- 但数据内容与 `elements[]` 中带 `isPrimary: true` 的元素高度重复
- 如果 prompt 中已经按元素列表完整展开，单独再写 `Primary element` 段通常是重复的

#### 调用链 4：`selectionContext`

需要确认：

- 哪些字段真的被 prompt 消费
- 哪些字段只是调试时好看，但对 AI 修改帮助不大

追踪结果：

- `selectionPattern` 是最核心的信息
- `count` 在 prompt 头部通常已有
- `orderedBy` 是常量语义
- `commonBreadcrumb` / `commonAncestorSelector` 在精确定位时价值有限

因此，过程研读直接支撑了后续“精简 prompt 但不破坏调用链”的修改原则。

## 本阶段重点阅读文件清单

### 前端 Overlay

- `overlay/overlay.ts`
- `overlay/source.ts`
- `overlay/state.ts`
- `overlay/elements.ts`
- `overlay/styles.ts`
- `overlay/animate.ts`
- `overlay/history.ts`
- `overlay/git.ts`
- `overlay/constants.ts`

### 服务端与编辑流程

- `src/cli.ts`
- `src/server/proxy.ts`
- `src/server/ws-handler.ts`
- `src/server/edit-queue.ts`
- `src/server/version.ts`
- `src/editor/source-mapper.ts`

### Agent 系统

- `src/agents/base.ts`
- `src/agents/index.ts`
- `src/agents/prompt.ts`
- `src/agents/claude.ts`
- `src/agents/codex.ts`
- `src/agents/pi-mono.ts`
- `src/agents/local/config.ts`
- `src/agents/local/runtime.ts`
- `src/agents/local/tools.ts`

## 研读输出的中间产物

在源码研读过程中，最终沉淀出的不是单一结论，而是几类中间认知。

### 1. 模块分层

系统可以稳定拆成 4 层：

1. 浏览器采集层：`overlay/*`
2. 接入与编排层：`proxy.ts` / `ws-handler.ts`
3. 编辑执行层：`cli.ts` / `edit-queue.ts` / `source-mapper.ts`
4. AI 能力层：`agents/*`

### 2. 核心数据流

```text
DOM element
-> Element payload
-> PendingEditRequest
-> Prompt string
-> Agent execution
-> File changes
-> Git commit
-> Edit result
```

### 3. 核心状态点

必须重点记住的状态不是很多，但都关键：

- 浏览器端 `app`
- 后端 `editQueue.lastResult`
- Git 预览态 `originalBranch`
- Local Agent 的 `messages` / `todo` / `iterations`

### 4. 几个容易误判的点

源码研读阶段特别容易误判的地方有：

- 误以为前端和后端各自独立，其实二者通过 WebSocket 和共享数据结构强耦合
- 误以为 `editQueue` 是标准消息队列，其实更像 Promise 通道
- 误以为 `primaryElement` 是独立必要对象，实际上常常是列表焦点的重复表达
- 误以为源码定位只靠前端，实际上服务端增强非常关键
- 误以为 Git 版本功能只是附加能力，实际上它是 AI 编辑安全闭环的一部分

## 研读阶段的验证方式

为了避免“看懂了但理解不准确”，研读阶段需要结合验证。

### 1. 类型与调用关系验证

通过追踪类型和函数调用位置，确认：

- 字段是否真的被消费
- 模板是否真的依赖这些字段
- 改动公共模块时是否需要改调用方

### 2. 行为链路验证

把多个文件串起来验证是否闭环：

```text
overlay.ts sendEdit()
-> ws-handler.ts handleEditRequest()
-> source-mapper.ts resolveSource()
-> edit-queue.ts push()
-> cli.ts editLoop
-> prompt.ts buildPrompt()
-> agent.applyEdit()
-> editQueue.notifyComplete()
-> overlay.ts onEditResult()
```

### 3. 编译验证

在做过结构性修改后，需要通过 TypeScript 编译来验证：

- 是否引入未使用变量
- 是否破坏类型定义
- 是否遗漏调用方

## 研读阶段对后续文档写作的帮助

没有这一轮过程性研读，最终架构文档只能停留在“目录说明”层面；完成这轮研读后，才可以把文档写成以下几个维度：

1. **系统总览**：明确单进程架构、模块边界、构建形态
2. **前端采集**：讲清注入、状态、选择、多选、源码定位
3. **后端处理**：讲清代理、WS 路由、源码增强、编辑队列
4. **Agent 系统**：讲清接口、prompt、4 种 Agent、Local runtime
5. **完整数据流**：讲清端到端生命周期和 fallback 路径

也就是说，这份过程文档是后续所有架构文档的“上游说明”。

## 建议的后续使用方式

后续如果继续补架构文档或继续做 prompt / selection 相关优化，建议遵循同样的方法：

1. 先确认入口文件
2. 再确认共享类型
3. 再追踪调用链
4. 最后再改 prompt 或精简字段

对于 `layrr-view` 这类跨浏览器、服务端、AI Agent、Git 的多层系统，只有先把“过程认知”写下来，后续修改才能保持精准。
