import { App, PluginSettingTab, Setting } from "obsidian";
import type ListAssistantPlugin from "./main";

export interface ListAssistantSettings {
  templatesFolder: string;
  notesFolder: string;
  dailyPrioritiesFolder: string;
  triageExcludeFolders: string[];
}

export const DEFAULT_SETTINGS: ListAssistantSettings = {
  templatesFolder: "Templates",
  notesFolder: "",
  dailyPrioritiesFolder: "Daily Priorities",
  triageExcludeFolders: ["Templates", "Daily Priorities"],
};

export class ListAssistantSettingTab extends PluginSettingTab {
  private plugin: ListAssistantPlugin;

  constructor(app: App, plugin: ListAssistantPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "List Assistant" });

    containerEl.createEl("h3", { text: "Templates" });
    new Setting(containerEl)
      .setName("Templates folder")
      .setDesc("Vault-relative folder the plugin scans for templates.")
      .addText((t) =>
        t
          .setPlaceholder("Templates")
          .setValue(this.plugin.settings.templatesFolder)
          .onChange(async (v) => {
            this.plugin.settings.templatesFolder = v.trim() || "Templates";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("New notes folder")
      .setDesc("Where new notes go. Leave empty for vault root.")
      .addText((t) =>
        t
          .setPlaceholder("(vault root)")
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (v) => {
            this.plugin.settings.notesFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Daily triage" });
    new Setting(containerEl)
      .setName("Daily Priorities folder")
      .setDesc("Where the daily triage report is written. One file per day.")
      .addText((t) =>
        t
          .setPlaceholder("Daily Priorities")
          .setValue(this.plugin.settings.dailyPrioritiesFolder)
          .onChange(async (v) => {
            this.plugin.settings.dailyPrioritiesFolder = v.trim() || "Daily Priorities";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Exclude folders from triage")
      .setDesc(
        "Comma-separated list of folders whose notes are never scanned (templates, the report folder itself, etc.).",
      )
      .addText((t) =>
        t
          .setPlaceholder("Templates, Daily Priorities")
          .setValue(this.plugin.settings.triageExcludeFolders.join(", "))
          .onChange(async (v) => {
            this.plugin.settings.triageExcludeFolders = v
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          }),
      );
  }
}
