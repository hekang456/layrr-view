# 02 - 前端 Overlay 采集系统

## 概述

`layrr-view` 的前端部分不是一个独立部署的 Web 应用，而是一段被注入到用户页面中的浏览器脚本。它以 IIFE 形式打包成单文件 `dist/overlay.js`，通过后端代理在 HTML 响应中插入到用户 dev-server 页面里。

Overlay 的职责不是渲染业务页面，而是在“不侵入业务代码”的前提下，为用户页面叠加一层可视化编辑能力：

- 让用户用鼠标选中真实页面上的 DOM 元素
- 采集该元素的结构信息、可视信息、源码信息
- 支持单选、多选、历史版本预览、回滚、提交
- 将编辑请求通过 WebSocket 发给后端
- 接收 AI 编辑结果并反馈给用户

从架构上看，Overlay 是整个系统的数据采集入口，也是用户唯一直接接触的交互层。

## 模块结构

```text
overlay/
├── overlay.ts      # 主入口，负责初始化、模式切换、事件绑定、编辑发送
├── source.ts       # 源码定位引擎，负责从 DOM 反推源码位置
├── state.ts        # 全局状态管理，维护 app 单例和 sessionStorage
├── elements.ts     # 构建 overlay 的 DOM 结构
├── styles.ts       # 注入 CSS 和字体
├── animate.ts      # 封装所有动画效果
├── history.ts      # 历史版本面板逻辑
├── git.ts          # Revert / Commit 前端触发逻辑
└── constants.ts    # 前缀常量和设计 Token
```

这几个文件的关系不是“页面组件树”的关系，而是“运行时协作模块”的关系。`overlay.ts` 是编排中心，其余模块围绕它提供能力。

## 注入机制

Overlay 的加载从服务端 HTML 注入开始，而不是从浏览器主动请求开始。

### 注入位置

后端代理在 HTML 响应的 `</body>` 前插入：

```html
<script>window.__PAIR_WS_PORT__ = ${proxyPort};</script>
<script src="/__layrr__/overlay.js"></script>
```

这两段脚本分别承担两个作用：

1. 告诉浏览器 Overlay 要连接哪个 WebSocket 端口
2. 加载真正的 Overlay 脚本

### 注入后的初始化顺序

```text
HTML 加载完成
-> overlay.js 执行
-> 防重复注入检查
-> 动态 import 所有依赖模块
-> 初始化源码定位 resolver
-> 恢复状态
-> 创建 DOM
-> 建立 WebSocket
-> 绑定全局事件
-> 等待用户操作
```

### 防重复注入

因为 dev-server、SPA 路由切换、页面局部刷新都可能导致脚本再次进入执行流程，所以 `overlay.ts` 启动时会先检查一个全局标记，防止重复挂载多个 Overlay 实例。

这个机制解决了两个问题：

- 避免重复创建工具栏、面板、遮罩、高亮框
- 避免多条 WebSocket 连接同时存在

## 初始化流程

Overlay 启动并不是单个 `init()` 函数，而是一套串联流程。

```text
IIFE 启动
│
├── 1. 解析 PATH_PREFIX
│      用于兼容预览路径，如 /preview/{slug}/...
│
├── 2. initSourceMapping()
│      初始化 element-source resolver
│
├── 3. loadState()
│      从 sessionStorage 恢复上次状态
│
├── 4. initState(saved)
│      初始化全局 app 单例
│
├── 5. ensureStyles()
│      注入 CSS 和字体
│
├── 6. createElements()
│      创建 root / dim / hl / label / toasts / bar / panel / history
│
├── 7. connectWs()
│      建立到 /__layrr__/ws 的 WebSocket 连接
│
├── 8. fetch edit-status
│      检查是否有上一轮已完成但前端未收到的编辑结果
│
├── 9. 绑定工具栏和输入框事件
│
├── 10. fetchAndRenderHistory()
│       渲染 Git 历史
│
└── 11. setupGlobalListeners()
       绑定 mousemove / click / keydown / mouseup
```

这条链路的特点是：先准备运行环境，再挂接 UI，再连接服务端，最后才开始接受用户交互。

## DOM 结构

Overlay 不使用 Shadow DOM，而是直接插入到宿主页面中。因此它必须通过统一命名空间避免样式冲突。

### 根结构

```text
.__layrr-root
├── #__layrr-dim
├── #__layrr-hl
├── #__layrr-label
├── #__layrr-toasts
└── #__layrr-bar
    ├── .__layrr-panel
    ├── #__layrr-history
    └── .__layrr-toolbar
```

