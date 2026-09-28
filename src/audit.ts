import { App, TFile, normalizePath, stringifyYaml } from "obsidian";
import { todayISO } from "./util";

export interface AuditFindings {
  scannedCount: number;
  untagged: TFile[];
  stubs: Array<{ file: TFile; size: number }>;
  brokenLinks: Array<{ file: TFile; link: string; line: number }>;
  orphans: TFile[];
  sinks: TFile[];
  possibleDuplicates: Array<{ a: TFile; b: TFile; reason: string }>;
  unlinkedMentions: Array<{ target: TFile; sources: Array<{ file: TFile; count: number }> }>;
  entitiesWithoutNote: Array<{ name: string; mentions: number; files: TFile[] }>;
  urlsWithoutNote: Array<{ host: string; mentions: number; files: TFile[] }>;
}

export interface AuditOptions {
  excludeFolders: string[];
  stubMaxBytes: number;
  minMentionFilesForEntity: number;
  minMentionFilesForUrl: number;
  hubExemptTags: string[];
}

const STOPWORD_TITLES = new Set([
  "index",
  "readme",
  "template",
  "main",
]);

const ENTITY_STOPWORDS = new Set([
  "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday",
  "January","February","March","April","May","June","July","August","September","October","November","December",
  "United States","New York","Los Angeles","San Francisco","North America","South America","North Star",
  "Google Calendar","Google Cloud","Google Drive","Task Scheduler","Windows Task Scheduler","Obsidian Sync",
  "The Ranch","The Sentinel","The Watch","The Plan","The Rapids",
]);

const URL_HOST_STOPWORDS = new Set([
  "github.com","google.com","www.google.com","calendar.google.com","docs.google.com",
  "youtube.com","youtu.be","www.youtube.com","wikipedia.org","en.wikipedia.org",
  "amazon.com","www.amazon.com","obsidian.md","claude.ai","anthropic.com",
]);

function inExcluded(path: string, folders: string[]): boolean {
  for (const f of folders) {
    if (!f) continue;
    const norm = normalizePath(f);
    if (path === norm || path.startsWith(norm + "/")) return true;
  }
  return false;
}

function hasAnyTags(fm: Record<string, unknown> | undefined, inline: Array<{ tag: string }> | undefined): boolean {
  if (inline && inline.length > 0) return true;
  if (!fm) return false;
  const t = fm.tags ?? fm.Tags ?? fm.tag;
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && x.trim().length > 0);
  if (typeof t === "string") return t.trim().length > 0;
  return false;
}

function stripFrontmatter(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return m ? m[1] : content;
}

