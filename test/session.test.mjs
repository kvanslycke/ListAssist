import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "templates");

const {
  createSession,
  pickTemplate,
  submitCapture,
  answerFollowUp,
  mergeExtracted,
  generateTitle,
  resolveDate,
  prepareReview,
} = await import("../.test-build/smart/session.js");

function loadTemplates() {
  const names = [
    "Grocery List Template.md",
    "Anger Log Template.md",
    "Person Template.md",
    "Trip Packing Checklist Template.md",
    "Project Template.md",
    "Daily Note Template.md",
  ];
  return names.map((n) => ({
    basename: n.replace(/\.md$/, ""),
    path: `Templates HUB/${n}`,
    raw: readFileSync(path.join(fixturesDir, n), "utf8"),
  }));
}

function makeDeps(chatImpl, overrides = {}) {
  return {
    templates: loadTemplates(),
    chat: chatImpl,
    nowISODate: () => "2026-10-10",
    nowISOTime: () => "22:30",
    folderEnum: ["Shopping HUB", "People HUB", "K&K Ranch HUB", "Health HUB/Anger MGMT/AngerLogs"],
    ...overrides,
  };
}

test("fuzzy template pick: 'grocery' -> Grocery List Template", () => {
  const session = createSession(makeDeps(() => assert.fail("chat should not run")));
  const { session: next, pick } = pickTemplate(session, "grocery list");
  assert.equal(pick.primary.basename, "Grocery List Template");
  assert.equal(next.state, "awaitCapture");
  assert.equal(next.schema.isActionable, true);
});

test("fuzzy pick: 'packing' -> Trip Packing Checklist Template", () => {
  const session = createSession(makeDeps(() => {}));
  const { pick } = pickTemplate(session, "packing");
  assert.equal(pick.primary.basename, "Trip Packing Checklist Template");
});

test("fuzzy pick: 'POD' alias -> Plan of the Day", () => {
  // Add Plan Of The Day to the template list via a one-off deps.
  const extra = loadTemplates().concat({
    basename: "Plan Of The Day Template",
    path: "Templates HUB/Plan Of The Day Template.md",
    raw: readFileSync(path.join(fixturesDir, "Plan Of The Day Template.md"), "utf8"),
  });
  const deps = { ...makeDeps(() => {}), templates: extra };
  const session = createSession(deps);
  const { pick } = pickTemplate(session, "pod");
  assert.equal(pick.primary.basename, "Plan Of The Day Template");
});

test("submitCapture calls LLM and transitions to review when no ask-fields empty", async () => {
  let called = 0;
  const chat = async (_req) => {
    called++;
    return { parsed: { name: "Dave" }, retried: false };
  };
  const deps = makeDeps(chat);
  let session = createSession(deps);
  ({ session } = pickTemplate(session, "person"));
  session = await submitCapture(session, "Dave, my coworker at Marston");
  assert.equal(called, 1);
  // Person Template has `relationship:` ask-field. Not provided by chat
  // mock -> state is followUp (asking for relationship).
  assert.equal(session.state, "followUp");
  assert.equal(session.followUps.length, 1);
  assert.equal(session.followUps[0].field, "relationship");
});

test("submitCapture surfaces LLM failure as error state", async () => {
  const chat = async () => {
    throw new Error("ollama offline");
  };
  const deps = makeDeps(chat);
  let session = createSession(deps);
  ({ session } = pickTemplate(session, "grocery"));
  session = await submitCapture(session, "eggs and milk");
  assert.equal(session.state, "error");
  assert.match(session.error, /ollama offline/);
});

test("answerFollowUp: non-skip answer merges into extracted and advances", async () => {
  const chat = async () => ({ parsed: {}, retried: false });
  const deps = makeDeps(chat);
  let session = createSession(deps);
  ({ session } = pickTemplate(session, "person"));
  session = await submitCapture(session, "Dave");
  assert.equal(session.state, "followUp");
  session = answerFollowUp(session, "coworker");
  assert.equal(session.extracted.relationship, "coworker");
  assert.equal(session.state, "review");
});

