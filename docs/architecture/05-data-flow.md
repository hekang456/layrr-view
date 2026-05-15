# 05 - 完整数据流与流程图

## 概述

这一篇不再按模块拆解，而是从“数据如何流动”和“一个请求如何走完生命周期”的角度，串起整个 `layrr-view`。

前面的几份文档解决的是：

- 每个模块做什么
- 每个文件怎么分工
- Agent 和后端分别如何实现

这一篇解决的是：

- 一个会话从启动到结束经历了什么
- 一次编辑请求在系统里如何流动
- 一次版本预览、回滚、恢复如何流动
- 失败时有哪些 fallback 和兜底路径

## 全局总图

```text
┌──────────────────────────────────────────────────────────────────────┐
│                             用户浏览器                               │
│                                                                      │
│  用户页面（React/Vue/...）                                           │
│      │                                                               │
│      ├── 被 layrr 代理返回的 HTML 注入 overlay.js                     │
│      │                                                               │
│      └── Overlay                                                     │
│          ├── 选择元素                                                │
│          ├── 采集 sourceInfo / selector / text / rect               │
│          ├── 输入自然语言指令                                        │
│          └── 通过 WS 发请求                                          │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          layrr-view Node 进程                          │
│                                                                      │
│  proxy.ts                                                            │
│   ├── 反向代理 dev server                                            │
│   ├── 注入 overlay.js                                                │
│   ├── 处理 /__layrr__/ws                                              │
│   └── 提供 /__layrr__/history / /__layrr__/edit-status                 │
│                                                                      │
│  ws-handler.ts                                                       │
│   ├── 接收 edit-request                                              │
│   ├── 调用 source-mapper.ts                                          │
│   ├── 组装 PendingEditRequest                                        │
│   └── push 到 editQueue                                              │
│                                                                      │
│  edit-queue.ts                                                       │
│   └── 唤醒 cli.ts 的 editLoop                                        │
│                                                                      │
│  cli.ts                                                              │
│   ├── buildPrompt()                                                  │
│   ├── 调用 Agent.applyEdit()                                         │
│   ├── 检测文件变化                                                   │
│   ├── 自动 git commit                                                │
│   └── notifyComplete()                                               │
│                                                                      │
│  version.ts                                                          │
│   └── preview / restore / revert / commit                            │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                           用户项目源码与 Git                         │
│                                                                      │
│  src/...  components/...  pages/...                                  │
│   ├── 被 Agent 修改                                                  │
│   ├── 被 git add / commit                                            │
│   └── 可被 preview / restore / revert                                │
└──────────────────────────────────────────────────────────────────────┘
```

## 启动流程

从用户执行 CLI 开始，系统会完成一整轮启动准备。

## 启动时序图

```text
用户
-> 执行 layrr-view --port <targetPort>

cli.ts
-> 解析参数
-> 选择 Agent
-> checkAgent()
-> 检查 / 初始化 Git 仓库
-> startProxy(targetPort, proxyPort, projectRoot)
-> 可选：自动打开浏览器
-> 进入 editLoop()

proxy.ts
-> 启动 HTTP server
-> 准备 WS upgrade 逻辑
-> 准备静态资源和 REST 路由

浏览器访问代理地址
-> proxy.ts 请求 targetPort
-> 获取 HTML
-> 注入 overlay.js
-> 返回给浏览器

overlay.ts
-> 初始化 Overlay
-> 连接 /__layrr__/ws
-> 发送 overlay-ready
```

## 启动阶段的关键状态

### 1. 项目根目录

由 CLI 启动时确定，后续所有：

- Agent 执行
- 文件搜索
- Git 命令
- 路径安全检查

都依赖这个根目录。

### 2. 目标 dev server 端口

决定代理要转发到哪里。

### 3. 代理端口

决定浏览器访问哪个入口，也决定 Overlay 连接哪个 WS 端口。

### 4. 当前 Agent

决定后续编辑请求由哪个执行器处理。

## 编辑请求生命周期

这是系统最核心的一条链路。

## 高层流程图

```text
用户选择元素
-> 输入自然语言指令
-> Overlay 构造 edit-request
-> 后端增强源码位置
-> editQueue 投递请求
-> CLI editLoop 执行 Agent
-> 文件被修改
-> Git 自动提交
-> 前端收到结果
```

## 详细时序图

```text
用户
-> 在页面上点击一个或多个元素

Overlay
-> 收集元素信息
-> 提取 sourceInfo
-> 用户输入 instruction
-> ws.send(edit-request)

proxy.ts
-> 将 /__layrr__/ws 消息交给 ws-handler.ts

ws-handler.ts
-> 解析 edit-request
-> 对单选或多选分别处理
-> 调用 source-mapper.ts resolveSource()
-> 构造 PendingEditRequest
-> editQueue.push(request)

edit-queue.ts
-> resolve waitForNext() 挂起的 Promise

cli.ts editLoop
-> 拿到 request
-> buildPrompt(request)
-> agent.applyEdit(request)

Agent
-> 读取源码
-> 搜索 / 编辑 / 写文件
-> 返回 success / message

cli.ts
-> 比较编辑前后文件集合
-> git add
-> git commit "[layrr] ..."
-> editQueue.notifyComplete()

edit-queue.ts
-> 保存 lastResult
-> 通过 wsNotifier 发给当前浏览器

Overlay
-> 收到 edit-result
-> 停止轮询
-> toast 结果
-> 清理选择状态
```

