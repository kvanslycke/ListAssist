// Smart Note's To-Do List flow is a loop, not a single note.
//
// One session can create many To-Do notes: for each one the user
// gives a title, a priority, a due date, a destination folder, and
// (optionally) subtasks that fill the template's `- [ ]`
// placeholders. When the user says "done", every draft is written in
// one batch.
//
// This module is pure state transitions + the body-filler helper.
// The LLM call (Ollama subtask-expansion) is injected from the
// session layer, and the Obsidian-side writer lives in writer.ts.
// Both are called by SmartNoteView after the loop reaches "review".

import { renderNote, type RenderResult } from "./writer-core";
import { resolveDate } from "./session";

export type TodoLoopState =
  | "askTask"
  | "askPriority"
  | "askDue"
  | "askFolder"
  | "askSubtasks"
  | "roundEnd"
  | "review"
  | "writing"
  | "done"
  | "error";

export type TodoPriority = "" | "q1" | "q2" | "q3" | "q4";

export interface TodoDraft {
  title: string;
  priority: TodoPriority;
  due: string;            // YYYY-MM-DD, or ""
  folder: string;         // "" = vault root
  subtasks: string[];     // user-provided; empty = ask LLM at render time
  // When subtasks is [] AND llmSubtasks is non-null, use llmSubtasks.
  // When both are empty, the body falls back to `- [ ] <title>`.
  llmSubtasks: string[] | null;
}

export interface TodoLoopSession {
  state: TodoLoopState;
  drafts: TodoDraft[];         // completed rounds, in order
  current: Partial<TodoDraft>; // the round in progress
  error: string | null;
}

export function createTodoLoop(): TodoLoopSession {
  return {
    state: "askTask",
    drafts: [],
    current: emptyDraft(),
    error: null,
  };
}

function emptyDraft(): Partial<TodoDraft> {
  return { priority: "", due: "", folder: "", subtasks: [], llmSubtasks: null };
}

// -- Step transitions ------------------------------------------------

export function setTask(session: TodoLoopSession, title: string): TodoLoopSession {
  const t = title.trim();
  if (!t) return { ...session, error: "Task title can't be empty." };
  return {
    ...session,
    error: null,
    current: { ...session.current, title: t },
    state: "askPriority",
  };
}

export function setPriority(session: TodoLoopSession, priority: TodoPriority): TodoLoopSession {
  return {
    ...session,
    error: null,
    current: { ...session.current, priority },
    state: "askDue",
  };
}

// `dueInput` can be YYYY-MM-DD, "today", "tomorrow", "next Friday",
// "the 25th", etc. Empty / "skip" → no due date.
export function setDue(session: TodoLoopSession, dueInput: string, today: string): TodoLoopSession {
  const raw = dueInput.trim().toLowerCase();
  if (!raw || raw === "skip" || raw === "none") {
    return {
      ...session,
      error: null,
      current: { ...session.current, due: "" },
      state: "askFolder",
    };
  }
  const resolved = resolveDate(dueInput, today);
  if (!resolved) {
    return { ...session, error: `Couldn't resolve "${dueInput}" to a date. Try YYYY-MM-DD or "next Friday", or skip.` };
  }
  return {
    ...session,
    error: null,
    current: { ...session.current, due: resolved },
    state: "askFolder",
  };
}

export function setFolder(session: TodoLoopSession, folder: string): TodoLoopSession {
  return {
    ...session,
    error: null,
    current: { ...session.current, folder: folder.trim() },
    state: "askSubtasks",
  };
}

// `subtasks` may be empty — the view calls this with [] when the user
// clicks Skip. In that case the LLM is called at render-time by the
// session layer to populate llmSubtasks.
export function setSubtasks(session: TodoLoopSession, subtasks: readonly string[]): TodoLoopSession {
  const clean = subtasks.map((s) => s.trim()).filter((s) => s.length > 0);
  return {
    ...session,
    error: null,
    current: { ...session.current, subtasks: clean },
    state: "roundEnd",
  };
}

// After roundEnd, user picks "Add another" or "Done".
// commitRound finalises the current draft; nextRound then clears the
// current slot for a fresh task; finishLoop moves to review.
function commitRound(session: TodoLoopSession): TodoLoopSession {
  const draft: TodoDraft = {
    title: session.current.title ?? "",
    priority: (session.current.priority as TodoPriority) ?? "",
    due: session.current.due ?? "",
    folder: session.current.folder ?? "",
    subtasks: session.current.subtasks ?? [],
    llmSubtasks: session.current.llmSubtasks ?? null,
  };
  if (!draft.title) return session; // guard — shouldn't happen; setTask enforces non-empty
  return { ...session, drafts: [...session.drafts, draft] };
}

