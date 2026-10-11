// Command handlers for Smart Note. Called from main.ts.
//
// - smart-note-from-template: health-check Ollama; open (or reveal)
//   the Smart Note tab view when it's up, or fall back to the
//   existing "Create note from template" walkthrough with a Notice.
// - benchmark-transcribers: record 10 s and report latency + text
//   from whisper and Gemma side by side.

import { Notice, TFile, TFolder } from "obsidian";
import type ListAssistantPlugin from "../main";
import {
  SmartNoteView,
  VIEW_TYPE_SMART_NOTE,
  smartNoteCanOpen,
  modalOptionsFromSettings,
} from "./SmartNoteView";
import { TemplatePickerModal } from "../template-picker";
import { CreateNoteModal } from "../create-note-modal";
import { AudioCapture } from "./audioCapture";
import { WhisperTranscriber, whisperHealth } from "./whisperTranscriber";
import { GemmaTranscriber } from "./gemmaTranscriber";

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
  const workspace = plugin.app.workspace;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_SMART_NOTE);
  let leaf = existing[0];
  if (!leaf) {
    leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_SMART_NOTE, active: true });
  }
  workspace.revealLeaf(leaf);
  // If the user re-triggers Smart Note on a tab that's already finished,
  // reset the session so they start fresh. Mid-session state is kept.
  const view = leaf.view;
  if (view instanceof SmartNoteView) {
    view.resetIfFinished();
  }
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

export { modalOptionsFromSettings };

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
