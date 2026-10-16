// Additional writer-core tests beyond priority.test.mjs: collision
// suffix, filename sanitizing, append-entry rendering, hub Main link
// append (idempotent + heading-missing cases), and the stronger
// scrub rules (passthrough preservation, no fabrication).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "templates");

const {
  renderNote,
  assertNoPriorityWrite,
  resolveCollision,
  sanitizeFilename,
  renderAppendEntry,
  fileWithAppendedEntry,
  hubMainWithAppendedLink,
  assembleNote,
} = await import("../.test-build/smart/writer-core.js");

test("sanitizeFilename strips reserved chars and falls back to Untitled", () => {
  assert.equal(sanitizeFilename('A?B*C:D/E\\F<G>H|I"J'), "ABCDEFGHIJ.md");
  assert.equal(sanitizeFilename("    "), "Untitled.md");
  assert.equal(sanitizeFilename("Normal Title"), "Normal Title.md");
});

test("resolveCollision adds (2), (3), …", () => {
  const taken = new Set(["Foo.md", "Foo (2).md"]);
  assert.equal(resolveCollision("Foo.md", taken), "Foo (3).md");
  assert.equal(resolveCollision("Bar.md", taken), "Bar.md");
});

test("renderNote: passthrough preserves template-set values", () => {
  const raw = readFileSync(path.join(fixturesDir, "Grocery List Template.md"), "utf8");
  const r = renderNote({
    raw,
    title: "Grocery List — 2026-10-10",
    today: "2026-10-10",
    extracted: {},
  });
  // Grocery template pre-sets Priority Level = "2: Not Urgent, Important"
  // — must survive untouched.
  assert.equal(r.frontmatter["Priority Level"], "2: Not Urgent, Important");
  // priority stays empty.
  assert.equal(r.frontmatter.priority, "");
  // tags passthrough — comes back as an array of strings.
  assert.ok(Array.isArray(r.frontmatter.tags));
  assert.ok(r.frontmatter.tags.includes("list"));
});

test("renderNote: auto-status fills 'not-started' only on actionable templates when empty", () => {
  const rawTodo = readFileSync(path.join(fixturesDir, "To-Do List Template.md"), "utf8");
  const todo = renderNote({ raw: rawTodo, title: "x", today: "2026-10-10", extracted: {} });
  assert.equal(todo.frontmatter.status, "not-started");

  // Daily Note has no priority field — not actionable, no auto-status.
  const rawDaily = readFileSync(path.join(fixturesDir, "Daily Note Template.md"), "utf8");
  const daily = renderNote({ raw: rawDaily, title: "x", today: "2026-10-10", extracted: {} });
  assert.ok(!("status" in daily.frontmatter), `Daily Note should not have status: ${JSON.stringify(daily.frontmatter)}`);
});

test("renderNote: ask fields take extracted values when provided", () => {
  const raw = readFileSync(path.join(fixturesDir, "Trip Packing Checklist Template.md"), "utf8");
  const r = renderNote({
    raw,
    title: "Pagosa Packing List",
    today: "2026-10-10",
    extracted: { dates: "2026-11-14 to 2026-11-17" },
  });
  assert.equal(r.frontmatter.dates, "2026-11-14 to 2026-11-17");
  assert.equal(r.frontmatter.priority, ""); // forbidden stays empty
});

test("renderNote: no fabrication — unspecified ask fields stay as the template left them", () => {
  const raw = readFileSync(path.join(fixturesDir, "Person Template.md"), "utf8");
  const r = renderNote({ raw, title: "Dave", today: "2026-10-10", extracted: {} });
  // Template had `relationship: ` empty — stays empty.
  assert.equal(r.frontmatter.relationship, "");
});

test("renderNote: title placeholder resolves in body", () => {
  const raw = readFileSync(path.join(fixturesDir, "Person Template.md"), "utf8");
  const r = renderNote({ raw, title: "Dave", today: "2026-10-10", extracted: {} });
  assert.ok(r.body.includes("# Dave"), `body missing title substitution: ${r.body}`);
});

test("renderNote: unknown body placeholders are preserved as {{name}} markers", () => {
  const raw = readFileSync(path.join(fixturesDir, "List Template.md"), "utf8");
  const r = renderNote({ raw, title: "x", today: "2026-10-10", extracted: {} });
  assert.ok(r.body.includes("{{List Name}}"), `body: ${r.body}`);
});

test("renderNote: date placeholder resolves in body", () => {
  const raw = readFileSync(path.join(fixturesDir, "Grocery List Template.md"), "utf8");
  const r = renderNote({ raw, title: "x", today: "2026-10-10", extracted: {} });
  assert.ok(r.body.includes("# Grocery List — 2026-10-10"));
});

