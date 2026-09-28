import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { TemplatePickerModal } from "./template-picker";
import { CreateNoteModal } from "./create-note-modal";
import {
  DEFAULT_SETTINGS,
  ListAssistantSettings,
  ListAssistantSettingTab,
} from "./settings";
import { runTriage } from "./triage";
import { beginOAuthFlow, OAuthConfig, OAuthTokens } from "./oauth";
import { CalendarClient } from "./calendar";
import { syncCalendar } from "./sync";
import { runAndWrite as runAndWriteAudit } from "./audit";
import { runSemanticAudit } from "./semantic-audit";

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

    this.addCommand({
      id: "sync-google-calendar",
      name: "Sync Google Calendar",
      callback: () => {
        this.syncCalendar().catch((err) => this.reportError("Calendar sync", err));
      },
    });

    this.addCommand({
      id: "connect-google-calendar",
      name: "Connect Google Calendar",
      callback: () => {
        this.connectGoogleCalendar().catch((err) =>
          this.reportError("Calendar connect", err),
        );
      },
    });

    this.addCommand({
      id: "run-vault-audit",
      name: "Run vault audit",
      callback: () => {
        this.runVaultAudit().catch((err) => this.reportError("Vault audit", err));
      },
    });

    this.addCommand({
      id: "run-semantic-vault-audit",
      name: "Run semantic vault audit (uses Anthropic API)",
      callback: () => {
        this.runSemanticVaultAudit().catch((err) => this.reportError("Semantic audit", err));
      },
    });

    this.addRibbonIcon("file-plus", "List Assistant: create from template", () =>
      this.openTemplatePicker(),
    );
    this.addRibbonIcon("list-checks", "List Assistant: run daily triage", () => {
      this.runTriage().catch((err) => this.reportError("Triage", err));
    });
    this.addRibbonIcon("calendar-sync", "List Assistant: sync Google Calendar", () => {
      this.syncCalendar().catch((err) => this.reportError("Calendar sync", err));
    });
    this.addRibbonIcon("search-check", "List Assistant: run vault audit", () => {
      this.runVaultAudit().catch((err) => this.reportError("Vault audit", err));
    });
    this.addRibbonIcon("sparkles", "List Assistant: run semantic vault audit (costs API credit)", () => {
      this.runSemanticVaultAudit().catch((err) => this.reportError("Semantic audit", err));
    });

    this.registerObsidianProtocolHandler("list-assistant", async (params) => {
      try {
        if (params.action === "triage") await this.runTriage();
        else if (params.action === "sync-calendar") await this.syncCalendar();
        else if (params.action === "audit") await this.runVaultAudit();
        else if (params.action === "semantic-audit") await this.runSemanticVaultAudit();
        else if (params.action === "triage-and-sync") {
          await this.runTriage();
          await this.syncCalendar();
        } else if (params.action === "triage-sync-audit") {
          await this.runTriage();
          await this.syncCalendar();
          await this.runVaultAudit();
        }
      } catch (err) {
        this.reportError(`URI ${params.action}`, err);
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

  async runTriage(): Promise<void> {
    const result = await runTriage(this.app, {
      excludeFolders: this.settings.triageExcludeFolders,
      targetFolder: this.settings.dailyPrioritiesFolder,
    });
    const c = result.report.buckets;
    new Notice(
      `Triage — ${result.today}\nQ1 ${c.q1.length} · Q2 ${c.q2.length} · Q3 ${c.q3.length} · Q4 ${c.q4.length} · needs ${result.report.untriaged.length}`,
    );
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(result.file);
  }

  async connectGoogleCalendar(): Promise<void> {
    const config = this.oauthConfig();
    if (!config) return;
    const tokens = await beginOAuthFlow(config);
    this.settings.googleTokens = tokens;
    await this.saveSettings();
    const client = this.buildClient(tokens);
    if (client) {
      try {
        const name = await client.whoAmI();
        new Notice(`Connected to calendar: ${name}`);
      } catch {
        new Notice("Connected. (Could not read calendar name.)");
      }
    }
  }

  async runSemanticVaultAudit(): Promise<void> {
    if (!this.settings.anthropicApiKey) {
      new Notice(
        "Set your Anthropic API key in List Assistant settings before running the semantic audit.",
      );
      return;
    }
    new Notice("Semantic audit running — this may take 30–90 seconds.");
    const result = await runSemanticAudit(this.app, {
      claude: {
        apiKey: this.settings.anthropicApiKey,
        model: this.settings.anthropicModel,
        effort: this.settings.anthropicEffort,
        maxTokens: this.settings.anthropicMaxTokens,
        enableFallbacks: this.settings.anthropicEnableFallbacks,
      },
      auditOpts: {
        excludeFolders: this.settings.auditExcludeFolders,
        stubMaxBytes: this.settings.auditStubMaxBytes,
        minMentionFilesForEntity: this.settings.auditMinMentionFilesForEntity,
        minMentionFilesForUrl: this.settings.auditMinMentionFilesForUrl,
        hubExemptTags: this.settings.auditHubExemptTags,
      },
      targetFolder: this.settings.auditFolder,
      includeDeterministicAudit: this.settings.semanticIncludeAudit,
      noteExcerptChars: this.settings.semanticExcerptChars,
    });
    new Notice(
      `Semantic audit — ${result.findings.length} findings · ` +
        `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens · ` +
        `≈ $${result.usage.costUSD.toFixed(4)}`,
    );
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(result.file);
  }

  async runVaultAudit(): Promise<void> {
    const result = await runAndWriteAudit(this.app, {
      excludeFolders: this.settings.auditExcludeFolders,
      stubMaxBytes: this.settings.auditStubMaxBytes,
      minMentionFilesForEntity: this.settings.auditMinMentionFilesForEntity,
      minMentionFilesForUrl: this.settings.auditMinMentionFilesForUrl,
      hubExemptTags: this.settings.auditHubExemptTags,
      targetFolder: this.settings.auditFolder,
    });
    const f = result.findings;
    new Notice(
      `Vault audit — ${result.today}\n` +
        `${f.scannedCount} scanned · ${f.untagged.length} untagged · ${f.brokenLinks.length} broken · ` +
        `${f.orphans.length} orphans · ${f.stubs.length} stubs · ${f.unlinkedMentions.length} mention-targets · ` +
        `${f.entitiesWithoutNote.length} missing entities · ${f.urlsWithoutNote.length} missing URLs`,
    );
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(result.file);
  }

  async syncCalendar(): Promise<void> {
    const config = this.oauthConfig();
    if (!config) return;
    if (!this.settings.googleTokens) {
      new Notice("Google Calendar not connected. Open List Assistant settings to connect.");
      return;
    }
    const client = this.buildClient(this.settings.googleTokens);
    if (!client) return;
    const summary = await syncCalendar(this.app, client, {
      q1StartHour: this.settings.q1StartHour,
      q1StartMinute: this.settings.q1StartMinute,
      q1EndHour: this.settings.q1EndHour,
      q1EndMinute: this.settings.q1EndMinute,
      q2ReminderDays: this.settings.q2ReminderDays,
      rapidsTemplatePath: this.settings.rapidsTemplatePath,
      excludeFolders: this.settings.triageExcludeFolders,
    });
    const errPart = summary.errors.length ? `\n${summary.errors.length} errors (see console)` : "";
    if (summary.errors.length) {
      for (const e of summary.errors) console.error("List Assistant calendar sync:", e);
    }
    new Notice(
      `Calendar sync\n+${summary.created} created · ${summary.updated} updated${errPart}`,
    );
  }

  private oauthConfig(): OAuthConfig | null {
    const { googleClientId, googleClientSecret, oauthRedirectPort } = this.settings;
    if (!googleClientId || !googleClientSecret) {
      new Notice(
        "Set Google OAuth client ID and secret in List Assistant settings before connecting.",
      );
      return null;
    }
    return {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      redirectPort: oauthRedirectPort,
    };
  }

  private buildClient(tokens: OAuthTokens): CalendarClient | null {
    const config = this.oauthConfig();
    if (!config) return null;
    return new CalendarClient(config, tokens, this.settings.googleCalendarId, async (t) => {
      this.settings.googleTokens = t;
      await this.saveSettings();
    });
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
