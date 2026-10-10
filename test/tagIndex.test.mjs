// Tests parseTags against the vault's real Tags.md plus synthetic
// fixtures for case-dedup and enum enforcement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tagsMd = readFileSync(
  path.join(
    here,
    "..",
    "test",
    "fixtures",
    "Tags.md",
  ),
  "utf8",
);

const { parseTags, isValidTag, enforceEnum, allTags, tagsFileWithAppendedSuggestion } =
  await import("../.test-build/smart/tagIndex.js");

test("parses canonical tags from the real Tags.md", () => {
  const idx = parseTags(tagsMd);
  // Spot-check: well-known tags are present.
  assert.ok(idx.canonical.has("hub"));
  assert.ok(idx.canonical.has("project"));
  assert.ok(idx.canonical.has("daily"));
  assert.ok(idx.canonical.has("sentinel"));
  assert.ok(idx.canonical.has("marston"));
  assert.ok(idx.canonical.has("karin"));
});

test("case dedupe: karin / Karin collapse to one canonical form", () => {
  const idx = parseTags(tagsMd);
  assert.equal(
    Array.from(idx.canonical).filter((t) => t === "karin").length,
    1,
  );
  // originalCase keeps the first-seen cased form; we don't assert
  // which form wins across runs, only that it's one of the two.
  const original = idx.originalCase.get("karin");
  assert.ok(["karin", "Karin"].includes(original));
});

test("log section bullets are not treated as tags", () => {
  const idx = parseTags(tagsMd);
  // "2026-08-27: Created ..." must not become a tag.
  for (const t of idx.canonical) {
    assert.ok(!/^\d{4}-\d{2}-\d{2}/.test(t), `date-looking tag leaked: ${t}`);
  }
});

test("isValidTag enforces canonical membership", () => {
  const idx = parseTags(tagsMd);
  assert.ok(isValidTag(idx, "project"));
  assert.ok(isValidTag(idx, "Project")); // case-insensitive
  assert.ok(!isValidTag(idx, "nonexistent-tag-xyz"));
});

test("enforceEnum splits proposed tags into accepted/rejected", () => {
  const idx = parseTags(tagsMd);
  const { accepted, rejected } = enforceEnum(idx, [
    "project",
    "Karin",
    "new-fake-tag",
    "project", // duplicate — one copy accepted
  ]);
  assert.deepEqual(accepted.sort(), ["karin", "project"]);
  assert.deepEqual(rejected, ["new-fake-tag"]);
});

test("tagsFileWithAppendedSuggestion inserts under Suggested — general life and logs", () => {
  const before = `# Tags

## Already in use
**Structural**
- hub
- project

## Suggested — general life
- journal
- idea

## Log
- 2026-08-27: Created.
`;
  const after = tagsFileWithAppendedSuggestion(before, "new-tag", "2026-10-10");
  assert.ok(
    after.includes("## Suggested — general life\n- journal\n- idea\n- new-tag"),
    `expected append under Suggested section:\n${after}`,
  );
  assert.ok(
    after.includes("- 2026-10-10: Added `new-tag` to Suggested — general life"),
    `expected log line`,
  );
});

test("tagsFileWithAppendedSuggestion is a no-op for empty tag", () => {
  const before = "# Tags\n\n## Log\n- 2026-01-01: created\n";
  assert.equal(tagsFileWithAppendedSuggestion(before, "   ", "2026-10-10"), before);
});