test("answerFollowUp: 'skip' advances without recording", async () => {
  const chat = async () => ({ parsed: {}, retried: false });
  const deps = makeDeps(chat);
  let session = createSession(deps);
  ({ session } = pickTemplate(session, "person"));
  session = await submitCapture(session, "Dave");
  session = answerFollowUp(session, "skip");
  assert.equal(session.state, "review");
  assert.equal(session.extracted.relationship, undefined);
});

test("answerFollowUp: 'done' jumps to review mid-queue", async () => {
  // Trip Packing has `dates:` ask-field.
  const chat = async () => ({ parsed: {}, retried: false });
  const deps = makeDeps(chat);
  let session = createSession(deps);
  ({ session } = pickTemplate(session, "packing"));
  session = await submitCapture(session, "Pagosa Springs");
  assert.equal(session.state, "followUp");
  session = answerFollowUp(session, "done");
  assert.equal(session.state, "review");
});

test("mergeExtracted ignores empty/null, keeps prior answers", () => {
  const merged = mergeExtracted(
    { name: "Dave", relationship: "coworker" },
    { relationship: "", notes: "lives in Montrose", bogus: null },
  );
  assert.deepEqual(merged, {
    name: "Dave",
    relationship: "coworker",
    notes: "lives in Montrose",
  });
});

test("generateTitle: Grocery List -> dated title", () => {
  assert.equal(generateTitle("Grocery List Template", {}, "2026-10-10"), "Grocery List — 2026-10-10");
});

test("generateTitle: Trip Packing uses destination", () => {
  assert.equal(
    generateTitle("Trip Packing Checklist Template", { destination: "Pagosa" }, "2026-10-10"),
    "Pagosa Packing List",
  );
});

test("generateTitle: Person uses extracted name", () => {
  assert.equal(generateTitle("Person Template", { name: "Dave" }, "2026-10-10"), "Dave");
});

test("resolveDate: ISO passes through", () => {
  assert.equal(resolveDate("2026-10-14", "2026-10-10"), "2026-10-14");
});

test("resolveDate: 'today' / 'tomorrow' / 'yesterday'", () => {
  assert.equal(resolveDate("today", "2026-10-10"), "2026-10-10");
  assert.equal(resolveDate("tomorrow", "2026-10-10"), "2026-10-11");
  assert.equal(resolveDate("yesterday", "2026-10-10"), "2026-10-09");
});

test("resolveDate: 'next Friday' from a Saturday (2026-10-10)", () => {
  // 2026-10-10 is a Saturday; next Friday is 2026-10-16.
  assert.equal(resolveDate("next friday", "2026-10-10"), "2026-10-16");
});

test("resolveDate: 'the 15th' resolves to this month if upcoming", () => {
  assert.equal(resolveDate("the 15th", "2026-10-10"), "2026-10-15");
});

test("resolveDate: 'the 5th of November'", () => {
  assert.equal(resolveDate("the 5th of November", "2026-10-10"), "2026-11-05");
});

test("resolveDate: returns null on unparseable", () => {
  assert.equal(resolveDate("whenever", "2026-10-10"), null);
  assert.equal(resolveDate("", "2026-10-10"), null);
});

test("end-to-end: pick -> capture -> answer -> review builds a RenderResult", async () => {
  const chat = async () => ({
    parsed: { name: "Dave" },
    retried: false,
  });
  const deps = makeDeps(chat);
  let session = createSession(deps);
  ({ session } = pickTemplate(session, "person"));
  session = await submitCapture(session, "Dave is a coworker at Marston");
  session = answerFollowUp(session, "coworker");
  assert.equal(session.state, "review");
  const plan = prepareReview(session);
  assert.ok(plan);
  // Priority never written non-empty.
  assert.equal(plan.rendered.frontmatter.priority ?? "", "");
  // relationship captured via follow-up.
  assert.equal(plan.rendered.frontmatter.relationship, "coworker");
  // Folder suggestion: Person -> People HUB.
  assert.equal(plan.folder.folder, "People HUB");
});
