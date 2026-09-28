import { requestUrl } from "obsidian";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeConfig {
  apiKey: string;
  model: string;
  effort: Effort;
  maxTokens: number;
  enableFallbacks: boolean;
}

export interface TextBlockInput {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeResponse {
  text: string;
  stopReason: string;
  usage: ClaudeUsage;
  raw: unknown;
}

export async function callClaude(
  config: ClaudeConfig,
  system: string,
  userContent: TextBlockInput[],
): Promise<ClaudeResponse> {
  if (!config.apiKey) {
    throw new Error("Anthropic API key is not set. Configure it in List Assistant settings.");
  }
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    messages: [{ role: "user", content: userContent }],
    thinking: { type: "adaptive" },
    output_config: { effort: config.effort },
  };
  if (config.enableFallbacks) {
    body.fallbacks = "default";
  }
  const headers: Record<string, string> = {
    "x-api-key": config.apiKey,
    "anthropic-version": API_VERSION,
    "content-type": "application/json",
  };
  if (config.enableFallbacks) {
    headers["anthropic-beta"] = FALLBACK_BETA;
  }
  const resp = await requestUrl({
    url: API_URL,
    method: "POST",
    headers,
    body: JSON.stringify(body),
    throw: false,
  });
  if (resp.status < 200 || resp.status >= 300) {
    let msg = `Anthropic API ${resp.status}`;
    try {
      const j = resp.json as { error?: { type?: string; message?: string } };
      if (j.error) msg += ` (${j.error.type}): ${j.error.message}`;
    } catch {
      msg += `: ${resp.text?.slice(0, 500) ?? ""}`;
    }
    throw new Error(msg);
  }
  const data = resp.json as {
    stop_reason: string;
    content: Array<{ type: string; text?: string }>;
    usage: ClaudeUsage;
    stop_details?: { type: string; category?: string; explanation?: string };
  };
  if (data.stop_reason === "refusal") {
    const cat = data.stop_details?.category ?? "unknown";
    const explanation = data.stop_details?.explanation ?? "";
    throw new Error(`Anthropic refused the request (${cat}): ${explanation}`);
  }
  const text = (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  return { text, stopReason: data.stop_reason, usage: data.usage, raw: data };
}

export function estimateCostUSD(model: string, usage: ClaudeUsage): number {
  const rates: Record<string, { input: number; output: number; cacheRead: number }> = {
    "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.4 },
    "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
    "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
    "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  };
  const r = rates[model];
  if (!r) return 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const regularInput = Math.max(0, usage.input_tokens - cacheRead - cacheCreate);
  const inputCost = (regularInput * r.input + cacheCreate * r.input * 1.25 + cacheRead * r.cacheRead) / 1_000_000;
  const outputCost = (usage.output_tokens * r.output) / 1_000_000;
  return inputCost + outputCost;
}