### 各节点职责

#### `#__layrr-dim`

编辑模式下的全屏半透明遮罩，用于告诉用户当前处于可编辑状态，同时弱化页面背景。

#### `#__layrr-hl`

高亮框，用于标出当前 hover 或选中的元素。它跟随 `getBoundingClientRect()` 结果定位，不直接依赖 DOM 层级。

#### `#__layrr-label`

元素标签提示，显示类似 `<button.primary>` 这样的结构标签，帮助用户确认当前 hover 到的元素。

#### `#__layrr-toasts`

右上角通知容器，用于显示：

- 编辑成功
- 编辑失败
- 版本预览成功
- 版本恢复成功
- 无法回滚
- 连接状态异常

#### `#__layrr-bar`

主工具栏容器，可拖拽，是整个 Overlay 的交互枢纽。展开时包含面板，折叠时只显示一排按钮。

### 面板结构

```text
.__layrr-panel
├── .__layrr-ph   # Header: 标题、拖拽区、关闭按钮
├── .__layrr-ei   # Element Info: 选中元素信息区
├── .__layrr-ia   # Instruction Area: textarea + send button
└── .__layrr-hn   # Hint: 快捷键提示
```

### 历史面板结构

```text
#__layrr-history
├── .__layrr-hh
└── .__layrr-he-*
```

它与编辑面板共存于工具栏容器内，通过内容切换动画进行切换，而不是打开新窗口。

## 状态管理

Overlay 使用一个全局 `app` 单例来保存运行时状态。它不是响应式状态库，而是轻量的可变状态对象。

### `app` 中的核心状态

```typescript
app = {
  mode,
  hoveredEl,
  selectedEl,
  selectedEls,
  multiHighlights,
  selectedSourceInfo,
  sourceInfoLoading,
  ws,
  connected,
  editCount,
  lastEdit,
  historyPage,
  previewingHash,
  hlEl,
  labelEl,
  panelEl,
  barEl,
  dimEl,
  inputEl,
  sendBtnEl,
  pollTimer,
  spinnerTimeout,
}
```

### 为什么使用单例状态

这里不使用 React/Vue 状态系统，是因为 Overlay 本身不是一个组件化前端应用，而是一个在任意页面环境里执行的轻量脚本。单例状态有几个好处：

- 初始化成本低
- 不依赖宿主页面框架
- 容易与原生 DOM 事件直接配合
- 更适合 IIFE 注入场景

### 持久化内容

Overlay 会把部分状态写入 `sessionStorage`：

- 当前模式
- 已完成编辑次数
- 上次编辑时间
- 历史面板是否打开
- 工具栏拖拽后的位置
- 当前是否在 preview 某个 Git 版本

这意味着页面刷新或 HMR 重载后，Overlay 能恢复大部分用户态，而不是完全重置。

## 模式系统

Overlay 有两种模式：`browse` 和 `edit`。

### Browse 模式

这是默认状态，特点是：

- 不显示编辑遮罩
- 不显示高亮框
- 不拦截页面点击来选择元素
- 用户像正常访问页面一样与业务页面交互

### Edit 模式

这是采集模式，特点是：

- 光标切换为十字准星
- 显示 dim 遮罩
- hover 时高亮元素
- click 时选择元素
- Shift + click 支持多选
- 面板展开，允许输入编辑指令

### 模式切换入口

用户可以通过两类入口切换模式：

1. 快捷键：`Cmd+K` 或 `Alt+K`
2. 工具栏按钮：`Browse` / `Edit`

### 模式切换时的副作用

切换模式不仅是改一个状态位，还会触发一组 UI 与状态副作用。

#### 切到 `browse`

```text
清空当前 hover
-> 清空 selectedEl / selectedEls
-> 删除多选高亮框
-> 隐藏 dim / hl / label / panel
-> 恢复默认光标
-> 关闭 history
-> 保存状态
```

#### 切到 `edit`

```text
检查当前是否处于 preview 历史版本
-> 若是则阻止进入编辑并提示
-> 显示 dim
-> 展开工具栏和面板
-> 设置十字准星光标
-> 保存状态
```

这里有一个重要限制：如果当前页面正处于历史版本预览态，Overlay 会阻止进入编辑模式，避免用户在 detached HEAD 预览状态下误改代码。

## 元素选择系统

元素选择是 Overlay 的核心交互。它解决的是“用户点击的是页面上的真实元素，而不是某个抽象组件”的问题。

### Hover 过程

