import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ListAssistantPlugin from "./main";
import { OAuthTokens } from "./oauth";

export interface ListAssistantSettings {
  templatesFolder: string;
  notesFolder: string;
  dailyPrioritiesFolder: string;
  triageExcludeFolders: string[];

  googleClientId: string;
  googleClientSecret: string;
  googleCalendarId: string;
  oauthRedirectPort: number;
  googleTokens: OAuthTokens | null;

  q1StartHour: number;
  q1StartMinute: number;
  q1EndHour: number;
  q1EndMinute: number;
  q2ReminderDays: number;
  rapidsTemplatePath: string;

  auditFolder: string;
  auditExcludeFolders: string[];
  auditStubMaxBytes: number;
  auditMinMentionFilesForEntity: number;
  auditMinMentionFilesForUrl: number;
  auditHubExemptTags: string[];
}

export const DEFAULT_SETTINGS: ListAssistantSettings = {
  templatesFolder: "Templates",
  notesFolder: "",
  dailyPrioritiesFolder: "Daily Priorities",
  triageExcludeFolders: ["Templates", "Daily Priorities"],

  googleClientId: "",
  googleClientSecret: "",
  googleCalendarId: "primary",
  oauthRedirectPort: 42816,
  googleTokens: null,

  q1StartHour: 16,
  q1StartMinute: 0,
  q1EndHour: 17,
  q1EndMinute: 0,
  q2ReminderDays: 3,
  rapidsTemplatePath: "Templates/Rapids_System_Template.md",

  auditFolder: "Vault Audits",
  auditExcludeFolders: ["Templates", "Daily Priorities", "Vault Audits"],
  auditStubMaxBytes: 400,
  auditMinMentionFilesForEntity: 3,
  auditMinMentionFilesForUrl: 2,
  auditHubExemptTags: ["hub", "index", "moc"],
};

