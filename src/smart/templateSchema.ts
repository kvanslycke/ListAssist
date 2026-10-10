// Classify every frontmatter key of a template as one of a small set
// of roles, and parse the body into the structures Smart Note needs
// to extract into: section headings, inline bold fields, tables, and
// checkbox lists. Pure logic — no obsidian imports, so tests can run
// it directly.

import { parseFrontmatter } from "./yaml-tiny";

export type FieldClass =
  | "auto-date"      // date/created/updated — writer fills today
  | "auto-status"    // status — writer fills "not-started" when empty on actionable templates
  | "auto-title"     // key whose value is {{title}}
  | "ask"            // user must supply this value
  | "forbidden"      // priority, Priority Level — never written by Smart Note
  | "passthrough";   // template-provided value kept verbatim

export interface ClassifiedField {
  key: string;
  class: FieldClass;
  value: unknown;
  placeholder: string | null; // e.g. "date" for {{date}}, else null
}

export interface BodySection {
  heading: string;
  level: number;
  startLine: number; // first line AFTER the heading, 0-indexed in body
  endLine: number;   // exclusive
  content: string;
}

export interface InlineBoldField {
  label: string;
  line: number;
  value: string;
}

export interface BodyTable {
  startLine: number;
  endLine: number;
  headers: string[];
  rows: string[][];
}

export interface BodyCheckboxList {
  startLine: number;
  endLine: number;
  items: Array<{ text: string; checked: boolean }>;
}

export interface TemplateSchema {
  fields: ClassifiedField[];
  bodySections: BodySection[];
  inlineBoldFields: InlineBoldField[];
  tables: BodyTable[];
  checkboxLists: BodyCheckboxList[];
  body: string;
  isActionable: boolean;
}

const FORBIDDEN = new Set(["priority", "Priority Level"]);
const AUTO_DATE = new Set(["date", "created", "updated"]);
const AUTO_STATUS = new Set(["status"]);
const KNOWN_ASK = new Set([
  "relationship",
  "due",
  "dates",
  "next-action",
  "rapids-class",
  "destination",
  "area",
]);
const PLACEHOLDER_RE = /^\{\{(\w+)\}\}$/;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function placeholderOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = PLACEHOLDER_RE.exec(v.trim());
  return m ? m[1] : null;
}

export function classifyTemplate(raw: string): TemplateSchema {
  const fm = parseFrontmatter(raw);
  const isActionable = Object.prototype.hasOwnProperty.call(fm.yaml, "priority");

  const fields: ClassifiedField[] = fm.keyOrder.map((key) => {
    const value = fm.yaml[key];
    const placeholder = placeholderOf(value);
    const cls = classifyKey(key, value, placeholder, isActionable);
    return { key, class: cls, value, placeholder };
  });

  const body = fm.body;
  const lines = body.split(/\r?\n/);
  const bodySections = parseBodySections(lines);
  const inlineBoldFields = parseInlineBoldFields(lines);
  const tables = parseTables(lines);
  const checkboxLists = parseCheckboxLists(lines);

  return {
    fields,
    bodySections,
    inlineBoldFields,
    tables,
    checkboxLists,
    body,
    isActionable,
  };
}

function classifyKey(
  key: string,
  value: unknown,
  placeholder: string | null,
  isActionable: boolean,
): FieldClass {
  if (FORBIDDEN.has(key)) return "forbidden";
  if (placeholder === "title") return "auto-title";
  if (AUTO_DATE.has(key)) return "auto-date";
  if (AUTO_STATUS.has(key)) {
    if (isActionable) return "auto-status";
    return isEmpty(value) ? "ask" : "passthrough";
  }
  if (KNOWN_ASK.has(key)) {
    return isEmpty(value) ? "ask" : "passthrough";
  }
  if (isEmpty(value)) return "ask";
  return "passthrough";
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

function parseBodySections(lines: string[]): BodySection[] {
  const headings: Array<{ heading: string; level: number; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) headings.push({ heading: m[2], level: m[1].length, line: i });
  }
  const sections: BodySection[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings[i + 1];
    const start = h.line + 1;
    const end = next ? next.line : lines.length;
    const content = lines.slice(start, end).join("\n");
    sections.push({
      heading: h.heading,
      level: h.level,
      startLine: start,
      endLine: end,
      content,
    });
  }
  return sections;
}

const INLINE_BOLD_RE = /^\s*\*\*([^*]+?):\*\*\s*(.*)$/;

function parseInlineBoldFields(lines: string[]): InlineBoldField[] {
  const out: InlineBoldField[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = INLINE_BOLD_RE.exec(lines[i]);
    if (m) out.push({ label: m[1].trim(), line: i, value: m[2].trim() });
  }
  return out;
}

function parseTables(lines: string[]): BodyTable[] {
  const tables: BodyTable[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      i++;
      continue;
    }
    // Expect a header, separator, then rows.
    if (i + 1 >= lines.length || !isTableSeparator(lines[i + 1])) {
      i++;
      continue;
    }
    const headers = splitRow(lines[i]);
    const start = i;
    let j = i + 2;
    const rows: string[][] = [];
    while (j < lines.length && isTableRow(lines[j])) {
      rows.push(splitRow(lines[j]));
      j++;
    }
    tables.push({ startLine: start, endLine: j, headers, rows });
    i = j;
  }
  return tables;
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return false;
  const inner = t.slice(1, -1);
  return /^(\s*:?-{2,}:?\s*\|)*\s*:?-{2,}:?\s*$/.test(inner);
}

function splitRow(line: string): string[] {
  const t = line.trim();
  const inner = t.slice(1, -1);
  return inner.split("|").map((c) => c.trim());
}

const CHECKBOX_RE = /^\s*-\s+\[( |x|X)\]\s*(.*)$/;

function parseCheckboxLists(lines: string[]): BodyCheckboxList[] {
  const lists: BodyCheckboxList[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const start = i;
    const items: Array<{ text: string; checked: boolean }> = [];
    while (i < lines.length) {
      const mm = CHECKBOX_RE.exec(lines[i]);
      if (!mm) break;
      items.push({ text: mm[2].trim(), checked: mm[1].toLowerCase() === "x" });
      i++;
    }
    lists.push({ startLine: start, endLine: i, items });
  }
  return lists;
}