在 `edit` 模式下，`mousemove` 会持续运行：

```text
鼠标移动
-> 找到目标元素
-> 跳过 overlay 自身元素
-> 更新 hoveredEl
-> 计算 rect
-> reposition highlight
-> 更新 label 内容和位置
```

这样用户在点击前，就能通过高亮框和标签明确看到“当前将要选择哪个元素”。

### 单选流程

```text
click (无 Shift)
-> 若命中 overlay 自身则忽略
-> selectedEls = [target]
-> selectedEl = target
-> 清空旧多选高亮
-> 固定高亮框到 selectedEl
-> 更新面板
-> 异步刷新源码信息
-> 发送 element-selected 给后端
```

单选适用于“只改一个元素”的场景，例如：

- 把按钮文字改成 “立即购买”
- 调整一个标题颜色
- 修改某个输入框的 placeholder

### 多选流程

```text
Shift + click
-> 若元素已存在于 selectedEls
   -> 从数组移除
-> 否则
   -> push 进入数组
-> selectedEl = selectedEls[last]
-> rebuild 多选高亮框
-> 更新面板中的元素列表
-> 计算 selectionContext
```

### 为什么“最后一个元素”为主元素

多选模式下，`selectedEls` 保存的是整个有序集合，而 `selectedEl` 总是指向最后一个被点到的元素。

这件事的作用不是制造一份额外数据，而是提供一个焦点：

- 让面板在需要单点展示时有默认参照对象
- 让 prompt 构造时可以有“主元素”的视角
- 让用户最后一次点击具备更强的语义权重

它本质上是“焦点元素”，不是“与列表完全无关的新对象”。

### 多选高亮框

多选时不会只保留一个 `#__layrr-hl`，而是为每个已选元素创建一个独立高亮框节点。这样可以同时展示多个被选区域。

架构上这是一个显式的视觉映射：

```text
selectedEls[0] -> mhl-0
selectedEls[1] -> mhl-1
selectedEls[2] -> mhl-2
...
```

每次选区变化后会整体重建高亮框，确保位置与顺序一致。

## 选择上下文

多选不仅传元素列表，还会生成 `selectionContext`。这个对象不是用来定位源码，而是给后续 AI 理解“这些元素之间的关系”。

### 上下文内容

```typescript
selectionContext = {
  count,
  orderedBy: 'selection',
  commonAncestorSelector?,
  commonAncestorTag?,
  commonBreadcrumb?,
  selectionPattern,
}
```

### `selectionPattern` 的三种模式

#### `same-container`

所有元素共享同一个父容器。

这通常意味着它们来自同一段循环渲染、列表结构或局部布局，例如：

- 同一个卡片列表中的多个标题
- 同一个表格中的多个单元格
- 同一个导航栏中的多个链接

#### `same-tag`

元素标签相同，但不一定来自同一父容器。

这通常提示 AI：这些元素可能属于同一类语义节点，但布局位置分散。

#### `mixed`

既不共享父容器，也不共享标签。

这种模式下，AI 更需要逐个理解元素，而不能简单假设它们来自同一实现。

## 源码定位系统

Overlay 前端的核心能力不是“知道用户点了什么 DOM”，而是“尽量在浏览器里就拿到该 DOM 对应的源码位置信息”。

`source.ts` 实现了一条多策略定位链。

### 返回结构

```typescript
type SourceInfo = {
  file: string
  line: number
  column?: number
  strategy?: 'locatorjs' | 'inspector' | 'element-source' | 'react-debug' | 'vue-debug'
  exact?: boolean
}
```

### 6 种定位策略

#### 1. LocatorJS 属性

如果元素或祖先带有 `data-locatorjs`，可以直接解析出 `file:line:column`。

这是最理想路径之一，因为它来自编译期插桩，通常精度很高。

#### 2. LocatorJS ID 索引

如果元素带有 `data-locatorjs-id`，Overlay 会进一步从 `window.__LOCATOR_DATA__` 中查询表达式位置信息。

它适用于 LocatorJS 的另一种注入形式。

#### 3. React Inspector

读取类似 `data-react-inspector` / `data-inspector-line` 一类属性。

这类信息一般由 React 开发态插件或 inspector 能力提供。

#### 4. Vue Inspector

读取 `data-v-inspector`。

它对应 Vue 生态里的开发期定位能力。

#### 5. `element-source`

前四种都失败时，Overlay 会尝试运行时库 `element-source`。

这个库可以针对 Vue、Svelte、Solid、Preact 等框架，在浏览器上下文中做额外解析。