function parseIntSafe(v: string, fallback: number): number {
  const n = parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

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

    // Templates section
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

    // Triage
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
        "Comma-separated list of folders whose notes are never scanned.",
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

    // Google Calendar
    containerEl.createEl("h3", { text: "Google Calendar" });
    containerEl.createEl("p", {
      text:
        "Uses your own Google Cloud OAuth 2.0 Desktop client. See docs/GOOGLE-CALENDAR.md for setup.",
    });

    new Setting(containerEl)
      .setName("OAuth client ID")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.googleClientId)
          .onChange(async (v) => {
            this.plugin.settings.googleClientId = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("OAuth client secret")
      .addText((t) => {
        t.inputEl.type = "password";
        t
          .setValue(this.plugin.settings.googleClientSecret)
          .onChange(async (v) => {
            this.plugin.settings.googleClientSecret = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Redirect port")
      .setDesc("Port for the OAuth loopback. Must match the redirect URI in your Google Cloud client.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.oauthRedirectPort))
          .onChange(async (v) => {
            this.plugin.settings.oauthRedirectPort = parseIntSafe(v, 42816);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Calendar ID")
      .setDesc('"primary" for your main calendar, or a specific ID.')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.googleCalendarId)
          .onChange(async (v) => {
            this.plugin.settings.googleCalendarId = v.trim() || "primary";
            await this.plugin.saveSettings();
          }),
      );

    const connected = this.plugin.settings.googleTokens !== null;
    new Setting(containerEl)
      .setName(connected ? "Connected" : "Not connected")
      .setDesc(
        connected
          ? "Refresh token stored. Sync will use it on all devices."
          : "Fill in client ID and secret, then connect from this desktop device.",
      )
      .addButton((b) =>
        b
          .setButtonText(connected ? "Reconnect" : "Connect")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.connectGoogleCalendar();
              this.display();
            } catch (e) {
              new Notice(`Connect failed: ${(e as Error).message}`);
            }
          }),
      )
      .addButton((b) => {
        b.setButtonText("Disconnect").onClick(async () => {
          this.plugin.settings.googleTokens = null;
          await this.plugin.saveSettings();
          new Notice("Google Calendar disconnected.");
          this.display();
        });
        if (!connected) b.setDisabled(true);
      });

    // Sync tuning
    containerEl.createEl("h3", { text: "Calendar sync tuning" });
    new Setting(containerEl)
      .setName("Q1 event start (HH:MM)")
      .setDesc("Time-of-day for Q1 due-date events. America/Denver.")
      .addText((t) =>
        t
          .setValue(this.hhmm(this.plugin.settings.q1StartHour, this.plugin.settings.q1StartMinute))
          .onChange(async (v) => {
            const p = this.parseHHMM(v);
            if (p) {
              this.plugin.settings.q1StartHour = p.h;
              this.plugin.settings.q1StartMinute = p.m;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Q1 event end (HH:MM)")
      .setDesc("End time for Q1 due-date events.")
      .addText((t) =>
        t
          .setValue(this.hhmm(this.plugin.settings.q1EndHour, this.plugin.settings.q1EndMinute))
          .onChange(async (v) => {
            const p = this.parseHHMM(v);
            if (p) {
              this.plugin.settings.q1EndHour = p.h;
              this.plugin.settings.q1EndMinute = p.m;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Q2 reminder days before due")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.q2ReminderDays))
          .onChange(async (v) => {
            this.plugin.settings.q2ReminderDays = parseIntSafe(v, 3);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Rapids System template path")
      .setDesc("Read to build the time-blocked event chain from a Plan of the Day's rapids-class.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.rapidsTemplatePath)
          .onChange(async (v) => {
            this.plugin.settings.rapidsTemplatePath = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    // Vault audit
    containerEl.createEl("h3", { text: "Vault audit" });
    new Setting(containerEl)
      .setName("Audit reports folder")
      .setDesc("Where audit reports are written. One file per day.")
      .addText((t) =>
        t
          .setPlaceholder("Vault Audits")
          .setValue(this.plugin.settings.auditFolder)
          .onChange(async (v) => {
            this.plugin.settings.auditFolder = v.trim() || "Vault Audits";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Audit exclude folders")
      .setDesc("Comma-separated folders skipped by the auditor.")
      .addText((t) =>
        t
          .setPlaceholder("Templates, Daily Priorities, Vault Audits")
          .setValue(this.plugin.settings.auditExcludeFolders.join(", "))
          .onChange(async (v) => {
            this.plugin.settings.auditExcludeFolders = v
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Stub threshold (bytes)")
      .setDesc("Files at or below this size (or with body under 30 chars) are flagged as stubs.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.auditStubMaxBytes))
          .onChange(async (v) => {
            this.plugin.settings.auditStubMaxBytes = parseIntSafe(v, 400);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Entity minimum mentions")
      .setDesc("A capitalized name must appear in at least this many notes to be flagged as missing.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.auditMinMentionFilesForEntity))
          .onChange(async (v) => {
            this.plugin.settings.auditMinMentionFilesForEntity = parseIntSafe(v, 3);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("URL minimum mentions")
      .setDesc("A hostname must appear in at least this many notes to be flagged as missing.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.auditMinMentionFilesForUrl))
          .onChange(async (v) => {
            this.plugin.settings.auditMinMentionFilesForUrl = parseIntSafe(v, 2);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Hub exempt tags")
      .setDesc("Notes with any of these tags are exempt from the sinks list (typically hub index notes).")
      .addText((t) =>
        t
          .setPlaceholder("hub, index, moc")
          .setValue(this.plugin.settings.auditHubExemptTags.join(", "))
          .onChange(async (v) => {
            this.plugin.settings.auditHubExemptTags = v
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          }),
      );
  }

  private hhmm(h: number, m: number): string {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  private parseHHMM(v: string): { h: number; m: number } | null {
    const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h, m: min };
  }
}
