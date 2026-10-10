// Deterministic classification + structural parse of every real
// template in test/fixtures/templates/. Confirms the four invariants
// Smart Note depends on:
//   1. classifyTemplate is deterministic (idempotent across runs).
//   2. priority / Priority Level ALWAYS classify as "forbidden" when
//      present in the template.
//   3. Known ask keys classify as "ask" when empty and "passthrough"
//      when the template pre-set a value.
//   4. isActionable follows the "has a priority key" rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "templates");
const files = readdirSync(fixturesDir).filter((n) => n.endsWith(".md")).sort();

const { classifyTemplate } = await import(
  "../.test-build/smart/templateSchema.js"
);

const ACTIONABLE = new Set([
  "Grocery List Template.md",
  "Project Template.md",
  "Inventory Template.md",
  "List Template.md",
  "To-Do List Template.md",
  "Trip Packing Checklist Template.md",
  "Auto Maintenance Checklist Template.md",
]);

const ASK_KEYS = new Set([
  "relationship",
  "due",
  "dates",
  "next-action",
  "rapids-class",
  "destination",
  "area",
]);

test("fixture count is 14", () => {
  assert.equal(files.length, 14);
});

test("classifyTemplate is deterministic", async (t) => {
  for (const name of files) {
    await t.test(name, () => {
      const raw = readFileSync(path.join(fixturesDir, name), "utf8");
      const a = classifyTemplate(raw);
      const b = classifyTemplate(raw);
      assert.deepEqual(a, b);
    });
  }
});

test("priority and Priority Level always classify as forbidden", async (t) => {
  for (const name of files) {
    await t.test(name, () => {
      const raw = readFileSync(path.join(fixturesDir, name), "utf8");
      const schema = classifyTemplate(raw);
      for (const f of schema.fields) {
        if (f.key === "priority" || f.key === "Priority Level") {
          assert.equal(
            f.class,
            "forbidden",
            `${name}: ${f.key} should be forbidden, got ${f.class}`,
          );
        }
      }
    });
  }
});

test("known ask keys: ask when empty, passthrough when template-set", async (t) => {
  for (const name of files) {
    await t.test(name, () => {
      const raw = readFileSync(path.join(fixturesDir, name), "utf8");
      const schema = classifyTemplate(raw);
      for (const f of schema.fields) {
        if (!ASK_KEYS.has(f.key)) continue;
        const empty = f.value === null || f.value === undefined || f.value === "";
        const expected = empty ? "ask" : "passthrough";
        assert.equal(
          f.class,
          expected,
          `${name}: ${f.key}=${JSON.stringify(f.value)} should be ${expected}, got ${f.class}`,
        );
      }
    });
  }
});

test("isActionable matches the known 7 actionable templates", async (t) => {
  for (const name of files) {
    await t.test(name, () => {
      const raw = readFileSync(path.join(fixturesDir, name), "utf8");
      const schema = classifyTemplate(raw);
      assert.equal(schema.isActionable, ACTIONABLE.has(name));
    });
  }
});

test("body sections are detected (Grocery has Produce/Meat/Pantry/Frozen/Household)", () => {
  const raw = readFileSync(
    path.join(fixturesDir, "Grocery List Template.md"),
    "utf8",
  );
  const schema = classifyTemplate(raw);
  const h2s = schema.bodySections.filter((s) => s.level === 2).map((s) => s.heading);
  assert.deepEqual(h2s, ["Produce", "Meat", "Pantry", "Frozen", "Household"]);
});

test("inline bold fields are detected (Anger Log has 5)", () => {
  const raw = readFileSync(
    path.join(fixturesDir, "Anger Log Template.md"),
    "utf8",
  );
  const schema = classifyTemplate(raw);
  const labels = schema.inlineBoldFields.map((f) => f.label);
  assert.deepEqual(labels, [
    "Trigger",
    "What happened",
    "How I responded",
    "Outcome",
    "Notes for next time",
  ]);
});

test("tables are detected (Inventory has one with 5 headers)", () => {
  const raw = readFileSync(
    path.join(fixturesDir, "Inventory Template.md"),
    "utf8",
  );
  const schema = classifyTemplate(raw);
  assert.equal(schema.tables.length, 1);
  assert.deepEqual(schema.tables[0].headers, [
    "Item",
    "Quantity",
    "Location",
    "Notes",
    "Assignment",
  ]);
});

test("checkbox lists are detected (Grocery has 5 lists)", () => {
  const raw = readFileSync(
    path.join(fixturesDir, "Grocery List Template.md"),
    "utf8",
  );
  const schema = classifyTemplate(raw);
  assert.equal(
    schema.checkboxLists.length,
    5,
    `expected 5 checkbox lists under Produce/Meat/Pantry/Frozen/Household, got ${schema.checkboxLists.length}`,
  );
});
