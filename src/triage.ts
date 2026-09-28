import { App, TFile, normalizePath, stringifyYaml } from "obsidian";
import { todayISO } from "./util";

export type Priority = "q1" | "q2" | "q3" | "q4";

export interface TriageEntry {
  file: TFile;
  priority: Priority | null;
  due: string | null;
  status: string | null;
  ageDays: number;
}

export interface TriageReport {
  buckets: Record<Priority, TriageEntry[]>;
  untriaged: TriageEntry[];
  scannedAt: string;
}

const PRIORITY_KEYS = ["priority", "Priority Level"] as const;
const STATUS_DONE_VALUES = new Set(["done", "completed", "complete", "cancelled", "canceled"]);
const QUADRANT_ORDER: Priority[] = ["q1", "q2", "q3", "q4"];
const QUADRANT_LABELS: Record<Priority, string> = {
  q1: "Q1 — Urgent & Important",
  q2: "Q2 — Not Urgent, Important",
  q3: "Q3 — Urgent, Not Important",
  q4: "Q4 — Neither",
};

export function parsePriority(raw: unknown): Priority | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "") return null;
  const head = s.replace(/^q?/, "").charAt(0);
  if (head === "1") return "q1";
  if (head === "2") return "q2";
  if (head === "3") return "q3";
  if (head === "4") return "q4";
  return null;
}

function readPriority(fm: Record<string, unknown>): { present: boolean; value: Priority | null } {
  for (const k of PRIORITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(fm, k)) {
      return { present: true, value: parsePriority(fm[k]) };
    }
  }
  return { present: false, value: null };
}

function readDue(fm: Record<string, unknown>): string | null {
  const raw = fm.due ?? fm.Due;
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date) {
    const yyyy = raw.getFullYear();
    const mm = String(raw.getMonth() + 1).padStart(2, "0");
    const dd = String(raw.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(raw);
}

function readStatus(fm: Record<string, unknown>): string | null {
  const raw = fm.status ?? fm.Status;
  if (raw === null || raw === undefined || raw === "") return null;
  return String(raw).toLowerCase();
}

function inExcludedFolder(path: string, folders: string[]): boolean {
  for (const f of folders) {
    if (!f) continue;
    const norm = normalizePath(f);
    if (path === norm || path.startsWith(norm + "/")) return true;
  }
  return false;
}

export interface ScanOptions {
  excludeFolders: string[];
  now?: number;
}

export function scanVault(app: App, opts: ScanOptions): TriageEntry[] {
  const now = opts.now ?? Date.now();
  const files = app.vault.getMarkdownFiles();
  const entries: TriageEntry[] = [];
  for (const file of files) {
    if (inExcludedFolder(file.path, opts.excludeFolders)) continue;
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    if (!fm) continue;
    const priority = readPriority(fm);
    if (!priority.present) continue;
    const status = readStatus(fm);
    if (status && STATUS_DONE_VALUES.has(status)) continue;
    const due = readDue(fm);
    const ageDays = Math.floor((now - file.stat.mtime) / 86_400_000);
    entries.push({ file, priority: priority.value, due, status, ageDays });
  }
  return entries;
}

export function buildReport(entries: TriageEntry[], now: Date = new Date()): TriageReport {
  const buckets: Record<Priority, TriageEntry[]> = { q1: [], q2: [], q3: [], q4: [] };
  const untriaged: TriageEntry[] = [];
  for (const e of entries) {
    if (e.priority) buckets[e.priority].push(e);
    else untriaged.push(e);
  }
  const cmp = (a: TriageEntry, b: TriageEntry): number => {
    if (a.due && b.due) {
      const c = a.due.localeCompare(b.due);
      if (c !== 0) return c;
    } else if (a.due) return -1;
    else if (b.due) return 1;
    return a.file.basename.localeCompare(b.file.basename);
  };
  for (const p of QUADRANT_ORDER) buckets[p].sort(cmp);
  untriaged.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
  return { buckets, untriaged, scannedAt: now.toISOString() };
}

function renderEntry(e: TriageEntry): string {
  const bits: string[] = [];
  if (e.due) bits.push(`due ${e.due}`);
  if (e.status && e.status !== "not-started") bits.push(e.status);
  if (e.ageDays > 30) bits.push(`stale ${e.ageDays}d`);
  const link = `[[${e.file.basename}]]`;
  return bits.length ? `${link} · ${bits.join(" · ")}` : link;
}

export function renderReport(report: TriageReport, today: string): string {
  const fm = stringifyYaml({
    tags: ["daily", "priorities"],
    date: today,
    generated: report.scannedAt,
  }).trimEnd();

  const lines: string[] = [];
  lines.push("---", fm, "---", "", `# Daily Priorities — ${today}`, "");

  for (const p of QUADRANT_ORDER) {
    lines.push(`## ${QUADRANT_LABELS[p]}`);
    const bucket = report.buckets[p];
    if (bucket.length === 0) {
      lines.push("- (none)");
    } else {
      for (const e of bucket) lines.push(`- ${renderEntry(e)}`);
    }
    lines.push("");
  }

  lines.push(`## Needs triage (${report.untriaged.length})`);
  if (report.untriaged.length === 0) {
    lines.push("- (none)");
  } else {
    for (const e of report.untriaged) lines.push(`- ${renderEntry(e)}`);
    lines.push("");
    lines.push("Set `priority: q1 | q2 | q3 | q4` in each note's frontmatter to bucket it.");
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeReport(
  app: App,
  content: string,
  folder: string,
  today: string,
): Promise<TFile> {
  const folderPath = normalizePath(folder);
  if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
    await app.vault.createFolder(folderPath);
  }
  const path = folderPath
    ? normalizePath(`${folderPath}/${today}.md`)
    : normalizePath(`${today}.md`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return existing;
  }
  return (await app.vault.create(path, content)) as TFile;
}

export async function runTriage(
  app: App,
  opts: { excludeFolders: string[]; targetFolder: string },
): Promise<{ file: TFile; report: TriageReport; today: string }> {
  const entries = scanVault(app, { excludeFolders: opts.excludeFolders });
  const report = buildReport(entries);
  const today = todayISO();
  const content = renderReport(report, today);
  const file = await writeReport(app, content, opts.targetFolder, today);
  return { file, report, today };
}
