import { parseYaml } from "obsidian";
import { splitFrontmatter } from "./util";

export type FieldKind =
  | "date-today"        // {{date}} placeholder — auto-fill with today
  | "title"             // {{title}} placeholder — bind to note title
  | "prompt"            // empty value or unknown {{token}} — prompt user
  | "static"            // has a real value — leave alone
  | "priority-untouched"; // priority fields — never written by agent

export interface TemplateField {
  key: string;
  kind: FieldKind;
  currentValue: unknown;
  placeholderName?: string;
}

export interface ParsedTemplate {
  fields: TemplateField[];
  bodyPlaceholders: Set<string>;
  needsTitlePrompt: boolean;
  body: string;
}

const KNOWN_DATE_TOKENS = new Set(["date", "today", "created", "updated"]);
const PRIORITY_KEYS = new Set(["priority", "Priority Level"]);

export function parseTemplate(raw: string): ParsedTemplate {
  const { yaml, body } = splitFrontmatter(raw);

  const tokenByField = new Map<string, string>();
  const yamlSafe = yaml.replace(
    /^(\s*)([\w][\w -]*):\s*\{\{(\w+)\}\}\s*$/gm,
    (_m, indent: string, key: string, token: string) => {
      tokenByField.set(key.trim(), token);
      return `${indent}${key}: "__LA_TOKEN_${token}__"`;
    },
  );

  let parsed: Record<string, unknown> = {};
  try {
    parsed = (parseYaml(yamlSafe) ?? {}) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const fields: TemplateField[] = [];
  for (const [key, val] of Object.entries(parsed)) {
    if (PRIORITY_KEYS.has(key)) {
      fields.push({ key, kind: "priority-untouched", currentValue: val });
      continue;
    }
    const tokenName = tokenByField.get(key);
    if (tokenName) {
      if (KNOWN_DATE_TOKENS.has(tokenName)) {
        fields.push({ key, kind: "date-today", currentValue: null, placeholderName: tokenName });
      } else if (tokenName === "title") {
        fields.push({ key, kind: "title", currentValue: null, placeholderName: tokenName });
      } else {
        fields.push({ key, kind: "prompt", currentValue: null, placeholderName: tokenName });
      }
      continue;
    }
    if (val === null || val === undefined || val === "") {
      fields.push({ key, kind: "prompt", currentValue: val });
      continue;
    }
    fields.push({ key, kind: "static", currentValue: val });
  }

  const bodyPlaceholders = new Set<string>();
  const bodyRe = /\{\{(\w+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = bodyRe.exec(body)) !== null) bodyPlaceholders.add(m[1]);
  const needsTitlePrompt = bodyPlaceholders.has("title");
  bodyPlaceholders.delete("title");
  bodyPlaceholders.delete("date");

  return { fields, bodyPlaceholders, needsTitlePrompt, body };
}
