import type { ILLMClient } from "../types.js";
import { OpenAIClient } from "./openai-client.js";

export type LLMProvider = "openai" | "anthropic" | "gemini" | "deepseek";

interface LLMClientConfig {
  apiKey: string;
  baseURL?: string;
}

export function createLLMClient(
  provider: LLMProvider,
  config: LLMClientConfig,
): ILLMClient {
  // 所有 provider 统一走 OpenAI 兼容接口，只需不同的 baseURL
  return new OpenAIClient(config);
}
