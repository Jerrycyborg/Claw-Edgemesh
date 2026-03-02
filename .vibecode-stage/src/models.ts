export type ModelProvider = "openai" | "anthropic" | "google";

export interface AIModel {
  id: string;
  label: string;
  provider: ModelProvider;
  contextWindow: number;
  description: string;
}

export const SUPPORTED_MODELS: AIModel[] = [
  {
    id: "gpt-4o",
    label: "GPT-4o",
    provider: "openai",
    contextWindow: 128000,
    description: "OpenAI GPT-4o — best for complex tasks (recommended)",
  },
  {
    id: "gpt-4-turbo",
    label: "GPT-4 Turbo",
    provider: "openai",
    contextWindow: 128000,
    description: "OpenAI GPT-4 Turbo — powerful and fast",
  },
  {
    id: "gpt-3.5-turbo",
    label: "GPT-3.5 Turbo",
    provider: "openai",
    contextWindow: 16385,
    description: "OpenAI GPT-3.5 Turbo — fast and cost-effective",
  },
  {
    id: "claude-3-5-sonnet-20241022",
    label: "Claude 3.5 Sonnet",
    provider: "anthropic",
    contextWindow: 200000,
    description: "Anthropic Claude 3.5 Sonnet — excellent for coding",
  },
  {
    id: "claude-3-haiku-20240307",
    label: "Claude 3 Haiku",
    provider: "anthropic",
    contextWindow: 200000,
    description: "Anthropic Claude 3 Haiku — fastest Claude model",
  },
  {
    id: "gemini-1.5-pro",
    label: "Gemini 1.5 Pro",
    provider: "google",
    contextWindow: 1000000,
    description: "Google Gemini 1.5 Pro — huge context window",
  },
  {
    id: "gemini-1.5-flash",
    label: "Gemini 1.5 Flash",
    provider: "google",
    contextWindow: 1000000,
    description: "Google Gemini 1.5 Flash — fast and efficient",
  },
];

export function getModelById(id: string): AIModel | undefined {
  return SUPPORTED_MODELS.find((m) => m.id === id);
}

export function getProviderForModel(modelId: string): ModelProvider | undefined {
  return getModelById(modelId)?.provider;
}

export function getModelsForProvider(provider: ModelProvider): AIModel[] {
  return SUPPORTED_MODELS.filter((m) => m.provider === provider);
}
