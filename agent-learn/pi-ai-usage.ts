/**
 * 研究 pi-ai 使用。
 * 使用参考文档见 packages/ai/README.md。
 * 
 * 注意：v0.80.0 版本相比于 v0.78.0 版本，在 Model / Provider 方面进行了一次小规模重构，
 * 迁移过程可以参考 packages/ai/README.md 里的 "Migrating from the Old Global API" 章节。
 */
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
// ------ compat 中的 Provider/Model 是旧版的全局API，不推荐使用了 ------
// import { 
//   getProviders, getModels, getModel,
//   stream, complete, streamSimple, completeSimple,
// } from "@earendil-works/pi-ai/compat"
// ------ 新版的 Provider + Models API ------
import { 
  builtinModels, builtinProviders, 
  getBuiltinModels, getBuiltinProviders, getBuiltinModel,
} from '@earendil-works/pi-ai/providers/all';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
// import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
// import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
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

const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_API_KEY = "";
const USED_MODEL = {provider: "ollama", id: "qwen3.5:8b"};
// const USED_MODEL = {provider: "deepseek", id: "deepseek-v4-flash"};

/**
 * pi-ai 中对模型的抽象分为 3 个层次：
 * 
 *  - interface Models: 为所有的模型使用提供了一个统一的注册对象。
 *    - 用于注册多个模型提供商Provider的不同模型。
 *    - 提供了 Provider / Model 获取的方法
 *    - 提供了 stream / complete / streamSimple / completeSimple 等请求方法
 *    - 提供了 getAuth() 用于查询认证状态
 *    - 提供了 refresh() 用于刷新动态模型列表
 *    - 一般通过 createModels() / builtinModels() 方法获取
 * 
 *  - interface Provider: 它是 runtime unit，包含了模型配置、API-Key、stream 方法
 *    - 通过 createProvider() 或内置工厂函数（如 deepseekProvider()）创建
 *    - 每个 Provider 拥有自己的 auth 解析逻辑（env var / 存储凭证 / OAuth）
 * 
 *  - interface Model: 它是某个模型的静态配置（纯数据），不包含请求方法。
 *    - 包含 id、name、api、provider、baseUrl、cost、contextWindow、maxTokens 等字段
 *    - 可以通过 hasApi() 类型守卫来窄化到特定 API 以获取完整的 options 类型
 */
function showModelsUsage() {
  console.log("---------- showModelsUsage ----------")

  console.log("\n========== 创建 Models 并注册 Provider ==========");

  // 1. 使用 createModels 创建一个空的 Models 注册对象
  const models: MutableModels = createModels();
  // 2. 手动注册需要的 Provider
  models.setProvider(deepseekProvider());
  models.setProvider(openaiProvider());

  // 也可以直接使用注册了所有内置模型提供商的 Models
  const modelsAll: MutableModels = builtinModels(); 

  console.log("\n========== 查询 Provider / Model ==========");

  // ---- 查询 Provider ----
  const providers = models.getProviders();           // 所有已注册的 Provider 对象
  const provider = models.getProvider('deepseek');   // 按 id 查找单个 Provider

  // ---- 查询 Model（同步，返回最后已知的列表） ----
  const all = models.getModels();                    // 所有 Provider 的所有 Model
  const deepseekModels = models.getModels('deepseek'); // 按 provider 过滤
  const model = models.getModel('deepseek', 'deepseek-v4-flash'); // 按 provider + model id 查找

  console.log("\n========== 模型元数据查询 ==========");

  // ---- 模型元数据查询 ----
  if (model) {
    console.log(`Model: ${model.id} (${model.name})`);
    console.log(`  API: ${model.api}`);
    console.log(`  Provider: ${model.provider}`);
    console.log(`  Context window: ${model.contextWindow} tokens`);
    console.log(`  Max output: ${model.maxTokens} tokens`);
    console.log(`  Supports vision: ${model.input.includes('image')}`);
    console.log(`  Supports reasoning: ${model.reasoning}`);
    console.log(`  Cost: $${model.cost.input}/M input, $${model.cost.output}/M output`);

    // hasApi() 类型守卫：窄化 Model<Api> 到具体的 API 类型
    if (hasApi(model, 'openai-completions')) {
      // model 现在被窄化为 Model<'openai-completions'>，可以安全使用 compat 属性
      console.log(`  Compat settings:`, model.compat);
    }
  }

  console.log("\n========== 动态刷新 / 认证 / 凭证 / 模型比较 ==========");

  // ---- 动态刷新模型列表（仅对动态 Provider 有效，内置 Provider 是 no-op） ----
  // await models.refresh();           // 并发刷新所有 Provider
  // await models.refresh('deepseek'); // 刷新指定 Provider

  // ---- 查询认证状态 ----
  // const auth = await models.getAuth(model);
  // if (auth) {
  //   console.log(`Auth source: ${auth.source}`); // e.g. "DEEPSEEK_API_KEY"
  // }

  // ---- 使用 CredentialStore 持久化凭证 ----
  // const store = new InMemoryCredentialStore();
  // const modelsWithStore = createModels({ credentials: store });
  // 也可以传入自定义的持久化存储（如文件系统、localStorage 等）

  // ---- 使用 modelsAreEqual 比较两个 Model 是否相同 ----
  const model2 = models.getModel('deepseek', 'deepseek-v4-flash');
  console.log(`Models equal: ${modelsAreEqual(model, model2)}`); // true
}

