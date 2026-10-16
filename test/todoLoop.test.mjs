import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTodoLoop,
  setTask,
  setPriority,
  setDue,
  setFolder,
  setSubtasks,
  nextRound,
  finishLoop,
  stepBack,
  renderDraft,
  fillTopLevelCheckboxes,
  parseLlmSubtasks,
} from "../.test-build/smart/todoLoop.js";

const TODO_TEMPLATE = `---
tags:
  - todo
created: {{date}}
due:
priority:
status: not-started
---

# {{title}}

- [ ]
- [ ]
- [ ]
`;

// -- State transitions --------------------------------------------

test("createTodoLoop starts in askTask with no drafts", () => {
  const s = createTodoLoop();
  assert.equal(s.state, "askTask");
  assert.deepEqual(s.drafts, []);
  assert.equal(s.error, null);
});

test("setTask rejects empty title, advances on non-empty", () => {
  let s = createTodoLoop();
  s = setTask(s, "   ");
  assert.equal(s.state, "askTask");
  assert.match(s.error, /empty/);
  s = setTask(s, "renew truck registration");
  assert.equal(s.state, "askPriority");
  assert.equal(s.error, null);
  assert.equal(s.current.title, "renew truck registration");
});

test("setPriority accepts valid values and advances", () => {
  let s = setTask(createTodoLoop(), "x");
  s = setPriority(s, "q1");
  assert.equal(s.state, "askDue");
  assert.equal(s.current.priority, "q1");
});

test("setDue skip/empty leaves due empty and advances", () => {
  let s = setPriority(setTask(createTodoLoop(), "x"), "q2");
  s = setDue(s, "skip", "2026-10-16");
  assert.equal(s.state, "askFolder");
  assert.equal(s.current.due, "");
});

test("setDue resolves 'next friday' against today", () => {
  let s = setPriority(setTask(createTodoLoop(), "x"), "q2");
  s = setDue(s, "next friday", "2026-10-16"); // Oct 16 is a Friday
  assert.equal(s.state, "askFolder");
  assert.match(s.current.due, /^\d{4}-\d{2}-\d{2}$/);
});