export function nextRound(session: TodoLoopSession): TodoLoopSession {
  const committed = commitRound(session);
  return { ...committed, current: emptyDraft(), state: "askTask", error: null };
}

export function finishLoop(session: TodoLoopSession): TodoLoopSession {
  const committed = commitRound(session);
  return { ...committed, current: emptyDraft(), state: "review", error: null };
}

// Step back one state. Used by the "Back" button on each panel.
export function stepBack(session: TodoLoopSession): TodoLoopSession {
  const prev: Record<TodoLoopState, TodoLoopState> = {
    askTask: "askTask", // nothing to go back to on the first round's first step
    askPriority: "askTask",
    askDue: "askPriority",
    askFolder: "askDue",
    askSubtasks: "askFolder",
    roundEnd: "askSubtasks",
    review: "roundEnd",
    writing: "writing",
    done: "done",
    error: "askTask",
  };
  return { ...session, state: prev[session.state], error: null };
}

// -- Rendering a draft into a note body ----------------------------

export interface RenderDraftInput {
  draft: TodoDraft;
  templateRaw: string;
  today: string;
}

export function renderDraft(input: RenderDraftInput): RenderResult {
  // The writer treats `priority` as template-owned (writer-core
  // post-2026-10-15). Inject the per-draft priority into the raw
  // template so renderNote emits it in the frontmatter.
  const rawWithPriority = injectPriority(input.templateRaw, input.draft.priority);
  const extracted: Record<string, unknown> = {};
  if (input.draft.due) extracted.due = input.draft.due;
  const rendered = renderNote({
    raw: rawWithPriority,
    title: input.draft.title,
    today: input.today,
    extracted,
  });
  rendered.body = fillTopLevelCheckboxes(rendered.body, chooseBodyItems(input.draft));
  return rendered;
}

// Priority order of body items:
//   1. User-supplied subtasks (never overridden by the LLM).
//   2. LLM-generated subtasks, if asked and non-empty.
//   3. The title itself, as the single checkbox fallback.
function chooseBodyItems(draft: TodoDraft): string[] {
  if (draft.subtasks.length > 0) return draft.subtasks;
  if (draft.llmSubtasks && draft.llmSubtasks.length > 0) return draft.llmSubtasks;
  return [draft.title];
}

function injectPriority(raw: string, priority: TodoPriority): string {
  if (!priority) return raw;
  return raw.replace(/^priority:[ \t]*$/m, `priority: ${priority}`);
}

// Fill the bare top-level `- [ ]` placeholders with the given items.
// Fewer items than placeholders → remaining placeholders stay empty.
// More items than placeholders → extras are appended immediately
// after the last placeholder. Pre-filled checkbox lines are not
// touched; only empty `- [ ]` lines are replaced.
export function fillTopLevelCheckboxes(body: string, items: readonly string[]): string {
  if (items.length === 0) return body;
  const empty = /^\s*-\s+\[\s*\]\s*$/;
  const lines = body.split("\n");
  const remaining = [...items];
  let lastReplacedIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (empty.test(lines[i]) && remaining.length > 0) {
      const next = remaining.shift()!;
      lines[i] = `- [ ] ${next}`;
      lastReplacedIdx = i;
    } else if (empty.test(lines[i])) {
      lastReplacedIdx = i; // track position for appending extras
    }
  }
  if (remaining.length > 0) {
    const extras = remaining.map((t) => `- [ ] ${t}`);
    if (lastReplacedIdx >= 0) {
      lines.splice(lastReplacedIdx + 1, 0, ...extras);
    } else {
      // No placeholders in body at all — append to the bottom.
      lines.push(...extras);
    }
  }
  return lines.join("\n");
}

// -- LLM subtask expansion -----------------------------------------
//
// Called from the session layer with the injected chat function.
// System prompt is deliberately short: ONE paragraph of guidance.
// If the chat throws, returns [] and the renderer falls back to the
// title. If the chat returns [] or garbage, same fallback.

export const SUBTASK_SYSTEM_PROMPT =
  "You help the user break a to-do task into 1-5 simple sub-actions. " +
  "The user gives you a task title. Return a JSON object with a `subtasks` array of short imperative phrases. " +
  "If the title is too vague or already atomic, return an empty array and the user's own title will be used. " +
  "Never invent context the user did not provide. Return JSON only.";

export const SUBTASK_FORMAT = {
  type: "object",
  properties: {
    subtasks: { type: "array", items: { type: "string" } },
  },
  required: ["subtasks"],
  additionalProperties: false,
};

export function parseLlmSubtasks(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object") return [];
  const v = (parsed as Record<string, unknown>).subtasks;
  if (!Array.isArray(v)) return [];
  const clean = v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return clean.slice(0, 5);
}