/**
 * pi-ai 提供的一系列静态模型查询工具函数（来自 providers/all）。
 * 这些函数直接从生成的目录中读取，不依赖 Models 集合，适合工具脚本和类型推导场景。
 * 
 * - builtinProviders(): 返回所有内置 Provider 的数组，用于自行注册到 createModels() 中
 * - getBuiltinModels(provider?): 获取内置模型列表，可按 provider 过滤
 * - getBuiltinProviders(): 获取内置 Provider 列表
 * - getBuiltinModel(provider, id): 精确查找单个内置模型，返回完整类型（如 Model<'openai-responses'>）
 * 
 * 与 Models 集合方法的区别：
 * - getBuiltin* 是静态查询，不需要 Models 实例，返回类型更精确（字面量类型）
 * - models.getModel() 是运行时查询，动态模型列表也适用，返回 Model<Api>（需 hasApi 窄化）
 */
function showModelsUtilFunctionUsage() {
  console.log("---------- showModelsUtilFunctionUsage ----------")

  console.log("\n========== builtinProviders / getBuiltinProviders ==========");

  // 获取所有内置 Provider（可用于自行注册到 createModels() 中）
  const allProviders: Provider<Api>[] = builtinProviders();
  console.log(`Builtin providers count: ${allProviders.length}`);
  for (const p of allProviders) {
    console.log(`  - ${p.id}: ${p.name}`);
  }

  // 获取所有内置 Provider 名称（字符串数组）
  const providerNames: string[] = getBuiltinProviders();
  console.log(`Provider names: ${providerNames.join(', ')}`);

  console.log("\n========== getBuiltinModels ==========");

  // 按 Provider 获取模型（需要传入 provider 参数）
  const openaiModels = getBuiltinModels('openai');
  console.log(`OpenAI models: ${openaiModels.length}`);
  for (const m of openaiModels) {
    console.log(`  - ${m.id}: ${m.name} (context: ${m.contextWindow}, reasoning: ${m.reasoning})`);
  }

  console.log("\n========== getBuiltinModel + getSupportedThinkingLevels ==========");

  // 精确查找单个模型 — 返回完整字面量类型，无需 hasApi 窄化
  const gpt4o = getBuiltinModel('openai', 'gpt-4o-mini');
  if (gpt4o) {
    // gpt4o 类型为 Model<'openai-responses'>，可以直接使用 API 特定选项
    console.log(`Found: ${gpt4o.name}`);
    console.log(`  Reasoning: ${gpt4o.reasoning}`);
    // 支持的推理级别
    const levels = getSupportedThinkingLevels(gpt4o);
    console.log(`  Supported thinking levels: ${levels.join(', ')}`);
  }

  // 注意：getBuiltinModel 只查内置目录，对动态 Provider（如 Ollama 自定义）返回 undefined
}

/**
 * pi-ai 自定义 Provider。
 * 一般适用于本地模型服务或者自建模型服务，比如 Ollama、vLLM、LM Studio 等。
 * 
 * 使用 createProvider() 函数，需要提供：
 *   - id / name: Provider 标识
 *   - auth: 认证方式（envApiKeyAuth 或自定义 resolve）
 *   - models: 模型列表（静态）或 + refreshModels（动态）
 *   - api: ProviderStreams 实现（来自 @earendil-works/pi-ai/api/*.lazy）
 * 
 * 对于 OpenAI 兼容的服务，使用 openAICompletionsApi() 作为 api 实现。
 * 对于 Anthropic 兼容的服务，使用 anthropicMessagesApi()。
 * 混合 API 的 Provider 可以传一个按 model.api 分发的映射表。
 * 
 * 不过有一点，Provider接口里，只有一个返回所有模型的 getModels() 方法，不能按照模型名称进行准确查询，
 * 所以还是建议将其注册到 Models 里。
 */