test("setDue surfaces an error for garbage input and holds state", () => {
  let s = setPriority(setTask(createTodoLoop(), "x"), "q2");
  s = setDue(s, "jabberwocky", "2026-10-16");
  assert.equal(s.state, "askDue");
  assert.match(s.error, /Couldn't resolve/);
});

test("setFolder trims and advances", () => {
  let s = setDue(setPriority(setTask(createTodoLoop(), "x"), "q2"), "", "2026-10-16");
  s = setFolder(s, "  Hobbies HUB/Projects  ");
  assert.equal(s.state, "askSubtasks");
  assert.equal(s.current.folder, "Hobbies HUB/Projects");
});

test("setSubtasks dedupes empties and advances", () => {
  let s = setFolder(setDue(setPriority(setTask(createTodoLoop(), "x"), "q2"), "", "2026-10-16"), "");
  s = setSubtasks(s, ["call vet", "  ", "pick up food", ""]);
  assert.equal(s.state, "roundEnd");
  assert.deepEqual(s.current.subtasks, ["call vet", "pick up food"]);
});

test("nextRound commits the current draft and resets", () => {
  let s = createTodoLoop();
  s = setTask(s, "a");
  s = setPriority(s, "q1");
  s = setDue(s, "", "2026-10-16");
  s = setFolder(s, "F1");
  s = setSubtasks(s, ["one"]);
  s = nextRound(s);
  assert.equal(s.state, "askTask");
  assert.equal(s.drafts.length, 1);
  assert.equal(s.drafts[0].title, "a");
  assert.equal(s.drafts[0].priority, "q1");
  assert.deepEqual(s.drafts[0].subtasks, ["one"]);
  assert.equal(s.current.title, undefined);
});

test("finishLoop commits and moves to review", () => {
  let s = createTodoLoop();
  s = setTask(s, "a");
  s = setPriority(s, "q1");
  s = setDue(s, "", "2026-10-16");
  s = setFolder(s, "F1");
  s = setSubtasks(s, []);
  s = finishLoop(s);
  assert.equal(s.state, "review");
  assert.equal(s.drafts.length, 1);
});

test("stepBack walks one state backwards", () => {
  let s = setPriority(setTask(createTodoLoop(), "x"), "q1");
  assert.equal(s.state, "askDue");
  s = stepBack(s);
  assert.equal(s.state, "askPriority");
  s = stepBack(s);
  assert.equal(s.state, "askTask");
});

// -- Body-filler ---------------------------------------------------

test("fillTopLevelCheckboxes fills exactly N placeholders", () => {
  const body = "# T\n\n- [ ] \n- [ ] \n- [ ] \n";
  const out = fillTopLevelCheckboxes(body, ["a", "b"]);
  assert.ok(out.includes("- [ ] a"));
  assert.ok(out.includes("- [ ] b"));
  // Third placeholder stays empty.
  assert.ok(/- \[ \] *\n|- \[ \] *$/.test(out));
});

test("fillTopLevelCheckboxes appends extras after the last placeholder", () => {
  const body = "# T\n\n- [ ] \n- [ ] \n- [ ] \n";
  const out = fillTopLevelCheckboxes(body, ["a", "b", "c", "d", "e"]);
  for (const t of ["a", "b", "c", "d", "e"]) {
    assert.ok(out.includes(`- [ ] ${t}`), `missing ${t}`);
  }
});

test("fillTopLevelCheckboxes with no items leaves the body alone", () => {
  const body = "# T\n\n- [ ] \n- [ ] \n";
  assert.equal(fillTopLevelCheckboxes(body, []), body);
});

// -- renderDraft ---------------------------------------------------

test("renderDraft stamps title, priority, due, and subtasks into the note", () => {
  const r = renderDraft({
    draft: {
      title: "Call vet",
      priority: "q1",
      due: "2026-10-20",
      folder: "Health HUB",
      subtasks: ["find vet number", "ask about shots"],
      llmSubtasks: null,
    },
    templateRaw: TODO_TEMPLATE,
    today: "2026-10-16",
  });
  assert.equal(r.frontmatter.priority, "q1");
  assert.equal(r.frontmatter.due, "2026-10-20");
  assert.equal(r.frontmatter.status, "not-started");
  assert.ok(r.body.includes("# Call vet"));
  assert.ok(r.body.includes("- [ ] find vet number"));
  assert.ok(r.body.includes("- [ ] ask about shots"));
});

test("renderDraft with no user subtasks and no llmSubtasks falls back to the title", () => {
  const r = renderDraft({
    draft: {
      title: "Email bank",
      priority: "",
      due: "",
      folder: "",
      subtasks: [],
      llmSubtasks: null,
    },
    templateRaw: TODO_TEMPLATE,
    today: "2026-10-16",
  });
  assert.ok(r.body.includes("- [ ] Email bank"));
});

test("renderDraft prefers user subtasks over llmSubtasks", () => {
  const r = renderDraft({
    draft: {
      title: "Email bank",
      priority: "",
      due: "",
      folder: "",
      subtasks: ["draft email"],
      llmSubtasks: ["step 1", "step 2"],
    },
    templateRaw: TODO_TEMPLATE,
    today: "2026-10-16",
  });
  assert.ok(r.body.includes("- [ ] draft email"));
  assert.ok(!r.body.includes("- [ ] step 1"));
});

test("renderDraft uses llmSubtasks when user skipped and llm returned items", () => {
  const r = renderDraft({
    draft: {
      title: "Email bank",
      priority: "",
      due: "",
      folder: "",
      subtasks: [],
      llmSubtasks: ["gather account number", "write message", "send"],
    },
    templateRaw: TODO_TEMPLATE,
    today: "2026-10-16",
  });
  assert.ok(r.body.includes("- [ ] gather account number"));
  assert.ok(r.body.includes("- [ ] send"));
});

test("renderDraft with no priority leaves frontmatter priority empty", () => {
  const r = renderDraft({
    draft: {
      title: "x",
      priority: "",
      due: "",
      folder: "",
      subtasks: [],
      llmSubtasks: null,
    },
    templateRaw: TODO_TEMPLATE,
    today: "2026-10-16",
  });
  assert.equal(r.frontmatter.priority, "");
});

// -- parseLlmSubtasks ----------------------------------------------

test("parseLlmSubtasks returns the array when well-formed", () => {
  assert.deepEqual(parseLlmSubtasks({ subtasks: ["a", "b"] }), ["a", "b"]);
});

test("parseLlmSubtasks caps at 5", () => {
  assert.equal(parseLlmSubtasks({ subtasks: ["1", "2", "3", "4", "5", "6"] }).length, 5);
});

test("parseLlmSubtasks returns [] on garbage", () => {
  assert.deepEqual(parseLlmSubtasks(null), []);
  assert.deepEqual(parseLlmSubtasks("nope"), []);
  assert.deepEqual(parseLlmSubtasks({ subtasks: "not-an-array" }), []);
  assert.deepEqual(parseLlmSubtasks({ subtasks: [1, 2, 3] }), []);
  assert.deepEqual(parseLlmSubtasks({ subtasks: ["", "   "] }), []);
});
