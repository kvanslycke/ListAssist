import { App, TFile, normalizePath, stringifyYaml } from "obsidian";
import { callClaude, ClaudeConfig, estimateCostUSD, TextBlockInput } from "./claude-client";
import { todayISO } from "./util";
import { runAudit, AuditFindings, renderReport as renderAuditReport, AuditOptions } from "./audit";

const NOTE_EXCERPT_CHARS = 280;

interface ManifestNote {
  path: string;
  title: string;
  tags: string[];
  linksTo: string[];
  excerpt: string;
}

export interface SemanticFinding {
  category: "cross-domain-bridge" | "thematic-pattern" | "suggested-link" | "suggested-note";
  title: string;
  description: string;
  notes: string[];
}

export interface SemanticAuditResult {
  file: TFile;
  findings: SemanticFinding[];
  usage: { model: string; inputTokens: number; outputTokens: number; costUSD: number };
  today: string;
}

export interface SemanticAuditOptions {
  claude: ClaudeConfig;
  auditOpts: AuditOptions;
  targetFolder: string;
  includeDeterministicAudit: boolean;
  noteExcerptChars: number;
}

const SYSTEM_PROMPT = `You analyze personal Obsidian vaults to surface non-obvious connections
between notes that a deterministic audit cannot find. You look for:

- Cross-domain bridges: notes in different hubs that share an underlying idea
  or capability (e.g. a hydrology website and a truck-mounted cyberdeck are
  both hydrology-GIS capability aimed at different targets).
- Thematic patterns: recurring ideas, philosophies, or values that appear
  across notes in different domains (e.g. media watchlist names matching a
  system's stated intellectual lineage).
- Suggested links: pairs of existing notes that should link to each other
  based on content but currently do not.
- Suggested notes: emerging clusters that would benefit from a hub or MOC
  note that does not exist yet.

You will be given a compact index of every note in the vault (path, title,
tags, outbound wikilinks, first-paragraph excerpt) plus a deterministic
audit report. You will return findings as JSON only, no prose before or
after. Prefer fewer, higher-confidence findings over exhaustive listings.

Response format (JSON):
{
  "findings": [
    {
      "category": "cross-domain-bridge" | "thematic-pattern" | "suggested-link" | "suggested-note",
      "title": "short human-readable name",
      "description": "one to three sentences explaining the pattern and why it matters",
      "notes": ["Vault-relative/Path/To/Note.md", ...]
    }
  ]
}

Rules:
- Be specific. Cite actual note paths, not vague clusters.
- Skip anything a deterministic tool already flagged (untagged notes, broken
  wikilinks, unlinked mentions, entities without a note, URLs without a
  note). Those are handled elsewhere; your job is the semantic layer.
- If nothing meaningful stands out, return {"findings": []}.
- Never invent notes that are not in the index.`;

function inExcluded(path: string, folders: string[]): boolean {
  for (const f of folders) {
    if (!f) continue;
    const norm = normalizePath(f);
    if (path === norm || path.startsWith(norm + "/")) return true;
  }
  return false;
}

function collectTags(cache: ReturnType<App["metadataCache"]["getFileCache"]>): string[] {
  const out = new Set<string>();
  for (const t of cache?.tags ?? []) out.add(t.tag.replace(/^#/, ""));
  const fm = cache?.frontmatter as Record<string, unknown> | undefined;
  if (fm) {
    const t: unknown = fm.tags ?? fm.Tags ?? fm.tag;
    if (Array.isArray(t)) {
      for (const x of t) if (typeof x === "string") out.add(x);
    } else if (typeof t === "string") {
      for (const x of t.split(/[\s,]+/)) if (x) out.add(x);
    }
  }
  return [...out];
}

function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return m ? m[1] : raw;
}

async function buildManifest(
  app: App,
  files: TFile[],
  excerptChars: number,
): Promise<ManifestNote[]> {
  const out: ManifestNote[] = [];
  for (const f of files) {
    const cache = app.metadataCache.getFileCache(f);
    const raw = await app.vault.cachedRead(f);
    const body = stripFrontmatter(raw).replace(/\r/g, "").trim();
    const excerpt = body
      .slice(0, excerptChars)
      .replace(/\s+/g, " ")
      .trim();
    const links = (cache?.links ?? [])
      .map((l) => l.link)
      .filter((v, i, a) => a.indexOf(v) === i);
    out.push({
      path: f.path,
      title: f.basename,
      tags: collectTags(cache),
      linksTo: links,
      excerpt,
    });
  }
  return out;
}

function renderManifest(notes: ManifestNote[]): string {
  const lines: string[] = [`# Vault index (${notes.length} notes)\n`];
  for (const n of notes) {
    lines.push(`## ${n.path}`);
    lines.push(`title: ${n.title}`);
    if (n.tags.length) lines.push(`tags: ${n.tags.join(", ")}`);
    if (n.linksTo.length) lines.push(`links: ${n.linksTo.join(", ")}`);
    if (n.excerpt) lines.push(`excerpt: ${n.excerpt}`);
    lines.push("");
  }
  return lines.join("\n");
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model response did not contain a JSON object.");
  }
  const jsonText = trimmed.slice(start, end + 1);
  return JSON.parse(jsonText);
}

