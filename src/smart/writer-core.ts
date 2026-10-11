// Pure write-path logic: render a Smart Note from a template +
// extracted field values, without ever touching an Obsidian API.
//
// Hard rules enforced here (no amount of model trickery should break):
//   - `priority` / `Priority Level` are NEVER written non-empty.
//   - Fields the user never spoke about stay as the template left
//     them (no fabrication).
//   - Known passthrough values the template pre-set (Priority Matrix,
//     Auto Maintenance tag lists, etc.) are copied verbatim.
//
// Obsidian-side ops (vault.create, hub Main-note updates) live in
// writer.ts and consume the output of this module.

import { parseFrontmatter } from "./yaml-tiny";
import { classifyTemplate, type ClassifiedField, type TemplateSchema } from "./templateSchema";

export interface RenderInput {
  raw: string;                             // template file content
  title: string;                           // final note title
  today: string;                           // "YYYY-MM-DD"
  extracted: Record<string, unknown>;      // model-extracted field values; may be adversarial
}

export interface RenderResult {
  frontmatter: Record<string, unknown>;
  frontmatterOrder: string[];              // deterministic emit order
  body: string;                            // body with placeholders substituted
  filename: string;                        // "<title>.md", filename-safe
  schema: TemplateSchema;
}

// `priority` is the hard-rule key — ALWAYS empty, no matter what.
// `Priority Level` and `Priority Matrix` are template-owned fields:
// the writer preserves whatever the template set, but never allows
// extracted (i.e. model-sourced) data to supply them.
const HARD_EMPTY_KEYS = new Set(["priority"]);
const EXTRACTED_LOCKED_KEYS = new Set([
  "priority",
  "Priority Level",
  "Priority Matrix",
]);
const FILENAME_FORBIDDEN = /[\\/:*?"<>|]/g;

export function assertNoPriorityWrite(fm: Record<string, unknown>): void {
  for (const key of HARD_EMPTY_KEYS) {
    const v = fm[key];
    if (v === undefined || v === null || v === "") continue;
    throw new Error(
      `Smart Note hard-rule violation: refused to write ${key}=${JSON.stringify(v)}`,
    );
  }
}

export function sanitizeFilename(title: string): string {
  const cleaned = title.replace(FILENAME_FORBIDDEN, "").trim();
  return cleaned.length > 0 ? `${cleaned}.md` : "Untitled.md";
}

// Compute a collision-free filename given a desired name and the set
// of already-taken paths in the target folder. Produces "name (2).md",
// "name (3).md", … The input `desired` includes the ".md" extension.
export function resolveCollision(
  desired: string,
  takenInFolder: ReadonlySet<string>,
): string {
  if (!takenInFolder.has(desired)) return desired;
  const base = desired.replace(/\.md$/i, "");
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n}).md`;
    if (!takenInFolder.has(candidate)) return candidate;
  }
  throw new Error(`resolveCollision: more than 999 collisions for ${desired}`);
}

export function renderNote(input: RenderInput): RenderResult {
  const schema = classifyTemplate(input.raw);
  const fm = parseFrontmatter(input.raw);
  const extracted = scrubExtracted(input.extracted);

  const outFm: Record<string, unknown> = {};
  const order: string[] = [];

  for (const field of schema.fields) {
    const key = field.key;
    order.push(key);
    outFm[key] = resolveFieldValue(field, {
      extracted,
      today: input.today,
      title: input.title,
      isActionable: schema.isActionable,
      currentValue: fm.yaml[key],
    });
  }

  // Final guard rail — defense in depth.
  assertNoPriorityWrite(outFm);

  const substituted = substituteBodyPlaceholders(schema.body, {
    title: input.title,
    date: input.today,
  });
  const body = mergeExtractedIntoBody(substituted, schema, extracted);

  const filename = sanitizeFilename(input.title);

  return { frontmatter: outFm, frontmatterOrder: order, body, filename, schema };
}

interface FieldContext {
  extracted: Record<string, unknown>;
  today: string;
  title: string;
  isActionable: boolean;
  currentValue: unknown;
}

function resolveFieldValue(field: ClassifiedField, ctx: FieldContext): unknown {
  switch (field.class) {
    case "forbidden":
      // `priority` always empty. Other extracted-locked keys like
      // `Priority Level` / `Priority Matrix` keep whatever value the
      // template carried — passthrough, never writer-generated.
      if (field.key === "priority") return "";
      return ctx.currentValue ?? "";
    case "auto-date":
      return ctx.today;
    case "auto-title":
      return ctx.title;
    case "auto-status":
      // Fill "not-started" only when the template left it empty on an
      // actionable template; otherwise preserve.
      if (ctx.isActionable && isEmpty(ctx.currentValue)) return "not-started";
      return ctx.currentValue ?? "";
    case "ask": {
      const v = ctx.extracted[field.key];
      if (v !== undefined && !isEmpty(v)) return v;
      // No user data — keep whatever the template had (likely empty).
      return ctx.currentValue ?? "";
    }
    case "passthrough":
      // Template set a value; never overwrite from extracted.
      return ctx.currentValue ?? "";
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

// Strip any attempt to set an extracted-locked field (priority,
// Priority Level, Priority Matrix) from the extracted payload BEFORE
// it reaches field resolution. The resolver's switch is already
// defensive but this makes the intent obvious.
function scrubExtracted(extracted: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extracted };
  for (const k of EXTRACTED_LOCKED_KEYS) delete out[k];
  return out;
}

function substituteBodyPlaceholders(
  body: string,
  subs: { title: string; date: string },
): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (name === "title") return subs.title;
    if (name === "date") return subs.date;
    // Unknown placeholders — leave for the UI to prompt. Keep the raw
    // {{name}} marker so the user sees it in the preview.
    return `{{${name}}}`;
  });
}

// Walks the body, filling two things from `extracted` without ever
// fabricating:
//   - For each `## Section` whose heading matches an extracted key with
//     an array value, empty "- [ ]" checkboxes in that section get
//     filled with the extracted items (first-fit, left to right), and
//     any items beyond the empty slots are appended as new "- [ ] item"
//     lines at the end of that section. Pre-filled checkbox items in
//     the template are kept verbatim and extracted items that match
//     them (case-insensitive) are dropped so we don't duplicate.
//   - For each "**Label:**" inline field whose label matches an
//     extracted key with a non-empty string value AND whose current
//     inline value is empty, the inline value is filled in. Pre-filled
//     inline values are left alone.
// Sections and labels not present in `extracted` are untouched (no
// fabrication).
export function mergeExtractedIntoBody(
  body: string,
  schema: TemplateSchema,
  extracted: Record<string, unknown>,
): string {
  const sectionItems = new Map<string, string[]>();
  for (const sec of schema.bodySections) {
    const v = extracted[sec.heading];
    if (Array.isArray(v)) {
      const items = v
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (items.length > 0) sectionItems.set(sec.heading, items);
    }
  }
  const inlineValues = new Map<string, string>();
  for (const f of schema.inlineBoldFields) {
    const v = extracted[f.label];
    if (typeof v === "string" && v.trim().length > 0) {
      inlineValues.set(f.label, v.trim());
    }
  }

  if (sectionItems.size === 0 && inlineValues.size === 0) return body;

  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;
  const inlineRe = /^(\s*\*\*([^*]+?):\*\*\s*)(.*)$/;
  const emptyCheckboxRe = /^(\s*-\s+\[\s*\]\s*)$/;
  const prefilledCheckboxRe = /^(\s*-\s+\[\s*\]\s+)(\S.*?)\s*$/;

  const lines = body.split("\n");
  const out: string[] = [];
  let currentSection: string | null = null;
  let pending: string[] = [];

  const flushPending = (): void => {
    if (pending.length === 0) return;
    while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
    for (const item of pending) out.push(`- [ ] ${item}`);
    pending = [];
  };

  for (const line of lines) {
    const hm = headingRe.exec(line);
    if (hm) {
      flushPending();
      currentSection = hm[2];
      const items = sectionItems.get(currentSection);
      pending = items ? [...items] : [];
      out.push(line);
      continue;
    }

    if (inlineValues.size > 0) {
      const im = inlineRe.exec(line);
      if (im) {
        const label = im[2].trim();
        const existing = im[3].trim();
        const incoming = inlineValues.get(label);
        if (incoming && existing === "") {
          out.push(`${im[1]}${incoming}`);
          continue;
        }
      }
    }

    if (pending.length > 0 && currentSection !== null) {
      if (emptyCheckboxRe.test(line)) {
        const next = pending.shift();
        if (next !== undefined) {
          out.push(`- [ ] ${next}`);
          continue;
        }
      }
      const pf = prefilledCheckboxRe.exec(line);
      if (pf) {
        const existingLower = pf[2].toLowerCase();
        pending = pending.filter((p) => p.toLowerCase() !== existingLower);
      }
    }

    out.push(line);
  }
  flushPending();

  return out.join("\n");
}

