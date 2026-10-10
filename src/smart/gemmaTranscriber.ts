// Gemma-native audio transcription via Ollama's OpenAI-compatible
// endpoint. Experimental — Gemma 4 claims audio input but hands-on
// tests on 8 GB SP7 hardware show looping/hallucination and
// multi-minute latency on 10 s clips, so this is off by default.
// Benchmark command exposes both transcribers side by side so Kevin
// can decide on the SP7 itself.

import { Transcriber, TranscriberError } from "./transcriber";

export interface GemmaTranscriberConfig {
  baseUrl: string;     // e.g. "http://localhost:11434"
  model: string;       // e.g. "gemma4:e2b"
  timeoutMs?: number;  // default 180000 — generous because quality is iffy
}

export class GemmaTranscriber implements Transcriber {
  readonly name = "gemma-experimental";
  constructor(private cfg: GemmaTranscriberConfig) {}

  async transcribe(wav: ArrayBuffer): Promise<string> {
    const b64 = arrayBufferToBase64(wav);
    // input_audio part BEFORE the text part — order matters per the
    // handoff. The text instructs the model to transcribe only.
    const body = {
      model: this.cfg.model,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: b64, format: "wav" } },
            { type: "text", text: "Transcribe the audio. Return the transcript only, no commentary." },
          ],
        },
      ],
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 180000);
    try {
      const resp = await fetch(
        `${this.cfg.baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`gemma ${resp.status} ${resp.statusText} ${txt}`);
      }
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return (data.choices?.[0]?.message?.content ?? "").trim();
    } catch (e) {
      throw new TranscriberError("gemma-experimental", e);
    } finally {
      clearTimeout(t);
    }
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)) as unknown as number[],
    );
  }
  return btoa(binary);
}