test("renderAppendEntry formats an Anger Log entry block", () => {
  const entry = renderAppendEntry({
    today: "2026-10-10",
    time: "22:30",
    fields: {
      Trigger: "late dinner",
      "What happened": "snapped at K",
      "How I responded": "walked outside",
      Outcome: "apologized",
      "Notes for next time": "eat earlier",
    },
    fieldOrder: [
      "Trigger",
      "What happened",
      "How I responded",
      "Outcome",
      "Notes for next time",
    ],
  });
  assert.ok(entry.startsWith("Date: 2026-10-10 22:30\n"));
  assert.ok(entry.includes("**Trigger:** late dinner"));
  assert.ok(entry.includes("**Notes for next time:** eat earlier"));
});

test("fileWithAppendedEntry inserts above the trailing link line and bumps updated", () => {
  const before = `---
tags: [anger-log]
updated: 2026-10-09
---

Date: 2026-10-09 14:00
**Trigger:** earlier incident
**Outcome:** fine

[[Anger MGMT Main]]`;
  const entry = `Date: 2026-10-10 22:00\n**Trigger:** new\n**Outcome:** ok`;
  const after = fileWithAppendedEntry(before, entry, "2026-10-10");
  // Entry present, old entry retained.
  assert.ok(after.includes("**Trigger:** earlier incident"));
  assert.ok(after.includes("**Trigger:** new"));
  // Trailing wikilink still present.
  assert.ok(after.includes("[[Anger MGMT Main]]"));
  // updated bumped.
  assert.ok(/updated: 2026-10-10/.test(after));
  // Order: new entry must appear BEFORE the trailing wikilink.
  assert.ok(
    after.indexOf("**Trigger:** new") < after.indexOf("[[Anger MGMT Main]]"),
    `wrong order:\n${after}`,
  );
});

test("hubMainWithAppendedLink is idempotent and adds heading when missing", () => {
  const before = `# Shopping Main

## Notes
- [[Grocery List — 2026-10-09]]
`;
  const once = hubMainWithAppendedLink(before, "Grocery List — 2026-10-10", "Notes");
  assert.ok(once.includes("- [[Grocery List — 2026-10-10]]"));
  // Idempotent
  const twice = hubMainWithAppendedLink(once, "Grocery List — 2026-10-10", "Notes");
  assert.equal(twice, once);
  // Original link preserved
  assert.ok(twice.includes("- [[Grocery List — 2026-10-09]]"));
  // Missing heading
  const noNotes = "# Hobbies Main\n";
  const added = hubMainWithAppendedLink(noNotes, "Project X", "Projects");
  assert.ok(added.includes("## Projects"));
  assert.ok(added.includes("- [[Project X]]"));
});

test("assertNoPriorityWrite validates priority is empty or q1-q4 (template-owned; model is scrubbed upstream)", () => {
  // Known-valid priority values pass; templates can seed q1 (e.g.
  // Grocery List Template) because the model's output never reaches
  // this field.
  assert.doesNotThrow(() => assertNoPriorityWrite({ priority: "q1" }));
  assert.doesNotThrow(() => assertNoPriorityWrite({ priority: "q2" }));
  assert.doesNotThrow(() => assertNoPriorityWrite({ priority: "q3" }));
  assert.doesNotThrow(() => assertNoPriorityWrite({ priority: "q4" }));
  assert.doesNotThrow(() => assertNoPriorityWrite({ priority: "" }));
  assert.doesNotThrow(() => assertNoPriorityWrite({}));
  // Garbage values still throw — a bug must surface, not land silently
  // in a note.
  assert.throws(() => assertNoPriorityWrite({ priority: "high" }), /hard-rule/);
  assert.throws(() => assertNoPriorityWrite({ priority: "Q1" }), /hard-rule/);
  assert.throws(() => assertNoPriorityWrite({ priority: 1 }), /hard-rule/);
  // Priority Level is template-locked — the writer preserves whatever
  // value the template set. assertNoPriorityWrite does NOT touch it.
  assert.doesNotThrow(() => assertNoPriorityWrite({ "Priority Level": "2: Not Urgent, Important" }));
});

test("assembleNote produces frontmatter + body with no leading blank gap", () => {
  const raw = readFileSync(path.join(fixturesDir, "Note Template.md"), "utf8");
  const r = renderNote({ raw, title: "A Note", today: "2026-10-10", extracted: {} });
  const content = assembleNote(r);
  assert.ok(content.startsWith("---\n"));
  assert.ok(content.includes("\ncreated: 2026-10-10\n"));
  assert.ok(content.includes("# A Note"));
});