## 编辑请求的数据形态变化

一次编辑请求在系统中并不是同一种结构，它会不断被增强。

### 阶段 1：浏览器 DOM 上下文

用户刚点击元素时，浏览器手里只有 DOM 视角信息：

- `tagName`
- `className`
- `textContent`
- `selector`
- `breadcrumb`
- `rect`

这时它还不是一个代码编辑请求，只是“页面元素描述”。

### 阶段 2：前端 `edit-request`

当用户输入自然语言指令后，Overlay 会把 DOM 信息包装成 WebSocket 消息：

```text
Element payload
+ instruction
+ sourceInfo
+ selectionContext
```

这时它已经从“页面元素”变成“编辑意图 + 上下文”。

### 阶段 3：后端 `PendingEditRequest`

`ws-handler.ts` 会继续增强它，形成真正的内部请求结构：

- 补全 `sourceLocation`
- 标记匹配质量
- 读取代码上下文
- 多选时补全每个元素的 `sourceLocation`

### 阶段 4：Prompt 字符串

`buildPrompt()` 再把结构化数据变成 AI 能消费的自然语言任务描述。

### 阶段 5：文件变化

Agent 执行后，数据不再是“消息对象”，而变成：

- 工作区文件差异
- Git staged changes
- 新的 commit

这也是整个链路的数据终点。

## 单选编辑流

单选是最基础的一条链路。

### 流程

```text
用户点击一个元素
-> Overlay 记录 selectedEl
-> 提取 sourceInfo
-> 输入 instruction
-> 发送 single edit-request
-> ws-handler 调用 resolveSource()
-> 构造单元素 PendingEditRequest
-> editLoop 调用 Agent
-> Agent 修改文件
-> git commit
-> 返回 edit-result
```

### 架构特点

- 路径更短
- 数据结构更简单
- Prompt 更聚焦
- AI 更容易直接命中目标实现

### 风险点

单选看似简单，但仍有两个关键风险：

1. 点到的是组件定义，而不是实际渲染位置
2. 文本是动态拼接值，不直接出现在当前上下文中

因此服务端的上下文增强和 Prompt 提示仍然很重要。

## 多选编辑流

多选是系统里最复杂的一条编辑链路。

## 流程

```text
用户 Shift + Click 多个元素
-> Overlay 维护 selectedEls
-> 最后一个元素成为 selectedEl / primary focus
-> 构造 elements[]
-> 计算 selectionContext
-> 发送 multi edit-request

ws-handler.ts
-> 对每个 element 分别 resolveSource()
-> 为每个元素生成 sourceLocation
-> 构造多元素 PendingEditRequest

cli.ts
-> buildPrompt() 生成多选 Prompt
-> Agent 先判断共享实现还是独立实现
-> 修改共享组件或逐个修改文件
-> git commit
-> 返回 edit-result
```

## 多选链路最关键的判断

AI 在多选模式下首先必须回答：

```text
这些元素是不是同一实现的不同实例？
```

这是多选架构成立的核心。如果没有这个判断，多选就会退化成：

- 简单复制单选逻辑 N 次
- 重复修改多个文件
- 失去共享组件编辑的价值

所以多选的数据结构才会同时传：

- `elements[]`
- `isPrimary`
- `selectionPattern`
- 多个 `sourceLocation`

## 源码定位的端到端流动

源码定位不是某一个模块单独完成，而是跨前后端的协同结果。

## 端到端定位流程

```text
DOM element
-> overlay/source.ts extractSourceInfo()
   -> locatorjs / inspector / element-source / debug fallback
-> sourceInfo
-> ws-handler.ts
-> source-mapper.ts resolveSource()
   -> 路径修正
   -> context 读取
   -> enhanceContext()
   -> fallback search
-> sourceLocation
-> prompt.ts
-> Agent 根据质量决定是否继续搜索
```

## 为什么要两段式定位

### 前端定位的优势

- 离 DOM 最近
- 能直接读浏览器运行时结构
- 能访问调试属性和 Fiber / Vue 实例

### 后端增强的优势

- 能访问整个项目文件系统
- 能跨文件搜索
- 能补充更多代码上下文
- 能统一文件路径

两段结合后，系统既有“点到即得”的优势，也有“落到源码后继续纠偏”的能力。

## 编辑结果回传流

编辑完成后的回传也不是单通道。

## 主路径：WebSocket 推送

```text
cli.ts
-> editQueue.notifyComplete()
-> wsNotifier(success, message)
-> activeWs.send(edit-result)
-> Overlay onmessage
```

这是最快的路径，也是用户通常感知到的路径。

## 兜底路径：HTTP 轮询

