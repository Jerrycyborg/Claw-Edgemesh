import { ModelProvider } from "./models";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface CompletionOptions {
  model: string;
  provider: ModelProvider;
  apiKey: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface CompletionResult {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Calls OpenAI Chat Completions API */
async function callOpenAI(options: CompletionOptions): Promise<CompletionResult> {
  const messages: ChatMessage[] = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push(...options.messages);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages,
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0.7,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(
      `OpenAI API error ${response.status}: ${(err as any).error?.message ?? response.statusText}`
    );
  }

  const data = (await response.json()) as any;
  return {
    content: data.choices[0].message.content,
    model: data.model,
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
  };
}

/** Calls Anthropic Messages API */
async function callAnthropic(options: CompletionOptions): Promise<CompletionResult> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 2048,
      system: options.systemPrompt,
      messages: options.messages.filter((m) => m.role !== "system"),
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(
      `Anthropic API error ${response.status}: ${(err as any).error?.message ?? response.statusText}`
    );
  }

  const data = (await response.json()) as any;
  return {
    content: data.content[0].text,
    model: data.model,
    usage: data.usage
      ? {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        }
      : undefined,
  };
}

/** Calls Google Gemini generateContent API */
async function callGoogle(options: CompletionOptions): Promise<CompletionResult> {
  const contents = options.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent?key=${options.apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: options.systemPrompt
        ? { parts: [{ text: options.systemPrompt }] }
        : undefined,
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.7,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(
      `Google API error ${response.status}: ${(err as any).error?.message ?? response.statusText}`
    );
  }

  const data = (await response.json()) as any;
  const text = data.candidates[0].content.parts[0].text;
  return {
    content: text,
    model: options.model,
    usage: data.usageMetadata
      ? {
          promptTokens: data.usageMetadata.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: data.usageMetadata.totalTokenCount ?? 0,
        }
      : undefined,
  };
}

/** Dispatches to the correct provider */
export async function getCompletion(options: CompletionOptions): Promise<CompletionResult> {
  switch (options.provider) {
    case "openai":
      return callOpenAI(options);
    case "anthropic":
      return callAnthropic(options);
    case "google":
      return callGoogle(options);
    default:
      throw new Error(`Unsupported provider: ${options.provider}`);
  }
}
