import { App, FuzzySuggestModal, TFile } from "obsidian";

export class TemplatePickerModal extends FuzzySuggestModal<TFile> {
  private templates: TFile[];
  private onPick: (t: TFile) => void;

  constructor(app: App, templates: TFile[], onPick: (t: TFile) => void) {
    super(app);
    this.templates = templates;
    this.onPick = onPick;
    this.setPlaceholder("Pick a template");
  }

  getItems(): TFile[] {
    return this.templates;
  }

  getItemText(t: TFile): string {
    return t.basename.replace(/_?Template$/i, "").replace(/_/g, " ").trim() || t.basename;
  }

  onChooseItem(item: TFile): void {
    this.onPick(item);
  }
}
