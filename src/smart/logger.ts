// Append-only JSONL log for Smart Note sessions. Never writes note
// content — only metadata for tuning. Lives at
// `.obsidian/plugins/list-assistant/smart-note-log.jsonl`.

import type { App } from "obsidian";

export interface SmartNoteLogEntry {
  timestamp: string;        // ISO-8601
  template: string;         // template basename
  folder: string;           // destination folder (vault-relative)
  follow_ups_asked: number;
  follow_ups_answered: number;
  latency_ms: number;       // total session latency (open -> save)
  transcriber: string;      // whisper | gemma-experimental | none
  model: string;            // ollama model used
  outcome: "saved" | "cancelled" | "error";
  error?: string;           // short error message when outcome=error
}

export async function appendLog(
  app: App,
  pluginDir: string,
  entry: SmartNoteLogEntry,
): Promise<void> {
  const path = `${pluginDir}/smart-note-log.jsonl`;
  const line = JSON.stringify(entry) + "\n";
  try {
    const adapter = app.vault.adapter;
    const exists = await adapter.exists(path);
    if (exists) {
      const current = await adapter.read(path);
      await adapter.write(path, current + line);
    } else {
      await adapter.write(path, line);
    }
  } catch (e) {
    // Never fail the user-facing flow because of logging.
    console.warn("smart-note logger failed:", (e as Error).message);
  }
}
