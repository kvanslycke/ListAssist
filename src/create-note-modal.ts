import {
  App,
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  stringifyYaml,
} from "obsidian";
import { ParsedTemplate, parseTemplate } from "./template-parser";
import { humanizeKey, slugifyTitle, substituteBody, todayISO } from "./util";
import type ListAssistantPlugin from "./main";

export class CreateNoteModal extends Modal {
  private plugin: ListAssistantPlugin;
  private template: TFile;
  private parsed: ParsedTemplate;
  private values: Record<string, string> = {};
  private bodyValues: Record<string, string> = {};
  private title: string;

  constructor(app: App, plugin: ListAssistantPlugin, template: TFile, raw: string) {
    super(app);
    this.plugin = plugin;
    this.template = template;
    this.parsed = parseTemplate(raw);
    this.title = template.basename
      .replace(/_?Template$/i, "")
      .replace(/_/g, " ")
      .trim();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `New note from ${this.template.basename}` });

    new Setting(contentEl)
      .setName("Title")
      .setDesc("Filename and note heading")
      .addText((t) => {
        t.setValue(this.title);
        t.onChange((v) => (this.title = v));
        t.inputEl.style.width = "100%";
      });

    for (const f of this.parsed.fields) {
      if (f.kind === "static" || f.kind === "date-today" || f.kind === "title") continue;

      if (f.kind === "priority-untouched") {
        new Setting(contentEl)
          .setName(humanizeKey(f.key))
          .setDesc("Priority is yours to set later — leaving empty.")
          .addText((t) => {
            t.setDisabled(true);
            t.setValue(String(f.currentValue ?? ""));
          });
        continue;
      }

      const label = f.placeholderName ?? f.key;
      new Setting(contentEl)
        .setName(humanizeKey(label))
        .setDesc(
          f.placeholderName
            ? `Placeholder \`{{${f.placeholderName}}}\``
            : `Frontmatter field \`${f.key}\``,
        )
        .addText((t) => {
          t.onChange((v) => (this.values[f.key] = v));
        });
    }

    for (const ph of this.parsed.bodyPlaceholders) {
      new Setting(contentEl)
        .setName(humanizeKey(ph))
        .setDesc(`Body placeholder \`{{${ph}}}\``)
        .addText((t) => {
          t.onChange((v) => (this.bodyValues[ph] = v));
        });
    }

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const submit = btnRow.createEl("button", { text: "Create note", cls: "mod-cta" });
    submit.addEventListener("click", () => {
      this.createNote().catch((err) => {
        console.error("List Assistant: create note failed", err);
        new Notice(`Create failed: ${(err as Error).message}`);
      });
    });
    const cancel = btnRow.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async createNote(): Promise<void> {
    const title = this.title.trim();
    if (!title) {
      new Notice("Title is required.");
      return;
    }
    const today = todayISO();

    const newFm: Record<string, unknown> = {};
    for (const f of this.parsed.fields) {
      switch (f.kind) {
        case "date-today":
          newFm[f.key] = today;
          break;
        case "title":
          newFm[f.key] = title;
          break;
        case "prompt": {
          const v = this.values[f.key];
          newFm[f.key] = v !== undefined && v !== "" ? v : f.currentValue ?? "";
          break;
        }
        case "static":
          newFm[f.key] = f.currentValue;
          break;
        case "priority-untouched":
          newFm[f.key] = f.currentValue ?? "";
          break;
      }
    }

    const bodySubs: Record<string, string> = { title, date: today, ...this.bodyValues };
    const newBody = substituteBody(this.parsed.body, bodySubs);

    const yamlStr = Object.keys(newFm).length ? stringifyYaml(newFm).trimEnd() : "";
    const fileContent = yamlStr
      ? `---\n${yamlStr}\n---\n\n${newBody.trimStart()}`
      : newBody.trimStart();

    const folder = this.plugin.settings.notesFolder.trim();
    const safeName = slugifyTitle(title) || "Untitled";
    let path = folder ? normalizePath(`${folder}/${safeName}.md`) : `${safeName}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      path = path.replace(/\.md$/, ` ${today}.md`);
    }
    if (folder && !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
      await this.app.vault.createFolder(folder);
    }
    const created = await this.app.vault.create(path, fileContent);
    new Notice(`Created ${path}`);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(created as TFile);
    this.close();
  }
}
