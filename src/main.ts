import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { TemplatePickerModal } from "./template-picker";
import { CreateNoteModal } from "./create-note-modal";
import {
  DEFAULT_SETTINGS,
  ListAssistantSettings,
  ListAssistantSettingTab,
} from "./settings";
import { runTriage } from "./triage";

export default class ListAssistantPlugin extends Plugin {
  settings!: ListAssistantSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "create-note-from-template",
      name: "Create note from template",
      callback: () => this.openTemplatePicker(),
    });

    this.addCommand({
      id: "run-daily-triage",
      name: "Run daily triage",
      callback: () => {
        this.runTriage().catch((err) => this.reportError("Triage", err));
      },
    });

    this.addRibbonIcon("file-plus", "List Assistant: create from template", () => {
      this.openTemplatePicker();
    });

    this.addRibbonIcon("list-checks", "List Assistant: run daily triage", () => {
      this.runTriage().catch((err) => this.reportError("Triage", err));
    });

    this.registerObsidianProtocolHandler("list-assistant", async (params) => {
      if (params.action === "triage") {
        try {
          await this.runTriage();
        } catch (err) {
          this.reportError("Triage (URI)", err);
        }
      }
    });

    this.addSettingTab(new ListAssistantSettingTab(this.app, this));
  }

  onunload(): void {}

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private openTemplatePicker(): void {
    const templates = this.getTemplateFiles();
    if (templates.length === 0) {
      new Notice(
        `No templates found in "${this.settings.templatesFolder}". Adjust in List Assistant settings.`,
      );
      return;
    }
    new TemplatePickerModal(this.app, templates, async (tpl) => {
      const raw = await this.app.vault.read(tpl);
      new CreateNoteModal(this.app, this, tpl, raw).open();
    }).open();
  }

  async runTriage(): Promise<void> {
    const result = await runTriage(this.app, {
      excludeFolders: this.settings.triageExcludeFolders,
      targetFolder: this.settings.dailyPrioritiesFolder,
    });
    const counts = result.report.buckets;
    const summary = `Q1 ${counts.q1.length} · Q2 ${counts.q2.length} · Q3 ${counts.q3.length} · Q4 ${counts.q4.length} · triage ${result.report.untriaged.length}`;
    new Notice(`Daily Priorities — ${result.today}\n${summary}`);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(result.file);
  }

  private reportError(context: string, err: unknown): void {
    console.error(`List Assistant: ${context} failed`, err);
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(`${context} failed: ${msg}`);
  }

  private getTemplateFiles(): TFile[] {
    const folderPath = normalizePath(this.settings.templatesFolder);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return [];
    const out: TFile[] = [];
    const walk = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === "md") out.push(child);
        else if (child instanceof TFolder) walk(child);
      }
    };
    walk(folder);
    return out;
  }
}
