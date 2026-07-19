# 目录

[TOC]


# Pi Ai 源码分析

重点看如下几个源码文件就行：
- index.ts
- types.ts
- providers/all.ts
- providers/deepseek.ts，看一个模型的示例即可
- api/openai-completions.ts

可以结合下面两个官方项目文档，了解pi-ai的使用方式和设计思路：
- [pi-ai:README.md](../packages/ai/README.md): 使用方式
- [pi-agent-core:docs/models.md](../packages/agent/docs/models.md): 设计思路

另外，pi-ai的models使用在 v0.80.0 版本经历了一次 Breaking Changes，
参考文档 [pi-ai:CHANGELOG.md](../packages/ai/CHANGELOG.md#v0.80.0-breaking-changes).

------------------------------------------------------------
# Pi Agent Core 源码分析

> 分析版本: v0.80.3 | 包名: `@earendil-works/pi-agent-core`

---

## 一、入口文件及其执行链条

### 1.1 入口文件

| 入口 | 文件 | 用途 |
|------|------|------|
| 主入口 | `src/index.ts` | 重新导出所有公共 API |
| Node.js 入口 | `src/node.ts` | 主入口 + `NodeExecutionEnv`（Node.js 文件系统和 Shell 实现） |

`src/index.ts` 的导出结构：

```
src/index.ts
├── agent.ts          → Agent 类（有状态的高级封装）
├── agent-loop.ts     → 低级 Agent 循环函数（无状态）
├── harness/          → AgentHarness（会话管理、压缩、钩子系统）
│   ├── agent-harness.ts
│   ├── compaction/   → 上下文压缩 & 分支摘要
│   ├── session/      → 会话持久化（JSONL / 内存）
│   ├── messages.ts   → AgentMessage ↔ LLM Message 转换
│   ├── system-prompt.ts → 系统提示词格式化（含 Skills）
│   ├── skills.ts     → Skill 加载
│   ├── prompt-templates.ts → Prompt 模板加载
│   ├── env/nodejs.ts → Node.js ExecutionEnv 实现
│   └── utils/        → shell-output, truncate 工具
├── proxy.ts          → 代理流函数（通过服务器路由 LLM 调用）
└── types.ts          → 所有类型定义
```

### 1.2 执行链条

```
用户调用
  │
  ├─► Agent.prompt(text)                    [agent.ts]
  │     └─► runAgentLoop(messages, ctx, config, emit, signal, streamFn)  [agent-loop.ts]
  │           └─► runLoop(ctx, newMessages, config, signal, emit, streamFn)
  │                 │
  │                 │  ┌── 外层循环: 处理 follow-up 消息 ──────────────────┐
  │                 │  │                                                  │
  │                 │  │  ┌── 内层循环: 处理 tool calls + steering ────┐   │
  │                 │  │  │                                           │   │
  │                 │  │  │  1. 注入 pending steering/follow-up 消息   │   │
  │                 │  │  │  2. streamAssistantResponse() → LLM 调用   │   │
  │                 │  │  │  3. executeToolCalls() → 工具执行          │   │
  │                 │  │  │     ├─ sequential: 逐个执行                │   │
  │                 │  │  │     └─ parallel: 并发执行                  │   │
  │                 │  │  │  4. emit turn_end                         │   │
  │                 │  │  │  5. prepareNextTurn() → 刷新会话状态       │   │
  │                 │  │  │  6. shouldStopAfterTurn()? → 退出          │  │
  │                 │  │  │  7. getSteeringMessages() → 下一轮         │  │
  │                 │  │  └────────────────────────────────────────────┘  │
  │                 │  │                                                  │
  │                 │  │  8. getFollowUpMessages() → 有则继续外层循环       │
  │                 │  └──────────────────────────────────────────────────┘
  │                 │
  │                 └─► emit agent_end
  │
  └─► AgentHarness.prompt(text)             [harness/agent-harness.ts]
        └─► createTurnState() → 从 Session 构建 Turn Snapshot
        └─► executeTurn() → 直接调用 runAgentLoop()（不经过 Agent 类）
              └─► handleAgentEvent() → 事件处理 + 会话持久化
```

---

## 二、整体设计思路和架构

### 2.1 分层架构

`AgentHarness` 和 `Agent` 是**两条并行的上层路径**，它们都基于底层的 `agent-loop.ts` 和 `pi-ai`：

```
┌──────────────────────────┐  ┌──────────────────────────────┐
│       AgentHarness       │  │           Agent              │
│  会话管理 · 压缩 · 钩子   │  │  状态封装 · 事件订阅 · 队列    │
│  (harness/agent-harness) │  │  (agent.ts)                  │
│  直接调用 runAgentLoop()  │  │  调用 runAgentLoop()         │
└──────────┬───────────────┘  └──────────────┬───────────────┘
           │                                 │
           └───────────┬─────────────────────┘
                       │
           ┌───────────▼────────────────────────────┐
           │       低级 Agent 循环 (无状态)          │
           │  runAgentLoop / runLoop                │
           │  streamAssistantResponse               │
           │  executeToolCalls (sequential|parallel)│
           │  (agent-loop.ts)                       │
           ├────────────────────────────────────────┤
           │          pi-ai (LLM API)               │
           │  streamSimple · Model · Message        │
           │  (packages/ai)                         │
           └────────────────────────────────────────┘
```

### 2.2 核心设计原则

1. **关注点分离**：低级循环（`agent-loop.ts`）是无状态的纯函数。`Agent` 类和 `AgentHarness` 是两条独立的上层路径——`Agent` 类在循环之上添加有状态封装和事件系统，`AgentHarness` 则在循环之上添加会话持久化、钩子、压缩等基础设施。`AgentHarness` 不依赖 `Agent` 类，而是直接调用 `runAgentLoop()`。

2. **AgentMessage 抽象**：所有消息使用 `AgentMessage`（`Message | CustomAgentMessages[keyof CustomAgentMessages]`），在 LLM 调用边界通过 `convertToLlm()` 转换为标准 `Message[]`。应用可通过 TypeScript 声明合并扩展自定义消息类型。

3. **事件驱动**：Agent 循环通过 `AgentEvent` 联合类型发出生命周期事件（`agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`），UI 层通过 `subscribe()` 监听。

4. **消息队列系统**：支持两种队列
   - **Steering Queue**：在当前 assistant turn 完成后立即注入（用于中途干预）
   - **Follow-up Queue**：仅在 Agent 即将停止时注入（用于追加任务）
   - 每种队列支持 `"all"`（一次全部排出）和 `"one-at-a-time"`（每次排出一个）模式

5. **工具执行策略**：
   - `"sequential"`：逐个准备 → 执行 → 完成
   - `"parallel"`：顺序准备，然后并发执行，按完成顺序发出 `tool_execution_end`，按 assistant 源码顺序发出 tool-result 消息

---

## 三、基本 Agent 循环实现逻辑

### 3.1 涉及的核心源码文件

| 文件 | 职责 |
|------|------|
| `src/agent-loop.ts` | 低级循环：`runAgentLoop`、`runAgentLoopContinue`、`runLoop`、`streamAssistantResponse`、`executeToolCalls` |
| `src/agent.ts` | `Agent` 类：状态管理、生命周期、消息队列、事件分发 |
| `src/types.ts` | 类型定义：`AgentContext`、`AgentLoopConfig`、`AgentEvent`、`AgentTool`、`StreamFn` 等 |

### 3.2 循环详细逻辑

#### 3.2.1 入口：`runAgentLoop`

agent-loop.ts:95-115

```typescript
async function runAgentLoop(prompts, context, config, emit, signal, streamFn) {
    // 1. 将 prompts 追加到 context.messages
    // 2. emit agent_start → turn_start → message_start/end (每个 prompt)
    // 3. 调用 runLoop()
}
```

#### 3.2.2 核心：`runLoop`

agent-loop.ts:148-270

双层循环结构：

**外层循环** — 处理 follow-up 消息：
- 当内层循环结束（无更多 tool calls 且无 steering 消息）时
- 检查 `getFollowUpMessages()`，有则重新进入内层循环
- 无则退出，emit `agent_end`

**内层循环** — 处理 tool calls + steering：
1. **注入 pending 消息**：将 steering/follow-up 队列中的消息注入 context
2. **`streamAssistantResponse()`**：调用 LLM 获取 assistant 响应
   - 应用 `transformContext`（AgentMessage 级别转换，如上下文窗口管理）
   - 调用 `convertToLlm`（AgentMessage → LLM Message）
   - 通过 `streamFn`（默认 `streamSimple`）发起 LLM 请求
   - 流式处理响应事件（`text_start/delta/end`、`thinking_*`、`toolcall_*`）
   - 返回最终的 `AssistantMessage`
3. **`executeToolCalls()`**：执行 assistant 消息中的 tool calls
   - 检查是否有工具标记为 `sequential` 模式
   - 根据 `toolExecution` 配置选择 sequential 或 parallel 执行
   - 每个 tool call 经历：`prepareToolCall` → `beforeToolCall` 钩子 → `execute` → `afterToolCall` 钩子 → `finalize`
4. **emit `turn_end`**
5. **`prepareNextTurn()`**：允许更新 context/model/thinkingLevel
6. **`shouldStopAfterTurn()`**：检查是否应停止
7. **`getSteeringMessages()`**：获取 steering 消息，有则继续内层循环

#### 3.2.3 工具执行流程

```
prepareToolCall()
  ├─ 查找 tool 定义
  ├─ prepareArguments() — 参数兼容转换
  ├─ validateToolArguments() — schema 验证
  ├─ beforeToolCall() 钩子 — 可 block 工具执行
  └─ 返回 PreparedToolCall 或 ImmediateToolCallOutcome

executePreparedToolCall()
  ├─ tool.execute(toolCallId, args, signal, onUpdate)
  └─ onUpdate → emit tool_execution_update

finalizeExecutedToolCall()
  ├─ afterToolCall() 钩子 — 可覆盖 content/details/isError/terminate
  └─ 返回 FinalizedToolCallOutcome

emitToolExecutionEnd() → createToolResultMessage() → emitToolResultMessage()
```

#### 3.2.4 关键配置项 (`AgentLoopConfig`)

| 配置 | 说明 |
|------|------|
| `convertToLlm` | AgentMessage[] → Message[] 转换（必须） |
| `transformContext` | LLM 调用前的 AgentMessage 级别转换（可选，如上下文裁剪） |
| `getApiKey` | 动态 API key 解析（支持过期 token 刷新） |
| `beforeToolCall` | 工具执行前钩子，可 block |
| `afterToolCall` | 工具执行后钩子，可覆盖结果 |
| `prepareNextTurn` | 每轮结束后更新 context/model/thinkingLevel |
| `shouldStopAfterTurn` | 每轮结束后判断是否应停止当前对话 |
| `getSteeringMessages` | 获取中途 steering 消息 |
| `getFollowUpMessages` | 获取 follow-up 消息 |
| `toolExecution` | `"sequential"` 或 `"parallel"` |

---

## 四、Agent Harness 工程实现

> [设计文档](../packages/agent/docs/agent-harness.md): `packages/agent/docs/agent-harness.md`

### 4.1 与 Agent 类的关系

**AgentHarness 不依赖 Agent 类**。它直接调用 `agent-loop.ts` 中的 `runAgentLoop()` 函数。这与 `Agent` 类形成两条平行的上层路径，各自基于底层循环构建不同的抽象。

`Agent` 类面向有状态封装（事件订阅、消息队列、state 管理），`AgentHarness` 面向会话持久化、钩子系统、上下文压缩等基础设施。

### 4.2 核心源码文件概览

| 文件 | 职责 |
|------|------|
| `src/harness/agent-harness.ts` | `AgentHarness` 主类：会话管理、钩子系统、turn 执行 |
| `src/harness/types.ts` | Harness 类型：`ExecutionEnv`、`FileSystem`、`Shell`、`Session`、事件类型、错误类型 |
| `src/harness/session/session.ts` | `Session` 类：会话树管理、上下文构建 |
| `src/harness/session/jsonl-repo.ts` | JSONL 文件持久化的 Session 仓库 |
| `src/harness/session/jsonl-storage.ts` | JSONL 存储后端 |
| `src/harness/session/memory-repo.ts` | 内存 Session 仓库（测试用） |
| `src/harness/session/memory-storage.ts` | 内存存储后端 |
| `src/harness/session/repo-utils.ts` | 仓库工具函数 |
| `src/harness/session/uuid.ts` | UUID v7 生成 |
| `src/harness/compaction/compaction.ts` | 上下文压缩：token 估算、cut point 查找、摘要生成 |
| `src/harness/compaction/branch-summarization.ts` | 分支摘要：树导航时的分支变更摘要 |
| `src/harness/compaction/utils.ts` | 压缩工具：文件操作提取、对话序列化 |
| `src/harness/messages.ts` | 消息转换：`convertToLlm`、自定义消息类型 |
| `src/harness/system-prompt.ts` | 系统提示词格式化（含 Skills XML 块） |
| `src/harness/skills.ts` | Skill 加载（从目录递归加载 `SKILL.md`） |
| `src/harness/prompt-templates.ts` | Prompt 模板加载（从 `.md` 文件） |
| `src/harness/env/nodejs.ts` | Node.js `ExecutionEnv` 实现 |
| `src/harness/utils/shell-output.ts` | Shell 输出处理 |
| `src/harness/utils/truncate.ts` | 文本截断工具 |

### 4.3 状态模型 (State Model)

设计文档将 AgentHarness 的状态分为**四类**，这是理解其设计的核心：

| 类别 | 说明 | 生命周期 |
|------|------|---------|
| **Harness Config** | 最新运行时配置（model、thinkingLevel、tools、activeToolNames、resources、streamOptions、systemPrompt）。getter 返回最新值，不是 in-flight 快照。setter 立即更新，影响下一轮 turn snapshot。 | 持久的，跨 turn |
| **Turn Snapshot** | 每轮 LLM 调用时由 `createTurnState()` 创建的快照。包含：持久化 session messages、解析后的 resources、systemPrompt、model、thinkingLevel、activeTools、streamOptions、sessionId。该轮所有逻辑使用同一快照。 | 每轮新建 |
| **Session** | 仅持久化的条目（通过 `SessionStorage` 存储）。不包含 pending writes。读取返回已持久化状态。 | 持久化 |
| **Pending Session Writes** | busy 期间排队的 session 写入。基于 session-entry 形状但无生成字段（`id`、`parentId`、`timestamp`）。在 save point 或 operation settlement 时刷新。 | 排队，随后刷新 |

### 4.4 操作阶段 (Operation Phases)

```typescript
type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
```

**结构性操作**（需要 `phase === "idle"`，否则抛出 `AgentHarnessError("busy")`）：
- `prompt()`、`skill()`、`promptFromTemplate()`
- `compact()`、`navigateTree()`

**Turn 期间允许的操作**：
- `steer()`、`followUp()`、`nextTurn()`、`abort()`
- 运行时 config setter（`setModel()`、`setThinkingLevel()`、`setTools()` 等）

### 4.5 AgentHarness 架构

```
AgentHarness
├── 状态模型
│   ├── Harness Config — 最新运行时配置，getter/setter 立即生效
│   ├── Turn Snapshot — createTurnState() 创建，每轮快照
│   ├── Session — 仅持久化条目，不包含 pending writes
│   └── Pending Session Writes — busy 期间排队，save point 刷新
│
├── 会话管理 (Session)
│   ├── 树形会话结构 (parentId 链表)
│   ├── 多种条目类型: message, model_change, thinking_level_change,
│   │   active_tools_change, compaction, branch_summary, custom, label, leaf
│   ├── 持久化后端: JSONL 文件 或 内存
│   └── buildContext() → 从当前分支重建 AgentMessage[]
│
├── 上下文压缩 (Compaction)
│   ├── shouldCompact() — 判断是否需要压缩
│   ├── prepareCompaction() — 准备压缩（找 cut point）
│   ├── compact() — 调用 LLM 生成摘要
│   └── 文件操作追踪 (readFiles / modifiedFiles)
│
├── 分支导航 (Branch Summarization)
│   ├── navigateTree() — 在会话树中跳转
│   ├── collectEntriesForBranchSummary() — 收集需要摘要的条目
│   └── generateBranchSummary() — 生成分支变更摘要
│
├── 钩子系统 (Hooks)
│   ├── subscribe() — 通配符订阅，接收所有事件（observational）
│   ├── on() — 按事件类型注册，可返回结果（mutation hooks）
│   ├── before_agent_start — 修改 prompt / systemPrompt
│   ├── context — 修改发送给 LLM 的消息
│   ├── before_provider_request — 修改 stream options（支持链式 patch）
│   ├── before_provider_payload — 修改请求 payload
│   ├── after_provider_response — 观察响应
│   ├── tool_call — 可 block 工具调用
│   ├── tool_result — 可覆盖结果（content/details/isError/terminate）
│   ├── session_before_compact — 压缩前拦截（可取消或提供自定义摘要）
│   ├── session_compact — 压缩后通知
│   ├── session_before_tree — 树导航前拦截（可取消）
│   └── session_tree — 树导航后通知
│
├── 资源管理
│   ├── Skills — 通过 setResources() 注入，system prompt 回调中格式化
│   └── Prompt Templates — 通过 setResources() 注入，promptFromTemplate() 使用
│
└── 执行环境抽象 (ExecutionEnv)
    ├── FileSystem — 平台无关的文件操作
    └── Shell — 平台无关的命令执行
```

### 4.6 AgentHarness 执行流程

```
AgentHarness.prompt(text)
  │
  ├─ 1. 检查 phase === "idle"（否则抛出 "busy"）
  ├─ 2. 设置 phase = "turn"
  ├─ 3. createTurnState() — 创建 Turn Snapshot
  │     ├─ session.buildContext() → 从会话树重建消息（含 compaction 处理）
  │     ├─ getResources() → 获取 skills / promptTemplates（浅拷贝）
  │     ├─ 解析 activeTools（从 activeToolNames 映射到实际 tool 对象）
  │     ├─ 构建 systemPrompt：
  │     │   ├─ 如果是字符串 → 直接使用
  │     │   └─ 如果是回调 → 调用并传入 { env, session, model, thinkingLevel, activeTools, resources }
  │     └─ 返回 AgentHarnessTurnState（包含 messages, resources, streamOptions, sessionId, systemPrompt, model, thinkingLevel, tools, activeTools）
  │
  ├─ 4. executeTurn(turnState, text)
  │     ├─ 处理 nextTurnQueue 中的排队消息（插入到用户消息之前）
  │     ├─ emitHook("before_agent_start") → 可修改 messages[] 和 systemPrompt
  │     ├─ 创建 AbortController（赋值给 runAbortController）
  │     ├─ 直接调用 runAgentLoop()（不经过 Agent 类）
  │     │     ├─ createContext(turnState, overrideSystemPrompt?) → AgentContext
  │     │     ├─ createLoopConfig(getTurnState, setTurnState) → AgentLoopConfig
  │     │     │     ├─ convertToLlm: 来自 harness/messages.ts
  │     │     │     ├─ transformContext → emitHook("context")
  │     │     │     ├─ beforeToolCall → emitHook("tool_call")
  │     │     │     ├─ afterToolCall → emitHook("tool_result")
  │     │     │     ├─ prepareNextTurn → flushPendingSessionWrites() + createTurnState()
  │     │     │     │     └─ 创建新的 Turn Snapshot，更新 activeTurnState
  │     │     │     ├─ getSteeringMessages → drainQueuedMessages(steerQueue, steeringQueueMode)
  │     │     │     │     └─ 支持 "all" 或 "one-at-a-time" 排出模式
  │     │     │     │     └─ emitQueueUpdate() 失败时回滚已排出的消息
  │     │     │     └─ getFollowUpMessages → drainQueuedMessages(followUpQueue, followUpQueueMode)
  │     │     ├─ handleAgentEvent(event, signal) → 事件处理 + 会话持久化
  │     │     │     ├─ message_end → session.appendMessage() + emitAny()
  │     │     │     ├─ turn_end → emitAny() + flushPendingSessionWrites() + emitOwn("save_point")
  │     │     │     └─ agent_end → flushPendingSessionWrites() + phase="idle" + emitAny() + emitOwn("settled")
  │     │     └─ createStreamFn(getTurnState) → 包装 models.streamSimple
  │     │           ├─ emitBeforeProviderRequest(model, sessionId, streamOptions)
  │     │           │     └─ 链式调用多个 before_provider_request 钩子，合并 streamOptions patch
  │     │           ├─ onPayload → emitBeforeProviderPayload(model, payload)
  │     │           └─ onResponse → emitOwn("after_provider_response")
  │     │
  │     └─ 从 newMessages 中提取最后一个 AssistantMessage 返回
  │
  └─ 5. finishRunPromise() → runPromise 变为 undefined
```

### 4.7 Save Points（保存点）

Save point 发生在 assistant turn 及其 tool-result 消息完成后（`turn_end` 事件处理中）：

1. 先通知订阅者（`emitAny`），然后刷新 pending session writes
2. 如果循环继续，`prepareNextTurn` 回调会：
   - 刷新 pending session writes
   - 调用 `createTurnState()` 创建新的 Turn Snapshot
   - 更新 `activeTurnState`，使下一轮 LLM 调用使用新配置
3. 发出 `save_point` 事件（含 `hadPendingMutations` 标志）

这确保了 model、thinkingLevel、tools、resources、streamOptions 的变更在 turn 期间不会影响当前 in-flight 请求，但会在下一轮生效。

### 4.8 Abort 语义

- `abort()` 在 turn 期间允许，不在 idle 时使用
- 调用 `runAbortController.abort()` 取消底层循环
- **清除** steering 和 followUp 队列
- **不清除** `nextTurnQueue`（消息在下一次用户发起的 turn 中插入到用户消息之前）
- **不丢弃** pending session writes（在下一个 save point 或 `agent_end` 时刷新）
- 返回 `{ clearedSteer, clearedFollowUp }`

### 4.9 会话模型

会话采用**树形结构**，每个条目通过 `parentId` 链接到父节点：

```
SessionTreeEntry 类型:
├── message           — 对话消息
├── model_change      — 模型切换记录
├── thinking_level_change — 思考级别变更
├── active_tools_change   — 活跃工具集变更
├── compaction        — 上下文压缩摘要
├── branch_summary    — 分支跳转摘要
├── custom            — 自定义条目
├── custom_message    — 自定义消息（可控制是否显示）
├── label             — 标签（用于 UI 书签）
├── session_info      — 会话名称
└── leaf              — 当前分支叶子指针（持久化为 entry，非纯内存游标）
```

`buildContext()` 从当前 leaf 沿 `parentId` 链回溯到根，重建 `AgentMessage[]`。遇到 `compaction` 条目时，只保留摘要消息和 `firstKeptEntryId` 之后的消息。

`setLeafId()` 不是纯内存操作——它持久化一条 `leaf` entry，其 `targetId` 为当前活跃叶子或 `null`（根节点）。重新打开存储时必须从最新的 leaf-affecting entry 重建当前叶子。

### 4.10 上下文压缩 (Compaction)

压缩流程：

1. **`shouldCompact()`**：当 `contextTokens > contextWindow - reserveTokens` 时触发
2. **`prepareCompaction()`**：从会话条目中找到合适的 cut point（在 user/assistant 消息边界）
3. **`compact()`**：
   - 序列化被压缩的对话
   - 提取文件操作（readFiles / modifiedFiles）
   - 调用 LLM 生成结构化摘要
4. 摘要作为 `compaction` 条目持久化，后续 `buildContext()` 自动使用

### 4.11 错误处理

- **低层能力**（`ExecutionEnv`、文件系统、Shell、资源加载、compaction 辅助函数）：使用 `Result<T, E>` 模式，不抛异常
- **高层变更/编排 API**（`Session`、`AgentHarness`）：reject/throw，不返回可忽略的 bare result
- 公共 harness 失败被规范化为 `AgentHarnessError`；子系统错误保留为 `cause`
- 钩子/订阅者失败在 commit 之后：状态变更不回滚，公共方法 reject 并带 `AgentHarnessError("hook")`
- Queue drain 失败时消息回滚（`drainQueuedMessages` 在 `emitQueueUpdate` 失败后 `unshift` 回去）

### 4.12 关键设计特点

1. **平台无关的执行环境**：`ExecutionEnv` 接口抽象了文件系统和 Shell，`NodeExecutionEnv` 是 Node.js 实现。这使得 harness 可以在浏览器、沙箱等不同环境中运行。

2. **Result 类型**：所有 I/O 操作返回 `Result<T, E>`（`{ ok: true, value } | { ok: false, error }`），不抛异常。这确保了 harness 在文件系统错误等场景下的健壮性。

3. **延迟会话写入**：在 turn 执行期间，会话写入被缓存在 `pendingSessionWrites` 队列中，在 `turn_end` 时批量刷新。这保证了会话状态的一致性。

4. **泛型扩展**：`AgentHarness<TSkill, TPromptTemplate, TTool>` 使用泛型参数，允许应用层使用更具体的 Skill/PromptTemplate/Tool 类型。

5. **钩子链**：多个同类型钩子按注册顺序依次执行，后续钩子可覆盖前一个的结果（如 `before_provider_request` 的 streamOptions 合并，支持 key 级别删除）。

6. **直接调用 runAgentLoop**：AgentHarness 不通过 `Agent` 类，而是直接调用 `agent-loop.ts` 的 `runAgentLoop()`。它自己管理 run 生命周期、abort controller、queue draining、provider stream config、event reduction、session persistence、pending write flushing 和 save-point snapshots。

7. **Config 与 Snapshot 分离**：getter 返回最新 harness config，不是 in-flight 快照。setter 立即更新 config，影响下一次 `createTurnState()`。Turn Snapshot 一旦创建就不可变，保证该轮 LLM 调用的一致性。


## 五、组件细节讨论



-------------------------------------------------------------
# Pi Coding Agent 源码分析

> 包名: `@earendil-works/pi-coding-agent` | CLI 命令: `pi`

---
## 一、整体设计思路

pi-coding-agent 是一个交互式编程 Agent CLI 工具，提供三种运行模式（交互式 TUI、单次 print、JSON-RPC）。

其架构遵循**关注点分离**原则，分为四层：

```
┌─────────────────────────────────────────────────────────┐
│                   运行模式 (modes/)                       │
│  InteractiveMode (TUI)  │  PrintMode  │  RpcMode         │
│  使用 pi-tui 渲染界面    │  单次文本输出 │  JSON-RPC 协议   │
├─────────────────────────────────────────────────────────┤
│               AgentSession (core/agent-session.ts)       │
│  会话生命周期 · 事件封装 · 压缩 · Bash执行 · 模型切换      │
│  ExtensionRunner 集成 · 自动重试                          │
├─────────────────────────────────────────────────────────┤
│          AgentSessionRuntime (agent-session-runtime.ts)   │
│  运行时管理 · Session 切换/分支/fork · 服务生命周期         │
├─────────────────────────────────────────────────────────┤
│              SDK (core/sdk.ts)                           │
│  createAgentSession() · Agent 实例化 · 工具工厂            │
│  Model 解析 · Auth 管理 · convertToLlm                    │
├─────────────────────────────────────────────────────────┤
│                pi-agent-core (Agent)                      │
│  Agent 类 · runAgentLoop · AgentMessage · AgentTool       │
│  (packages/agent)                                        │
├─────────────────────────────────────────────────────────┤
│                pi-ai (LLM API)                            │
│  streamSimple · Model · Message                          │
│  (packages/ai)                                           │
└─────────────────────────────────────────────────────────┘
```

核心设计特点：

1. **模式无关的核心抽象**：`AgentSession` 是所有运行模式共享的核心类，封装了 Agent 生命周期、会话持久化、压缩、Bash 执行等。各模式只负责 I/O 层。

2. **自建基础设施（非 AgentHarness）**：pi-coding-agent **没有使用** `pi-agent-core` 中的 `AgentHarness`。它在 `Agent` 类之上构建了自己的并行基础设施——自己的会话管理（`SessionManager`）、自己的压缩系统（`core/compaction/`）、自己的消息类型（`core/messages.ts`）、自己的扩展系统（`core/extensions/`）、自己的系统提示词构建器（`core/system-prompt.ts`）。

3. **扩展系统**：通过 `ExtensionRunner` 管理第三方扩展的生命周期，扩展可注册工具、订阅事件、注册 slash 命令、键盘快捷键。

4. **工具工厂模式**：所有内置工具（read、bash、edit、write、grep、find、ls）通过工厂函数创建（如 `createReadToolDefinition(cwd, options)`），支持自定义 cwd 和配置。

5. **会话持久化**：使用 JSONL 文件存储会话历史，支持会话的分支（fork）、摘要（compact）、树导航（navigateTree）。

---
## 二、执行模式

| 模式 | 入口文件 | CLI 触发方式 | 说明 |
|------|---------|-------------|------|
| **Interactive** | `modes/interactive/interactive-mode.ts` | 默认（TTY 环境） | 完整的 TUI 交互界面，基于 pi-tui 实现 |
| **Print (text)** | `modes/print-mode.ts` | `pi -p "prompt"` | 单次执行，输出最终 assistant 响应文本 |
| **Print (json)** | `modes/print-mode.ts` | `pi --mode json "prompt"` | 单次执行，输出 JSON 事件流 |
| **RPC** | `modes/rpc/rpc-mode.ts` | `pi --mode rpc` | Headless 模式，通过 stdin/stdout 的 JSON 协议通信 |

---
## 三、整体执行流程

以 `pi -p "hello"` 为例（Print 模式）：

```
cli.ts (Node.js 入口)
  │
  ├─ 设置 process.title / PI_CODING_AGENT 环境变量
  └─ main(process.argv.slice(2))

main.ts
  │
  ├─ Phase 1: 参数解析 & 初始化
  │   ├─ parseArgs(args) → 解析 CLI 参数
  │   ├─ resolveAppMode() → 确定模式 (interactive/print/rpc/json)
  │   ├─ resolveProjectTrusted() → 项目信任检查
  │   ├─ runMigrations(cwd) → 运行数据迁移
  │   └─ createSessionManager() → 创建/恢复/分支会话
  │       ├─ 新建 (默认): SessionManager.create()
  │       ├─ 恢复: SessionManager.continueRecent() / --session
  │       ├─ 分支: SessionManager.forkFrom() / --fork
  │       └─ 内存: SessionManager.inMemory() / --no-session
  │
  ├─ Phase 2: 创建运行时服务
  │   └─ createAgentSessionServices(cwd, agentDir, ...)
  │       ├─ AuthStorage.create(auth.json)
  │       ├─ ModelRegistry.create(models.json)
  │       ├─ SettingsManager.create(cwd, agentDir)
  │       └─ DefaultResourceLoader 加载:
  │           ├─ Skills (SKILL.md)
  │           ├─ Prompt Templates (.md)
  │           ├─ Extensions (TS 模块)
  │           └─ Context files (AGENTS.md, etc.)
  │
  ├─ Phase 3: 解析模型 & Session 选项
  │   ├─ resolveCliModel() → 解析 --model / --provider
  │   ├─ buildSessionOptions() → 构建 CreateAgentSessionOptions
  │   └─ createAgentSessionRuntime() → 创建完整运行时
  │       └─ createAgentSession() [sdk.ts]
  │           ├─ 创建 Agent 实例
  │           │   ├─ initialState: { systemPrompt, model, thinkingLevel, tools }
  │           │   ├─ convertToLlm: 自定义转换（含 blockImages）
  │           │   ├─ streamFn: 包装 streamSimple（注入 auth、headers、retry）
  │           │   ├─ transformContext: 通过 ExtensionRunner 修改上下文
  │           │   ├─ steeringMode / followUpMode / transport / thinkingBudgets
  │           │   └─ sessionId: 会话 UUID
  │           └─ 创建 AgentSession(agent, sessionManager, ...)
  │
  ├─ Phase 4: 运行对应模式
  │   │
  │   ├─ Print/JSON 模式:
  │   │   ├─ 注册 Signale 处理器 (SIGTERM/SIGHUP)
  │   │   ├─ bindExtensions({ mode, commandContextActions })
  │   │   ├─ prepareInitialMessage() → 处理 @file 和 stdin
  │   │   ├─ session.prompt(message, { images })
  │   │   │     └─ agent.prompt(userMessage)
  │   │   │           └─ runAgentLoop() [agent-loop.ts]
  │   │   │                 └─ runLoop() (双层循环)
  │   │   └─ 监听 AgentSessionEvent → 输出最终结果
  │   │
  │   ├─ Interactive 模式:
  │   │   ├─ initTheme() → 加载 TUI 主题
  │   │   ├─ 创建 InteractiveMode(agentSession, runtime, options)
  │   │   │     ├─ 构建 TUI 组件树
  │   │   │     ├─ 注册 slash 命令
  │   │   │     ├─ 绑定扩展 UI 上下文
  │   │   │     └─ 注册键盘快捷键
  │   │   └─ interactiveMode.run()
  │   │         └─ TUI.processInput() → 事件循环
  │   │
  │   └─ RPC 模式:
  │       ├─ takeOverStdout()
  │       ├─ 监听 stdin JSON 命令
  │       └─ 输出 JSON 事件流到 stdout
  │
  └─ Phase 5: 清理
      ├─ killTrackedDetachedChildren()
      └─ runtimeHost.dispose() / stopThemeWatcher()
```

---
## 四、基于 pi-agent-core 的实现方式

### 4.1 不使用 AgentHarness

**pi-coding-agent 没有使用 `AgentHarness`**。在 `packages/coding-agent/src/` 中搜索 `AgentHarness` 返回零结果。

pi-coding-agent 直接从 `@earendil-works/pi-agent-core` 导入的核心 API：

| 导入 | 来源模块 | 用途 |
|------|---------|------|
| `Agent` | `"@earendil-works/pi-agent-core"` | 核心 Agent 类，所有模式的基础 |
| `AgentMessage` | 同上 | 消息类型 |
| `AgentTool` | 同上 | 工具定义类型 |
| `ThinkingLevel` | 同上 | 思考级别类型 |
| `AgentState` | 同上 | 状态类型 |
| `StreamFn` | 同上 | 流函数类型（compaction 用） |
| `uuidv7` | 同上 | UUID 生成（会话 ID） |

### 4.2 Agent 实例化 (sdk.ts)

```typescript
agent = new Agent({
    initialState: {
        systemPrompt: "",
        model,
        thinkingLevel,
        tools: [],
    },
    convertToLlm: convertToLlmWithBlockImages,  // 自定义转换（含 blockImages 防御）
    streamFn: async (model, context, options) => {
        // 包装 streamSimple，注入 auth key、headers、retry 配置
        const auth = await modelRegistry.getApiKeyAndHeaders(model);
        return streamSimple(model, context, {
            ...options,
            apiKey: auth.apiKey,
            headers: mergeProviderAttributionHeaders(...),
            maxRetries: providerRetrySettings.maxRetries,
            // ...
        });
    },
    transformContext: async (messages) => {
        // 通过 ExtensionRunner 的 context 钩子修改消息
        return runner.emitContext(messages);
    },
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    transport: settingsManager.getTransport(),
    thinkingBudgets: settingsManager.getThinkingBudgets(),
    sessionId: sessionManager.getSessionId(),
});
```

### 4.3 AgentSession 对 Agent 的封装 (agent-session.ts)

`AgentSession` 包装 `Agent`，提供以下增强：

- **事件转发**：订阅 `agent.subscribe()` 的内部事件，转换为 `AgentSessionEvent` 并转发给模式层
- **工具钩子**：在 `agent.beforeToolCall` / `agent.afterToolCall` 上安装 `ExtensionRunner` 的 `tool_call` / `tool_result` 钩子
- **Turn 刷新**：通过 `agent.prepareNextTurnWithContext` 每轮刷新 system prompt 和 tools
- **自动压缩**：监听 `message_end` 事件，当 token 使用量超过阈值时自动触发 compact
- **自动重试**：捕获 `agent_end`（stopReason="error"），可自动重试
- **Bash 执行**：通过 `executeBashWithOperations` 包装 bash 工具调用

### 4.4 自建的并行基础设施

pi-coding-agent 在 `Agent` 类之上构建了自己的基础设施层，与 `pi-agent-core` 中的 `AgentHarness` 形成**功能并行**但**独立实现**的关系：

| 功能 | AgentHarness (pi-agent-core) | pi-coding-agent 自建 |
|------|------------------------------|---------------------|
| 会话管理 | `harness/session/` (树形结构) | `core/session-manager.ts` (JSONL 文件) |
| 上下文压缩 | `harness/compaction/compaction.ts` | `core/compaction/compaction.ts` (独立实现) |
| 消息类型 | `harness/messages.ts` | `core/messages.ts` (独立声明合并) |
| 系统提示词 | `harness/system-prompt.ts` | `core/system-prompt.ts` (独立实现) |
| Skills 加载 | `harness/skills.ts` | `core/skills.ts` (独立实现) |
| 钩子系统 | `emitHook()` 10+ 种钩子 | `ExtensionRunner` 扩展事件系统 |
| 执行环境 | `ExecutionEnv` (FileSystem + Shell) | 直接使用 Node.js API |

### 4.5 设计决策分析

选择不使用 `AgentHarness` 而自建基础设施的可能原因：

1. **不同的会话模型**：`AgentHarness` 的 Session 是树形结构（parentId 链表），而 pi-coding-agent 使用扁平的 JSONL 追加写入模型。树形结构更适合分支/合并场景。

2. **扩展系统的独立性**：pi-coding-agent 的扩展系统（`ExtensionRunner`）是独立设计的，需要与 Extension SDK、slash commands、键盘快捷键等深度集成，不适合直接映射到 AgentHarness 的钩子系统。

3. **演进路径**：从代码结构看，`AgentHarness` 可能是后期设计的通用化抽象，而 pi-coding-agent 在更早版本就已存在。两套系统当前并行存在，未来可能逐步统一。

4. **关注点**：`AgentHarness` 面向的是通用 agent 运行时（跨平台 FileSystem/Shell 抽象），而 pi-coding-agent 是专为编程场景设计的 CLI 工具，需要更贴近 Node.js 生态。

### 4.6 关键共享代码

pi-coding-agent 与 pi-agent-core 共享的核心路径：

```
pi-coding-agent                          pi-agent-core
─────────────                            ─────────────
AgentSession                             Agent
  └─ agent.prompt() ──────────────────►   └─ runAgentLoop()
  └─ agent.continue() ───────────────►   └─ runAgentLoopContinue()
  └─ agent.subscribe() ──────────────►   事件系统
  └─ agent.beforeToolCall ───────────►   工具钩子
  └─ agent.afterToolCall ────────────►   工具钩子
  └─ agent.prepareNextTurnWithContext ►  回合刷新
  └─ agent.steer() ──────────────────►   steering 队列
  └─ agent.followUp() ───────────────►   followUp 队列

core/messages.ts::convertToLlm()         harness/messages.ts::convertToLlm()
  (独立实现，逻辑相似)                     (AgentHarness 使用)
  └─ 通过声明合并扩展 CustomAgentMessages   └─ 通过声明合并扩展 CustomAgentMessages

core/session-manager.ts                  harness/session/session.ts
  (扁平 JSONL 文件)                       (树形 parentId 链表)
```


-----------------------
# 其他讨论

## Skill 加载

Skills 加载在项目中有**两套独立实现**，分别位于两个子项目：

---

### pi-agent-core：skills.ts

这是 `AgentHarness` 使用的 Skills 加载器。

核心函数：

| 函数                                                    | 作用                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `loadSkills(env, dirs)`                                 | 从目录递归遍历，加载 `SKILL.md` 文件，遵循 .gitignore 等忽略规则 |
| `loadSourcedSkills(env, inputs, mapSkill?)`             | 带来源标记的加载（每个 skill 标记其来源路径）                |
| `formatSkillInvocation(skill, additionalInstructions?)` | 格式化 skill 调用提示词（`<skill name="..." location="...">` XML 块） |

解析 `SKILL.md` 时读取 YAML frontmatter 中的 `name`、`description`、`disable-model-invocation` 字段。

配套文件 system-prompt.ts 中的 `formatSkillsForSystemPrompt()` 负责将 Skills 列表格式化为 `<available_skills>` XML 块注入系统提示词。

---

### pi-coding-agent：skills.ts

这是 pi-coding-agent 自己的 Skills 加载器（独立于 AgentHarness 实现）。

功能类似——从目录加载 `SKILL.md`，解析 frontmatter，通过 `ResourceLoader`（`core/resource-loader.ts`）集成到启动流程中。

---

### 在流程中的位置

- **AgentHarness 路径**：Skills 通过 `setResources()` 由应用层注入到 `AgentHarness.resources`。在 `createTurnState()` 中通过 `getResources()` 获取后传给 system prompt 回调（或 `formatSkillsForSystemPrompt()`），最终注入 system prompt。`before_agent_start` 钩子在 `executeTurn()` 中发出，可进一步修改 prompt 和 systemPrompt。
- **pi-coding-agent 路径**：`core/resource-loader.ts`（`DefaultResourceLoader`）在 `reload()` 时调用 `core/skills.ts` 加载 skills，随后 `core/system-prompt.ts` 的 `buildSystemPrompt()` 将它们注入系统提示词