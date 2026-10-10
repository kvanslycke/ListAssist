// Reads the vault's `Reference HUB/Tags.md` as the single source of
// truth for valid tags. Returns a canonical lowercase set, with a
// map back to the first-seen cased form so Smart Note can prefer
// lowercase (karin) without rewriting existing notes that use the
// capital variant (Karin). Pure — no obsidian imports.

export interface TagIndex {
  canonical: Set<string>;            // lowercase canonical set
  originalCase: Map<string, string>; // lowercase -> first-seen cased form
  groups: Map<string, string[]>;     // section heading (lowercase) -> original-case tag names in order
}

const H2_RE = /^##\s+(.+?)\s*$/;
const BULLET_TAG_RE = /^-\s+([^\s—-][^—\n]*?)(?:\s+—\s.*)?$/;
// Allow en-dash separator (—) or `-` with surrounding spaces.
// We DO NOT eat lines like "- 2026-08-27: Created ..." (log entries).

const LOG_SECTION_RE = /^log$/i;

export function parseTags(markdown: string): TagIndex {
  const canonical = new Set<string>();
  const originalCase = new Map<string, string>();
  const groups = new Map<string, string[]>();

  const lines = markdown.split(/\r?\n/);
  let currentSection = "";
  let inLog = false;

  for (const line of lines) {
    const h = H2_RE.exec(line);
    if (h) {
      currentSection = h[1].trim();
      inLog = LOG_SECTION_RE.test(currentSection);
      continue;
    }
    if (inLog) continue;
    if (!currentSection) continue;
    const b = BULLET_TAG_RE.exec(line);
    if (!b) continue;
    const raw = b[1].trim();
    // Reject anything that still looks like a date-prefixed log line
    // (e.g. "2026-08-27: Created ..."). Dates on their own are not
    // valid tags.
    if (/^\d{4}-\d{2}-\d{2}:/.test(raw)) continue;
    // A tag line might be "karin / Karin — joint stuff" — split.
    for (const variant of raw.split("/").map((s) => s.trim()).filter(Boolean)) {
      // A tag is a single token-ish string. Skip things with spaces,
      // which are prose on these bullet lines rather than actual tags.
      if (/\s/.test(variant)) continue;
      const lower = variant.toLowerCase();
      if (!canonical.has(lower)) {
        canonical.add(lower);
        originalCase.set(lower, variant);
      }
      const sec = currentSection.toLowerCase();
      const arr = groups.get(sec) ?? [];
      arr.push(variant);
      groups.set(sec, arr);
    }
  }

  return { canonical, originalCase, groups };
}

export function isValidTag(index: TagIndex, tag: string): boolean {
  return index.canonical.has(tag.trim().toLowerCase());
}

export function allTags(index: TagIndex): string[] {
  return Array.from(index.canonical).sort();
}

// Enforce the enum against a set of model-proposed tags. Returns
// {accepted, rejected}. Accepted uses the canonical lowercase form.
// Any tag the model proposes that is not in the index goes to
// rejected — the UI surfaces it as an unchecked suggestion.
export function enforceEnum(
  index: TagIndex,
  proposed: readonly string[],
): { accepted: string[]; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const t of proposed) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (index.canonical.has(lower)) {
      accepted.push(lower);
    } else {
      rejected.push(trimmed);
    }
  }
  return { accepted, rejected };
}

// Pure transform: given the current Tags.md content, produce a new
// one with `tag` appended under the "Suggested — general life"
// section and a Log line added. Called by the writer when the user
// confirms an unchecked suggestion checkbox. Never writes to disk —
// the caller does, through the Obsidian API.
export function tagsFileWithAppendedSuggestion(
  current: string,
  tag: string,
  today: string,
): string {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) return current;
  const lines = current.split(/\r?\n/);
  const sectionIndex = findSectionBoundary(lines, "Suggested — general life");
  if (sectionIndex) {
    const insertAt = sectionIndex.lastBulletLine + 1;
    lines.splice(insertAt, 0, `- ${normalized}`);
  } else {
    lines.push("", "## Suggested — general life", `- ${normalized}`);
  }
  const logIndex = findSectionBoundary(lines, "Log");
  const logLine = `- ${today}: Added \`${normalized}\` to Suggested — general life (via Smart Note).`;
  if (logIndex) {
    const insertAt = logIndex.lastBulletLine + 1;
    lines.splice(insertAt, 0, logLine);
  } else {
    lines.push("", "## Log", logLine);
  }
  return lines.join("\n");
}

interface SectionBoundary {
  headingLine: number;
  firstBulletLine: number;
  lastBulletLine: number;
}

function findSectionBoundary(
  lines: string[],
  heading: string,
): SectionBoundary | null {
  const targetLower = heading.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const h = H2_RE.exec(lines[i]);
    if (!h) continue;
    if (h[1].trim().toLowerCase() !== targetLower) continue;
    const headingLine = i;
    let firstBulletLine = -1;
    let lastBulletLine = headingLine;
    for (let j = i + 1; j < lines.length; j++) {
      if (H2_RE.test(lines[j])) break;
      if (/^-\s+\S/.test(lines[j])) {
        if (firstBulletLine < 0) firstBulletLine = j;
        lastBulletLine = j;
      }
    }
    if (firstBulletLine < 0) {
      // Section exists but has no bullets yet. Treat the heading line
      // as the anchor and insert immediately after.
      return { headingLine, firstBulletLine: headingLine, lastBulletLine: headingLine };
    }
    return { headingLine, firstBulletLine, lastBulletLine };
  }
  return null;
}
