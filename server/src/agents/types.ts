// ============ Agent 任务与调度类型 ============

export interface AgentTask {
  id: string;
  agentId: string;
  projectId: string;
  messageId: string;
  content: string;
  priority: number;
  createdAt: Date;
  retryCount: number;
  maxRetries: number;
  executionId?: string;
  depth: number;
}

export interface AgentWorker {
  agentId: string;
  isBusy: boolean;
  currentTask: AgentTask | null;
  lastActivity: Date;
  totalProcessed: number;
  instanceGroup: string | null;
}

export interface AgentExecution {
  id: string;
  agentId: string;
  projectId: string;
  messageId: string;
  taskId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  input: string;
  output?: string;
  error?: string;
  toolsUsed: string[];
  tokenUsed: number;
  latencyMs: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

// ============ LLM 抽象类型 ============

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  functionName: string;
  arguments: string;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface StreamChunk {
  type: "content" | "tool_call" | "done";
  content?: string;
  toolCall?: ToolCall;
}

export interface ILLMClient {
  chat(
    messages: ChatMessage[],
    options?: {
      model?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): Promise<LLMResponse>;

  chatStream(
    messages: ChatMessage[],
    options?: {
      model?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): AsyncIterable<StreamChunk>;
}