// Render YAML frontmatter string in the exact key order produced by
// renderNote. Minimal YAML: scalars quoted when they contain special
// chars, lists emit block style, nulls become empty values.
export function stringifyFrontmatter(
  fm: Record<string, unknown>,
  order: readonly string[],
): string {
  const lines: string[] = [];
  for (const key of order) {
    const v = fm[key];
    lines.push(...emitKV(key, v));
  }
  return lines.join("\n");
}

function emitKV(key: string, value: unknown): string[] {
  const emittedKey = needsKeyQuote(key) ? `"${key}"` : key;
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${emittedKey}: []`];
    const lines = [`${emittedKey}:`];
    for (const item of value) lines.push(`  - ${scalarize(item)}`);
    return lines;
  }
  if (value === null || value === undefined || value === "") {
    return [`${emittedKey}:`];
  }
  return [`${emittedKey}: ${scalarize(value)}`];
}

function needsKeyQuote(key: string): boolean {
  return /[\s:]/.test(key);
}

function scalarize(v: unknown): string {
  if (typeof v === "string") {
    if (needsScalarQuote(v)) return JSON.stringify(v);
    return v;
  }
  if (v === null || v === undefined) return "";
  return String(v);
}

function needsScalarQuote(s: string): boolean {
  if (s.length === 0) return false;
  if (/^[\[\{>|!*&?%@`]/.test(s)) return true;      // reserved YAML indicators
  if (/^-\s/.test(s)) return true;                   // looks like a block-list entry
  if (/^#/.test(s)) return true;                     // looks like a comment
  if (/:\s/.test(s)) return true;                    // looks like a map
  if (/\s#/.test(s)) return true;                    // trailing-comment confusion
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;                // leading/trailing whitespace
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return true;     // pure number — must quote to keep as string
  return false;
}

// Full assembled note content, ready for vault.create.
export function assembleNote(result: RenderResult): string {
  const yaml = stringifyFrontmatter(result.frontmatter, result.frontmatterOrder);
  const trimmedBody = result.body.replace(/^\s+/, "");
  if (yaml.length === 0) return trimmedBody;
  return `---\n${yaml}\n---\n\n${trimmedBody}`;
}

// Append-mode (Anger Log monthly). Renders ONE new entry block from
// the inline bold fields the user filled in. The caller inserts this
// above any trailing link line of the existing monthly file, or into
// a freshly created file if none exists yet.
export interface AppendEntryInput {
  today: string;       // "YYYY-MM-DD"
  time: string;        // "HH:mm" local
  fields: Record<string, string>; // e.g. { Trigger, "What happened", "How I responded", Outcome, "Notes for next time" }
  fieldOrder: readonly string[];  // order matching the template
}

export function renderAppendEntry(input: AppendEntryInput): string {
  const lines: string[] = [];
  lines.push(`Date: ${input.today} ${input.time}`);
  for (const label of input.fieldOrder) {
    const v = (input.fields[label] ?? "").trim();
    lines.push(`**${label}:** ${v}`);
  }
  return lines.join("\n");
}

// Pure transform: inject an entry block into an existing monthly file.
// Preserves everything already present. If the file ends with a lone
// wikilink line (common vault convention), the entry lands above it;
// otherwise it appends at the end. Updates frontmatter `updated:`
// when present.
export function fileWithAppendedEntry(
  current: string,
  entry: string,
  today: string,
): string {
  const fm = parseFrontmatter(current);
  const bodyLines = fm.body.split(/\r?\n/);
  // Find trailing link line (ignoring blank tail).
  let insertAt = bodyLines.length;
  for (let i = bodyLines.length - 1; i >= 0; i--) {
    const t = bodyLines[i].trim();
    if (t === "") continue;
    if (/^\[\[.+\]\]$/.test(t) || /^Links:/.test(t)) {
      insertAt = i;
    }
    break;
  }
  // Normalize: ensure a blank line separates the entry from both
  // neighbors.
  const prefix = bodyLines.slice(0, insertAt);
  const suffix = bodyLines.slice(insertAt);
  const newBody = [
    ...prefix,
    ...(prefix.length > 0 && prefix[prefix.length - 1].trim() !== "" ? [""] : []),
    entry,
    "",
    ...suffix,
  ].join("\n");
  const newYaml = updateYamlUpdated(fm.rawFrontmatter, today);
  if (newYaml === null) return newBody;
  return `---\n${newYaml}\n---\n${newBody.startsWith("\n") ? "" : "\n"}${newBody}`;
}

function updateYamlUpdated(rawYaml: string, today: string): string | null {
  if (!rawYaml) return null;
  const lines = rawYaml.split(/\r?\n/);
  let hadUpdated = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^updated\s*:/.test(lines[i])) {
      lines[i] = `updated: ${today}`;
      hadUpdated = true;
    }
  }
  if (!hadUpdated) lines.push(`updated: ${today}`);
  return lines.join("\n");
}

// Append a wikilink under a specific heading in a hub Main note.
// Preserves existing content; adds a new bullet at the end of the
// target section (immediately before the next heading).
export function hubMainWithAppendedLink(
  current: string,
  linkText: string,
  heading: string,
): string {
  const headingRe = new RegExp(`^${escapeRe(heading)}\\s*$`);
  const lines = current.split(/\r?\n/);
  let targetHeadingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    if (headingRe.test(m[2])) {
      targetHeadingLine = i;
      break;
    }
  }
  if (targetHeadingLine < 0) {
    // Heading doesn't exist — append both heading and link.
    return `${current.trimEnd()}\n\n## ${heading}\n- [[${linkText}]]\n`;
  }
  // Find end of this section (next heading or EOF).
  let end = lines.length;
  for (let i = targetHeadingLine + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Already present? Idempotent.
  for (let i = targetHeadingLine + 1; i < end; i++) {
    if (lines[i].includes(`[[${linkText}]]`)) return current;
  }
  // Walk back from `end` to skip trailing blank lines.
  let insert = end;
  while (insert > targetHeadingLine + 1 && lines[insert - 1].trim() === "") insert--;
  lines.splice(insert, 0, `- [[${linkText}]]`);
  return lines.join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