```text
Overlay startPolling()
-> 每 2 秒请求 /__layrr__/edit-status
-> 读取 editQueue.lastResult
-> 若发现新结果则停止轮询并处理
```

## 为什么要双通道

因为编辑成功后经常伴随以下副作用：

- 文件变化触发 HMR
- Git 操作导致页面刷新
- WebSocket 临时断开

如果只依赖 WS，用户可能在“编辑已经成功”时仍然看不到结果。轮询解决的是这个可靠性问题。

## Git 版本管理流

除了编辑请求，另一条重要数据流是版本管理流。

## 历史查询

```text
Overlay history.ts
-> GET /__layrr__/history
-> proxy.ts 读取 git log
-> 返回 commits[]
-> 前端渲染历史列表
```

## 预览某个版本

```text
用户点击历史提交
-> ws.send(version-preview)
-> version.ts preview()
-> 记录 originalBranch
-> 先发 version-preview-result
-> git checkout <hash> --detach
-> dev server reload
-> 前端刷新后用 previewingHash 恢复预览态
```

## 恢复最新版本

```text
用户点击 restore
-> ws.send(version-restore)
-> version.ts restore()
-> 先发结果
-> git checkout <originalBranch>
-> 清空 preview 状态
```

## 永久回滚

```text
用户点击 revert 并确认
-> ws.send(version-revert)
-> version.ts revert()
-> 切回分支
-> 先发结果
-> git reset --hard <hash>
-> 清空 originalBranch
```

## 推送远程

```text
用户点击 Commit
-> ws.send(commit-request)
-> version.ts commit()
-> git push -u origin HEAD
-> 返回 commit-result
```

## 启动到编辑完成的完整大时序

下面把从启动到一轮编辑结束串成一个大图。

```text
用户启动 layrr-view
-> cli.ts 初始化 Git / Agent / proxy
-> 浏览器打开代理地址
-> proxy.ts 转发 HTML 并注入 overlay.js
-> Overlay 初始化并连接 WS
-> 用户进入 Edit 模式
-> hover 并选中元素
-> 输入自然语言指令
-> 发送 edit-request
-> ws-handler.ts 做源码增强
-> editQueue 唤醒 editLoop
-> buildPrompt()
-> Agent 执行修改
-> 文件变化
-> git commit
-> notifyComplete()
-> 前端收到结果并反馈
```

## 失败场景与 fallback 链

系统的健壮性主要来自多层 fallback，而不是依赖单点成功。

## 1. 前端定位失败

```text
overlay/source.ts 返回 null
-> 后端 source-mapper.ts 执行全局搜索
```

## 2. WebSocket 结果丢失

```text
未收到 edit-result
-> 前端继续轮询 /__layrr__/edit-status
```

## 3. 当前上下文落在签名区域

```text
source-mapper / prompt.ts 识别出签名区域
-> Prompt 显式要求继续读取渲染实现
```

## 4. Git checkout 导致页面刷新

```text
version.ts 先发结果
-> 再执行 checkout/reset
-> 前端刷新后恢复状态
```

## 5. 工作区已有未提交改动

```text
cli.ts 编辑前做脏文件快照
-> 编辑后比较差异
-> 尽量只提交本轮新增改动
```

## 关键状态在链路中的流动

除了请求对象，还有几个长期状态在系统中穿行。

## 浏览器端状态

- `app.mode`
- `app.selectedEl`
- `app.selectedEls`
- `app.previewingHash`
- `app.connected`

## 后端状态

- `editQueue.waitingResolver`
- `editQueue.lastResult`
- `version.originalBranch`

## AI 运行时状态

- Prompt 文本
- Local Runtime 的 `messages`
- Local Runtime 的 `todo`
- 当前 Agent 类型

这些状态虽然分散在不同模块，但共同组成一轮会话的上下文。

## 从数据流看系统边界

从纯数据流角度，可以把系统分成 4 层：

### 第 1 层：UI 观察层

浏览器中的 Overlay，负责“观察页面”和“收集用户意图”。

### 第 2 层：编排与增强层

`proxy.ts`、`ws-handler.ts`、`source-mapper.ts`，负责把原始页面信息变成结构化编辑请求。

### 第 3 层：执行层

`cli.ts` + `editQueue` + Agent，负责实际执行代码编辑。

### 第 4 层：版本安全层

Git 自动提交、历史查询、预览、恢复、回滚。

这四层叠加后，才形成一个完整的“可视 AI 编辑闭环”。

## 总结

`layrr-view` 的完整数据流可以概括成一句话：

```text
把用户在真实页面上的一次点击和一句自然语言，
转成一次可定位、可执行、可回退、可追踪的源码修改。
```

这条链路成立，依赖的是 5 个关键条件：

1. 前端能稳定采集元素和上下文
2. 后端能把上下文增强成高可信源码位置
3. AI Agent 能在受控环境中执行代码修改
4. Git 能为每轮修改提供可回退历史
5. 前端能在刷新、断连、导航后仍恢复结果和状态

因此，`layrr-view` 的价值并不只是“调用 AI 改代码”，而是把这个过程做成了一条完整、可靠、工程化的端到端数据流。
