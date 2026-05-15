# 04 - AI Agent 系统

## 概述

`layrr-view` 的 AI Agent 系统负责把一次可视化编辑请求转成真正的源码修改。它位于整个系统链路的最后半段：

```text
前端选择元素
-> 后端整理请求
-> buildPrompt()
-> Agent.applyEdit()
-> 模型或 CLI 执行修改
-> 文件发生变化
-> Git 自动提交
```

这个系统并不是单一模型调用封装，而是一层统一抽象之上挂载了多种执行后端：

- Claude Code CLI
- Codex CLI
- Pi Mono SDK
- Local Anthropic SDK Runtime

这种设计让 `layrr-view` 可以把“上游的元素上下文与编辑请求”稳定输出成统一的 Prompt，同时允许底层编辑执行器按环境切换。

## 模块结构

```text
src/agents/
├── base.ts               # Agent 接口与通用进程调用工具
├── index.ts              # Agent 注册表、创建与校验逻辑
├── prompt.ts             # Prompt 构建器
├── claude.ts             # Claude Code CLI Agent
├── codex.ts              # Codex CLI Agent
├── pi-mono.ts            # Pi Mono SDK Agent
└── local/
    ├── config.ts         # Local Agent 配置
    ├── runtime.ts        # Local Agent agentic loop
    └── tools.ts          # Local Agent 内置工具系统
```

## 统一抽象层：`base.ts`

Agent 系统的统一抽象非常薄，它故意不把所有实现强行拉平，只保留真正必要的公共接口。

## `Agent` 接口

核心接口可以概括为：

```typescript
interface Agent {
  readonly name: AgentName
  readonly displayName: string
  applyEdit(request: PendingEditRequest): Promise<{ success: boolean; message: string }>
}
```

### 这个接口的含义

它把所有 Agent 的共性压缩成三件事：

1. 有名字
2. 有展示名
3. 能处理一个 `PendingEditRequest`

这样做的好处是：

- 上游 `cli.ts` 不需要关心底层 Agent 的执行方式
- 各 Agent 可以自由使用 CLI、SDK、工具循环等不同实现
- Prompt 构建与 Agent 执行被清晰解耦

## `AgentName`

支持的 Agent 包括：

- `claude`
- `codex`
- `pi-mono`
- `local`

其中 `PUBLIC_AGENTS` 只公开了部分 Agent 给常规 CLI 选择，这说明系统层面允许“可注册但不默认公开”的实现存在。

## 通用辅助能力

`base.ts` 还提供两个核心工具：

### `checkBinary()`

用于检查某个 CLI 是否存在、能否执行、是否已认证。

它通常用于：

- `codex --version`
- Claude CLI 自检

它的返回不是简单布尔值，而是带错误语义的结果，例如：

- 可用
- 未找到
- 未认证

### `spawnAgent()`

用于统一执行子进程类 Agent。

这个封装处理了：

- 工作目录设置
- stdout / stderr 收集
- 超时
- exit code 判定

但不是所有 Agent 都复用它，例如 Claude 会自己控制更细的 CLI 调用参数。

## 注册表与工厂：`index.ts`

`index.ts` 的作用是把不同 Agent 实现组织成一个统一入口。

## 注册表内容

每个 Agent 在注册表中通常包含：

- `create`
- `check`
- `installHint`
- `authHint`

这意味着系统不仅知道“如何创建 Agent”，还知道：

- 如何判断它能不能工作
- 如果不能工作，该提示用户安装什么
- 如果没认证，该提示用户做什么

## 对外能力

`index.ts` 对外提供几类关键函数：

### `createAgent(name, options)`

返回具体 Agent 实例。

### `checkAgent(name)`

启动前执行健康检查。

### `getAgentDisplayName(name)`

用于 CLI 或界面展示友好名字。

### `getInstallHint(name)` / `getAuthHint(name)`

用于在 Agent 不可用时给用户更明确的指引。

### `isValidAgent(name)`

用于参数解析阶段做合法性校验。

## 为什么要有注册表

如果没有这一层，`cli.ts` 就得手写大量分支：

```text
if claude ...
else if codex ...
else if local ...
```

有了注册表之后，`cli.ts` 只依赖抽象，不需要知道各 Agent 的内部差异。