function stringSimilarityRatio(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const shorter = la < lb ? a : b;
  const longer = la < lb ? b : a;
  if (longer.length > 100) return 0;
  // Levenshtein
  const dp: number[] = new Array(shorter.length + 1);
  for (let i = 0; i <= shorter.length; i++) dp[i] = i;
  for (let j = 1; j <= longer.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= shorter.length; i++) {
      const tmp = dp[i];
      dp[i] =
        longer[j - 1] === shorter[i - 1]
          ? prev
          : 1 + Math.min(dp[i], dp[i - 1], prev);
      prev = tmp;
    }
  }
  const dist = dp[shorter.length];
  return 1 - dist / longer.length;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runAudit(app: App, opts: AuditOptions): Promise<AuditFindings> {
  const allFiles = app.vault.getMarkdownFiles();
  const files = allFiles.filter((f) => !inExcluded(f.path, opts.excludeFolders));

  const untagged: TFile[] = [];
  const stubs: Array<{ file: TFile; size: number }> = [];
  const brokenLinks: AuditFindings["brokenLinks"] = [];
  const linkedTargets = new Set<string>();
  const outboundCount = new Map<string, number>();

  // Preload content once for stub + mention passes
  const contentByPath = new Map<string, string>();
  for (const f of files) {
    if (f.stat.size <= opts.stubMaxBytes) {
      contentByPath.set(f.path, await app.vault.cachedRead(f));
    }
  }

  for (const f of files) {
    const cache = app.metadataCache.getFileCache(f);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    if (!hasAnyTags(fm, cache?.tags)) untagged.push(f);

    // Stub check: small file or empty body after frontmatter
    if (f.stat.size <= opts.stubMaxBytes) {
      const raw = contentByPath.get(f.path) ?? "";
      const body = stripFrontmatter(raw).trim();
      if (body.length < 30) stubs.push({ file: f, size: f.stat.size });
    }

    const links = cache?.links ?? [];
    outboundCount.set(f.path, (cache?.links?.length ?? 0) + (cache?.embeds?.length ?? 0));
    for (const link of links) {
      const dest = app.metadataCache.getFirstLinkpathDest(link.link, f.path);
      if (dest) {
        linkedTargets.add(dest.path);
      } else {
        brokenLinks.push({
          file: f,
          link: link.link,
          line: link.position?.start?.line ?? 0,
        });
      }
    }
  }

  const orphans = files.filter((f) => !linkedTargets.has(f.path));
  const sinks = files.filter((f) => (outboundCount.get(f.path) ?? 0) === 0);

  // Possible duplicates: very similar names AND at least one is tiny
  const possibleDuplicates: AuditFindings["possibleDuplicates"] = [];
  const byBaseKey = new Map<string, TFile[]>();
  for (const f of files) {
    const key = f.basename.toLowerCase().replace(/[\s_\-]+/g, "").replace(/\d+$/, "");
    if (!key) continue;
    (byBaseKey.get(key) ?? byBaseKey.set(key, []).get(key)!).push(f);
  }
  for (const group of byBaseKey.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const smaller = a.stat.size < b.stat.size ? a : b;
        if (smaller.stat.size <= opts.stubMaxBytes) {
          const sim = stringSimilarityRatio(a.basename.toLowerCase(), b.basename.toLowerCase());
          if (sim >= 0.7) {
            possibleDuplicates.push({
              a,
              b,
              reason: `basenames ${(sim * 100).toFixed(0)}% similar; smaller is ${smaller.stat.size}B`,
            });
          }
        }
      }
    }
  }

  // Unlinked mentions: title-of-A appears as bare text in body-of-B, and B doesn't already link to A.
  const mentionCandidates: TFile[] = files.filter((f) => {
    const b = f.basename;
    if (b.length < 4) return false;
    if (STOPWORD_TITLES.has(b.toLowerCase())) return false;
    return true;
  });
  const titleRegexes = mentionCandidates.map((f) => ({
    file: f,
    re: new RegExp(`\\b${escapeRegex(f.basename)}\\b`, "g"),
  }));
  const linkedFromTo = buildLinkAdjacency(app, files);
  const unlinkedMentions: AuditFindings["unlinkedMentions"] = [];
  const mentionsByTarget = new Map<string, Array<{ file: TFile; count: number }>>();
  for (const source of files) {
    const raw = contentByPath.get(source.path) ?? (await app.vault.cachedRead(source));
    // Strip frontmatter and existing [[...]] links so we don't match inside them
    const body = stripFrontmatter(raw).replace(/\[\[[^\]]+\]\]/g, "");
    if (body.length === 0) continue;
    for (const { file: target, re } of titleRegexes) {
      if (target.path === source.path) continue;
      if (linkedFromTo.get(source.path)?.has(target.path)) continue;
      re.lastIndex = 0;
      let count = 0;
      while (re.exec(body) !== null) count++;
      if (count > 0) {
        const list = mentionsByTarget.get(target.path) ?? [];
        list.push({ file: source, count });
        mentionsByTarget.set(target.path, list);
      }
    }
  }
  for (const target of mentionCandidates) {
    const sources = mentionsByTarget.get(target.path);
    if (sources && sources.length > 0) {
      sources.sort((a, b) => b.count - a.count);
      unlinkedMentions.push({ target, sources });
    }
  }
  unlinkedMentions.sort((a, b) => {
    const sa = a.sources.reduce((s, x) => s + x.count, 0);
    const sb = b.sources.reduce((s, x) => s + x.count, 0);
    return sb - sa;
  });

  // Entities without a note: capitalized 2-4 word phrases mentioned in >= N notes, no existing note by that name
  const existingTitles = new Set(files.map((f) => f.basename.toLowerCase()));
  const entityRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;
  const entityAppearances = new Map<string, Set<string>>();
  for (const f of files) {
    const raw = contentByPath.get(f.path) ?? (await app.vault.cachedRead(f));
    const body = stripFrontmatter(raw).replace(/\[\[[^\]]+\]\]/g, "").replace(/https?:\/\/\S+/g, "");
    let m: RegExpExecArray | null;
    entityRe.lastIndex = 0;
    while ((m = entityRe.exec(body)) !== null) {
      const name = m[1];
      if (ENTITY_STOPWORDS.has(name)) continue;
      if (existingTitles.has(name.toLowerCase())) continue;
      const set = entityAppearances.get(name) ?? new Set<string>();
      set.add(f.path);
      entityAppearances.set(name, set);
    }
  }
  const entitiesWithoutNote: AuditFindings["entitiesWithoutNote"] = [];
  for (const [name, paths] of entityAppearances.entries()) {
    if (paths.size < opts.minMentionFilesForEntity) continue;
    const filesFor = files.filter((f) => paths.has(f.path));
    entitiesWithoutNote.push({ name, mentions: paths.size, files: filesFor });
  }
  entitiesWithoutNote.sort((a, b) => b.mentions - a.mentions);

  // URLs without a note: hostnames appearing in >= N notes, no note whose title contains the host
  const urlRe = /https?:\/\/([^\s/)]+)/g;
  const urlAppearances = new Map<string, Set<string>>();
  for (const f of files) {
    const raw = contentByPath.get(f.path) ?? (await app.vault.cachedRead(f));
    urlRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(raw)) !== null) {
      const host = m[1].replace(/^www\./, "").toLowerCase();
      if (URL_HOST_STOPWORDS.has(host) || URL_HOST_STOPWORDS.has("www." + host)) continue;
      const set = urlAppearances.get(host) ?? new Set<string>();
      set.add(f.path);
      urlAppearances.set(host, set);
    }
  }
  const urlsWithoutNote: AuditFindings["urlsWithoutNote"] = [];
  for (const [host, paths] of urlAppearances.entries()) {
    if (paths.size < opts.minMentionFilesForUrl) continue;
    const titled = files.some((f) => f.basename.toLowerCase().includes(host));
    if (titled) continue;
    urlsWithoutNote.push({
      host,
      mentions: paths.size,
      files: files.filter((f) => paths.has(f.path)),
    });
  }
  urlsWithoutNote.sort((a, b) => b.mentions - a.mentions);

  // Exempt hub-tagged notes from the sinks list
  const finalSinks = sinks.filter((f) => {
    const cache = app.metadataCache.getFileCache(f);
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    const tags = collectTags(fm, cache?.tags);
    return !tags.some((t) => opts.hubExemptTags.some((h) => t.replace(/^#/, "").toLowerCase() === h.toLowerCase()));
  });

  return {
    scannedCount: files.length,
    untagged,
    stubs,
    brokenLinks,
    orphans,
    sinks: finalSinks,
    possibleDuplicates,
    unlinkedMentions,
    entitiesWithoutNote,
    urlsWithoutNote,
  };
}

function collectTags(
  fm: Record<string, unknown> | undefined,
  inline: Array<{ tag: string }> | undefined,
): string[] {
  const out: string[] = [];
  if (inline) {
    for (const t of inline) out.push(t.tag);
  }
  if (fm) {
    const t: unknown = fm.tags ?? fm.Tags ?? fm.tag;
    if (Array.isArray(t)) {
      for (const x of t) {
        if (typeof x === "string") out.push(x);
      }
    } else if (typeof t === "string") {
      for (const x of t.split(/[\s,]+/)) {
        if (x) out.push(x);
      }
    }
  }
  return out;
}

function buildLinkAdjacency(app: App, files: TFile[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    const cache = app.metadataCache.getFileCache(f);
    const set = new Set<string>();
    for (const link of cache?.links ?? []) {
      const dest = app.metadataCache.getFirstLinkpathDest(link.link, f.path);
      if (dest) set.add(dest.path);
    }
    for (const embed of cache?.embeds ?? []) {
      const dest = app.metadataCache.getFirstLinkpathDest(embed.link, f.path);
      if (dest) set.add(dest.path);
    }
    out.set(f.path, set);
  }
  return out;
}

function linkFor(f: TFile): string {
  return `[[${f.basename}]]`;
}

export function renderReport(findings: AuditFindings, today: string): string {
  const fm = stringifyYaml({
    tags: ["vault", "audit"],
    date: today,
    generated: new Date().toISOString(),
  }).trimEnd();

  const lines: string[] = [];
  lines.push("---", fm, "---", "", `# Vault Audit — ${today}`, "");
  lines.push(`Scanned ${findings.scannedCount} notes.`, "");

  section(lines, "Untagged notes", findings.untagged.length, () => {
    for (const f of findings.untagged) lines.push(`- ${linkFor(f)}`);
  });

  section(lines, "Stub files", findings.stubs.length, () => {
    for (const s of findings.stubs) lines.push(`- ${linkFor(s.file)} (${s.size} bytes)`);
  });

  section(lines, "Broken wikilinks", findings.brokenLinks.length, () => {
    for (const b of findings.brokenLinks)
      lines.push(`- ${linkFor(b.file)} → \`[[${b.link}]]\` (line ${b.line + 1})`);
  });

  section(lines, "Possible duplicates", findings.possibleDuplicates.length, () => {
    for (const d of findings.possibleDuplicates)
      lines.push(`- ${linkFor(d.a)} ↔ ${linkFor(d.b)} — ${d.reason}`);
  });

  section(lines, "Orphans — no incoming links", findings.orphans.length, () => {
    for (const f of findings.orphans) lines.push(`- ${linkFor(f)}`);
  });

  section(lines, "Sinks — no outgoing links", findings.sinks.length, () => {
    for (const f of findings.sinks) lines.push(`- ${linkFor(f)}`);
  });

  section(lines, "Unlinked mentions of existing notes", findings.unlinkedMentions.length, () => {
    const cap = Math.min(findings.unlinkedMentions.length, 30);
    for (let i = 0; i < cap; i++) {
      const m = findings.unlinkedMentions[i];
      const total = m.sources.reduce((s, x) => s + x.count, 0);
      lines.push(`- ${linkFor(m.target)} — mentioned in ${m.sources.length} notes, ${total}× total`);
      for (const s of m.sources.slice(0, 5)) {
        lines.push(`    - ${linkFor(s.file)} (×${s.count})`);
      }
    }
    if (findings.unlinkedMentions.length > cap) {
      lines.push(`- … and ${findings.unlinkedMentions.length - cap} more.`);
    }
  });

  section(lines, "Frequently-mentioned entities without a note", findings.entitiesWithoutNote.length, () => {
    const cap = Math.min(findings.entitiesWithoutNote.length, 30);
    for (let i = 0; i < cap; i++) {
      const e = findings.entitiesWithoutNote[i];
      const files = e.files.slice(0, 4).map(linkFor).join(", ");
      const more = e.files.length > 4 ? `, +${e.files.length - 4} more` : "";
      lines.push(`- **${e.name}** — mentioned in ${e.mentions} notes: ${files}${more}`);
    }
    if (findings.entitiesWithoutNote.length > cap) {
      lines.push(`- … and ${findings.entitiesWithoutNote.length - cap} more.`);
    }
  });

  section(lines, "Frequently-appearing URLs without a note", findings.urlsWithoutNote.length, () => {
    for (const u of findings.urlsWithoutNote) {
      const files = u.files.slice(0, 4).map(linkFor).join(", ");
      const more = u.files.length > 4 ? `, +${u.files.length - 4} more` : "";
      lines.push(`- **${u.host}** — in ${u.mentions} notes: ${files}${more}`);
    }
  });

  lines.push("");
  return lines.join("\n");
}

function section(lines: string[], name: string, count: number, body: () => void): void {
  lines.push(`## ${name} (${count})`);
  if (count === 0) {
    lines.push("- (none)");
    lines.push("");
    return;
  }
  body();
  lines.push("");
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

export async function runAndWrite(
  app: App,
  opts: AuditOptions & { targetFolder: string },
): Promise<{ file: TFile; findings: AuditFindings; today: string }> {
  const findings = await runAudit(app, opts);
  const today = todayISO();
  const content = renderReport(findings, today);
  const file = await writeReport(app, content, opts.targetFolder, today);
  return { file, findings, today };
}
