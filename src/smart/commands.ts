// Command handlers for Smart Note. Called from main.ts.
//
// - smart-note-from-template: health-check Ollama; open the Smart
//   Note modal when it's up, or fall back to the existing
//   "Create note from template" walkthrough with a Notice.
// - benchmark-transcribers: record 10 s and report latency + text
//   from whisper and Gemma side by side.

import { App, Notice, TFile, TFolder } from "obsidian";
import type ListAssistantPlugin from "../main";
import { SmartNoteModal, smartNoteCanOpen, type SmartNoteModalOptions } from "./SmartNoteModal";
import { TemplatePickerModal } from "../template-picker";
import { CreateNoteModal } from "../create-note-modal";
import { AudioCapture } from "./audioCapture";
import { WhisperTranscriber, whisperHealth } from "./whisperTranscriber";
import { GemmaTranscriber } from "./gemmaTranscriber";
import { DEFAULT_CONFIG as OLLAMA_DEFAULTS } from "./ollamaClient";

export async function openSmartNote(plugin: ListAssistantPlugin): Promise<void> {
  const opts = modalOptionsFromSettings(plugin);
  const health = await smartNoteCanOpen({
    ollama: opts.ollama,
    transcriberKind: opts.transcriberKind,
    whisperUrl: opts.whisperUrl,
  });
  if (!health.ollamaOk) {
    new Notice(
      `Ollama not running (or ${opts.ollama.model} missing) — using standard walkthrough.`,
      6000,
    );
    openStandardWalkthrough(plugin);
    return;
  }
  const modal = new SmartNoteModal(plugin.app, plugin, opts);
  await preloadTemplatesIntoModal(plugin.app, modal);
  modal.open();
}

export function openStandardWalkthrough(plugin: ListAssistantPlugin): void {
  const files = getTemplateFiles(plugin);
  if (files.length === 0) {
    new Notice(
      `No templates found in "${plugin.settings.templatesFolder}". Adjust in List Assistant settings.`,
    );
    return;
  }
  new TemplatePickerModal(plugin.app, files, async (tpl) => {
    const raw = await plugin.app.vault.read(tpl);
    new CreateNoteModal(plugin.app, plugin, tpl, raw).open();
  }).open();
}

function getTemplateFiles(plugin: ListAssistantPlugin): TFile[] {
  const folder = plugin.app.vault.getAbstractFileByPath(plugin.settings.templatesFolder);
  if (!(folder instanceof TFolder)) return [];
  const out: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFile && child.extension === "md") out.push(child);
      else if (child instanceof TFolder) walk(child);
    }
  };
  walk(folder);
  return out;
}

async function preloadTemplatesIntoModal(app: App, modal: SmartNoteModal): Promise<void> {
  // The modal was constructed with placeholder raw="" strings. Read
  // each template file's content now so the session can classify them.
  const session = (modal as unknown as { session: { deps: { templates: Array<{ path: string; raw: string }> } } }).session;
  for (const t of session.deps.templates) {
    const file = app.vault.getAbstractFileByPath(t.path);
    if (file instanceof TFile) {
      t.raw = await app.vault.cachedRead(file);
    }
  }
}

export function modalOptionsFromSettings(plugin: ListAssistantPlugin): SmartNoteModalOptions {
  const s = plugin.settings;
  return {
    ollama: {
      ...OLLAMA_DEFAULTS,
      baseUrl: s.smartNoteOllamaUrl,
      model: s.smartNoteModel,
      temperature: s.smartNoteTemperature,
    },
    transcriberKind: s.smartNoteTranscriber,
    whisperUrl: s.smartNoteWhisperUrl,
    maxFollowUps: s.smartNoteMaxFollowUps,
  };
}

// Benchmark: record 10 s, feed into both whisper and gemma, report
// latency + text. Prints to console AND a Notice.
export async function benchmarkTranscribers(plugin: ListAssistantPlugin): Promise<void> {
  const cap = new AudioCapture();
  const opts = modalOptionsFromSettings(plugin);
  const whisperOk = await whisperHealth(opts.whisperUrl);
  const whisper = whisperOk ? new WhisperTranscriber({ url: opts.whisperUrl }) : null;
  const gemma = new GemmaTranscriber({ baseUrl: opts.ollama.baseUrl, model: opts.ollama.model });

  new Notice("Benchmark: recording 10 s. Speak now.", 2000);
  try {
    await cap.start();
  } catch (e) {
    new Notice(`Mic failed: ${(e as Error).message}`);
    return;
  }
  await new Promise((r) => setTimeout(r, 10_000));
  const wav = await cap.stop();

  const results: Array<{ name: string; latencyMs: number; text: string; error?: string }> = [];
  for (const [name, t] of [
    ["whisper", whisper],
    ["gemma-experimental", gemma],
  ] as const) {
    if (!t) {
      results.push({ name, latencyMs: 0, text: "", error: "not reachable" });
      continue;
    }
    const start = performance.now();
    try {
      const text = await t.transcribe(wav);
      results.push({ name, latencyMs: Math.round(performance.now() - start), text });
    } catch (e) {
      results.push({
        name,
        latencyMs: Math.round(performance.now() - start),
        text: "",
        error: (e as Error).message,
      });
    }
  }
  console.table(results);
  const summary = results
    .map((r) => `${r.name}: ${r.latencyMs}ms${r.error ? ` (${r.error})` : ""}`)
    .join("\n");
  new Notice(`Transcriber benchmark\n${summary}`, 10_000);
}
