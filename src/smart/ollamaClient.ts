// Thin wrapper around Ollama's /api/tags (health) and /api/chat
// (structured output) endpoints. Pure — uses the global `fetch`
// (Node 18+ / Obsidian's Electron). Tests inject `fetchImpl` to mock
// the network.

export type FetchFn = (
  input: string | URL,
  init?: RequestInit & { signal?: AbortSignal },
) => Promise<Response>;

export interface OllamaConfig {
  baseUrl: string;        // default "http://localhost:11434"
  model: string;          // default "gemma4:e2b"
  temperature: number;    // default 0.2
  numCtx: number;         // default 8192
  keepAlive: string;      // default "15m"
  timeoutMs: number;      // default 30000
  fetchImpl?: FetchFn;
}

export const DEFAULT_CONFIG: Omit<OllamaConfig, "fetchImpl"> = {
  baseUrl: "http://localhost:11434",
  model: "gemma4:e2b",
  temperature: 0.2,
  numCtx: 8192,
  keepAlive: "30m",
  // Gemma 4 e2b on SP7 CPU: cold load ~45-60 s, extraction ~30-120 s.
  // 180 s covers both; keep_alive stops the model from being evicted
  // between back-to-back sessions.
  timeoutMs: 180000,
};

// POST a trivial no-op chat so Ollama loads the model into RAM. The
// returned promise resolves as soon as the model is resident; use it
// to warm Ollama while the user is still typing. Errors are swallowed
// — the real extract call will surface them with its own message.
export async function prewarmModel(cfg: OllamaConfig): Promise<void> {
  const f = cfg.fetchImpl ?? fetch;
  try {
    await f(`${cfg.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "ok" }],
        stream: false,
        keep_alive: cfg.keepAlive,
        options: { num_predict: 1, temperature: 0, think: false },
      }),
    });
  } catch {
    // best-effort
  }
}

export interface HealthResult {
  ok: boolean;
  models: string[];
  modelPresent: boolean;
  error?: string;
}

export async function healthCheck(cfg: OllamaConfig): Promise<HealthResult> {
  const f = cfg.fetchImpl ?? fetch;
  try {
    const resp = await withTimeout(cfg.timeoutMs, (signal) =>
      f(`${cfg.baseUrl}/api/tags`, { method: "GET", signal }),
    );
    if (!resp.ok) {
      return {
        ok: false,
        models: [],
        modelPresent: false,
        error: `health check failed: ${resp.status} ${resp.statusText}`,
      };
    }
    const body = (await resp.json()) as { models?: Array<{ name: string }> };
    const models = (body.models ?? []).map((m) => m.name);
    return {
      ok: true,
      models,
      modelPresent: models.includes(cfg.model),
    };
  } catch (e) {
    return {
      ok: false,
      models: [],
      modelPresent: false,
      error: (e as Error).message,
    };
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  format: Record<string, unknown>; // JSON Schema object
}

export interface ChatResult {
  content: string;
  parsed: unknown;
  retried: boolean;
}

export class InvalidChatJsonError extends Error {
  constructor(public readonly content: string, cause: Error) {
    super(`Ollama returned invalid JSON after retry: ${cause.message}`);
    this.name = "InvalidChatJsonError";
  }
}

export async function chat(
  cfg: OllamaConfig,
  req: ChatRequest,
): Promise<ChatResult> {
  const first = await chatOnce(cfg, req);
  const firstParse = tryParse(first);
  if (firstParse.ok) {
    return { content: first, parsed: firstParse.value, retried: false };
  }
  // One retry.
  const second = await chatOnce(cfg, req);
  const secondParse = tryParse(second);
  if (secondParse.ok) {
    return { content: second, parsed: secondParse.value, retried: true };
  }
  throw new InvalidChatJsonError(second, secondParse.error);
}

async function chatOnce(cfg: OllamaConfig, req: ChatRequest): Promise<string> {
  const f = cfg.fetchImpl ?? fetch;
  const body = {
    model: cfg.model,
    messages: req.messages,
    stream: false,
    format: req.format,
    keep_alive: cfg.keepAlive,
    options: {
      temperature: cfg.temperature,
      num_ctx: cfg.numCtx,
      think: false,
    },
  };
  const resp = await withTimeout(cfg.timeoutMs, (signal) =>
    f(`${cfg.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  );
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Ollama chat failed: ${resp.status} ${resp.statusText} ${txt}`);
  }
  const data = (await resp.json()) as {
    message?: { content?: string };
  };
  return data.message?.content ?? "";
}

interface ParseOk {
  ok: true;
  value: unknown;
}
interface ParseErr {
  ok: false;
  error: Error;
}

function tryParse(text: string): ParseOk | ParseErr {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
