// 练习 pi-agent-core 使用
// ---------- pi-ai ----------
import type { 
  Static, TSchema,  // 这个是由 TypeBox 提供的类型别名
  Api, KnownProvider, Model, 
  CreateModelsOptions, CreateProviderOptions,
  Provider, MutableModels, Models,
  ModelThinkingLevel, Transport, 
  StreamOptions, SimpleStreamOptions, ProviderStreamOptions,
  Context, Tool, ToolCall, Usage, StopReason,
  AssistantMessage, UserMessage, ToolResultMessage, Message,
  AssistantMessageEvent,
  // OpenAI兼容性配置类型
  OpenAICompletionsCompat,
  // 缓存和会话相关
  CacheRetention,
  // 凭证相关
  CredentialStore, AuthResult,
} from "@earendil-works/pi-ai";
// ------ 新版的 Provider + Models API ------
import { 
  builtinModels, builtinProviders, 
  getBuiltinModels, getBuiltinProviders, getBuiltinModel,
} from '@earendil-works/pi-ai/providers/all';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import {
  Type,  // 这个是由 TypeBox 提供的类型构造函数
  createModels, createProvider, getSupportedThinkingLevels, hasApi,
  clampThinkingLevel, calculateCost, modelsAreEqual,
  InMemoryCredentialStore,
  AssistantMessageEventStream, 
  validateToolArguments, validateToolCall,
  // 认证相关
  envApiKeyAuth,
  // 测试用 Faux Provider
  fauxProvider, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall,
  // TypeBox 辅助工具
  StringEnum,
} from "@earendil-works/pi-ai";
// OpenAI-completions API 实现（lazy 加载，用于自定义 Provider）
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
// ---------- pi-agent-core ----------
import type {
  AgentOptions, 
  // 来自 agent/types.ts
  AgentLoopConfig, AgentMessage, AgentState, AgentContext, AgentEvent, 
  AgentTool, AgentToolCall, ToolExecutionMode, QueueMode,
  BeforeToolCallContext, AfterToolCallContext,
  AgentToolResult, BeforeToolCallResult, AfterToolCallResult,
  ThinkingLevel, AgentLoopTurnUpdate, PrepareNextTurnContext, ShouldStopAfterTurnContext,
  // 来自 agent/harness/types.ts
  AgentHarnessOptions, ExecutionEnv, AgentHarnessResources, AgentHarnessStreamOptions, AgentHarnessPhase,
  SessionRepo, SessionStorage, SessionMetadata, SessionContext, 
  PromptTemplate, Skill, 
  BashExecutionMessage, BranchSummaryMessage, CompactionSummaryMessage, CustomMessage,
  CompactionSettings,
  AgentHarnessErrorCode, SessionErrorCode, FileErrorCode, ExecutionErrorCode, BranchSummaryErrorCode, CompactionErrorCode,
} from "@earendil-works/pi-agent-core";
import { 
  // 来自 agent/agent.ts
  Agent, 
  // 来自 agent/agent-loop.ts
  agentLoop, agentLoopContinue, runAgentLoop, runAgentLoopContinue, 
  // 来自 agent/harness
  AgentHarness, 
  Session, buildSessionContext, InMemorySessionRepo, JsonlSessionRepo, 
  loadPromptTemplates, loadSkills, 
  convertToLlm, bashExecutionToText, createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage,
  estimateTokens, calculateContextTokens, shouldCompact, prepareCompaction, compact, generateBranchSummary,
  executeShellWithCapture,
  AgentHarnessError, SessionError, FileError, ExecutionError, BranchSummaryError, CompactionError,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { env } from "node:process";

const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_API_KEY = "";
const USED_MODEL = {provider: "ollama", id: "qwen3.5:8b"};
// const USED_MODEL = {provider: "deepseek", id: "deepseek-v4-flash"};

/**
 * 工具函数：创建注册了 自定义 Provider 的 Models 集合，供后续示例使用。
 * 返回 MutableModels，可以通过 getModel() 按名称精确查找模型。
 * 如果使用Ollama模型，使用前确保本地 Ollama 服务已启动（默认 http://localhost:11434）。
 * 注册的模型：
 *   - qwen3.5:9b   — 推理模型，reasoning: true
 *   - deepseek-v4-pro
 *   - deepseek-v4-flash
 */
function getCustomModels(): MutableModels {
  const models = createModels();

  // Ollama模型Provider
  const ollamaOptions: CreateProviderOptions<Api> = {
      id: 'ollama',
      name: 'Ollama',
      baseUrl: OLLAMA_BASE_URL,
      // 本地服务无需 API key，但必须声明 auth
      auth: {
        apiKey: {
          name: 'Ollama',
          resolve: async () => ({ auth: {} }),
        },
      },
      models: [
        {
          id: 'qwen3.5:9b',
          name: 'Qwen3.5 9B (Ollama)',
          api: 'openai-completions',
          provider: 'ollama',
          baseUrl: OLLAMA_BASE_URL,
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 32000,
          // 对于不支持 reasoning_effort 的 Ollama，设置 compat 选项
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
        },
      ],
      api: openAICompletionsApi(),
    }
  const ollamaProvider: Provider<Api> = createProvider(ollamaOptions);

  // DeepSeek 模型Provider（非官方）
  const deepseekOptions: CreateProviderOptions<Api> = {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: DEEPSEEK_BASE_URL,
      auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          api: "openai-completions",
          provider: "deepseek",
          baseUrl: DEEPSEEK_BASE_URL,
          compat: {"supportsStore":false,"supportsDeveloperRole":false,"requiresReasoningContentOnAssistantMessages":true,"thinkingFormat":"deepseek"},
          reasoning: true,
          thinkingLevelMap: {"minimal":null,"low":null,"medium":null,"high":"high","xhigh":"max"},
          input: ["text"],
          cost: {
            input: 0.14,
            output: 0.28,
            cacheRead: 0.0028,
            cacheWrite: 0,
          },
          contextWindow: 1000000,
          maxTokens: 384000,
        } satisfies Model<"openai-completions">,
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          api: "openai-completions",
          provider: "deepseek",
          baseUrl: DEEPSEEK_BASE_URL,
          compat: {"supportsStore":false,"supportsDeveloperRole":false,"requiresReasoningContentOnAssistantMessages":true,"thinkingFormat":"deepseek"},
          reasoning: true,
          thinkingLevelMap: {"minimal":null,"low":null,"medium":null,"high":"high","xhigh":"max"},
          input: ["text"],
          cost: {
            input: 0.435,
            output: 0.87,
            cacheRead: 0.003625,
            cacheWrite: 0,
          },
          contextWindow: 1000000,
          maxTokens: 384000,
        } satisfies Model<"openai-completions">,
      ],
      api: openAICompletionsApi(),
    };
  const deepseekProvider: Provider<Api> = createProvider(ollamaOptions);

  models.setProvider(ollamaProvider);
  models.setProvider(deepseekProvider);
  return models;
}