#### 6. React Fiber / Vue Runtime Fallback

如果仍然定位失败，会尝试读取运行时内部结构：

- React: 查找 Fiber 节点中的 `_debugSource`
- Vue: 查找组件实例上的 `__file`

这类信息通常存在于开发模式下。

### 策略执行顺序

```text
extractSourceInfo(el)
-> locatorjs
-> locatorjs-id
-> react inspector
-> vue inspector
-> element-source
-> react debug / vue debug
-> null
```

整体策略是：

- 优先使用显式注入的精确信息
- 其次使用运行时解析
- 最后退化为空，由后端继续兜底

### 辅助信息采集

除了 `sourceInfo`，前端还会采集多种辅助字段：

- `textContent`: 元素文本预览
- `accessibleLabel`: 无障碍标签
- `tagLabel`: 标签语义摘要
- `breadcrumb`: DOM 路径
- `selector`: CSS 选择器
- `rect`: 视觉位置和尺寸

这些字段的价值不同：

- 源码定位失败时，它们是后端 fallback 搜索的重要线索
- 多选模式下，它们帮助 AI 理解每个元素的异同
- UI 面板也依赖其中一部分做即时展示

## WebSocket 通信

Overlay 与后端之间的主通道是 WebSocket，而不是传统表单提交。

### 建立连接

浏览器根据 `window.__PAIR_WS_PORT__` 建立到：

```text
ws://localhost:{proxyPort}/__layrr__/ws
```

连接成功后，前端会发送一条 `overlay-ready` 消息，告诉后端“前端已就绪”。

### 前端发送的消息

#### `overlay-ready`

表示 Overlay 初始化完成并已连接。

#### `element-selected`

单选某个元素后发送，用于通知后端当前焦点元素信息。它不触发 AI 编辑，只是同步当前上下文。

#### `edit-request`

真正的编辑请求。分成两类：

##### 单选模式

```text
selectionMode = 'single'
selector / tagName / className / textContent / instruction / sourceInfo
```

##### 多选模式

```text
selectionMode = 'multi'
顶层兼容字段
+ primaryElement
+ elements[]
+ selectionContext
```

多选请求中既保留顶部兼容字段，也保留完整元素列表，目的是兼容旧的单元素处理思路，同时让后端和 prompt 构造逻辑拥有完整上下文。

#### 版本管理相关

- `version-preview`
- `version-restore`
- `version-revert`
- `commit-request`

这些消息都由工具栏或历史面板触发。

### 前端接收的消息

#### `edit-result`

AI 编辑完成后返回。Overlay 根据 `success` 做两条分支：

- 成功：toast 成功、清理选择状态、结束轮询、必要时刷新
- 失败：toast 错误、结束轮询、保留用户上下文便于重试

#### 版本结果消息

- `version-preview-result`
- `version-restore-result`
- `version-revert-result`
- `commit-result`

这些消息都与 Git 操作结果对应。

## 编辑请求构造

用户在面板输入自然语言后，Overlay 会构造一次编辑请求。

### 发送入口

触发方式有两种：

- 点击发送按钮
- 文本框中按 `Enter`

同时支持 `Shift+Enter` 换行，因此输入区具备简单的文本编辑行为。

### 单选请求构造

```text
读取 selectedEl
-> 提取基础信息
-> 提取 sourceInfo
-> 拼 instruction
-> ws.send(edit-request)
```

### 多选请求构造

```text
读取 selectedEls
-> 对每个元素提取基础字段
-> 对每个元素并行提取 sourceInfo
-> 标记 isPrimary
-> 计算 selectionContext
-> 组装 primaryElement + elements[]
-> ws.send(edit-request)
```

多选构造比单选复杂很多，因为它要同时保留：

- 选择顺序
- 焦点元素
- 每个元素的个体信息
- 元素集合的整体关系

## 结果接收与轮询兜底

编辑请求发出后，Overlay 不只依赖 WebSocket 推送结果，还会启动 HTTP 轮询作为兜底。

### 双通道机制

```text
sendEdit()
-> 启动 WebSocket 等待
-> 同时 startPolling()
   -> 每 2 秒 GET /__layrr__/edit-status
   -> 最长等待 60 秒
```

### 为什么需要轮询

理论上 WebSocket 已足够，但实际场景中：

- Git checkout / dev-server reload 可能导致连接断开
- 浏览器刷新前消息可能丢失
- 页面导航后旧连接已经失效

因此轮询承担了“最终一致性”角色，只要后端把最后一次结果保存在 `editQueue.lastResult` 中，前端就仍然能补拉到结果。

