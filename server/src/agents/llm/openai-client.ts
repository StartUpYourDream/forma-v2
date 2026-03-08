import OpenAI from "openai";
import type {
  ILLMClient,
  ChatMessage,
  ToolDefinition,
  LLMResponse,
  StreamChunk,
  ToolCall,
} from "../types.js";

export class OpenAIClient implements ILLMClient {
  private client: OpenAI;

  constructor(config: { apiKey: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async chat(
    messages: ChatMessage[],
    options?: {
      model?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): Promise<LLMResponse> {
    const openaiMessages = this.toOpenAIMessages(messages);
    const openaiTools = options?.tools?.length
      ? this.toOpenAITools(options.tools)
      : undefined;

    const completion = await this.client.chat.completions.create(
      {
        model: options?.model || "gpt-4o-mini",
        messages: openaiMessages,
        tools: openaiTools,
        tool_choice: openaiTools ? "auto" : undefined,
        max_tokens: options?.maxTokens ?? 2000,
        temperature: options?.temperature ?? 0.7,
      },
      { signal: options?.signal },
    );

    const choice = completion.choices[0].message;

    const toolCalls: ToolCall[] | undefined = choice.tool_calls?.map((tc) => ({
      id: tc.id,
      functionName: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      content: choice.content || "",
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *chatStream(
    messages: ChatMessage[],
    options?: {
      model?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): AsyncIterable<StreamChunk> {
    const openaiMessages = this.toOpenAIMessages(messages);
    const openaiTools = options?.tools?.length
      ? this.toOpenAITools(options.tools)
      : undefined;

    const stream = await this.client.chat.completions.create(
      {
        model: options?.model || "gpt-4o-mini",
        messages: openaiMessages,
        tools: openaiTools,
        tool_choice: openaiTools ? "auto" : undefined,
        max_tokens: options?.maxTokens ?? 2000,
        temperature: options?.temperature ?? 0.7,
        stream: true,
      },
      { signal: options?.signal },
    );

    const toolCallAccumulators = new Map<
      number,
      { id: string; functionName: string; arguments: string }
    >();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: "content", content: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccumulators.has(idx)) {
            toolCallAccumulators.set(idx, {
              id: tc.id || "",
              functionName: tc.function?.name || "",
              arguments: "",
            });
          }
          const acc = toolCallAccumulators.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.functionName = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }
    }

    // 流结束后 emit 完整的 tool calls
    for (const [, acc] of toolCallAccumulators) {
      yield {
        type: "tool_call",
        toolCall: {
          id: acc.id,
          functionName: acc.functionName,
          arguments: acc.arguments,
        },
      };
    }

    yield { type: "done" };
  }

  // ============ 格式转换 ============

  private toOpenAIMessages(
    messages: ChatMessage[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === "tool") {
        return {
          role: "tool" as const,
          tool_call_id: msg.toolCallId!,
          content: msg.content,
        };
      }

      if (msg.role === "assistant" && msg.toolCalls?.length) {
        return {
          role: "assistant" as const,
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.functionName,
              arguments: tc.arguments,
            },
          })),
        };
      }

      return {
        role: msg.role as "system" | "user" | "assistant",
        content: msg.content,
      };
    });
  }

  private toOpenAITools(
    tools: ToolDefinition[],
  ): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}
