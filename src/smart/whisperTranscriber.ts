// whisper.cpp server client. Default transcriber for Smart Note.
// Server runs locally: whisper-server -m models/ggml-base.en.bin
// --host 127.0.0.1 --port 8080. The /inference endpoint accepts
// multipart form data with a `file` field.

import { Transcriber, TranscriberError } from "./transcriber";

export interface WhisperConfig {
  url: string;        // e.g. "http://127.0.0.1:8080/inference"
  model?: string;     // optional model hint, server-side
  timeoutMs?: number; // default 60000
}

export class WhisperTranscriber implements Transcriber {
  readonly name = "whisper";
  constructor(private cfg: WhisperConfig) {}

  async transcribe(wav: ArrayBuffer): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "capture.wav");
    form.append("response_format", "json");
    if (this.cfg.model) form.append("model", this.cfg.model);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.cfg.timeoutMs ?? 60000,
    );
    try {
      const resp = await fetch(this.cfg.url, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`whisper ${resp.status} ${resp.statusText} ${body}`);
      }
      const data = (await resp.json()) as { text?: string };
      return (data.text ?? "").trim();
    } catch (e) {
      throw new TranscriberError("whisper", e);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Health probe — returns true if the whisper server is reachable.
export async function whisperHealth(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const base = url.replace(/\/inference\/?$/, "");
      const resp = await fetch(base, { method: "GET", signal: controller.signal });
      return resp.ok || resp.status === 404; // some builds return 404 on root
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}
