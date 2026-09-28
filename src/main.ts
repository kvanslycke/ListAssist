import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { TemplatePickerModal } from "./template-picker";
import { CreateNoteModal } from "./create-note-modal";
import {
  DEFAULT_SETTINGS,
  ListAssistantSettings,
  ListAssistantSettingTab,
} from "./settings";

export default class ListAssistantPlugin extends Plugin {
  settings!: ListAssistantSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "create-note-from-template",
      name: "Create note from template",
      callback: () => this.openTemplatePicker(),
    });

    this.addRibbonIcon("file-plus", "List Assistant: create from template", () => {
      this.openTemplatePicker();
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