## Prompt 构建器：`prompt.ts`

`prompt.ts` 是整个 AI Agent 系统里最关键的文件之一。因为它决定了前端和后端采集来的数据，最终以什么方式进入 AI 的上下文。

## 输入：`PendingEditRequest`

Prompt 的原始输入不是一段自由文本，而是结构化请求对象。这个对象来自前端与后端共同构造，可能包含：

- 用户自然语言指令
- 单选元素信息
- 多选元素列表
- 选择上下文
- 源码定位结果
- 匹配质量
- 源码上下文片段

## 输出：Prompt 字符串

最终输出是一段完整、可直接提交给 Agent 的文本。它不是简单拼接，而是一种“结构化编辑说明书”。

## Prompt 的两个主要分支

### 单选模式

适用于用户选择一个元素的情况。

它通常包含以下部分：

1. 背景说明
2. 选中元素信息
3. 源码位置与上下文
4. 用户指令
5. 编辑规则

### 多选模式

适用于用户选择多个元素，希望“一次改一组”。

它通常包含以下部分：

1. 背景说明
2. 选择上下文
3. 可能的实现范围
4. 每个元素的详细信息
5. 用户指令
6. 多元素编辑规则

## 单选 Prompt 结构

单选 Prompt 要解决的是：让 AI 明确知道“这个页面上的哪个元素对应到代码里的什么位置”。

### 关键内容

#### 1. 选中元素摘要

包括：

- Tag
- Class
- Text
- Selector

这是最基本的识别信息。

#### 2. Source location

如果后端定位成功，会继续给出：

- 文件路径
- 行号
- 匹配质量
- 来源策略
- 上下文代码片段

#### 3. 风险提醒

如果当前上下文看起来像签名区域，而不是渲染区域，Prompt 会主动提醒：

- 不要直接在签名处修改
- 先继续阅读找到真正渲染目标的代码

如果文本不在当前上下文中，也会提示 AI 继续搜索，而不是盲改。

#### 4. 编辑规则

单选规则强调：

- 优先从已定位文件开始
- 必要时继续 grep / 搜索
- 确认命中真正渲染实现后再改
- 保持变更最小
- 不做无关重构

## 多选 Prompt 结构

多选 Prompt 比单选复杂很多，因为它面对的是“一组元素”和“一个共同修改意图”。

### 多选 Prompt 的核心目标

帮助 AI 先判断一个问题：

```text
这些元素是同一份共享实现的多个实例
还是多个独立实现，只是用户想同时修改它们？
```

### 关键内容

#### 1. Selection context

告诉 AI 这些元素之间的关系，比如：

- same-container
- same-tag
- mixed

这会直接影响 AI 对实现位置的猜测。

#### 2. Likely implementation scope

根据多个元素涉及到的源码文件做汇总，告诉 AI “最可能改动发生在哪些文件”。

如果多个元素都指向同一文件，AI 更应该优先检查共享实现。

#### 3. Selected elements 列表

每个元素会带：

- 选择顺序
- 是否是焦点元素
- Tag
- Text
- Accessible label
- 可能还有 Class、Breadcrumb、Selector、Visual position
- Source location
- Code context

#### 4. 多元素编辑规则

这里的规则通常比单选更多，主要约束 AI：

- 不要默认复制粘贴改多个地方
- 先判断是否存在共享组件或共享模板
- 如果多个元素来自同一文件，优先寻找可复用实现
- 如果来自不同文件，再逐个处理
- 保留元素间已有差异
- 只做最小修改

## `sourceMatchQuality` 如何影响 Prompt

Prompt 构造不是静态模板，它会根据源码定位质量调整信息密度。

### `precise`

如果定位质量很高，Prompt 会更偏向：

- 直接给文件和上下文
- 减少无关辅助字段
- 强调从该文件开始检查

### `fallback`

如果定位不是完全精确，Prompt 会保留更多辅助信息，例如：

- breadcrumb
- selector
- visual position
- className

这样 AI 就算发现给出的源码位置有偏差，也还有额外线索可继续查找。

### `server search`

这是最弱的定位质量，Prompt 更倾向告诉 AI：

- 当前文件只是候选
- 需要主动进一步读取和搜索

## `contextLooksLikeSignature()`