/**
 * 练习 pi-agent-core 里 Agent 类的基本使用。
 *
 * Agent 类是对底层 agentLoop 的有状态封装，提供：
 * - prompt(text): 发送用户消息，自动处理流式响应、工具调用
 * - continue(): 从当前上下文继续（不追加新消息）
 * - steer() / followUp(): 在 Agent 运行中插入转向/追问消息
 * - subscribe(): 监听事件流（agent_start, message_start, message_update, tool_execution_start 等）
 * - state: 读写当前状态（systemPrompt, model, thinkingLevel, tools, messages）
 * - abort() / waitForIdle(): 控制运行生命周期
 * - reset(): 清空 transcript 和队列
 *
 * 注意：Agent 不包含 ExecutionEnv / Session 等持久化能力，
 * 需要这些时请使用 AgentHarness。
 */
async function showAgentBasicUsage(): Promise<void> {
  console.log("---------- showAgentBasicUsage ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id)!;
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  // Ollama 本地服务无需 API key，getApiKey 返回 undefined 即可
  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt: "You are a helpful assistant.",
      model: model,
    },
    getApiKey: async (_provider: string) => undefined,
  };

  const agent = new Agent(agentOptions);

  // 监听 agent_start / agent_end
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "agent_start") {
      console.log("\n>>> Agent starting...");
    }
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "agent_end") {
      console.log("\n>>> Agent ended");
    }
  });

  // 监听 message_start / message_end
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_start") {
      console.log(`\n>>> message_start: role=${event.message.role}`);
    }
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_end") {
      console.log(`>>> message_end: role=${event.message.role}`);
    }
  });

  // 监听流式文本输出
  agent.subscribe((event: AgentEvent) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  // 监听工具调用
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "tool_execution_start") {
      console.log(`\n[Agent] tool start: ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      console.log(`[Agent] tool end: ${event.toolName}, isError=${event.isError}`);
    }
  });

  await agent.prompt("Hello!");

  // 查看当前状态
  console.log("\n\n=== Agent 当前状态 ===");
  console.log("model:", agent.state.model.id);
  console.log("thinkingLevel:", agent.state.thinkingLevel);
  console.log("isStreaming:", agent.state.isStreaming);
  console.log("messages count:", agent.state.messages.length);
}


/**
 * 练习 AgentHarness 类的基本使用。
 * 
 * AgentHarness 类主要的外部调用方法如下：
 * 
 * ---
 * 对话交互方法：
 * 
 * - prompt(text, options?)
 *   发送用户消息并等待 Assistant 回复。要求 Agent 处于 idle 状态（否则抛 "busy"）。
 *   内部流程：消费 nextTurnQueue → 触发 before_agent_start 钩子 → 调用底层 runAgentLoop → 返回 AssistantMessage。
 * 
 * - steer(text, options?)
 *   在 Agent 执行期间（非 idle）插入转向消息到 steerQueue，用于中途修正 Agent 行为。
 *   消息会在当前 turn 的下一个 LLM 请求前注入到对话中。idle 状态下调用会抛 "Cannot steer while idle"。
 * 
 * - followUp(text, options?)
 *   在 Agent 执行期间（非 idle）插入追问消息到 followUpQueue，在当前 assistant 回复完成后触发新 turn。
 *   与 steer 不同，followUp 不会中断当前回复，而是在回复结束后才注入。idle 状态下调用会抛 "Cannot follow up while idle"。
 * 
 * - nextTurn(text, options?)
 *   将消息加入 nextTurnQueue，在下一轮 prompt() 调用时自动插入到用户消息之前。
 *   无 idle 限制，可在任意时刻调用。
 * 
 * - abort()
 *   中止当前 Agent 执行：清空 steerQueue/followUpQueue，调用 AbortController.abort()，等待 idle。
 *   返回被清空的 steer 和 followUp 消息列表。
 * 
 * - waitForIdle()
 *   等待当前 runPromise 完成（即 Agent 回到 idle 状态）。通常用于确保上一次操作完全结束。
 * 
 * ---
 * 上下文管理方法：
 * 
 * - appendMessage(message)
 *   直接向 Session 中追加一条消息（不触发 Agent 运行）。idle 时直接写入，非 idle 时加入 pending 队列。
 * 
 * - skill(name, additionalInstructions?)
 *   按名称查找已加载的 Skill，格式化后作为 prompt 发送给 Agent。要求 idle 状态。
 *   内部调用 formatSkillInvocation() 将 skill 包装为 XML 格式的 prompt。
 * 
 * - promptFromTemplate(name, args?)
 *   按名称查找已加载的 PromptTemplate，用 args 替换模板中的占位符（$1, $2, $@ 等），
 *   然后作为 prompt 发送给 Agent。要求 idle 状态。
 * 
 * - compact(customInstructions?)
 *   对当前会话历史进行压缩/摘要，减少 token 消耗。要求 idle 状态。
 *   内部流程：prepareCompaction → session_before_compact 钩子 → compact() 调用 LLM 生成摘要 → 写入 CompactionEntry。
 * 
 * - navigateTree(targetId, options?)
 *   将会话树导航到指定节点（支持分支切换）。要求 idle 状态。
 *   options 支持：summarize（是否生成分支摘要）、customInstructions、replaceInstructions、label。
 *   内部流程：session_before_tree 钩子 → 可选 generateBranchSummary → moveTo 目标节点。
 * 
 * ---
 * 事件订阅方法有如下2个：
 * - subscribe(): 监听所有事件（包括底层 AgentEvent 和 Harness 自有事件），但只能作为观察者，无法干预流程。
 * - on(): 监听特定类型的 Harness 自有事件，可通过注册的 handler 返回结果来干预 Agent 行为（如阻止工具调用、修改 systemPrompt 等）。
 * 
 * 其他大部分方法都被标记为 private，是内部调用的。
 */
async function showAgentHarnessBasicUsage(): Promise<void> {
  console.log("---------- showAgentHarnessBasicUsage ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id)!;
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  // ==========================================
  // 1. 配置 ExecutionEnv（执行环境）
  // ==========================================
  // ExecutionEnv 提供文件系统和 Shell 执行能力，是 AgentHarness 与外部世界交互的桥梁。
  // 所有文件/Shell 操作都返回 Result<T, Error>，永不抛出异常，保证错误可追踪。
  // 这里使用最小化实现（无实际文件系统/Shell），仅用于演示。
  const fakeEnv: ExecutionEnv = {
    cwd: process.cwd(),
    absolutePath: async (path: string) => ({ ok: true as const, value: path }),
    joinPath: async (parts: string[]) => ({ ok: true as const, value: parts.join("/") }),
    readTextFile: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    readTextLines: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    readBinaryFile: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    writeFile: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    appendFile: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    fileInfo: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    listDir: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    canonicalPath: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    exists: async () => ({ ok: true as const, value: false }),
    createDir: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    remove: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    createTempDir: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    createTempFile: async () => ({ ok: false as const, error: new FileError("not_supported", "not implemented") }),
    cleanup: async () => {},
    exec: async () => ({ ok: false as const, error: new ExecutionError("shell_unavailable", "not implemented") }),
  };

  // pi-agent-core 内部也提供了一个基于NodeJS的执行环境
  const nodeEnv: NodeExecutionEnv = new NodeExecutionEnv({
    cwd: process.cwd()
  })

  // ==========================================
  // 2. 创建 Session（会话存储）
  // ==========================================
  // Session 以树形结构存储对话历史，每个条目有唯一 ID 和 parentId。
  // AgentHarness 在每次 turn 结束后自动将消息写入 Session。
  // InMemorySessionRepo 是内存中的实现，适合练习/测试；
  // 生产环境可用 JsonlSessionRepo（文件持久化）。
  const sessionRepo = new InMemorySessionRepo();
  const session: Session = await sessionRepo.create({ id: "demo-session-1" });
  console.log(">>> Session created, id:", (await session.getMetadata()).id);

  // ==========================================
  // 3. 定义 Tool（可选）
  // ==========================================
  // AgentTool 扩展了 pi-ai 的 Tool，增加了 execute 回调和 label/executionMode 等字段。
  // 工具抛出异常时，Agent 会自动捕获并以 isError: true 报告给 LLM。
  // 不要手动返回错误文本——抛出异常让框架处理。
  const getCurrentTimeTool: AgentTool = {
    name: "getCurrentTime",
    label: "获取当前时间",
    description: "获取当前时间，支持指定时区。",
    parameters: Type.Object({
      timezone: Type.Optional(
        Type.String({ description: "时区标识符，如 'Asia/Shanghai'，默认 'Asia/Shanghai'" })
      ),
    }),
    execute: async (toolCallId: string, params: any) => {
      const args = params as { timezone?: string };
      const time = new Date().toLocaleString("zh-CN", {
        timeZone: args.timezone || "Asia/Shanghai",
        dateStyle: "full",
        timeStyle: "long",
      });
      return { content: [{ type: "text" as const, text: `当前时间: ${time}` }], details: { time } };
    },
  };
  const tools: AgentTool[] = [getCurrentTimeTool];

  // ==========================================
  // 4. 加载资源：PromptTemplate 和 Skill
  // ==========================================
  /**
   * loadPromptTemplates() 函数用于从指定的目录中以 非递归方式 加载以 .md 结尾的文件作为提示词模板。
   * loadSkills() 函数用于从指定目录中采用 递归子目录方式 加载 SKILL.md 文件作为 skills；
   * 此外，顶层根目录下的 .md 文件也会被加载为 skills。
   * 
   * 两者底层支持的文件内容格式是一样的，规范如下：
   * 
   * ```markdown
   * ---
   * name: 可选名称（仅 loadSkills 使用，若不提供则取父目录名）
   * description: 可选描述（loadSkills 要求必填，否则跳过该文件）
   * disable-model-invocation: true/false（仅 loadSkills 使用）
   * ---
   * 对于loadPromptTemplates：这里是模板正文内容，支持占位符如 $1、$2、$@、$ARGUMENTS、${@:1}、${@:2:3} 等。
   * 对于loadSkills：这里就是skills的正文，不支持占位符。
   * ```
   * 
   * 其中：
   * - 头部的 yaml 段是可选的，会被作为 frontmatter 信息。几种情况如下：
   * | 场景                           | frontmatter | body             | 是否报错                |
   * | ------------------------------ | ----------- | ---------------- | ----------------------- |
   * | 无 `---`                       | `{}`        | 全文             | 否                      |
   * | 有开头 `---` 无闭合            | `{}`        | 全文（含 `---`） | 否                      |
   * | 正常 YAML frontmatter          | 解析结果    | `---` 之后的内容 | 否                      |
   * | YAML 语法错误                  | —           | —                | **是** (`parse_failed`) |
   * | frontmatter 为空（`---\n---`） | `{}`        | 之后的内容       | 否                      |
   * 
   * - 后面的正文部分，支持多种占位符，如下所示：
   * | 占位符          | 含义                         | 示例                            |
   * | --------------- | ---------------------------- | ------------------------------- |
   * | `$1`, `$2`, ... | 第 N 个位置参数（1-indexed） | `$1` → 第一个参数               |
   * | `$@`            | 所有参数，空格连接           | `$@` → `arg1 arg2 arg3`         |
   * | `$ARGUMENTS`    | 同 `$@`                      | `$ARGUMENTS` → `arg1 arg2 arg3` |
   * | `${@:N}`        | 从第 N 个参数开始的所有参数  | `${@:2}` → `arg2 arg3`          |
   * | `${@:N:L}`      | 从第 N 个参数开始的 L 个参数 | `${@:2:1}` → `arg2`             |
   * 
   */
  // 使用专门的 prompts/ 目录加载模板，避免加载到项目根目录的 README.md、AGENTS.md 等无关文件
  const promptsDirResult = await nodeEnv.absolutePath("prompts");
  const promptsDir = promptsDirResult.ok ? promptsDirResult.value : process.cwd();
  const {promptTemplates: promptTemplates, diagnostics: promptDiagnostics} = await loadPromptTemplates(nodeEnv, promptsDir);
  const {skills: skills, diagnostics: skillDiagnostics} = await loadSkills(nodeEnv, process.cwd());
  const resources: AgentHarnessResources = {
    promptTemplates,
    skills
  }

  // ==========================================
  // 5. 创建 AgentHarness 实例
  // ==========================================
  // AgentHarness 是 Agent 的超集，额外提供：
  // - Session 持久化（对话历史自动写入 Session 树）
  // - ExecutionEnv（文件系统和 Shell 能力）
  // - models（Provider 集合，统一管理认证和请求）
  // - on() 钩子体系（可拦截/修改流程）
  // - compact() / navigateTree()（上下文压缩和分支导航）
  // - skill() / promptFromTemplate()（Skill 和模板调用）
  // systemPrompt 可以是字符串或返回字符串的异步回调函数。
  const harnessOptions: AgentHarnessOptions = {
    env: nodeEnv,
    // env: fakeEnv,
    session,
    models: customModels,         // AgentHarness 通过 models 管理 Provider 集合，统一认证
    model: model,
    systemPrompt: "你是一个智能助手，可以使用一系列工具。后续请用中文回答。",
    tools,
    activeToolNames: ["getCurrentTime"], // 指定哪些工具对模型可见（可运行时切换）
    resources,
    thinkingLevel: "low",
    // 下面两个参数的值，只能从 QueueMode = "all" | "one-at-a-time" 里二选一
    steeringMode: "one-at-a-time",   // 转向消息的队列模式
    followUpMode: "one-at-a-time",   // 追问消息的队列模式
    streamOptions: {
      transport: "auto",
      timeoutMs: 10000,
      maxRetries: 50,
    }
  };

  const harness = new AgentHarness(harnessOptions);
  console.log(">>> AgentHarness created");

  // ==========================================
  // 6. 订阅事件（subscribe）
  // ==========================================
  // subscribe 是纯观察者模式：监听所有事件但不能干预流程。
  // listener 按注册顺序依次 await，agent_end 的 listener 完成前 Agent 不会变为 idle。

  // 监听模型更新
  harness.subscribe((event) => {
    if (event.type === "model_update") {
      console.log(`\n[事件] 模型更新: ${event.previousModel?.id ?? "无"} → ${event.model.id}`);
    }
  });

  // 监听工具调用 - 演示在工具调用时使用 steer() 中途修正行为
  harness.subscribe((event) => {
    if (event.type === "tool_call") {
      console.log(`\n[事件] 工具调用: ${event.toolName}(${JSON.stringify(event.input)})`);
      // steer() 只能在非 idle 状态调用，这里在 turn 执行期间调用是正确的
      // harness.steer("请用中文回答"); // 如需中途修正可取消注释
    }
  });

  // 监听工具结果
  harness.subscribe((event) => {
    if (event.type === "tool_result") {
      const status = event.isError ? "❌ 失败" : "✅ 成功";
      console.log(`[事件] 工具结果: ${event.toolName} ${status}`);
    }
  });

  // 流式输出文本
  harness.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  // ==========================================
  // 7. 注册生命周期钩子（on）
  // ==========================================
  // on() 可以修改/拦截流程。handler 返回的对象会按字段合并到默认行为中。
  // 多个 handler 注册同一类型时，依次执行，最后一个非 undefined 返回值生效。
  // 与 subscribe 不同，on() 的 handler 抛出异常会中断当前 turn。

  // before_agent_start: 在 Agent 开始前修改消息或系统提示
  harness.on("before_agent_start", async (event) => {
    console.log(`\n[钩子] Agent 即将启动，prompt: "${event.prompt}"`);
    // 可以返回修改后的 systemPrompt 或 messages
    return undefined; // 不修改
  });

  // tool_call: 可以阻止特定工具调用
  harness.on("tool_call", async (event) => {
    console.log(`[钩子] 即将执行工具: ${event.toolName}`);
    // return { block: true, reason: "不允许调用此工具" }; // 阻止调用
    return undefined; // 允许调用
  });

  // ==========================================
  // 8. 与 Agent 交互
  // ==========================================

  // 8.1 prompt(): 发送用户消息，返回 AssistantMessage
  console.log("\n\n=== 第一轮对话: prompt() ===");
  const response1 = await harness.prompt("你好，请介绍一下你自己。");
  console.log("\n\n[响应] 消息内容块数:", response1.content.length);

  // 8.2 带工具调用的对话
  console.log("\n\n=== 第二轮对话: 工具调用 ===");
  console.log("用户: 现在几点了？");
  const response2 = await harness.prompt("现在几点了？");
  console.log("\n[响应] 消息内容块数:", response2.content.length);

  // 8.3 steer() vs nextTurn()
  // steer(): 只能在非 idle 状态调用，在当前 turn 的下一个 LLM 请求前注入消息。
  //          工具调用不会被跳过，steer 消息在工具完成后、下一轮 LLM 请求前生效。
  // nextTurn(): 无 idle 限制，在下一轮 prompt() 调用时自动插入到用户消息之前。
  // 这里演示通过 nextTurn() 在下一轮对话前插入指令。
  console.log("\n\n=== nextTurn(): 下轮指令 ===");
  await harness.nextTurn("请用更简洁的方式回答。");
  console.log("下轮指令已加入队列");

  // 8.4 继续对话
  console.log("\n用户: 再次告诉我现在的时间。");
  const response3 = await harness.prompt("再次告诉我现在的时间。");
  console.log("\n[响应] 消息内容块数:", response3.content.length);

  // ==========================================
  // 9. 查看当前状态
  // ==========================================
  console.log("\n\n=== AgentHarness 当前状态 ===");
  console.log("模型:", harness.getModel().id);
  console.log("思考级别:", harness.getThinkingLevel());
  console.log("可用工具:", harness.getTools().map((t) => t.name));
  console.log("活跃工具:", harness.getActiveTools().map((t) => t.name));

  // ==========================================
  // 10. 动态修改配置
  // ==========================================
  // 所有 set* 方法都会自动将变更写入 Session（idle 时直接写，非 idle 时排队到 turn_end）。
  // 这保证了即使崩溃重启，也能从 Session 中恢复到崩溃前的配置状态。
  // await harness.setModel(anotherModel);
  // await harness.setThinkingLevel("high");
  // await harness.setActiveTools(["otherTool"]);

  // ==========================================
  // 11. 等待空闲 & 清理
  // ==========================================
  await harness.waitForIdle();
  console.log("\n>>> AgentHarness 已空闲，演示结束");
}


/**
 * 练习底层 agentLoop / agentLoopContinue 函数。
 *
 * 与 Agent 类不同，底层 API 不维护状态，完全由调用者管理 AgentContext。
 * 适合需要精细控制消息流转、上下文转换的场景。
 *
 * agentLoop(prompts, context, config):
 *   传入新的 prompt 消息，自动追加到 context.messages，返回 EventStream。
 *
 * agentLoopContinue(context, config):
 *   从现有 context 继续（不追加新消息），要求最后一条消息不能是 assistant。
 *   用于在错误后重试等场景。
 *
 * 两者的事件流都是观察性的（observational），不会等待异步事件处理完成。
 * 如果需要消息处理作为工具预检的屏障，使用 Agent 类。
 */
async function showAgentLoopLowLevel(): Promise<void> {
  console.log("---------- showAgentLoopLowLevel ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id)!;
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  // AgentContext 是传递给底层循环的上下文快照，调用者完全拥有其生命周期。
  // 与 Agent 类不同，这里没有自动状态管理——你需要手动维护 messages 数组。
  const context: AgentContext = {
    systemPrompt: "You are a helpful assistant. Reply in Chinese.",
    messages: [],
    tools: [],
  };

  // AgentLoopConfig 是循环的只读配置。
  // convertToLlm 是必须的：将 AgentMessage[] 转换为 LLM 可理解的 Message[]。
  // 默认行为是过滤掉非 user/assistant/toolResult 角色的消息。
  const config: AgentLoopConfig = {
    model,
    convertToLlm: (messages) => messages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
    ),
    // transformContext: 在 convertToLlm 之前调用，用于裁剪旧消息或注入外部上下文
    // transformContext: async (messages) => messages,
  };

  console.log("=== agentLoop 底层示例 ===");

  // 使用 agentLoop 发送新消息
  const userMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "用一句话介绍你自己" }],
    timestamp: Date.now(),
  };

  for await (const event of agentLoop([userMessage], context, config)) {
    switch (event.type) {
      case "agent_start":
        console.log("\n[agentLoop] agent_start");
        break;
      case "agent_end":
        console.log("\n[agentLoop] agent_end");
        break;
      case "message_start":
        console.log(`[agentLoop] message_start: ${event.message.role}`);
        break;
      case "message_end":
        console.log(`[agentLoop] message_end: ${event.message.role}`);
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        break;
    }
  }

  console.log("\n\n=== agentLoopContinue 底层示例 ===");

  // agentLoopContinue 从现有上下文继续，不追加新消息。
  // 要求：context.messages 最后一条不能是 assistant（LLM 协议要求）。
  // 这里先追加一条 user 消息以满足协议要求。
  context.messages.push({
    role: "user",
    content: [{ type: "text", text: "再说一遍" }],
    timestamp: Date.now(),
  });

  for await (const event of agentLoopContinue(context, config)) {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  }
  console.log("");
}


/**
 * 练习 Agent 类的 steering / followUp 队列机制。
 *
 * - steer(message): 在 Agent 非 idle 时插入转向消息，会在当前 turn 的下一个 LLM 请求前注入。
 *   idle 状态下调用会抛 "Cannot steer while idle"。
 * - followUp(message): 在 Agent 非 idle 时插入追问消息，在当前 assistant 回复完成后触发新 turn。
 *   idle 状态下调用会抛 "Cannot follow up while idle"。
 * - nextTurn(message): 加入 nextTurnQueue，在下一轮 prompt() 调用时自动插入到用户消息之前。
 *   无 idle 限制。
 * - abort(): 中止当前执行，清空 steerQueue/followUpQueue。
 *
 * QueueMode 控制队列消费方式：
 * - "one-at-a-time": 每次只消费一条
 * - "all": 一次性消费全部
 */
async function showAgentSteeringFollowUp(): Promise<void> {
  console.log("---------- showAgentSteeringFollowUp ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id)!;
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: "你是一个助手。请用中文回答。",
      model,
    },
    getApiKey: async () => undefined,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
  });

  // steer() 只能在非 idle 状态调用，所以在 subscribe 回调中调用是正确做法。
  // 当工具开始执行时（tool_execution_start），Agent 处于 turn 执行阶段，可以安全调用 steer。
  // steer 消息会在当前 assistant 回复的工具调用完成后、下一轮 LLM 请求前注入。
  agent.subscribe(async (event) => {
    if (event.type === "tool_execution_start") {
      console.log(`\n[steer demo] 工具 ${event.toolName} 开始执行，插入 steer`);
      agent.steer({
        role: "user",
        content: [{ type: "text", text: "请用更简洁的方式回答" }],
        timestamp: Date.now(),
      });
    }
  });

  // 流式输出
  agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log("=== steering / followUp 示例 ===\n");

  // 添加一个 dummy 工具来触发 steer
  agent.state.tools = [{
    name: "dummy",
    label: "dummy",
    description: "A dummy tool",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "done" }],
      details: {},
    }),
  }];

  await agent.prompt("调用 dummy 工具");
  console.log("\n");

  await agent.waitForIdle();
  console.log("[steer demo] 演示结束");
}


/**
 * 练习 Agent 工具执行的高级特性：
 * - ToolExecutionMode: "parallel" vs "sequential"
 * - beforeToolCall / afterToolCall 钩子
 * - 工具 terminate 提示
 * - 工具执行错误处理
 * - 工具 streaming 更新 (onUpdate)
 */
async function showAgentToolExecution(): Promise<void> {
  console.log("---------- showAgentToolExecution ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id)!;
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  // 定义一个带 streaming 更新的工具
  const slowTool: AgentTool = {
    name: "slowProcess",
    label: "慢速处理",
    description: "一个模拟慢速处理的工具，会通过 onUpdate 报告进度",
    parameters: Type.Object({
      steps: Type.Number({ description: "处理步骤数", default: 3 }),
    }),
    // executionMode: "sequential" 表示此工具必须顺序执行。
    // 如果一批工具调用中有任何一个标记为 sequential，整批都会降级为顺序执行。
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate) => {
      const steps = (params as { steps: number }).steps;
      for (let i = 1; i <= steps; i++) {
        if (signal?.aborted) throw new Error("Aborted");
        // 模拟慢速操作
        await new Promise((r) => setTimeout(r, 300));
        onUpdate?.({
          content: [{ type: "text", text: `进度: ${i}/${steps}` }],
          details: { step: i, total: steps },
        });
      }
      return {
        content: [{ type: "text", text: `完成 ${steps} 个步骤` }],
        details: { totalSteps: steps },
      };
    },
  };

  // 定义一个会失败的工具
  const failingTool: AgentTool = {
    name: "mayFail",
    label: "可能失败",
    description: "一个可能失败的工具，用于演示错误处理",
    parameters: Type.Object({
      shouldFail: Type.Boolean({ description: "是否故意失败", default: false }),
    }),
    execute: async (_toolCallId, params) => {
      const { shouldFail } = params as { shouldFail: boolean };
      if (shouldFail) {
        throw new Error("故意失败！");
      }
      return {
        content: [{ type: "text", text: "操作成功" }],
        details: { success: true },
      };
    },
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: "你是一个助手。当用户要求时，使用 slowProcess 或 mayFail 工具。请用中文回答。",
      model,
      tools: [slowTool, failingTool],
    },
    getApiKey: async () => undefined,
    // toolExecution: 全局工具执行模式。
    // "parallel"（默认）: 工具并行执行，tool_execution_end 按完成顺序发出，
    //                    但 toolResult 消息按 assistant 消息中的源码顺序发出。
    // "sequential": 工具逐个执行。
    toolExecution: "parallel",
    // beforeToolCall: 在参数验证后、工具执行前调用。返回 { block: true } 可阻止执行。
    // 此钩子在 tool_execution_start 事件之后运行。
    beforeToolCall: async ({ toolCall, args }) => {
      console.log(`[beforeToolCall] 准备执行: ${toolCall.name}, args:`, JSON.stringify(args));
      // 示例：阻止某个条件
      // if (toolCall.name === "mayFail" && (args as any).shouldFail) {
      //   return { block: true, reason: "不允许故意失败" };
      // }
      return undefined;
    },
    // afterToolCall: 在工具执行完成后、tool_execution_end 事件发出前调用。
    // 可以修改 result 的 content/details/isError/terminate 字段。
    // 省略的字段保持原值不变，不做深度合并。
    afterToolCall: async ({ toolCall, result, isError }) => {
      console.log(`[afterToolCall] 工具完成: ${toolCall.name}, isError=${isError}`);
      if (!isError && toolCall.name === "slowProcess") {
        // 给结果添加时间戳
        return {
          details: {
            ...(result.details as Record<string, unknown>),
            auditedAt: new Date().toISOString(),
          },
        };
      }
      return undefined;
    },
  });

  // 监听工具执行事件
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      console.log(`[event] tool_execution_start: ${event.toolName}`);
    }
    if (event.type === "tool_execution_update") {
      console.log(`[event] tool_execution_update: ${event.toolName}`, JSON.stringify(event.partialResult));
    }
    if (event.type === "tool_execution_end") {
      console.log(`[event] tool_execution_end: ${event.toolName}, isError=${event.isError}`);
    }
  });

  agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log("=== 工具执行高级特性示例 ===\n");

  await agent.prompt("请运行 slowProcess 工具，steps=2");
  console.log("\n");

  await agent.prompt("请运行 mayFail 工具，shouldFail=true");
  console.log("\n");

  await agent.waitForIdle();
  console.log("[tool demo] 演示结束");
}


/**
 * 练习 AgentHarness 的 on() 钩子机制。
 *
 * on() 与 subscribe() 的区别：
 * - subscribe(): 纯观察者，监听所有事件，不能干预流程
 * - on(): 注册特定类型的钩子，handler 返回结果可以影响 Agent 行为
 *
 * 可用的钩子类型（来自 AgentHarnessEventResultMap）：
 * - "before_agent_start": 修改 prompt 前的 systemPrompt 或注入额外消息
 * - "context": 在 convertToLlm 前修改消息列表
 * - "before_provider_request": 修改请求的 streamOptions（headers, metadata 等）
 * - "before_provider_payload": 修改发送给 Provider 的 payload
 * - "after_provider_response": 观察 Provider 响应（无法修改）
 * - "tool_call": 阻止特定工具调用
 * - "tool_result": 修改工具执行结果
 * - "session_before_compact": 干预 compaction 流程
 * - "session_before_tree": 干预分支导航流程
 */
async function showAgentHarnessHooks(): Promise<void> {
  console.log("---------- showAgentHarnessHooks ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id)!;
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  const nodeEnv = new NodeExecutionEnv({ cwd: process.cwd() });
  const sessionRepo = new InMemorySessionRepo();
  const session = await sessionRepo.create({ id: "hooks-demo" });

  const echoTool: AgentTool = {
    name: "echo",
    label: "回显",
    description: "回显输入文本",
    parameters: Type.Object({
      text: Type.String({ description: "要回显的文本" }),
    }),
    execute: async (_toolCallId, params) => {
      const { text } = params as { text: string };
      return {
        content: [{ type: "text", text: `回显: ${text}` }],
        details: { original: text },
      };
    },
  };

  const harness = new AgentHarness({
    env: nodeEnv,
    session,
    models: customModels,
    model,
    systemPrompt: "你是一个助手。请用中文回答。",
    tools: [echoTool],
    activeToolNames: ["echo"],
  });

  // ---------- before_agent_start: 在 prompt 之前修改 systemPrompt 或注入消息 ----------
  // 返回 { systemPrompt } 可替换本轮 systemPrompt；返回 { messages } 可在用户消息前注入额外消息。
  harness.on("before_agent_start", async (event) => {
    console.log(`[hook] before_agent_start: prompt="${event.prompt}"`);
    // 可以返回修改后的 systemPrompt
    // return { systemPrompt: "你是一个更简洁的助手" };
    // 或注入额外消息
    // return { messages: [{ role: "user", content: [{ type: "text", text: "前置消息" }], timestamp: Date.now() }] };
    return undefined;
  });

  // ---------- context: 在 convertToLlm 前修改消息列表 ----------
  // 返回 { messages } 可替换整个消息列表。这是裁剪上下文、注入系统级消息的理想位置。
  harness.on("context", async (event) => {
    console.log(`[hook] context: messages count=${event.messages.length}`);
    // 可以过滤或修改消息
    return undefined;
  });

  // ---------- tool_call: 阻止特定工具调用 ----------
  // 返回 { block: true, reason } 可阻止工具执行，Agent 会生成一个 isError 的工具结果。
  harness.on("tool_call", async (event) => {
    console.log(`[hook] tool_call: ${event.toolName}`);
    // 示例：阻止 echo 工具当 text 包含 "secret" 时
    if (event.toolName === "echo" && event.input.text === "secret") {
      return { block: true, reason: "不允许回显敏感内容" };
    }
    return undefined;
  });

  // ---------- tool_result: 修改工具执行结果 ----------
  // 返回 { content, details, isError, terminate } 可按字段覆盖工具结果。
  // terminate: true 可提示 Agent 在整批工具都终止时跳过后续 LLM 调用。
  harness.on("tool_result", async (event) => {
    console.log(`[hook] tool_result: ${event.toolName}, isError=${event.isError}`);
    return undefined;
  });

  // ---------- before_provider_request: 修改发送给 LLM Provider 的请求参数 ----------
  // 返回 { streamOptions } 可修改 headers, metadata, timeoutMs, maxRetries 等。
  // 这是注入认证 header、自定义 metadata 的标准方式。
  harness.on("before_provider_request", async (event) => {
    console.log(`[hook] before_provider_request: model=${event.model.id}`);
    // 可以修改 headers, metadata, timeoutMs 等
    // return { streamOptions: { headers: { "X-Custom": "value" } } };
    return undefined;
  });

  // 流式输出
  harness.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log("=== AgentHarness 钩子示例 ===\n");

  await harness.prompt("你好");
  console.log("\n");

  await harness.prompt("请使用 echo 工具回显 'hello world'");
  console.log("\n");

  await harness.prompt("请使用 echo 工具回显 'secret'");
  console.log("\n");

  await harness.waitForIdle();
  console.log("[hooks demo] 演示结束");
}


/**
 * 练习 Session（会话存储）相关功能。
 *
 * Session 是 AgentHarness 的持久化层，以树形结构存储对话历史：
 * - 每个条目有唯一 ID 和 parentId，形成树形结构
 * - 支持分支（branching）：可以从任意节点 fork
 * - 支持 compaction：压缩历史以减少 token 消耗
 * - 支持 label：给节点打标签
 *
 * 两种实现：
 * - InMemorySessionRepo: 内存存储，适合测试
 * - JsonlSessionRepo: JSONL 文件持久化，适合生产
 */
async function showAgentHarnessSession(): Promise<void> {
  console.log("---------- showAgentHarnessSession ----------")

  // Session 以树形结构存储对话历史，每个条目有唯一 ID 和 parentId。
  // 支持分支（fork）、标签（label）、压缩（compaction）等操作。
  const sessionRepo = new InMemorySessionRepo();
  const session = await sessionRepo.create({ id: "session-demo" });

  // 获取元数据
  const metadata = await session.getMetadata();
  console.log("=== Session 示例 ===");
  console.log("Session ID:", metadata.id);
  console.log("Created at:", metadata.createdAt);

  // appendMessage: 直接向 Session 写入消息，不触发 Agent 运行。
  // 这在回放历史、导入外部对话等场景中很有用。
  await session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Hello" }],
    timestamp: Date.now(),
  });

  await session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Hi there!" }],
    api: "openai-completions",
    provider: "ollama",
    model: "qwen3.5:9b",
    stopReason: "stop",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  });

  // getBranch(): 获取从根节点到当前叶子节点的完整路径。
  // 如果存在 compaction，compaction 之前的条目会被压缩摘要替代。
  const branch = await session.getBranch();
  console.log("Branch entries count:", branch.length);
  for (const entry of branch) {
    console.log(`  - [${entry.type}] id=${entry.id}`);
  }

  // buildContext(): 从 Session 树中重建 AgentContext。
  // 内部调用 buildSessionContext()，处理 compaction 摘要、模型变更、thinking level 变更等。
  const context = await session.buildContext();
  console.log("Context messages:", context.messages.length);
  console.log("Context thinkingLevel:", context.thinkingLevel);
  console.log("Context model:", context.model);

  // 获取所有条目
  const allEntries = await session.getEntries();
  console.log("Total entries:", allEntries.length);

  // appendLabel: 给指定节点打标签，方便后续通过标签查找和导航。
  const leafId = await session.getLeafId();
  if (leafId) {
    await session.appendLabel(leafId, "greeting-round");
    const label = await session.getLabel(leafId);
    console.log(`Label for ${leafId}:`, label);
  }

  console.log("[session demo] 演示结束");
}


/**
 * 练习 AgentHarness 的动态配置能力。
 *
 * AgentHarness 支持运行时修改：
 * - setModel(model): 切换模型，自动记录到 Session
 * - setThinkingLevel(level): 切换思考级别
 * - setTools(tools, activeNames?): 替换工具集合
 * - setActiveTools(names): 切换活跃工具
 * - setResources(resources): 更新资源（skills, promptTemplates）
 * - setStreamOptions(options): 更新请求参数
 * - setSteeringMode(mode) / setFollowUpMode(mode): 切换队列模式
 *
 * 每次变更都会触发对应的事件，并持久化到 Session。
 */
async function showAgentHarnessConfig(): Promise<void> {
  console.log("---------- showAgentHarnessConfig ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id)!;
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  const nodeEnv = new NodeExecutionEnv({ cwd: process.cwd() });
  const sessionRepo = new InMemorySessionRepo();
  const session = await sessionRepo.create({ id: "config-demo" });

  const harness = new AgentHarness({
    env: nodeEnv,
    session,
    models: customModels,
    model,
    systemPrompt: "你是一个助手。请用中文回答。",
  });

  // 所有 set* 方法都会触发对应的 Harness 自有事件。
  // 这些事件在 Agent 的底层事件之外独立发出。
  harness.subscribe((event) => {
    if (event.type === "model_update") {
      console.log(`[config] 模型切换: ${event.previousModel?.id ?? "无"} → ${event.model.id}`);
    }
    if (event.type === "thinking_level_update") {
      console.log(`[config] 思考级别切换: ${event.previousLevel} → ${event.level}`);
    }
    if (event.type === "tools_update") {
      console.log(`[config] 工具更新: active=[${event.activeToolNames}] source=${event.source}`);
    }
    if (event.type === "resources_update") {
      console.log(`[config] 资源更新: skills=${event.resources.skills?.length ?? 0}`);
    }
  });

  console.log("=== AgentHarness 动态配置示例 ===\n");

  // 查看当前配置
  console.log("初始模型:", harness.getModel().id);
  console.log("初始思考级别:", harness.getThinkingLevel());
  console.log("初始工具:", harness.getTools().map((t) => t.name));
  console.log("初始活跃工具:", harness.getActiveTools().map((t) => t.name));

  // setThinkingLevel: 切换思考级别，自动记录到 Session（thinking_level_change 条目）。
  // 下次从 Session 恢复时，thinkingLevel 会自动还原。
  await harness.setThinkingLevel("medium");
  console.log("修改后思考级别:", harness.getThinkingLevel());

  // 获取当前 stream options
  const streamOpts = harness.getStreamOptions();
  console.log("Stream options:", JSON.stringify(streamOpts));

  // 获取当前资源
  const resources = harness.getResources();
  console.log("Skills count:", resources.skills?.length ?? 0);
  console.log("Prompt templates count:", resources.promptTemplates?.length ?? 0);

  // 获取 steering / followUp 模式
  console.log("Steering mode:", harness.getSteeringMode());
  console.log("FollowUp mode:", harness.getFollowUpMode());

  await harness.waitForIdle();
  console.log("[config demo] 演示结束");
}


/**
 * 练习 Agent.continue() 方法。
 *
 * continue() 从当前上下文恢复执行，不追加新消息。
 * 要求上下文中最后一条消息不能是 assistant 角色。
 * 适用场景：错误后重试、手动追加消息后继续。
 */
async function showAgentContinue(): Promise<void> {
  console.log("---------- showAgentContinue ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id)!;
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant.",
      model,
    },
    getApiKey: async () => undefined,
  });

  agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  console.log("=== Agent.continue() 示例 ===\n");

  // 先发一条消息
  await agent.prompt("Hello");
  console.log("\n");

  // prompt() 返回后，最后一条消息是 assistant。
  // continue() 要求最后一条消息是 user 或 toolResult（LLM 协议约束）。
  // 如果最后一条是 assistant，continue() 会先尝试消费 steer/followUp 队列，
  // 队列也为空时才抛出 "Cannot continue from message role: assistant"。
  agent.state.messages.push({
    role: "user",
    content: [{ type: "text", text: "再说一遍" }],
    timestamp: Date.now(),
  });

  // continue() 从当前上下文恢复执行，不追加新消息。
  // 内部调用 runAgentLoopContinue()，复用现有 messages 发起 LLM 请求。
  await agent.continue();
  console.log("\n");

  await agent.waitForIdle();
  console.log("[continue demo] 演示结束");
}


/**
 * 练习 Agent.reset() 方法和状态管理。
 *
 * reset() 清空：
 * - messages 数组
 * - isStreaming 标志
 * - streamingMessage
 * - pendingToolCalls
 * - errorMessage
 * - steerQueue 和 followUpQueue
 *
 * 注意：reset() 不会清空 systemPrompt、model、thinkingLevel、tools。
 */
async function showAgentStateManagement(): Promise<void> {
  console.log("---------- showAgentStateManagement ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id)!;
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant.",
      model,
      thinkingLevel: "low",
      tools: [],
    },
    getApiKey: async () => undefined,
  });

  console.log("=== Agent 状态管理示例 ===\n");

  // Agent.state 是读写属性。
  // 赋值 state.tools 或 state.messages 时，顶层数组会被浅拷贝后存储。
  // 修改返回的数组（如 push）会直接影响 Agent 内部状态。
  console.log("初始 thinkingLevel:", agent.state.thinkingLevel);
  agent.state.thinkingLevel = "medium";
  console.log("修改后 thinkingLevel:", agent.state.thinkingLevel);

  // systemPrompt 在每次 LLM 请求时作为系统消息发送，可随时修改。
  agent.state.systemPrompt = "你是一个幽默的助手";
  console.log("修改后 systemPrompt:", agent.state.systemPrompt);

  // isStreaming: 在 prompt() 调用期间为 true，agent_end 的 listener 全部完成后才变为 false。
  console.log("isStreaming:", agent.state.isStreaming);

  // errorMessage: 最近一次失败的 assistant turn 的错误消息（来自 stopReason="error" 的 assistant 消息）。
  console.log("errorMessage:", agent.state.errorMessage);

  // pendingToolCalls: 当前正在执行中的工具调用 ID 集合。
  console.log("pendingToolCalls size:", agent.state.pendingToolCalls.size);

  // reset(): 清空 messages、isStreaming、streamingMessage、pendingToolCalls、
  //          errorMessage、steerQueue、followUpQueue。
  //          不会清空 systemPrompt、model、thinkingLevel、tools。
  agent.reset();
  console.log("reset 后 messages count:", agent.state.messages.length);
  console.log("reset 后 isStreaming:", agent.state.isStreaming);
  // systemPrompt 不会被 reset 清空
  console.log("reset 后 systemPrompt:", agent.state.systemPrompt);

  // hasQueuedMessages(): 检查 steerQueue 或 followUpQueue 中是否有待处理消息。
  // reset() 会清空队列，所以这里应为 false。
  console.log("hasQueuedMessages:", agent.hasQueuedMessages());

  await agent.waitForIdle();
  console.log("[state demo] 演示结束");
}


async function main(): Promise<void> {
  // === 基础 Agent 类 ===
  await showAgentBasicUsage();
  await showAgentContinue();

  // === AgentHarness 基础 ===
  await showAgentHarnessBasicUsage();

  // === 底层 API ===
  await showAgentLoopLowLevel();

  // === 高级特性 ===
  await showAgentSteeringFollowUp();
  await showAgentToolExecution();

  // === AgentHarness 进阶 ===
  await showAgentHarnessHooks();
  await showAgentHarnessSession();
  await showAgentHarnessConfig();

  // === 状态管理 ===
  await showAgentStateManagement();
}

await main();
