// Chat-style tab view driving the Smart Note session end to end. Phases:
//   1. Template pick (fuzzy, surfaces top-3 for ambiguous input)
//   2. Capture (mic hold-to-talk + toggle, or type)
//   3. Extraction + up to maxFollowUps follow-ups
//   4. Preview (editable markdown, tag chips, folder dropdown, hub
//      link checkbox, Save / Back / Cancel)
//
// Opened as a workspace tab (ItemView) rather than a modal so the
// session doesn't block the vault — you can scroll notes, pop into
// settings, come back and your transcript is still here. If Ollama's
// health-check fails at command-trigger time, the view never opens;
// the plugin falls back to the existing create-note-modal.

import { ItemView, Notice, Setting, TFile, TFolder, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_SMART_NOTE = "list-assistant-smart-note";
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
import { chat as ollamaChat, DEFAULT_CONFIG as OLLAMA_DEFAULTS, prewarmModel, healthCheck, type OllamaConfig } from "./ollamaClient";
import { AudioCapture } from "./audioCapture";
import { WhisperTranscriber, whisperHealth } from "./whisperTranscriber";
import { GemmaTranscriber } from "./gemmaTranscriber";
import type { Transcriber } from "./transcriber";
import { assembleNote } from "./writer-core";
import { writeSmartNote, writeExtraArtifact, notifyWritten, type WriteContext, type AppendModeContext } from "./writer";
import { parseTags } from "./tagIndex";
import { renderAppendEntry } from "./writer-core";
import { todayISO } from "../util";
import { appendLog, type SmartNoteLogEntry } from "./logger";
import { parseMenuItems, type MenuIndex } from "./menuItems";
import { parseGroceryUnits, type GroceryUnitIndex } from "./groceryUnits";

const MENU_ITEMS_PATH = "Reference HUB/Menu Items.md";
const GROCERY_UNITS_PATH = "Reference HUB/Grocery Units.md";

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

export class SmartNoteView extends ItemView {
  private session!: SessionState;
  private transcriber: Transcriber | null = null;
  private capture = new AudioCapture();
  private readonly plugin: ListAssistantPlugin;
  private opts!: SmartNoteModalOptions;
  private openedAt = performance.now();
  private followUpsAnswered = 0;
  private outcome: "saved" | "cancelled" | "error" = "cancelled";
  private outcomeError: string | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: ListAssistantPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SMART_NOTE;
  }

  getDisplayText(): string {
    return "Smart Note";
  }

  getIcon(): string {
    return "mic";
  }

  // Called by the command when the user re-triggers Smart Note on an
  // already-open tab that's in a finished state. Resets the session so
  // the user starts fresh. If called while mid-session, reveals the
  // tab without resetting (preserves the transcript).
  resetIfFinished(): void {
    if (this.session && (this.session.state === "done" || this.session.state === "error")) {
      this.initSession();
      this.renderPhase();
    }
  }

  private initSession(): void {
    this.opts = modalOptionsFromSettings(this.plugin);
    this.transcriber = this.buildTranscriber();
    this.openedAt = performance.now();
    this.followUpsAnswered = 0;
    this.outcome = "cancelled";
    this.outcomeError = undefined;
    this.expandMeals = false;
    this.expandMenuNumbers = false;
    this.menuIndex = null;
    this.lastFolderChoice = "";

    const chatFn: ChatFn = async (req) => {
      const r = await ollamaChat(this.opts.ollama, req);
      return { parsed: r.parsed, retried: r.retried };
    };
    const templates = this.loadTemplates();
    this.session = createSession({
      templates,
      chat: chatFn,
      nowISODate: () => todayISO(),
      nowISOTime: () => timeHHmm(),
      maxFollowUps: this.opts.maxFollowUps,
      folderEnum: this.listPickableFolders(),
      lastUsedByTemplate: new Map(
        Object.entries(this.plugin.settings.smartNoteLastUsedByTemplate ?? {}),
      ),
    });
  }

  async onOpen(): Promise<void> {
    this.initSession();
    // Async-load template bodies so the schema classifier has real
    // content to work with. The sync loadTemplates() above returns
    // refs with raw="".
    for (const t of this.session.deps.templates) {
      const file = this.app.vault.getAbstractFileByPath(t.path);
      if (file instanceof TFile) {
        t.raw = await this.app.vault.cachedRead(file);
      }
    }
    this.renderPhase();
    // Prewarm Ollama in the background while the user picks a template
    // and types. The first inference per session otherwise pays the
    // full model-load cost (~60-90 s cold on SP7 CPU for e4b).
    prewarmModel(this.opts.ollama).catch(() => {
      // best-effort; the real call will surface errors
    });
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
    if (!this.session) return;
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

  private detach(): void {
    this.leaf.detach();
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
        return this.detach();
      case "error":
        return this.renderError(contentEl);
    }
  }

  // ----- Phase renderers -----

  private renderPickTemplate(el: HTMLElement): void {
    el.createEl("h2", { text: "Smart Note" });
    el.createEl("p", {
      text:
        "Say or type what kind of note you want. Fuzzy matching finds the right template — the full list is below.",
    });

    let utterance = "";
    new Setting(el)
      .setName("Template")
      .addText((t) => {
        t.setPlaceholder("grocery list");
        t.onChange((v) => (utterance = v));
        t.inputEl.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            go.click();
          }
        });
      });

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
    cancel.addEventListener("click", () => this.detach());

    // Templates it builds — all 14, one terse line each.
    el.createEl("h3", { text: `Templates it builds (${TEMPLATE_SUMMARIES.length})` });
    const tplList = el.createEl("ul");
    tplList.style.lineHeight = "1.5";
    for (const t of TEMPLATE_SUMMARIES) {
      const li = tplList.createEl("li");
      li.createEl("strong", { text: t.name });
      li.appendText(" — ");
      li.appendText(t.what);
      if (t.aliases) {
        const al = li.createEl("span");
        al.style.opacity = "0.7";
        al.textContent = `  Aliases: ${t.aliases}.`;
      }
    }

    // Capabilities — what the tool does regardless of template.
    el.createEl("h3", { text: "What it does" });
    const capList = el.createEl("ul");
    capList.style.lineHeight = "1.5";
    for (const line of CAPABILITY_LINES) {
      capList.createEl("li", { text: line });
    }
  }

  private expandMeals = false;
  private expandMenuNumbers = false;
  private menuIndex: MenuIndex | null = null;
  private groceryUnits: GroceryUnitIndex | null = null;

  private async ensureMenuIndex(): Promise<MenuIndex | null> {
    if (this.menuIndex) return this.menuIndex;
    const file = this.app.vault.getAbstractFileByPath(MENU_ITEMS_PATH);
    if (!(file instanceof TFile)) return null;
    try {
      const content = await this.app.vault.read(file);
      this.menuIndex = parseMenuItems(content);
      return this.menuIndex;
    } catch {
      return null;
    }
  }

  private async ensureGroceryUnits(): Promise<GroceryUnitIndex | null> {
    if (this.groceryUnits) return this.groceryUnits;
    const file = this.app.vault.getAbstractFileByPath(GROCERY_UNITS_PATH);
    if (!(file instanceof TFile)) return null;
    try {
      const content = await this.app.vault.read(file);
      this.groceryUnits = parseGroceryUnits(content);
      return this.groceryUnits;
    } catch {
      return null;
    }
  }

  private renderCapture(el: HTMLElement): void {
    const tpl = this.session.template!;
    const copy = captureCopyFor(tpl.basename);
    el.createEl("h2", { text: copy.heading });
    el.createEl("p", { text: copy.description });

    const log = el.createDiv({ cls: "smart-note-log" });
    log.style.minHeight = "80px";
    log.style.marginBottom = "8px";
    log.style.whiteSpace = "pre-wrap";

    const area = el.createEl("textarea");
    area.rows = 6;
    area.style.width = "100%";
    area.placeholder = copy.placeholder;

    // Grocery-only: two independent toggles.
    const isGrocery = /grocery/i.test(tpl.basename);
    if (isGrocery) {
      new Setting(el)
        .setName("Expand menu numbers from Reference HUB/Menu Items.md")
        .setDesc(
          "When on, naming a menu ID (e.g. \"L47\", \"D32, D40\", \"breakfast 11\") looks up the dish in your curated Menu Items table and adds its ingredients. Deterministic — no LLM invention. Dishes with blank Ingredients cells are skipped with a warning.",
        )
        .addToggle((t) => {
          t.setValue(this.expandMenuNumbers);
          t.onChange((v) => (this.expandMenuNumbers = v));
        });
      new Setting(el)
        .setName("Expand meals into ingredients (LLM guess)")
        .setDesc(
          "When on, naming a meal in free text (e.g. \"chicken parmesan Thursday\") uses the local model to add typical ingredients. For dishes not yet in your Menu Items table. Off by default.",
        )
        .addToggle((t) => {
          t.setValue(this.expandMeals);
          t.onChange((v) => (this.expandMeals = v));
        });
    }

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
      let menuIndex: MenuIndex | null = null;
      let groceryUnits: GroceryUnitIndex | null = null;
      const isGrocery = /grocery/i.test(this.session.template?.basename ?? "");
      if (this.expandMenuNumbers) {
        menuIndex = await this.ensureMenuIndex();
        if (!menuIndex) {
          new Notice(
            `Menu Items file not found at ${MENU_ITEMS_PATH} — continuing without menu lookup.`,
          );
        }
      }
      if (isGrocery) {
        groceryUnits = await this.ensureGroceryUnits();
        // Missing file is non-fatal — Smart Note falls back to raw
        // recipe units. We surface the hint only once per session.
        if (!groceryUnits) {
          new Notice(
            `Grocery Units table not found at ${GROCERY_UNITS_PATH} — using recipe-raw units.`,
          );
        }
      }
      this.session = await submitCapture(this.session, text, {
        expandMeals: this.expandMeals,
        expandMenuNumbers: this.expandMenuNumbers,
        menuIndex,
        groceryUnits,
      });
      this.renderPhase();
    });

    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.detach());
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
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.detach());
  }

  private renderReview(el: HTMLElement): void {
    const plan = prepareReview(this.session);
    if (!plan) {
      new Notice("Nothing to preview.");
      return;
    }
    el.createEl("h2", { text: "Preview" });

    if (this.session.warnings.length > 0) {
      const box = el.createDiv();
      box.style.border = "1px solid var(--text-warning)";
      box.style.padding = "6px 10px";
      box.style.marginBottom = "8px";
      box.style.borderRadius = "4px";
      const h = box.createEl("div", { text: "Menu lookup warnings:" });
      h.style.fontWeight = "600";
      const ul = box.createEl("ul");
      ul.style.margin = "4px 0 0 0";
      for (const w of this.session.warnings) {
        ul.createEl("li", { text: w });
      }
    }

    if (this.session.menuExpansion && this.session.menuExpansion.found.length > 0) {
      const box = el.createDiv();
      box.style.opacity = "0.8";
      box.style.fontSize = "0.9em";
      box.style.marginBottom = "8px";
      const dishes = this.session.menuExpansion.found
        .map((m) => `${m.id} ${m.dish}`)
        .join(" · ");
      box.createEl("div", { text: `From menu: ${dishes}` });
    }

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
        // Side artifacts: Grocery sessions also write a Meal Planner.
        // Failures here must not undo the main save — surface a notice
        // and move on.
        for (const extra of plan.extraArtifacts) {
          try {
            const file = await writeExtraArtifact(this.app, folder, extra.suggestedBasename, extra.body);
            new Notice(`Also created ${file.path}`);
          } catch (e) {
            new Notice(`Side artifact "${extra.suggestedBasename}" failed: ${(e as Error).message}`);
          }
        }
        await this.rememberLastUsed(folder);
        const leaf = this.app.workspace.getLeaf(false);
        if (outcome.file instanceof TFile) await leaf.openFile(outcome.file);
        this.outcome = "saved";
        this.detach();
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
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.detach());
  }

  private renderStatus(el: HTMLElement, text: string): void {
    el.createEl("h2", { text });
  }

  private renderError(el: HTMLElement): void {
    // Reaching this phase means something upstream threw (Ollama
    // timeout, invalid-JSON retry failure, menu lookup fault, …).
    // Record the outcome honestly so the log doesn't claim the user
    // cancelled an abort.
    this.outcome = "error";
    this.outcomeError = this.session.error ?? "(no error message)";
    const msg = this.session.error ?? "(no error message)";
    const looksLikeAbort = /abort|timeout|signal/i.test(msg);
    el.createEl("h2", { text: "Smart Note failed" });
    el.createEl("pre", { text: msg });
    if (looksLikeAbort) {
      const hint = el.createEl("p");
      hint.textContent =
        "Looks like Ollama didn't respond in time. If this is the first use after a reboot or long idle, hitting Retry usually works — the model is now loaded into RAM.";
      hint.style.opacity = "0.8";
    }
    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Retry", cls: "mod-cta" }).addEventListener(
      "click",
      async () => {
        this.outcome = "cancelled";
        this.outcomeError = undefined;
        this.session = { ...this.session, state: "extract", error: null };
        this.renderPhase();
        const retryIsGrocery = /grocery/i.test(this.session.template?.basename ?? "");
        this.session = await submitCapture(this.session, this.session.transcript || "", {
          expandMeals: this.expandMeals,
          expandMenuNumbers: this.expandMenuNumbers,
          menuIndex: this.expandMenuNumbers ? await this.ensureMenuIndex() : null,
          groceryUnits: retryIsGrocery ? await this.ensureGroceryUnits() : null,
        });
        this.renderPhase();
      },
    );
    row.createEl("button", { text: "Back to capture" }).addEventListener(
      "click",
      () => {
        this.outcome = "cancelled";
        this.outcomeError = undefined;
        this.session = { ...this.session, state: "awaitCapture", error: null };
        this.renderPhase();
      },
    );
    row.createEl("button", { text: "Close" }).addEventListener(
      "click",
      () => this.detach(),
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

interface TemplateSummary {
  name: string;
  what: string;
  aliases?: string;
}

// Every template Smart Note knows how to drive. Shown on the pick
// screen so the user never has to guess what's available. Order
// matches the alphabetical sort of basenames in `Templates HUB/`.
const TEMPLATE_SUMMARIES: readonly TemplateSummary[] = [
  {
    name: "Anger Log",
    what: "monthly append file (Anger Log <Month YYYY>.md) — asks what triggered it, what you did, outcome, and notes for next time.",
    aliases: "anger, mad, lost it",
  },
  {
    name: "Auto Maintenance Checklist",
    what: "car/vehicle maintenance by category.",
    aliases: "auto, car, vehicle, maintenance",
  },
  {
    name: "Daily Note",
    what: "today's date as the title; free-form prose body.",
    aliases: "daily",
  },
  {
    name: "Grocery List",
    what: "classifies items into Produce / Meat / Pantry / Frozen / Household. Toggle on \"Expand menu numbers\" to look up dishes by ID from Reference HUB/Menu Items.md (D40, L25, breakfast 11, etc.). Toggle on \"Expand meals\" to let the model guess ingredients for a dish name you give it in free text.",
    aliases: "grocery, groceries, shopping, food",
  },
  {
    name: "Inventory",
    what: "table-mode (Item / Quantity / Location / Notes / Assignment columns). Each item you name becomes one row; columns you skip stay blank. Empty placeholder rows in the template get consumed first; pre-filled rows are preserved.",
    aliases: "inventory",
  },
  {
    name: "List",
    what: "generic multi-section list; sections and routing depend on your template.",
    aliases: "list",
  },
  {
    name: "Menu",
    what: "day-of-eating template (Breakfast / Lunch / Snack 1 / Dinner / Snack 2 / Dessert); classifier when sections are populated.",
    aliases: "menu",
  },
  {
    name: "Note",
    what: "baseline capture; one body, one Links section, no required fields.",
    aliases: "note",
  },
  {
    name: "Person",
    what: "asks relationship; routes to People HUB.",
    aliases: "person",
  },
  {
    name: "Plan Of The Day",
    what: "timed daily plan.",
    aliases: "pod, plan, plan of the day",
  },
  {
    name: "Project",
    what: "asks next-action; routing based on the hub you pick in the preview.",
    aliases: "project",
  },
  {
    name: "Rapids System",
    what: "asks rapids-class (1–5); routes to Daily Priorities / Plans.",
    aliases: "rapids, class, routine",
  },
  {
    name: "To-Do List",
    what: "flat task list; classifier when the template has multiple sections.",
    aliases: "to-do, todo, to do",
  },
  {
    name: "Trip Packing Checklist",
    what: "classifier mode by category; asks destination; title becomes \"<Destination> Packing List\".",
    aliases: "packing, pack, trip",
  },
];

// What Smart Note itself can do, regardless of template.
const CAPABILITY_LINES: readonly string[] = [
  "Local LLM extraction via Ollama + gemma4:e4b (loopback only — nothing leaves this laptop).",
  "Voice capture via whisper.cpp — press the mic to record (hold or toggle). Keyboard works too if the mic isn't set up.",
  "Fuzzy template matching with aliases, so saying \"groceries\" picks Grocery List, \"lost it\" picks Anger Log, etc.",
  "Up to 3 follow-up questions for required fields the model couldn't fill from your capture.",
  "Preview phase before save: editable title, folder dropdown (with the reason it was picked), tag chips, hub-link toggle, full body as a textarea.",
  "Hub-link auto-insertion under ## Notes in the target hub's Main note (or ## Projects for a Project).",
  "Collision-free filenames: a duplicate becomes name (2).md, name (3).md, …",
  "Anger Log append-mode: one entry per capture appended into the current month's file; the plugin creates the monthly file on first use.",
  "Pre-filled template items stay verbatim; sections you didn't mention keep their empty checkbox placeholders. No fabrication.",
  "priority: is never written — the hard-rule guard enforces this on every save. Set priority at daily triage.",
  "Tag enum enforced against Reference HUB/Tags.md. A model-proposed new tag surfaces as an unchecked checkbox in the preview; only if you check it does it land in Tags.md.",
  "Date resolution in code: \"next Friday\", \"tomorrow\", \"the 15th\" are resolved against today in America/Denver — not guessed by the model.",
  "Retry button on error: a timeout usually succeeds on retry because the model is now warm.",
  "Session log at .obsidian/plugins/list-assistant/smart-note-log.jsonl records template, folder, follow-up counts, latency, and outcome. No note content is ever logged.",
];

interface CaptureCopy {
  heading: string;
  description: string;
  placeholder: string;
}

const CAPTURE_COPY: Record<string, CaptureCopy> = {
  "Grocery List Template": {
    heading: "What do you need from the store?",
    description:
      "Just name items — I'll sort them into Produce / Meat / Pantry / Frozen / Household. Reference dishes by their Menu Items ID (\"D40\", \"L25, B11\", \"breakfast 11\") with the menu toggle on. Use the meal toggle for ad-hoc dishes not yet in your Menu Items table.",
    placeholder: "e.g. L25 and D40, plus bananas, bread, paper towels",
  },
  "Inventory Template": {
    heading: "What are you adding to the inventory?",
    description:
      "Say each item with whatever you know about it — quantity, where it is, notes, who it belongs to. I'll put each item on its own row of the Item / Quantity / Location / Notes / Assignment table. Columns you skip stay blank.",
    placeholder: "e.g. '3 shovels in the shed at the ranch; a half-full 20-gal propane tank on the balcony for cookouts; two first-aid kits — one in the Tacoma, one at home.'",
  },
  "To-Do List Template": {
    heading: "What's on this to-do list?",
    description: "Say or type each task. One per line is fine.",
    placeholder: "e.g. renew truck registration, email bank, drop off donations",
  },
  "Trip Packing Checklist Template": {
    heading: "What are you packing?",
    description:
      "Name items — I'll sort them into Clothes / Toiletries / Gear / Documents / etc. if the template has them.",
    placeholder: "e.g. rain shell, headlamp, passport, two pairs of socks",
  },
  "Anger Log Template": {
    heading: "What happened?",
    description:
      "Tell me what triggered it, what you did, what the outcome was, and anything you'd do differently.",
    placeholder: "e.g. 'Kids fought over the iPad at bedtime; I yelled; everyone cried; next time hide the iPad after 7pm.'",
  },
  "Person Template": {
    heading: "Tell me about this person",
    description:
      "Who are they, how do you know them, and anything worth remembering (job, family, interests)?",
    placeholder: "e.g. 'Dave, neighbor two doors down, runs the HOA, has two kids in middle school, into mountain biking.'",
  },
  "Project Template": {
    heading: "Describe the project",
    description:
      "What is it, why does it matter, what's the next concrete action, and when is it due?",
    placeholder:
      "e.g. 'Phase 3.8 alerting: ntfy heartbeat for Pi cams + Frigate + Ranch Brain. Due this week. Next: pick the topic name.'",
  },
};

const DEFAULT_CAPTURE_COPY: CaptureCopy = {
  heading: "Tell me about this",
  description:
    "Speak freely. Press the mic to record (hold or toggle), or type into the box. Done when ready.",
  placeholder: "Type here, or use the mic above.",
};

function captureCopyFor(basename: string): CaptureCopy {
  const specific = CAPTURE_COPY[basename];
  if (specific) return specific;
  return {
    ...DEFAULT_CAPTURE_COPY,
    heading: `Tell me about this ${humanize(basename)}`,
  };
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

// Build an OllamaConfig / transcriber-kind bundle from current settings.
// Lives here (rather than in commands.ts) so SmartNoteView.initSession
// can rebuild options on every reopen without a circular import.
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

// Health check wrapper for the plugin's command handler.
export async function smartNoteCanOpen(opts: {
  ollama: OllamaConfig;
  transcriberKind: SmartNoteModalOptions["transcriberKind"];
  whisperUrl: string;
}): Promise<{ ollamaOk: boolean; transcriberOk: boolean; models: string[] }> {
  const h = await healthCheck(opts.ollama);
  const transcriberOk = opts.transcriberKind === "none"
    ? true
    : opts.transcriberKind === "whisper"
      ? await whisperHealth(opts.whisperUrl)
      : h.ok;
  return { ollamaOk: h.ok && h.modelPresent, transcriberOk, models: h.models };
}