这个辅助判断的价值很高。它不是定位逻辑，而是“提示逻辑”。它会识别当前代码上下文是否更像：

- import 区域
- interface/type 定义
- props 声明
- 组件签名

如果是，Prompt 会显式提醒 AI：这里可能不是最终渲染点。

这能显著降低 AI 在组件定义区盲改的风险。

## Claude Agent：`claude.ts`

Claude Agent 通过本地 Claude Code CLI 执行编辑。

## 执行方式

它会：

1. 调用 `buildPrompt(request)`
2. 组装 Claude CLI 参数
3. 在项目根目录中启动子进程
4. 等待 CLI 返回结果

### 特点

- 依赖本地安装的 Claude Code 能力
- 使用特定参数开启无交互的 print 模式
- 会为当前 Agent 维护一个 session id
- 自己控制 CLI 调用细节，而不是完全复用 `spawnAgent()`

## 健康检查

Claude Agent 的检查不只是“命令存在”，还会从 stderr 中识别认证失败语义。

这使系统能区分：

- CLI 没装
- CLI 已装但未登录
- CLI 可正常用

## Codex Agent：`codex.ts`

Codex Agent 是最薄的一层封装。

## 执行方式

它会：

1. 调用 `buildPrompt(request)`
2. 使用 `spawnAgent()` 执行 `codex exec --full-auto <prompt>`

### 特点

- 逻辑最简单
- 复用了 `base.ts` 的通用子进程封装
- 强依赖本地 `codex` CLI 的存在和认证状态

这种实现说明 Codex 在当前架构里更像“标准 CLI 适配器”。

## Pi Mono Agent：`pi-mono.ts`

Pi Mono Agent 与前两个最大的不同在于：它不是靠启动外部 CLI 子进程，而是通过 SDK 在进程内直接跑一套 agent session。

## 执行方式

它会动态导入：

- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-ai`

然后：

1. 获取模型
2. 创建 agent session
3. 注入 coding tools
4. 以 print mode 执行 prompt

### 特点

- 不是单次 CLI 命令调用
- 更像嵌入式 agent runtime
- 运行时依赖 OpenRouter / 本地认证信息

## Local Agent：本地 Agent Runtime

`local/` 目录是整个 AI 系统里最复杂的一部分。它不是某家 CLI 的包装器，而是一套自建的本地智能体执行框架。

## 为什么单独实现 Local Agent

这样做的好处是：

- 可以完全控制 system prompt
- 可以精确限制工具集
- 可以控制上下文压缩策略
- 可以定义 todo 与计划提醒机制
- 不依赖外部 CLI 的交互行为

换句话说，Local Agent 是 `layrr-view` 自己掌控最强的一套执行方式。

## `config.ts`：运行时配置

Local Agent 配置包括：

- API Key
- 模型 ID
- Base URL

还定义了一系列运行阈值，例如：

- token 压缩阈值
- 输出持久化阈值
- 最大迭代次数
- 最大输出 token
- 重试次数

这些阈值共同决定了 Local Runtime 的可控性。

## `runtime.ts`：Agentic Loop

这是 Local Agent 的核心。

## 基本循环

可以简化成：

```text
messages = [user prompt]
while not finished
-> 检查 iterations 是否超限
-> 对历史消息做 microCompact
-> 如上下文过大则 autoCompact
-> 调用模型
-> 若返回普通文本，结束
-> 若返回 tool_use，执行工具
-> 把工具结果塞回消息
-> 继续下一轮
```

### 为什么这是“Agentic Loop”

因为模型不是一次性返回最终答案，而是可以：

- 先读文件
- 再搜索
- 再编辑
- 再读回确认
- 最后给出总结

这已经不是简单的 completion，而是具备工具推理能力的多轮执行代理。

## 运行时的重要机制

### 1. 迭代限制

为避免无限循环，Runtime 限制了最大迭代次数，例如 `MAX_ITERATIONS = 50`。

### 2. `microCompact()`

对旧的工具结果做轻量压缩，减少重复长输出占用上下文。

它的设计目标不是丢掉所有历史，而是保留：

- 最近几次重要工具结果
- `read_file` 这类高价值输出

### 3. `autoCompact()`

当消息过多时，会：

- 把完整 transcript 持久化
- 请求模型生成结构化摘要
- 用摘要替换大段旧上下文
- 保留最近几条消息继续执行

这让长任务不会因为上下文爆炸而无法继续。

### 4. `callWithRetry()`

对模型调用做重试，处理：

- 限流
- 5xx
- 网络超时
- 连接重置

这是运行稳定性的重要保障。

### 5. Todo 提醒

Runtime 会追踪 Agent 是否持续更新计划。如果多轮都没有更新 todo，会插入 reminder，提醒模型维护计划。

这保证长链路任务不会越来越失控。

## `tools.ts`：Local 工具系统

Local Agent 能工作的关键不是模型本身，而是工具。

## 工具列表

当前内置 8 类工具：

1. `bash`
2. `read_file`
3. `write_file`
4. `edit_file`
5. `grep`
6. `find`
7. `ls`
8. `todo`

## 各工具职责

### `bash`

用于执行 shell 命令，适合：

- 运行测试
- 查看 Git 状态
- 调用项目已有脚本

同时内置危险命令拦截。

### `read_file`

按文件路径读取文本内容，是最基础也是最安全的上下文获取工具。

### `write_file`

用于新建或覆盖文件。

### `edit_file`

用于精确文本替换。它要求：

- `old_text` 唯一匹配
- 多编辑不重叠

这让编辑更可控，也更适合自动化。

### `grep`

按内容搜索，用于跨文件定位实现。

### `find`

按路径名或模式查找文件。

### `ls`

查看目录结构。

### `todo`

维护任务计划，是运行时自我管理的重要部分。

## 工具系统的额外能力

### 路径安全

所有文件操作都限制在工作区内，防止工具越界访问无关路径。

### 文件修改串行化

对同一文件的写入和编辑通过 mutation queue 串行执行，避免竞态。

### 超长输出持久化

如果命令或搜索结果过长，不会直接把全部内容塞回上下文，而是：

- 存盘到 `.task_outputs/tool-results/`
- 只把预览与引用路径回传给模型

这极大降低了上下文污染。

## 4 种 Agent 的对比

下面从架构角度对比 4 种 Agent。

| Agent | 执行方式 | 依赖形态 | 优点 | 代价 |
|------|------|------|------|------|
| Claude | 本地 CLI 子进程 | Claude Code CLI | 集成简单，能力成熟 | 依赖本地 CLI 安装与认证 |
| Codex | 本地 CLI 子进程 | Codex CLI | 封装最薄，调用直接 | 对 CLI 行为控制较少 |
| Pi Mono | 进程内 SDK | Pi Agent SDK + OpenRouter | 更接近嵌入式 agent | 依赖额外 SDK 和配置 |
| Local | 自建 runtime | Anthropic SDK + 本地工具 | 可控性最强，工具最完整 | 实现最复杂，维护成本最高 |

## Agent 选择流程

在系统运行时，Agent 选择流程可以概括为：

```text
用户指定或配置 Agent
-> index.ts 校验名称
-> checkAgent()
-> 若失败给出 install/auth hint
-> createAgent()
-> cli.ts 在 editLoop 中调用 applyEdit()
```

这个流程把“配置”、“可用性检查”和“真正执行”分离开了。

## Agent 系统在整体架构中的位置

从全链路角度看，Agent 层接收的是“已经结构化、已经做过源码增强的请求”，输出的是“实际文件修改结果”。

```text
PendingEditRequest
-> buildPrompt()
-> Agent.applyEdit()
-> 模型 / CLI / Runtime
-> 文件变化
```

这意味着 Agent 层不承担：

- 页面元素采集
- DOM 到源码的初步映射
- Git 自动提交

它只专注于：在已知上下文下做代码修改。

## AI Agent 系统总结

`layrr-view` 的 AI Agent 系统本质上是“一层统一请求模型 + 多种底层执行器”的设计。

它的关键价值在于：

1. 用统一 Prompt 把 UI 选择行为翻译成代码编辑任务
2. 通过薄抽象兼容不同供应商与不同执行方式
3. 用 Local Runtime 提供一套可控性极高的自有代理框架

从工程角度看，这一层决定了 `layrr-view` 不是“一个只会调某个固定模型的工具”，而是一个可扩展、可替换、可演进的 AI 编辑执行平台。