function showCreateProviderUsage() {
  console.log("---------- showCreateProviderUsage ----------")

  console.log("\n========== 示例1: 静态 Ollama Provider ==========");

  // ===== 示例1: 创建静态模型列表的 Ollama Provider =====
  // 先配置 Provider 的options
  const options: CreateProviderOptions<Api> = {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: OLLAMA_BASE_URL,
    // 认证：本地服务无需 key，但每个 Provider 必须有 auth 声明
    // resolve 返回 { auth: {} } 表示"已配置但无需 key"
    auth: {
      apiKey: {
        name: 'Ollama',
        resolve: async () => ({ auth: {} }),
      },
    },
    // 静态模型列表
    models: [
      {
        id: 'llama-3.1-8b',
        name: 'Llama 3.1 8B (Ollama)',
        api: 'openai-completions',
        provider: 'ollama',
        baseUrl: OLLAMA_BASE_URL,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32000,
      },
    ],
    // OpenAI 兼容 API 实现
    api: openAICompletionsApi(),
  }
  // 调用 createProvider() 函数创建
  const ollamaProvider = createProvider(options);

  console.log("\n========== 示例2: 使用 envApiKeyAuth 的动态 Provider ==========");

  // ===== 示例2: 使用 envApiKeyAuth 创建带 API Key 的自定义代理 =====
  const proxyProvider = createProvider({
    id: 'my-proxy',
    name: 'My Proxy',
    // envApiKeyAuth: 先查存储凭证，再查环境变量
    auth: { apiKey: envApiKeyAuth('My Proxy API Key', ['MY_PROXY_API_KEY']) },
    models: [],
    // 动态模型列表：首次 refresh() 时从远程获取
    refreshModels: async () => {
      // 实际场景：fetch('http://my-proxy/v1/models') 并映射为 Model[]
      return [];
    },
    api: openAICompletionsApi(),
  });

  console.log("\n========== 示例3: 带兼容性配置的推理模型 ==========");

  // ===== 示例3: 带兼容性配置的模型（用于非标准 OpenAI 兼容服务）=====
  const ollamaReasoningModel: Model<'openai-completions'> = {
    id: 'qwen3:14b',
    name: 'Qwen3 14B (Ollama)',
    api: 'openai-completions',
    provider: 'ollama',
    baseUrl: OLLAMA_BASE_URL,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32000,
    // 映射 pi 思考级别到模型实际支持的值，null 表示不支持该级别
    thinkingLevelMap: {
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
    },
    // 兼容性配置：Ollama 不支持 developer role 和 reasoning_effort
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
  // 将带推理的模型也注册到 Provider 中（需要重新 createProvider 或使用动态模型）

  console.log(`Created Ollama provider: ${ollamaProvider.id}`);
  console.log(`Models: ${ollamaProvider.getModels().length}`);
}

/**
 * 工具函数：创建注册了 自定义 Provider 的 Models 集合，供后续示例使用。
 * 返回 MutableModels，可以通过 getModel() 按名称精确查找模型。
 * 如果使用Ollama模型，使用前确保本地 Ollama 服务已启动（默认 http://localhost:11434）。
 * 注册的模型：
 *   - qwen3:8b     — 基础对话模型，无推理能力
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
      // 注册两个模型：一个基础模型，一个推理模型
      models: [
        {
          id: 'qwen3:8b',
          name: 'Qwen3 8B (Ollama)',
          api: 'openai-completions',
          provider: 'ollama',
          baseUrl: OLLAMA_BASE_URL,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 32000,
        },
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

  // DeepSeek 模型 Provider（非官方）
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
 * 练习 pi-ai 的模型基本调用（流式 + 非流式）。
 * 
 * 核心流程：
 *   1. 获取 Provider → 获取 Model
 *   2. 构建 Context（systemPrompt + messages）
 *   3. 调用 stream() 进行流式输出，或 complete() 获取完整结果
 *   4. 从 AssistantMessage 中获取 usage（token 消耗）和 cost（费用）
 *   5. 将 assistant 消息 push 回 context.messages，继续多轮对话
 */
async function showModelUsage(): Promise<void> {
  console.log("---------- showModelUsage ----------")

  const customModels = getCustomModels();

  // 通过 getModel() 按名称精确查找模型
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id);
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  // 初始化上下文
  const context: Context = {
    systemPrompt: "You are a helpful assistant.",
    messages: [{ role: "user", content: "你好啊，请用一句话介绍你自己", timestamp: Date.now() }],
  };

  console.log("\n========== 方式1: 流式调用 stream() ==========");

  // ===== 方式1: 流式调用 stream() =====
  // stream() 返回 AssistantMessageEventStream，是一个 AsyncIterable
  const s: AssistantMessageEventStream = customModels.stream(model, context);

  console.log("\n\n>>> Stream Chat with Ollama Model:\n");
  for await (const event of s) {
    switch (event.type) {
      case "start":
        // stream 开始，event.partial 是初始的 AssistantMessage 骨架
        console.log(`[Stream started, model: ${event.partial.model}]`);
        break;
      case "text_start":
        console.log("\n[Text started]");
        break;
      case "text_delta":
        // 增量文本，逐字输出
        process.stdout.write(event.delta);
        break;
      case "text_end":
        console.log("\n[Text ended]");
        break;
      case "thinking_start":
        // 推理模型开始思考（仅 reasoning: true 的模型）
        console.log("[Model is thinking...]");
        break;
      case "thinking_delta":
        // 思考过程增量
        process.stdout.write(event.delta);
        break;
      case "thinking_end":
        console.log("[Thinking complete]");
        break;
      case "toolcall_start":
        console.log(`\n[Tool call started: index ${event.contentIndex}]`);
        break;
      case "toolcall_delta":
        // 工具调用参数的增量 JSON 片段
        const partialCall = event.partial.content[event.contentIndex];
        if (partialCall.type === "toolCall") {
          console.log(`[Streaming args for ${partialCall.name}]`);
        }
        break;
      case "toolcall_end":
        // 工具调用完成，参数已完整但未验证
        console.log(`\nTool called: ${event.toolCall.name}`);
        console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
        break;
      case "done":
        // 正常结束，event.reason 为 "stop" | "length" | "toolUse"
        console.log(`\n[Finished: ${event.reason}]`);
        break;
      case "error":
        // 错误或中止，event.reason 为 "error" | "aborted"
        console.error(`[Error: ${event.reason}]`, event.error.errorMessage);
        break;
    }
  }

  // 流结束后通过 result() 获取最终的 AssistantMessage
  const finalMessage = await s.result();
  console.log(
    "\n\n>>> Stream Chat final result:\n",
    JSON.stringify(finalMessage.content, null, 2),
  );
  // 打印 token 消耗和费用
  console.log(`Tokens: ${finalMessage.usage.input} in / ${finalMessage.usage.output} out`);
  console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(6)}`);
  // 将 assistant 消息加入上下文，以便继续多轮对话
  context.messages.push(finalMessage);

  console.log("\n========== 方式2: 非流式调用 complete() ==========");

  // ===== 方式2: 非流式调用 complete() =====
  // Models 上提供了 complete() 便捷方法，等价于 stream().result()
  context.messages.push({
    role: "user",
    content: "再用一句话总结你刚才说的话",
    timestamp: Date.now(),
  });
  const response = await customModels.complete(model, context);
  console.log("\n\n>>> Complete (non-streaming):");
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(block.text);
    } else if (block.type === "thinking") {
      console.log(`[Thinking: ${block.thinking}]`);
    }
  }
  // 使用 calculateCost 手动计算费用
  const cost = calculateCost(model, response.usage);
  console.log(`Calculated cost: $${cost.total.toFixed(6)}`);

  console.log("\n========== 方式3: 使用 abort 中止请求 ==========");

  // ===== 方式3: 使用 abort 中止请求 =====
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1000); // 1秒后中止

  const abortStream = customModels.stream(
    model, 
    {
      messages: [{ role: "user", content: "请写一篇很长的文章", timestamp: Date.now() }],
    }, 
    { signal: controller.signal }
  );

  for await (const event of abortStream) {
    if (event.type === "text_delta") {
      process.stdout.write(event.delta);
    } else if (event.type === "error") {
      console.log(`\n[Request ${event.reason === 'aborted' ? 'aborted' : 'errored'}]`);
    }
  }
  const aborted = await abortStream.result();
  console.log(`Aborted message stopReason: ${aborted.stopReason}`);
  // 被中止的消息也可以加入上下文，在后续请求中继续
  // context.messages.push(aborted);
}


/**
 * 练习 pi-ai 的工具调用（Tool Calling / Function Calling）。
 * 
 * 核心流程：
 *   1. 使用 TypeBox (Type.Object, Type.String 等) 定义工具参数的 schema
 *   2. 将 Tool 附加到 Context.tools 中
 *   3. 调用模型，模型可能返回 toolCall 类型的 content block
 *   4. 执行工具逻辑，将结果包装为 ToolResultMessage 追加到 context
 *   5. 再次调用模型，让其基于工具结果生成最终回复
 * 
 * 验证工具参数：
 *   - validateToolCall(tools, toolCall): 校验 + 类型转换（如字符串 "5" → 数字 5），验证失败抛异常
 *   - validateToolArguments(tool, args): 与 validateToolCall 类似，但接收 Tool + 原始 arguments
 */
async function showToolCallingUsage() {
  console.log("---------- showToolCallingUsage ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id);
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  console.log("\n========== 定义工具并调用模型 ==========");

  // 1. 定义工具描述的 schema，使用 TypeBox 来定义参数的结构
  //    注意：这里只需要定义 schema，不需要提供工具的实现
  const tools: Tool[] = [
    {
      name: "getCurrentTime",
      description: "Get the current time in a specified timezone.",
      parameters: Type.Object({
        timezone: Type.Optional(
          Type.String({
            description:
              "Timezone identifier, e.g. 'UTC', 'America/New_York', default 'Asia/Shanghai'",
          }),
        ),
      }),
    },
    {
      name: "calculate",
      description: "Perform a simple arithmetic calculation.",
      parameters: Type.Object({
        expression: Type.String({
          description: "Math expression to evaluate, e.g. '2 + 3 * 4'",
        }),
      }),
    },
  ];

  // 2. 将 Tool 附加到 Context 中
  const context: Context = {
    systemPrompt: "You are a helpful assistant with access to tools. Use them when appropriate.",
    messages: [
      {
        role: "user",
        content: "你好，请问现在是什么时间？另外帮我算一下 123 * 456 等于多少",
        timestamp: Date.now(),
      },
    ],
    tools,
  };

  // 3. 使用 complete() 获取完整响应（非流式，适合工具调用场景）
  const response = await customModels.complete(model, context);
  console.log(`\n>>> Stop reason: ${response.stopReason}`);
  console.log(">>> Response content blocks:");
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(`  [text]: ${block.text}`);
    } else if (block.type === "toolCall") {
      console.log(`  [toolCall]: ${block.name}(${JSON.stringify(block.arguments)})`);
    }
  }

  // 4. 将 assistant 消息追加到上下文
  context.messages.push(response);

  console.log("\n========== 处理工具调用 ==========");

  // 5. 处理工具调用
  console.log("\n>>> Processing Tool Calls...");
  const toolCalls = response.content.filter((b): b is ToolCall => b.type === "toolCall");
  for (const call of toolCalls) {
    // 使用 validateToolCall 校验参数（自动进行类型转换，失败时抛出异常）
    let result: string;
    try {
      const validatedArgs = validateToolCall(tools, call);
      // 根据工具名称执行对应逻辑
      switch (call.name) {
        case "getCurrentTime":
          result = new Date().toLocaleString("zh-CN", {
            timeZone: validatedArgs.timezone || "Asia/Shanghai",
            dateStyle: "full",
            timeStyle: "long",
          });
          break;
        case "calculate":
          try {
            // 注意：生产环境应使用安全的表达式求值库
            result = `Result: ${eval(validatedArgs.expression)}`;
          } catch {
            result = `Error evaluating expression: ${validatedArgs.expression}`;
          }
          break;
        default:
          result = `Unknown tool: ${call.name}`;
      }
    } catch (validationError) {
      // 参数校验失败时，将错误信息作为 isError: true 的 toolResult 返回
      // 模型可以利用这个错误信息重新尝试
      result = `Validation error: ${(validationError as Error).message}`;
      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: result }],
        isError: true,
        timestamp: Date.now(),
      });
      continue;
    }

    // 添加工具结果到上下文
    console.log(`  ${call.name}: ${result}`);
    context.messages.push({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: result }],
      isError: false,
      timestamp: Date.now(),
    });
  }

  console.log("\n========== 继续对话（基于工具结果） ==========");

  // 6. 如果有工具调用，让模型基于工具结果继续生成回复
  if (toolCalls.length > 0) {
    const continuation = await customModels.complete(model, context);
    context.messages.push(continuation);
    console.log("\n>>> After tool execution:");
    for (const block of continuation.content) {
      if (block.type === "text") {
        console.log(`  ${block.text}`);
      }
    }
  }

  console.log(`\n>>> Conversation has ${context.messages.length} messages`);
}


// ===============================================================
// 以下为进阶示例
// ===============================================================

/**
 * 练习 pi-ai 的错误处理机制。
 * 
 * pi-ai 的请求失败不会抛出异常，而是通过流事件和 AssistantMessage 传递错误信息：
 *   - 流式: event.type === "error"，event.reason 为 "error" 或 "aborted"
 *   - 非流式: response.stopReason === "error" 或 "aborted"
 *   - errorMessage 属性包含错误描述
 *   - content 包含在错误发生前收到的部分内容
 *   - usage 包含部分 token 消耗
 * 
 * 常见错误类型：
 *   - 认证失败（无 API key、OAuth 过期）
 *   - 网络错误
 *   - 模型不支持（provider 找不到）
 *   - 上下文溢出（超过 contextWindow）
 */
async function showErrorHandlingUsage() {
  console.log("---------- showErrorHandlingUsage ----------")

  const customModels = getCustomModels();
  const model = customModels.getModel(USED_MODEL.provider, USED_MODEL.id);
  if (!model) {
    console.error(`"Model '${USED_MODEL.id}' not found in provider '${USED_MODEL.provider}'"`);
    return;
  }

  console.log("\n========== 场景1: 流式请求中的错误处理 ==========");

  // ===== 场景1: 流式请求中的错误处理 =====
  const context: Context = {
    messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
  };

  const s = customModels.stream(model, context);
  for await (const event of s) {
    if (event.type === "error") {
      // event.reason: "error"（网络/认证等错误）或 "aborted"（主动取消）
      console.error(`[Stream error] reason=${event.reason}`);
      console.error(`  message: ${event.error.errorMessage}`);
      // event.error 是一个 AssistantMessage，包含部分内容
      console.error(`  partial content blocks: ${event.error.content.length}`);
      console.error(`  partial tokens: ${event.error.usage.totalTokens}`);
    }
  }
  const message = await s.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    console.log(`Request failed: ${message.errorMessage}`);
    // 即使失败，message 也可以被加入上下文继续对话
    // context.messages.push(message);
    // context.messages.push({ role: "user", content: "Please continue", timestamp: Date.now() });
    // await customModels.complete(model, context);
  }

  console.log("\n========== 场景2: complete() 直接检查 stopReason ==========");

  // ===== 场景2: complete() 直接检查 stopReason =====
  const response = await customModels.complete(model, context);
  if (response.stopReason === "error") {
    console.error(`Complete failed: ${response.errorMessage}`);
  } else if (response.stopReason === "length") {
    console.warn(`Output truncated at max tokens: ${response.usage.output} tokens`);
  } else {
    console.log(`Success: ${response.stopReason}`);
  }

  console.log("\n========== 场景3: 使用 onPayload / onResponse 调试请求 ==========");

  // ===== 场景3: 使用 onPayload / onResponse 调试请求 =====
  await customModels.complete(model, context, {
    onPayload: (payload: unknown) => {
      // 在发送前检查/修改请求负载
      console.log("Request payload:", JSON.stringify(payload).substring(0, 200) + "...");
    },
    onResponse: (resp) => {
      // 在收到响应后检查 HTTP 状态和头部
      console.log(`HTTP ${resp.status}, headers:`, Object.keys(resp.headers));
    },
  });
}

/**
 * 练习 pi-ai 的统一推理/思考接口（streamSimple / completeSimple）。
 * 
 * streamSimple / completeSimple 提供了一个跨提供商的统一推理级别参数：
 *   - reasoning: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
 * 
 * 与 stream / complete（provider-specific options）的区别：
 *   - stream/complete: 需要 hasApi 窄化后使用 API 特定选项（如 thinkingEnabled, reasoningEffort）
 *   - streamSimple/completeSimple: 统一 reasoning 参数，pi 自动转换为各 Provider 的原生参数
 * 
 * 获取模型支持的推理级别：
 *   - getSupportedThinkingLevels(model): 返回 ModelThinkingLevel[]
 *   - clampThinkingLevel(model, level): 将请求的级别调整为最接近的可用级别
 */
async function showThinkingUsage() {
  console.log("---------- showThinkingUsage ----------")

  const customModels = getCustomModels();
  // 通过 getModel() 按名称精确查找推理模型
  const reasoningModel = customModels.getModel('ollama', 'qwen3.5:9b');
  if (!reasoningModel) {
    console.log("No reasoning model available (qwen3.5:9b not found)");
    return;
  }

  console.log("\n========== 查询推理能力 ==========");
  const supportedLevels = getSupportedThinkingLevels(reasoningModel);
  console.log(`Model: ${reasoningModel.id}`);
  console.log(`  Reasoning: ${reasoningModel.reasoning}`);
  console.log(`  Supported thinking levels: ${supportedLevels.join(', ')}`);

  // 如果请求的级别不被支持，clampThinkingLevel 会找到最接近的可用级别
  const requestedLevel: ModelThinkingLevel = "xhigh";
  const actualLevel = clampThinkingLevel(reasoningModel, requestedLevel);
  console.log(`  Requested: ${requestedLevel} → Clamped to: ${actualLevel}`);

  const context: Context = {
    systemPrompt: "You are a helpful assistant.",
    messages: [{ role: "user", content: "请解释量子纠缠的基本原理", timestamp: Date.now() }],
  };

  console.log("\n========== completeSimple：统一推理参数 ==========");

  // ===== 使用 completeSimple + 统一 reasoning 参数 =====
  const response = await customModels.completeSimple(reasoningModel, context, {
    reasoning: 'medium', // 统一推理级别，pi 自动转换为 Provider 原生参数
  });

  console.log(`\n>>> Reasoning response (stopReason: ${response.stopReason}):`);
  for (const block of response.content) {
    if (block.type === "thinking") {
      // 注意：某些 Provider 在 streamSimple 中会流式输出 thinking 事件
      console.log(`[Thinking]: ${block.thinking.substring(0, 200)}...`);
    } else if (block.type === "text") {
      console.log(`[Text]: ${block.text}`);
    }
  }
  console.log(`Tokens: ${response.usage.totalTokens}, Cost: $${response.usage.cost.total.toFixed(6)}`);

  console.log("\n========== streamSimple：流式推理 ==========");

  // ===== 流式推理：streamSimple =====
  const s = customModels.streamSimple(reasoningModel, context, { reasoning: 'high' });
  for await (const event of s) {
    switch (event.type) {
      case "thinking_start":
        console.log("[Model started thinking]");
        break;
      case "thinking_delta":
        process.stdout.write(event.delta);
        break;
      case "thinking_end":
        console.log("\n[Thinking complete]");
        break;
      case "text_delta":
        process.stdout.write(event.delta);
        break;
      case "done":
        console.log(`\n[Finished: ${event.reason}]`);
        break;
    }
  }
}

/**
 * 练习 Faux Provider —— 用于单元测试的模拟 Provider。
 * 
 * Faux Provider 提供可预编程的响应队列，适合：
 *   - 单元测试：不依赖真实 API
 *   - 开发调试：确定性输出
 *   - 演示：无需 API key
 * 
 * 核心 API：
 *   - fauxProvider(options): 创建 Faux Provider
 *   - faux.setResponses([...]): 设置响应队列（替换所有待消费响应）
 *   - faux.appendResponses([...]): 追加响应到队列末尾
 *   - faux.getPendingResponseCount(): 查看剩余响应数
 *   - fauxAssistantMessage(blocks, options): 构建预设的 AssistantMessage
 *   - fauxText(text), fauxThinking(text), fauxToolCall(name, args): 构建 content blocks
 */
async function showFauxProviderUsage() {
  console.log("---------- showFauxProviderUsage ----------")

  // 创建 Faux Provider
  const faux = fauxProvider({
    tokensPerSecond: 50, // 可选：限制 token 输出速率，模拟真实延迟
  });

  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel(); // 获取默认 faux 模型

  console.log("\n========== 第一轮：预设工具调用响应 ==========");

  // 构建上下文
  const context: Context = {
    messages: [{ role: "user", content: "Summarize package.json and then call echo", timestamp: Date.now() }],
  };

  // 预设第一轮响应：模型返回思考 + 工具调用
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking("Need to inspect package metadata first."),
        fauxToolCall("echo", { text: "package.json" }),
      ],
      { stopReason: "toolUse" },
    ),
  ]);

  // 第一轮请求
  const first = await models.complete(model, context, {
    sessionId: "session-1",
    cacheRetention: "short",
  });
  context.messages.push(first);
  console.log(`First response stopReason: ${first.stopReason}`);
  for (const block of first.content) {
    if (block.type === "thinking") console.log(`  Thinking: ${block.thinking}`);
    if (block.type === "toolCall") console.log(`  ToolCall: ${block.name}(${JSON.stringify(block.arguments)})`);
  }

  // 模拟工具执行结果
  const toolCallBlock = first.content.find((b) => b.type === "toolCall");
  if (toolCallBlock && toolCallBlock.type === "toolCall") {
    context.messages.push({
      role: "toolResult",
      toolCallId: toolCallBlock.id,
      toolName: toolCallBlock.name,
      content: [{ type: "text", text: "package.json contents here" }],
      isError: false,
      timestamp: Date.now(),
    });
  }

  console.log("\n========== 第二轮：预设文本回复 + 流式输出 ==========");

  // 预设第二轮响应：最终文本回复
  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("Now I can summarize the tool output."),
      fauxText("Here is the summary: package.json contains project metadata."),
    ]),
  ]);

  // 第二轮流式请求
  const s = models.stream(model, context);
  for await (const event of s) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
    if (event.type === "thinking_delta") process.stdout.write(`[think] ${event.delta}`);
  }
  console.log();

  console.log("\n========== 状态检查 & 多模型 Faux ==========");

  // 检查状态
  console.log(`Pending responses: ${faux.getPendingResponseCount()}`);
  console.log(`Total calls: ${faux.state.callCount}`);

  // 多模型 Faux Provider（用于模型切换测试）
  const multiFaux = fauxProvider({
    provider: "faux-multi",
    models: [
      { id: "faux-fast", reasoning: false },
      { id: "faux-thinker", reasoning: true },
    ],
  });
  const thinker = multiFaux.getModel("faux-thinker");
  console.log(`Faux thinker model reasoning: ${thinker?.reasoning}`);
}

/**
 * 练习跨 Provider 模型切换（Cross-Provider Handoffs）。
 * 
 * pi-ai 支持在同一对话中切换不同 Provider 的模型，自动处理消息格式转换：
 *   - 用户消息和工具结果：原样传递
 *   - 同 Provider/API 的 assistant 消息：原样保留
 *   - 不同 Provider 的 assistant 消息：thinking 块转换为 <thinking> 标签文本
 *   - 工具调用和文本内容：原样保留
 * 
 * 适用场景：
 *   - 用快速模型处理简单任务，切换到强模型处理复杂推理
 *   - Provider 故障时切换到备用 Provider
 *   - 比较不同模型对同一对话的响应
 */
async function showCrossProviderHandoffUsage() {
  console.log("---------- showCrossProviderHandoffUsage ----------")

  // 注册多个 Provider 到同一个 Models 集合
  const models = createModels();
  models.setProvider(deepseekProvider());
  models.setProvider(openaiProvider());

  const context: Context = { messages: [] };

  console.log("\n========== 第一轮：DeepSeek ==========");

  // 第一轮：使用 DeepSeek 模型
  const deepseekModel = models.getModel('deepseek', 'deepseek-v4-flash');
  if (deepseekModel) {
    context.messages.push({
      role: "user",
      content: "What is 25 * 18?",
      timestamp: Date.now(),
    });
    const response = await models.complete(deepseekModel, context);
    context.messages.push(response);
    console.log(`[DeepSeek]: ${response.content[0]?.type === 'text' ? response.content[0].text : '...'}`);
  }

  console.log("\n========== 第二轮：切换到 OpenAI ==========");

  // 第二轮：切换到 OpenAI 模型继续对话
  const openaiModel = models.getModel('openai', 'gpt-4o-mini');
  if (openaiModel) {
    context.messages.push({
      role: "user",
      content: "Is that calculation correct?",
      timestamp: Date.now(),
    });
    const response = await models.complete(openaiModel, context);
    context.messages.push(response);
    console.log(`[OpenAI]: ${response.content[0]?.type === 'text' ? response.content[0].text : '...'}`);
  }

  console.log(`Conversation: ${context.messages.length} messages across providers`);
}

/**
 * 练习 Context 的序列化与反序列化。
 * 
 * Context 对象可以通过 JSON.stringify/JSON.parse 进行序列化，用于：
 *   - 持久化对话历史到数据库或文件
 *   - 在浏览器中保存到 localStorage
 *   - 在服务之间传输对话上下文
 *   - 实现聊天记录的导入/导出
 * 
 * 注意：
 *   - Model 是纯数据，也可以序列化
 *   - 如果消息中包含图片（base64），也会被序列化
 *   - 序列化后可以在任意时间点恢复并继续对话，甚至切换到不同模型
 */
function showContextSerializationUsage() {
  console.log("---------- showContextSerializationUsage ----------")

  // 构建上下文
  const context: Context = {
    systemPrompt: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "What is TypeScript?", timestamp: Date.now() },
    ],
  };

  console.log("\n========== 序列化 ==========");

  // 序列化上下文
  const serialized = JSON.stringify(context);
  console.log(`Serialized context: ${serialized.length} chars`);

  // 可以保存到任何地方
  // localStorage.setItem('conversation', serialized);
  // await db.save(serialized);
  // fs.writeFileSync('conversation.json', serialized);

  console.log("\n========== 反序列化恢复 ==========");

  // 反序列化恢复
  const restored: Context = JSON.parse(serialized);
  console.log(`Restored messages: ${restored.messages.length}`);
  console.log(`System prompt: ${restored.systemPrompt}`);

  // 恢复后可以继续对话（需要 model 实例）
  // restored.messages.push({ role: "user", content: "Tell me more", timestamp: Date.now() });
  // const response = await models.complete(model, restored);
}

/**
 * 练习 CredentialStore 的使用。
 * 
 * CredentialStore 用于持久化存储 API key 和 OAuth token：
 *   - InMemoryCredentialStore: 内存存储（默认，进程重启后丢失）
 *   - 可自定义实现：文件存储、数据库存储、localStorage 等
 * 
 * 认证解析优先级：stored credential > 环境变量
 * 存储的凭证"拥有"该 Provider：存储后环境变量不再被查询。
 */
function showCredentialStoreUsage() {
  console.log("---------- showCredentialStoreUsage ----------")

  // 创建内存凭证存储
  const store = new InMemoryCredentialStore();

  // 将 store 注入到 Models 中
  const models = createModels({ credentials: store });
  models.setProvider(deepseekProvider());

  console.log("\n========== CredentialStore 操作 ==========");

  // 存储 API key 凭证
  // 实际使用中通过 provider.auth.apiKey.login() 交互式获取
  // await store.modify('deepseek', async () => ({
  //   type: 'api_key',
  //   key: 'sk-xxxx',
  // }));

  // 读取凭证
  // const credential = await store.read('deepseek');
  // if (credential) {
  //   console.log(`Credential type: ${credential.type}`);
  // }

  // 删除凭证（登出）
  // await store.delete('deepseek');

  console.log(`CredentialStore interface: read / modify / delete`);
  console.log(`InMemoryCredentialStore is the default when no store is provided`);
}

// ===============================================================
async function main() {
  showModelsUsage();
  showModelsUtilFunctionUsage();
  showCreateProviderUsage();
  // showContextSerializationUsage();
  // showCredentialStoreUsage();
  // 以下函数需要真实 API 连接：
  await showModelUsage();
  await showToolCallingUsage();
  // await showErrorHandlingUsage();
  // await showThinkingUsage();
  // await showFauxProviderUsage();
  // await showCrossProviderHandoffUsage();
}

await main()