export async function runSemanticAudit(
  app: App,
  opts: SemanticAuditOptions,
): Promise<SemanticAuditResult> {
  const allFiles = app.vault.getMarkdownFiles();
  const files = allFiles.filter((f) => !inExcluded(f.path, opts.auditOpts.excludeFolders));
  const manifestNotes = await buildManifest(app, files, opts.noteExcerptChars);
  const manifestText = renderManifest(manifestNotes);

  let auditText = "";
  if (opts.includeDeterministicAudit) {
    const findings: AuditFindings = await runAudit(app, opts.auditOpts);
    auditText = renderAuditReport(findings, todayISO());
  }

  const userContent: TextBlockInput[] = [
    { type: "text", text: manifestText, cache_control: { type: "ephemeral" } },
  ];
  if (auditText) {
    userContent.push({ type: "text", text: `# Deterministic audit report\n\n${auditText}` });
  }
  userContent.push({
    type: "text",
    text: "Analyze the vault above and return the JSON described in the system prompt.",
  });

  const response = await callClaude(opts.claude, SYSTEM_PROMPT, userContent);

  let findings: SemanticFinding[] = [];
  try {
    const parsed = extractJson(response.text) as { findings?: unknown };
    if (parsed && Array.isArray(parsed.findings)) {
      findings = parsed.findings
        .map((raw: unknown) => coerceFinding(raw))
        .filter((f): f is SemanticFinding => f !== null);
    }
  } catch (e) {
    throw new Error(
      `Could not parse Claude's response as JSON: ${(e as Error).message}. First 200 chars: ${response.text.slice(0, 200)}`,
    );
  }

  const today = todayISO();
  const cost = estimateCostUSD(opts.claude.model, response.usage);
  const rendered = renderSemanticReport(findings, today, opts.claude.model, response.usage, cost);
  const file = await writeReport(app, rendered, opts.targetFolder, today);

  return {
    file,
    findings,
    today,
    usage: {
      model: opts.claude.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUSD: cost,
    },
  };
}

function coerceFinding(raw: unknown): SemanticFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const category = obj.category;
  const title = obj.title;
  const description = obj.description;
  const notes = obj.notes;
  if (
    (category !== "cross-domain-bridge" &&
      category !== "thematic-pattern" &&
      category !== "suggested-link" &&
      category !== "suggested-note") ||
    typeof title !== "string" ||
    typeof description !== "string" ||
    !Array.isArray(notes)
  ) {
    return null;
  }
  return {
    category,
    title,
    description,
    notes: notes.filter((n): n is string => typeof n === "string"),
  };
}

const CATEGORY_LABELS: Record<SemanticFinding["category"], string> = {
  "cross-domain-bridge": "Cross-domain bridges",
  "thematic-pattern": "Thematic patterns",
  "suggested-link": "Suggested links between existing notes",
  "suggested-note": "Suggested new notes",
};

function renderSemanticReport(
  findings: SemanticFinding[],
  today: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number },
  costUSD: number,
): string {
  const fm = stringifyYaml({
    tags: ["vault", "audit", "semantic"],
    date: today,
    model,
    generated: new Date().toISOString(),
  }).trimEnd();

  const lines: string[] = [];
  lines.push("---", fm, "---", "", `# Vault Semantic Audit — ${today}`, "");
  lines.push(
    `Model: \`${model}\` · ${usage.input_tokens} input tokens (` +
      `${usage.cache_read_input_tokens ?? 0} cached) · ${usage.output_tokens} output tokens · ` +
      `≈ $${costUSD.toFixed(4)}`,
    "",
  );

  if (findings.length === 0) {
    lines.push("_No semantic patterns surfaced. Vault is in good shape or corpus too small to draw from._", "");
    return lines.join("\n") + "\n";
  }

  const byCat = new Map<SemanticFinding["category"], SemanticFinding[]>();
  for (const f of findings) {
    const list = byCat.get(f.category) ?? [];
    list.push(f);
    byCat.set(f.category, list);
  }

  const order: SemanticFinding["category"][] = [
    "cross-domain-bridge",
    "thematic-pattern",
    "suggested-link",
    "suggested-note",
  ];
  for (const cat of order) {
    const group = byCat.get(cat);
    if (!group || group.length === 0) continue;
    lines.push(`## ${CATEGORY_LABELS[cat]}`, "");
    for (const f of group) {
      lines.push(`### ${f.title}`);
      lines.push(f.description);
      if (f.notes.length) {
        lines.push("");
        for (const n of f.notes) {
          const stem = n.replace(/\.md$/, "").split("/").pop() ?? n;
          lines.push(`- [[${stem}]] (\`${n}\`)`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n") + "\n";
}

async function writeReport(app: App, content: string, folder: string, today: string): Promise<TFile> {
  const folderPath = normalizePath(folder);
  if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
    await app.vault.createFolder(folderPath);
  }
  const path = folderPath
    ? normalizePath(`${folderPath}/${today}-semantic.md`)
    : normalizePath(`${today}-semantic.md`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return existing;
  }
  return (await app.vault.create(path, content)) as TFile;
}
