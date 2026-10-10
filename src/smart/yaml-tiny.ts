// Tiny YAML frontmatter parser tailored to the vault's conventions:
// scalar strings, empty values, block sequences under a key, flow
// sequences, and quoted keys/values. Template placeholders like
// `{{date}}` are preserved verbatim as scalar strings — we never
// attempt to interpret `{...}` as a YAML flow map.
//
// This is intentionally NOT a full YAML implementation. Smart Note
// pure-logic modules consume it so they can be tested in Node without
// pulling in obsidian's parseYaml.

export interface Frontmatter {
  yaml: Record<string, unknown>;
  body: string;
  rawFrontmatter: string;
  keyOrder: string[];
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export function parseFrontmatter(raw: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { yaml: {}, body: raw, rawFrontmatter: "", keyOrder: [] };
  }
  const yamlText = match[1];
  const body = raw.slice(match[0].length);
  const { yaml, keyOrder } = parseYamlSubset(yamlText);
  return { yaml, body, rawFrontmatter: yamlText, keyOrder };
}

interface ParseResult {
  yaml: Record<string, unknown>;
  keyOrder: string[];
}

function parseYamlSubset(text: string): ParseResult {
  const yaml: Record<string, unknown> = {};
  const keyOrder: string[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    // Skip indented continuation lines; they're consumed by the
    // block-sequence branch below.
    if (/^\s/.test(line)) {
      i++;
      continue;
    }
    const kv = splitKV(line);
    if (!kv) {
      i++;
      continue;
    }
    const { key, inline } = kv;
    if (inline === "" || inline === "null" || inline === "~") {
      // Possibly a block sequence under this key.
      const items: unknown[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        const bm = nxt.match(/^\s+-\s*(.*)$/);
        if (!bm) break;
        items.push(parseScalar(bm[1].trim()));
        j++;
      }
      if (items.length > 0) {
        yaml[key] = items;
        i = j;
      } else {
        yaml[key] = inline === "" ? "" : null;
        i++;
      }
    } else if (inline === "[]") {
      yaml[key] = [];
      i++;
    } else if (inline.startsWith("[") && inline.endsWith("]")) {
      const content = inline.slice(1, -1).trim();
      yaml[key] = content === ""
        ? []
        : splitFlowList(content).map(parseScalar);
      i++;
    } else {
      yaml[key] = parseScalar(inline);
      i++;
    }
    keyOrder.push(key);
  }

  return { yaml, keyOrder };
}

function splitKV(line: string): { key: string; inline: string } | null {
  let key: string;
  let rest: string;
  if (line.startsWith('"') || line.startsWith("'")) {
    const quote = line[0];
    const end = line.indexOf(quote, 1);
    if (end < 0) return null;
    key = line.slice(1, end);
    rest = line.slice(end + 1);
  } else {
    const colon = line.indexOf(":");
    if (colon < 0) return null;
    key = line.slice(0, colon);
    rest = line.slice(colon);
  }
  const afterColon = rest.replace(/^:\s*/, "");
  // Strip trailing inline comment unless it's inside quotes.
  const inline = stripInlineComment(afterColon).trim();
  return { key: key.trim(), inline };
}

function stripInlineComment(s: string): string {
  // A `#` outside of quotes starts a comment. YAML requires a space
  // before `#` for an inline comment, but we're lenient.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) return s.slice(0, i);
  }
  return s;
}

function splitFlowList(s: string): string[] {
  // Simple comma split; good enough for `[a, b, c]` and `["a", "b"]`.
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let buf = "";
  for (const c of s) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) {
        parts.push(buf);
        buf = "";
        continue;
      }
    }
    buf += c;
  }
  if (buf.trim() !== "") parts.push(buf);
  return parts;
}

function parseScalar(s: string): string | null {
  const t = s.trim();
  if (t === "") return "";
  if (t === "null" || t === "~") return null;
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}