## 动画系统

Overlay 的动画不是装饰性的，而是用来强化状态变化：

- 工具栏展开 / 收起
- 历史面板与编辑面板之间切换
- Toast 入场 / 出场
- 遮罩显隐
- 列表项分批进入
- 确认弹层弹出

### 动画函数的职责分层

#### 容器级动画

- `barExpand`
- `barCollapse`
- `animateHeight`
- `contentSwap`

它们决定的是面板布局和高度变化。

#### 元素级动画

- `btnActivate`
- `btnDeactivate`
- `contentFadeIn`
- `listIn`
- `multiSelectIn`

它们决定的是局部交互反馈。

#### 瞬时反馈动画

- `toastIn`
- `toastOut`
- `confirmIn`
- `confirmOut`
- `dimIn`
- `dimOut`

它们负责消息反馈和状态切换氛围。

### 为什么单独拆 `animate.ts`

因为 Overlay 运行在任意宿主页面里，如果动画逻辑散在各个模块中：

- 很难管理并发动画冲突
- 很难在切换内容时统一处理高度过渡
- 容易在历史面板、编辑面板、多选列表之间出现互相干扰

集中封装后，可以通过记录 active animation 引用，在新动画开始前主动停止旧动画。

## 历史面板与 Git 前端入口

虽然 Git 操作实际由后端执行，但前端承担了交互入口和状态表达。

### 历史列表来源

前端通过请求 `/__layrr__/history` 拿到提交列表，包含：

- `hash`
- `message`
- `timeAgo`
- `isPair`
- `head`

### 历史面板支持的动作

#### 预览

点击历史提交后，发送 `version-preview`。后端会进入 detached HEAD 预览态，前端记录 `previewingHash` 并在刷新后保持该状态。

#### 恢复

从预览态恢复到原始分支，发送 `version-restore`。

#### 回滚

通过确认弹层二次确认后，发送 `version-revert`，对应的是一次真正的 Git 历史重置。

#### 提交

点击 `Commit` 按钮触发 `commit-request`，将当前 HEAD 推送到远程。

### 前端为什么要理解 Git 状态

因为它要基于状态做 UI 限制，例如：

- preview 状态下禁止进入编辑模式
- 当前预览的 hash 需要在列表中高亮
- 恢复后需要清理 sessionStorage 中的 preview 标记

## 与宿主页面的隔离策略

Overlay 并不使用 iframe 或 Shadow DOM，因此它必须在常规 DOM 中完成隔离。

主要策略包括：

### 命名空间隔离

所有节点类名和 ID 都以 `__layrr` 为前缀。

### 样式主动注入

通过 `styles.ts` 注入完整 CSS，而不依赖宿主页面提供任何样式基础。

### 自身元素过滤

通过 `isOwn(el)` 判断当前事件命中的是否为 Overlay 自己的节点，从而避免：

- 鼠标 hover 到工具栏时还被当作业务元素
- 点击按钮时被记录成待编辑元素

### 定位基于 viewport

高亮框和标签依赖 `getBoundingClientRect()`，而不是插入到业务 DOM 层级内部，因此不容易受宿主布局影响。

## SPA 兼容与重新注入

现代前端项目里，页面路由切换经常不会整页重载。对 Overlay 来说，这意味着：

- 原先插入的根节点可能被框架替换掉
- 页面内容已变，但事件绑定和 UI 状态还停留在旧页面

因此 Overlay 做了两类兼容：

### DOM 级监听

使用 `MutationObserver` 监控根节点是否被移除。如果发现 Overlay 自己的根被删除，会尝试重新注入。

### 框架导航事件监听

监听：

- `astro:after-swap`
- `sveltekit:navigation-end`
- `popstate`

这些事件出现时，会延迟检查当前页面状态并必要时重建 Overlay。

## 前端架构总结

Overlay 不是一个普通 UI 面板，而是一个运行在任意开发页面之上的“可视采集代理层”。它的核心价值有三点：

1. 把真实页面 DOM 转成可编辑对象
2. 尽量在浏览器端就拿到精确源码位置
3. 把用户意图、元素上下文、版本操作统一转成后端可消费的消息

它在整个系统中的位置可以概括为：

```text
真实页面上的用户交互
-> Overlay 采集与组织上下文
-> 后端处理与 AI 编辑
```

如果没有这层前端采集系统，后面的 WebSocket、Prompt、Agent 和 Git 自动提交都失去了准确的输入来源。
