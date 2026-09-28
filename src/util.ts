export function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function slugifyTitle(t: string): string {
  return t.replace(/[\/\\:?"*<>|]/g, "-").trim();
}

export function substituteBody(body: string, subs: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in subs ? subs[key] : m));
}

export function splitFrontmatter(raw: string): { yaml: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { yaml: "", body: raw };
  return { yaml: m[1], body: m[2] };
}

export function humanizeKey(key: string): string {
  return key
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
