import { App, PluginSettingTab, Setting } from "obsidian";
import type ListAssistantPlugin from "./main";

export interface ListAssistantSettings {
  templatesFolder: string;
  notesFolder: string;
}

export const DEFAULT_SETTINGS: ListAssistantSettings = {
  templatesFolder: "Templates",
  notesFolder: "",
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
  }
}
