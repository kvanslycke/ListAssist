// Hard-rule enforcement: the Smart Note write path NEVER produces a
// non-empty value for `priority` or `Priority Level`, no matter what
// the LLM returns. Exercised against every real template fixture.
//
// Before src/smart/writer-core.ts exists this test fails at import
// time — that is the intended red state until step 7.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "templates");
const fixtureFiles = readdirSync(fixturesDir).filter((n) => n.endsWith(".md"));

// Writer-core module is produced by `npm run test:build`. The import
// fails loudly until step 7 lands src/smart/writer-core.ts.
const writerCore = await import("../.test-build/smart/writer-core.js");
const { renderNote, assertNoPriorityWrite } = writerCore;

// Adversarial extraction payloads: the model "insists" on a priority.
// `priority` must always come out empty. `Priority Level` is template-
// locked (passthrough from the template; never set from extracted) —
// the leak values are chosen to NOT match any value the fixtures carry,
// so the assertion only fires when the writer actually accepted them.
const PRIORITY_LEAKS = [
  { priority: "q1" },
  { priority: "urgent" },
  { "Priority Level": "99: Satan Urgent" },
  { priority: "q2", "Priority Level": "88: Writer should not accept this" },
];

test("renderNote never writes a non-empty priority — all 14 templates", async (t) => {
  assert.equal(
    fixtureFiles.length,
    14,
    `expected 14 fixtures, found ${fixtureFiles.length}`,
  );

  for (const name of fixtureFiles) {
    await t.test(name, () => {
      const raw = readFileSync(path.join(fixturesDir, name), "utf8");
      for (const leak of PRIORITY_LEAKS) {
        const rendered = renderNote({
          raw,
          title: "Fixture Title",
          today: "2026-10-10",
          extracted: leak,
        });
        // Must not throw: assertNoPriorityWrite is the writer's own
        // guard rail. If it does throw, that's actually a pass for
        // the hard rule — but renderNote itself must have scrubbed.
        assertNoPriorityWrite(rendered.frontmatter);
        const p = rendered.frontmatter.priority;
        const pl = rendered.frontmatter["Priority Level"];
        const empties = [undefined, null, ""];
        assert.ok(
          empties.includes(p),
          `priority leaked as ${JSON.stringify(p)} in ${name} with input ${JSON.stringify(leak)}`,
        );
        // Priority Level is passthrough for templates that pre-set it
        // (e.g. Grocery). It stays verbatim from the template; the
        // writer must never OVERWRITE it from extracted. So the test
        // tolerates whatever value the template carried, but it must
        // not match the leak.
        if (leak["Priority Level"] !== undefined) {
          assert.notEqual(
            pl,
            leak["Priority Level"],
            `Priority Level overwritten from extracted in ${name}`,
          );
        }
      }
    });
  }
});
