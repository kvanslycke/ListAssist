import { App, TFile, normalizePath } from "obsidian";
import { CalendarClient, CalendarEventSpec, EVENT_TAG } from "./calendar";
import { parseRapidsSchedules } from "./rapids";
import { parsePriority } from "./triage";

export const TIMEZONE = "America/Denver";
const STATUS_DONE = new Set(["done", "completed", "complete", "cancelled", "canceled"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SyncOptions {
  q1StartHour: number;
  q1StartMinute: number;
  q1EndHour: number;
  q1EndMinute: number;
  q2ReminderDays: number;
  rapidsTemplatePath: string;
  excludeFolders: string[];
}

export interface SyncSummary {
  created: number;
  updated: number;
  skippedFiles: number;
  scannedFiles: number;
  errors: string[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function inExcludedFolder(path: string, folders: string[]): boolean {
  for (const f of folders) {
    if (!f) continue;
    const norm = normalizePath(f);
    if (path === norm || path.startsWith(norm + "/")) return true;
  }
  return false;
}

function toString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v);
}

export async function buildEventSpecs(
  app: App,
  opts: SyncOptions,
): Promise<{ specs: CalendarEventSpec[]; scanned: number; skipped: number }> {
  let scanned = 0;
  let skipped = 0;
  const specs: CalendarEventSpec[] = [];

  const rapidsFile = app.vault.getAbstractFileByPath(normalizePath(opts.rapidsTemplatePath));
  const rapids = rapidsFile instanceof TFile
    ? parseRapidsSchedules(await app.vault.read(rapidsFile))
    : new Map();

  for (const file of app.vault.getMarkdownFiles()) {
    if (inExcludedFolder(file.path, opts.excludeFolders)) continue;
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    if (!fm) continue;
    scanned++;

    const status = toString(fm.status ?? fm.Status).toLowerCase();
    if (status && STATUS_DONE.has(status)) {
      skipped++;
      continue;
    }

    let contributed = false;

    // Rapids class chain
    const rcRaw = fm["rapids-class"];
    const rcNum = typeof rcRaw === "number" ? rcRaw : parseInt(toString(rcRaw), 10);
    const dateStr = toString(fm.date);
    if (
      !Number.isNaN(rcNum) &&
      rapids.has(rcNum) &&
      ISO_DATE_RE.test(dateStr)
    ) {
      const schedule = rapids.get(rcNum)!;
      for (let i = 0; i < schedule.events.length; i++) {
        const ev = schedule.events[i];
        const next = schedule.events[i + 1];
        const endHour = next?.hour ?? ev.hour + 1;
        const endMinute = next?.minute ?? ev.minute;
        specs.push({
          sourceKey: `${file.path}#rapids-${i}`,
          kind: "rapids-class",
          summary: ev.label,
          description: `${EVENT_TAG} Rapids ${schedule.className}\nFrom [[${file.basename}]]`,
          start: {
            dateTime: `${dateStr}T${pad(ev.hour)}:${pad(ev.minute)}:00`,
            timeZone: TIMEZONE,
          },
          end: {
            dateTime: `${dateStr}T${pad(endHour)}:${pad(endMinute)}:00`,
            timeZone: TIMEZONE,
          },
        });
        contributed = true;
      }
    }

    // Due-based event (Q1/Q2 only)
    const due = toString(fm.due ?? fm.Due);
    const priority = parsePriority(fm.priority ?? fm["Priority Level"]);
    if (ISO_DATE_RE.test(due) && priority) {
      if (priority === "q1") {
        specs.push({
          sourceKey: file.path,
          kind: "due-q1",
          summary: file.basename,
          description: `${EVENT_TAG} Q1 due today\nFrom [[${file.basename}]]`,
          start: {
            dateTime: `${due}T${pad(opts.q1StartHour)}:${pad(opts.q1StartMinute)}:00`,
            timeZone: TIMEZONE,
          },
          end: {
            dateTime: `${due}T${pad(opts.q1EndHour)}:${pad(opts.q1EndMinute)}:00`,
            timeZone: TIMEZONE,
          },
        });
        contributed = true;
      } else if (priority === "q2") {
        const reminder = addDaysISO(due, -opts.q2ReminderDays);
        specs.push({
          sourceKey: file.path,
          kind: "due-q2-reminder",
          summary: `Reminder: ${file.basename} (due ${due})`,
          description: `${EVENT_TAG} Q2 reminder ${opts.q2ReminderDays}d before due\nFrom [[${file.basename}]]`,
          start: { date: reminder },
          end: { date: reminder },
        });
        contributed = true;
      }
    }

    if (!contributed) skipped++;
  }

  return { specs, scanned, skipped };
}

export async function syncCalendar(
  app: App,
  client: CalendarClient,
  opts: SyncOptions,
): Promise<SyncSummary> {
  const { specs, scanned, skipped } = await buildEventSpecs(app, opts);
  let created = 0;
  let updated = 0;
  const errors: string[] = [];
  for (const spec of specs) {
    try {
      const r = await client.upsert(spec);
      if (r.created) created++;
      else updated++;
    } catch (e) {
      errors.push(`${spec.sourceKey} (${spec.kind}): ${(e as Error).message}`);
    }
  }
  return { created, updated, skippedFiles: skipped, scannedFiles: scanned, errors };
}
