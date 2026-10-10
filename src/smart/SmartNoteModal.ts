// Chat-style modal driving the Smart Note session end to end. Phases:
//   1. Template pick (fuzzy, surfaces top-3 for ambiguous input)
//   2. Capture (mic hold-to-talk + toggle, or type)
//   3. Extraction + up to maxFollowUps follow-ups
//   4. Preview (editable markdown, tag chips, folder dropdown, hub
//      link checkbox, Save / Back / Cancel)
//
// If Ollama health-check fails at open, the modal closes immediately
// after a Notice and the plugin falls back to the existing
// create-note-modal — see commands.ts in step 12.

import { App, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type ListAssistantPlugin from "../main";
import {
  createSession,
  pickTemplate,
  submitCapture,
  answerFollowUp,
  prepareReview,
  type ChatFn,
  type SessionState,
  type TemplateRef,
} from "./session";
import { chat as ollamaChat, DEFAULT_CONFIG as OLLAMA_DEFAULTS, type OllamaConfig } from "./ollamaClient";
import { AudioCapture } from "./audioCapture";
import { WhisperTranscriber, whisperHealth } from "./whisperTranscriber";
import { GemmaTranscriber } from "./gemmaTranscriber";
import type { Transcriber } from "./transcriber";
import { assembleNote } from "./writer-core";
import { writeSmartNote, notifyWritten, type WriteContext, type AppendModeContext } from "./writer";
import { parseTags } from "./tagIndex";
import { renderAppendEntry } from "./writer-core";
import { todayISO } from "../util";
import { appendLog, type SmartNoteLogEntry } from "./logger";

const EXCLUDED_FOLDERS = new Set([
  ".obsidian",
  ".claude",
  "Templates HUB",
  "Daily Priorities",
  "Vault Audits",
  "_backups",
]);

export interface SmartNoteModalOptions {
  ollama: OllamaConfig;
  transcriberKind: "whisper" | "gemma-experimental" | "none";
  whisperUrl: string;
  maxFollowUps: number;
}

export class SmartNoteModal extends Modal {
  private session: SessionState;
  private transcriber: Transcriber | null = null;
  private capture = new AudioCapture();
  private readonly plugin: ListAssistantPlugin;
  private readonly opts: SmartNoteModalOptions;
  private readonly openedAt = performance.now();
  private followUpsAnswered = 0;
  private outcome: "saved" | "cancelled" | "error" = "cancelled";
  private outcomeError: string | undefined;

  constructor(app: App, plugin: ListAssistantPlugin, opts: SmartNoteModalOptions) {
    super(app);
    this.plugin = plugin;
    this.opts = opts;
    this.transcriber = this.buildTranscriber();

    const chatFn: ChatFn = async (req) => {
      const r = await ollamaChat(opts.ollama, req);
      return { parsed: r.parsed, retried: r.retried };
    };
    const templates = this.loadTemplates();
    this.session = createSession({
      templates,
      chat: chatFn,
      nowISODate: () => todayISO(),
      nowISOTime: () => timeHHmm(),
      maxFollowUps: opts.maxFollowUps,
      folderEnum: this.listPickableFolders(),
      lastUsedByTemplate: new Map(
        Object.entries(this.plugin.settings.smartNoteLastUsedByTemplate ?? {}),
      ),
    });
  }

  onOpen(): void {
    this.renderPhase();
  }

  onClose(): void {
    this.contentEl.empty();
    const entry: SmartNoteLogEntry = {
      timestamp: new Date().toISOString(),
      template: this.session.template?.basename ?? "",
      folder: this.lastFolderChoice,
      follow_ups_asked: this.session.followUpsAsked,
      follow_ups_answered: this.followUpsAnswered,
      latency_ms: Math.round(performance.now() - this.openedAt),
      transcriber: this.opts.transcriberKind,
      model: this.opts.ollama.model,
      outcome: this.outcome,
      error: this.outcomeError,
    };
    const pluginDir = this.plugin.manifest.dir;
    if (pluginDir) {
      appendLog(this.app, pluginDir, entry).catch(() => {
        /* logger is best-effort */
      });
    }
  }

  private lastFolderChoice = "";

  private renderPhase(): void {
    const { contentEl } = this;
    contentEl.empty();
    switch (this.session.state) {
      case "pickTemplate":
        return this.renderPickTemplate(contentEl);
      case "awaitCapture":
        return this.renderCapture(contentEl);
      case "extract":
        return this.renderStatus(contentEl, "Extracting…");
      case "followUp":
        return this.renderFollowUp(contentEl);
      case "review":
        return this.renderReview(contentEl);
      case "writing":
        return this.renderStatus(contentEl, "Saving…");
      case "done":
        return this.close();
      case "error":
        return this.renderError(contentEl);
    }
  }

  // ----- Phase renderers -----

  private renderPickTemplate(el: HTMLElement): void {
    el.createEl("h2", { text: "Smart Note" });
    el.createEl("p", {
      text: "Say or type the template type: grocery list, person, anger log, project, trip packing, …",
    });

    let utterance = "";
    const utteranceInput = new Setting(el)
      .setName("Template")
      .addText((t) => {
        t.setPlaceholder("grocery list");
        t.onChange((v) => (utterance = v));
      });
    utteranceInput;

    const row = el.createDiv({ cls: "modal-button-container" });
    const go = row.createEl("button", { text: "Continue", cls: "mod-cta" });
    go.addEventListener("click", () => {
      const { session: next, pick } = pickTemplate(this.session, utterance);
      if (!pick.primary) {
        new Notice("No template matched. Try 'grocery', 'person', 'anger log', …");
        return;
      }
      this.session = next;
      new Notice(`Using ${pick.primary.basename}`);
      this.renderPhase();
    });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  private renderCapture(el: HTMLElement): void {
    const tpl = this.session.template!;
    el.createEl("h2", { text: `Tell me about this ${humanize(tpl.basename)}` });
    el.createEl("p", {
      text:
        "Speak freely. Press the mic to record (hold or toggle), or type into the box. Done when ready.",
    });

    const log = el.createDiv({ cls: "smart-note-log" });
    log.style.minHeight = "80px";
    log.style.marginBottom = "8px";
    log.style.whiteSpace = "pre-wrap";

    const area = el.createEl("textarea");
    area.rows = 6;
    area.style.width = "100%";
    area.placeholder = "Type here, or use the mic above.";

    const row = el.createDiv({ cls: "modal-button-container" });
    const micBtn = row.createEl("button", { text: "🎙 Record (toggle)" });
    const micAvailable = this.transcriber !== null;
    if (!micAvailable) {
      micBtn.disabled = true;
      micBtn.title = "No transcriber reachable — type instead.";
    }
    micBtn.addEventListener("click", async () => {
      if (!this.transcriber) return;
      if (this.capture.isRecording) {
        micBtn.textContent = "⌛ Transcribing…";
        try {
          const wav = await this.capture.stop();
          const text = await this.transcriber.transcribe(wav);
          area.value = area.value ? `${area.value}\n${text}` : text;
        } catch (e) {
          new Notice(`Transcription failed: ${(e as Error).message}`);
        } finally {
          micBtn.textContent = "🎙 Record (toggle)";
        }
      } else {
        try {
          await this.capture.start();
          micBtn.textContent = "⏹ Stop";
        } catch (e) {
          new Notice(`Mic failed: ${(e as Error).message}`);
        }
      }
    });

    const submit = row.createEl("button", { text: "Done", cls: "mod-cta" });
    submit.addEventListener("click", async () => {
      const text = area.value.trim();
      if (!text) {
        new Notice("Say or type something first.");
        return;
      }
      log.textContent = text;
      this.session = { ...this.session, state: "extract" };
      this.renderPhase();
      this.session = await submitCapture(this.session, text);
      this.renderPhase();
    });

    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  private renderFollowUp(el: HTMLElement): void {
    const q = this.session.followUps[0];
    if (!q) {
      this.session = { ...this.session, state: "review" };
      return this.renderPhase();
    }
    el.createEl("h2", { text: `Follow-up (${this.session.followUpsAsked + 1}/${this.opts.maxFollowUps})` });
    el.createEl("p", { text: q.prompt });

    let answer = "";
    new Setting(el).addText((t) => {
      t.setPlaceholder("Your answer…");
      t.onChange((v) => (answer = v));
    });

    const row = el.createDiv({ cls: "modal-button-container" });
    const next = row.createEl("button", { text: "Answer", cls: "mod-cta" });
    next.addEventListener("click", () => {
      if (answer.trim()) this.followUpsAnswered++;
      this.session = answerFollowUp(this.session, answer);
      this.renderPhase();
    });
    row.createEl("button", { text: "Skip" }).addEventListener("click", () => {
      this.session = answerFollowUp(this.session, "skip");
      this.renderPhase();
    });
    row.createEl("button", { text: "Done" }).addEventListener("click", () => {
      this.session = answerFollowUp(this.session, "done");
      this.renderPhase();
    });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  private renderReview(el: HTMLElement): void {
    const plan = prepareReview(this.session);
    if (!plan) {
      new Notice("Nothing to preview.");
      return;
    }
    el.createEl("h2", { text: "Preview" });

    // Title
    let title = plan.title;
    new Setting(el)
      .setName("Title")
      .addText((t) => {
        t.setValue(title);
        t.onChange((v) => (title = v.trim() || plan.title));
      });

    // Folder
    const folders = this.listPickableFolders();
    let folder = folders.includes(plan.folder.folder) ? plan.folder.folder : "";
    new Setting(el)
      .setName("Folder")
      .setDesc(plan.folder.reason)
      .addDropdown((d) => {
        d.addOption("", "(vault root)");
        for (const f of folders) d.addOption(f, f);
        d.setValue(folder);
        d.onChange((v) => (folder = v));
      });

    // Hub link checkbox
    let linkToHub = true;
    new Setting(el)
      .setName("Link in Hub Main")
      .setDesc("Append this note under the hub's Main note.")
      .addToggle((t) => {
        t.setValue(true);
        t.onChange((v) => (linkToHub = v));
      });

    // Preview content (editable)
    const content = assembleNote(plan.rendered);
    const area = el.createEl("textarea");
    area.value = content;
    area.rows = 18;
    area.style.width = "100%";
    area.style.fontFamily = "monospace";

    // Priority hint (one-liner)
    if (plan.rendered.schema.isActionable) {
      const hint = el.createEl("p");
      hint.textContent =
        "Reminder: priority is left empty by design — set it at triage.";
      hint.style.opacity = "0.75";
      hint.style.fontSize = "0.9em";
    }

    const row = el.createDiv({ cls: "modal-button-container" });
    const save = row.createEl("button", { text: "Save", cls: "mod-cta" });
    save.addEventListener("click", async () => {
      this.lastFolderChoice = folder;
      this.session = { ...this.session, state: "writing" };
      this.renderPhase();
      try {
        const outcome = await writeSmartNote(plan.rendered, {
          app: this.app,
          folder,
          linkToHub,
          hubLinkHeading: this.hubLinkHeadingFor(plan.rendered.schema.isActionable, this.session.template!.basename),
          append: this.buildAppendCtx(plan.rendered, folder),
        });
        notifyWritten(outcome);
        await this.rememberLastUsed(folder);
        const leaf = this.app.workspace.getLeaf(false);
        if (outcome.file instanceof TFile) await leaf.openFile(outcome.file);
        this.outcome = "saved";
        this.close();
      } catch (e) {
        this.outcome = "error";
        this.outcomeError = (e as Error).message;
        new Notice(`Save failed: ${this.outcomeError}`);
        this.session = { ...this.session, state: "review" };
        this.renderPhase();
      }
    });
    row.createEl("button", { text: "Back" }).addEventListener("click", () => {
      this.session = { ...this.session, state: "followUp" };
      this.renderPhase();
    });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  private renderStatus(el: HTMLElement, text: string): void {
    el.createEl("h2", { text });
  }

  private renderError(el: HTMLElement): void {
    el.createEl("h2", { text: "Smart Note failed" });
    el.createEl("pre", { text: this.session.error ?? "(no error message)" });
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Close", cls: "mod-cta" }).addEventListener(
      "click",
      () => this.close(),
    );
  }

  // ----- Helpers -----

  private buildTranscriber(): Transcriber | null {
    switch (this.opts.transcriberKind) {
      case "whisper":
        return new WhisperTranscriber({ url: this.opts.whisperUrl });
      case "gemma-experimental":
        return new GemmaTranscriber({
          baseUrl: this.opts.ollama.baseUrl,
          model: this.opts.ollama.model,
        });
      case "none":
      default:
        return null;
    }
  }

  private loadTemplates(): TemplateRef[] {
    const folder = this.plugin.settings.templatesFolder;
    const refs: TemplateRef[] = [];
    const root = this.app.vault.getAbstractFileByPath(folder);
    if (!(root instanceof TFolder)) return refs;
    const walk = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === "md") {
          refs.push({ basename: child.basename, path: child.path, raw: "" });
        } else if (child instanceof TFolder) walk(child);
      }
    };
    walk(root);
    // Load raw lazily — avoid an await here. We'll read when picked.
    return refs.map((r) => ({ ...r, raw: this.readSyncOrEmpty(r.path) }));
  }

  private readSyncOrEmpty(path: string): string {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return "";
    // Vault's cachedRead is async; we need sync. The adapter's read is
    // async too. For a short template file we accept a sync-ish shim:
    // we'll trigger an async read and cache via metadataCache. For
    // simplicity in step 11, we return "" if sync isn't available —
    // callers can retry.
    // In practice obsidian's TFile has no sync read API; the modal's
    // open() does the async load via async loadTemplates() below.
    return "";
  }

  // Async template load — called in onOpen before renderPhase.
  async loadAndEnter(): Promise<void> {
    for (const t of this.session.deps.templates) {
      const file = this.app.vault.getAbstractFileByPath(t.path);
      if (file instanceof TFile) {
        t.raw = await this.app.vault.cachedRead(file);
      }
    }
    this.open();
  }

  private listPickableFolders(): string[] {
    const out: string[] = [];
    const walk = (f: TFolder) => {
      if (EXCLUDED_FOLDERS.has(f.name)) return;
      if (f.path !== "/" && f.path !== "") out.push(f.path);
      for (const child of f.children) if (child instanceof TFolder) walk(child);
    };
    walk(this.app.vault.getRoot());
    return out.sort((a, b) => a.localeCompare(b));
  }

  private hubLinkHeadingFor(isActionable: boolean, templateBasename: string): string {
    if (templateBasename === "Project Template") return "Projects";
    return "Notes";
  }

  private buildAppendCtx(
    rendered: NonNullable<ReturnType<typeof prepareReview>>["rendered"],
    folder: string,
  ): AppendModeContext | undefined {
    const tplName = this.session.template?.basename ?? "";
    if (!this.plugin.settings.smartNoteAppendModeTemplates?.includes(tplName)) return undefined;
    const today = todayISO();
    const month = monthName(today);
    const year = today.slice(0, 4);
    const monthlyPath = `${folder}/Anger Log ${month} ${year}.md`;
    const inlineLabels = rendered.schema.inlineBoldFields.map((f: { label: string }) => f.label);
    const entry = renderAppendEntry({
      today,
      time: timeHHmm(),
      fields: Object.fromEntries(
        inlineLabels.map((label: string) => [
          label,
          String(this.session.extracted[label] ?? ""),
        ]),
      ),
      fieldOrder: inlineLabels,
    });
    return { monthlyPath, entry, today };
  }

  private async rememberLastUsed(folder: string): Promise<void> {
    const tpl = this.session.template?.basename;
    if (!tpl) return;
    const memo = this.plugin.settings.smartNoteLastUsedByTemplate ?? {};
    memo[tpl] = folder;
    this.plugin.settings.smartNoteLastUsedByTemplate = memo;
    await this.plugin.saveSettings();
  }
}

function humanize(name: string): string {
  return name.replace(/\s+Template$/i, "").toLowerCase();
}

function timeHHmm(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthName(isoDate: string): string {
  const m = parseInt(isoDate.slice(5, 7), 10);
  return MONTH_NAMES[m - 1] ?? "";
}

// Health check wrapper for the plugin's command handler.
export async function smartNoteCanOpen(opts: {
  ollama: OllamaConfig;
  transcriberKind: SmartNoteModalOptions["transcriberKind"];
  whisperUrl: string;
}): Promise<{ ollamaOk: boolean; transcriberOk: boolean; models: string[] }> {
  const { healthCheck } = await import("./ollamaClient");
  const h = await healthCheck(opts.ollama);
  const transcriberOk = opts.transcriberKind === "none"
    ? true
    : opts.transcriberKind === "whisper"
      ? await whisperHealth(opts.whisperUrl)
      : h.ok;
  return { ollamaOk: h.ok && h.modelPresent, transcriberOk, models: h.models };
}
