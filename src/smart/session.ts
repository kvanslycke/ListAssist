// Smart Note session: the state machine that coordinates template
// pick -> capture -> extract -> follow-up -> review -> write.
//
// Everything in this file is pure except where it calls an injected
// LLM client (ollamaClient-compatible). The obsidian-side modal is a
// thin shell over these functions.

import { classifyTemplate, type TemplateSchema, type ClassifiedField } from "./templateSchema";
import { renderNote, type RenderResult } from "./writer-core";
import { suggestFolder, tripPackingFolder, type RoutingResult } from "./router";

export type State =
  | "pickTemplate"
  | "awaitCapture"
  | "extract"
  | "followUp"
  | "review"
  | "writing"
  | "done"
  | "error";

export interface TemplateRef {
  basename: string;      // "Grocery List Template"
  path: string;          // vault path
  raw: string;           // template content
}

export interface SessionDeps {
  templates: readonly TemplateRef[];
  chat: ChatFn;                                      // injected ollama chat
  nowISODate: () => string;                           // "YYYY-MM-DD" in America/Denver
  nowISOTime: () => string;                           // "HH:mm"
  maxFollowUps?: number;                              // default 3
  folderEnum?: readonly string[];                     // for routing
  lastUsedByTemplate?: ReadonlyMap<string, string>;   // settings memory
}

export type ChatFn = (req: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  format: Record<string, unknown>;
}) => Promise<{ parsed: unknown; retried: boolean }>;

export interface FollowUpQuestion {
  kind: "ask-field" | "gap";
  field?: string;         // present for ask-field
  prompt: string;
}

export interface SessionState {
  state: State;
  deps: SessionDeps;
  template: TemplateRef | null;
  schema: TemplateSchema | null;
  transcript: string;
  extracted: Record<string, unknown>;
  followUps: FollowUpQuestion[];
  followUpsAsked: number;
  error: string | null;
}

export function createSession(deps: SessionDeps): SessionState {
  return {
    state: "pickTemplate",
    deps,
    template: null,
    schema: null,
    transcript: "",
    extracted: {},
    followUps: [],
    followUpsAsked: 0,
    error: null,
  };
}

// -- Fuzzy template pick -----------------------------------------

export interface TemplatePickResult {
  primary: TemplateRef | null;
  candidates: TemplateRef[];
}

export function pickTemplate(
  session: SessionState,
  utterance: string,
): { session: SessionState; pick: TemplatePickResult } {
  const pick = fuzzyMatchTemplates(utterance, session.deps.templates);
  if (!pick.primary) return { session, pick };
  return {
    session: {
      ...session,
      state: "awaitCapture",
      template: pick.primary,
      schema: classifyTemplate(pick.primary.raw),
    },
    pick,
  };
}

function fuzzyMatchTemplates(
  utterance: string,
  templates: readonly TemplateRef[],
): TemplatePickResult {
  const needle = utterance.toLowerCase().trim();
  if (!needle) return { primary: null, candidates: [...templates] };
  const scored = templates
    .map((t) => {
      const base = t.basename.toLowerCase().replace(/\s+template$/i, "");
      return { t, score: scoreMatch(needle, base, t.basename.toLowerCase()) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const primary = scored[0]?.t ?? null;
  const candidates = scored.slice(0, 3).map((s) => s.t);
  return { primary, candidates };
}

function scoreMatch(needle: string, baseName: string, fullName: string): number {
  // Exact phrase in the needle wins.
  if (needle.includes(baseName)) return 100;
  // Token overlap scoring. Each shared word adds; words earlier in
  // the template name score higher.
  const needleTokens = tokenize(needle);
  const baseTokens = tokenize(baseName);
  let score = 0;
  for (let i = 0; i < baseTokens.length; i++) {
    if (needleTokens.includes(baseTokens[i])) {
      score += 10 - Math.min(i, 5);
    }
  }
  // Common aliases.
  const aliases: Record<string, string[]> = {
    "grocery list": ["grocery", "groceries", "shopping", "food"],
    "trip packing checklist": ["packing", "pack", "trip"],
    "plan of the day": ["pod", "plan"],
    "anger log": ["anger", "mad", "lost it"],
    "auto maintenance checklist": ["auto", "car", "vehicle", "maintenance"],
    "rapids system": ["rapids", "class", "routine"],
  };
  for (const [tpl, words] of Object.entries(aliases)) {
    if (baseName !== tpl) continue;
    for (const w of words) if (needle.includes(w)) score += 15;
  }
  return score;
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 1);
}

// -- Capture + extract -----------------------------------------

export async function submitCapture(
  session: SessionState,
  transcript: string,
): Promise<SessionState> {
  if (!session.template || !session.schema) {
    return { ...session, state: "error", error: "No template selected" };
  }
  const base = { ...session, transcript, state: "extract" as State };
  try {
    const prompt = buildExtractionPrompt(session.schema, transcript);
    const resp = await session.deps.chat(prompt);
    const extracted = asRecord(resp.parsed);
    const queue = buildInitialFollowUpQueue(session.schema, extracted, session.deps.maxFollowUps ?? 3);
    return {
      ...base,
      extracted,
      followUps: queue,
      state: queue.length > 0 ? "followUp" : "review",
    };
  } catch (e) {
    return { ...base, state: "error", error: (e as Error).message };
  }
}

function buildExtractionPrompt(
  schema: TemplateSchema,
  transcript: string,
): { messages: Array<{ role: "system" | "user"; content: string }>; format: Record<string, unknown> } {
  const askFields = schema.fields
    .filter((f) => f.class === "ask")
    .map((f) => f.key);
  const bodySectionNames = schema.bodySections.map((s) => s.heading);
  const inlineLabels = schema.inlineBoldFields.map((f) => f.label);
  const schemaProps: Record<string, unknown> = {};
  for (const k of askFields) schemaProps[k] = { type: "string" };
  for (const label of inlineLabels) schemaProps[label] = { type: "string" };
  for (const sec of bodySectionNames) schemaProps[sec] = { type: "array", items: { type: "string" } };
  const format = { type: "object", properties: schemaProps, additionalProperties: false };
  const system =
    "You extract structured note content from a spoken or typed description. " +
    "Return JSON that matches the provided schema. Fill fields only with details the user actually said; " +
    "if the user did not mention something, leave that key out. Never invent facts. " +
    "Never set `priority` or `Priority Level` — those keys are forbidden.";
  const user = `TEMPLATE SECTIONS: ${bodySectionNames.join(", ") || "(none)"}\n` +
    `INLINE FIELDS: ${inlineLabels.join(", ") || "(none)"}\n` +
    `ASK FIELDS: ${askFields.join(", ") || "(none)"}\n\n` +
    `USER DESCRIPTION:\n${transcript}`;
  return { messages: [{ role: "system", content: system }, { role: "user", content: user }], format };
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

// -- Follow-up queue --------------------------------------------

export function buildInitialFollowUpQueue(
  schema: TemplateSchema,
  extracted: Record<string, unknown>,
  max: number,
): FollowUpQuestion[] {
  const queue: FollowUpQuestion[] = [];
  // Required/ask fields that are still empty come first.
  for (const field of schema.fields) {
    if (queue.length >= max) break;
    if (field.class !== "ask") continue;
    const v = extracted[field.key];
    if (v === null || v === undefined || v === "") {
      queue.push({
        kind: "ask-field",
        field: field.key,
        prompt: promptForField(field),
      });
    }
  }
  return queue;
}

function promptForField(field: ClassifiedField): string {
  const label = humanize(field.key);
  const samples: Record<string, string> = {
    relationship: `What's your relationship to this person? (e.g. coworker, family, neighbor)`,
    "next-action": `What's the next concrete action on this project?`,
    due: `When is this due? (YYYY-MM-DD or "next Friday")`,
    dates: `What dates does this cover? (e.g. 2026-11-14 to 2026-11-17)`,
    destination: `Where to?`,
    area: `Which area of life does this belong to?`,
    "rapids-class": `Which rapids class? (1–5, or skip to leave blank)`,
  };
  return samples[field.key] ?? `${label}?`;
}

function humanize(key: string): string {
  return key
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function answerFollowUp(
  session: SessionState,
  answer: string | "skip" | "done",
): SessionState {
  if (session.state !== "followUp") return session;
  const current = session.followUps[0];
  if (!current) return { ...session, state: "review" };

  let extracted = session.extracted;
  if (answer === "done") {
    return { ...session, state: "review", followUpsAsked: session.followUpsAsked + 1 };
  }
  if (answer !== "skip" && current.kind === "ask-field" && current.field) {
    extracted = mergeExtracted(extracted, { [current.field]: answer });
  }
  const rest = session.followUps.slice(1);
  const asked = session.followUpsAsked + 1;
  const max = session.deps.maxFollowUps ?? 3;
  const nextState = rest.length === 0 || asked >= max ? "review" : "followUp";
  return { ...session, extracted, followUps: rest, followUpsAsked: asked, state: nextState };
}

// Non-empty values in `next` overwrite `prev`. Empty values do not
// clobber prior answers.
export function mergeExtracted(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

// -- Review preparation -----------------------------------------

export interface ReviewPlan {
  rendered: RenderResult;
  folder: RoutingResult;
  title: string;
}

export function prepareReview(
  session: SessionState,
  opts: { folderEnum?: readonly string[]; lastUsed?: string | null; modelPick?: { folder: string; reason: string } | null } = {},
): ReviewPlan | null {
  if (!session.template || !session.schema) return null;
  const title = generateTitle(session.template.basename, session.extracted, session.deps.nowISODate());
  const rendered = renderNote({
    raw: session.template.raw,
    title,
    today: session.deps.nowISODate(),
    extracted: session.extracted,
  });
  const folder = suggestFolder({
    templateBasename: session.template.basename,
    folderEnum: opts.folderEnum ?? session.deps.folderEnum ?? [],
    lastUsed: opts.lastUsed ?? session.deps.lastUsedByTemplate?.get(session.template.basename) ?? null,
    modelPick: opts.modelPick ?? null,
  });
  return { rendered, folder, title };
}

// -- Title generation -------------------------------------------

export function generateTitle(
  templateBasename: string,
  extracted: Record<string, unknown>,
  today: string,
): string {
  const name = templateBasename.replace(/\s+Template$/i, "");
  switch (name) {
    case "Grocery List":
      return `Grocery List — ${today}`;
    case "Plan Of The Day":
      return `Plan of the Day — ${today}`;
    case "Daily Note":
      return today;
    case "Rapids System":
      return `Rapids System — ${today}`;
    case "Person": {
      const n = asString(extracted.name) || asString(extracted.title) || "Person";
      return n;
    }
    case "Trip Packing Checklist": {
      const d = asString(extracted.destination) || "Trip";
      return `${d} Packing List`;
    }
    default: {
      const t = asString(extracted.title);
      if (t) return titleCase(t.slice(0, 80));
      return `${name} ${today}`;
    }
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

// -- Date resolution -----------------------------------------

// Resolves human-ish date phrases against `today` (YYYY-MM-DD) in
// America/Denver. Supports: ISO ("2026-10-14"), "today", "tomorrow",
// "yesterday", "next <weekday>", "this <weekday>", "<weekday>",
// "the Nth" (same month), and "the Nth of <month>".
export function resolveDate(input: string, today: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const base = parseISO(today);
  if (!base) return null;
  if (s === "today") return today;
  if (s === "tomorrow") return offsetDays(base, 1);
  if (s === "yesterday") return offsetDays(base, -1);
  const nextWd = /^(next\s+)(sun|mon|tue|wed|thu|fri|sat)(day)?$/.exec(s);
  if (nextWd) return nextWeekday(base, nextWd[2], true);
  const thisWd = /^(this\s+)?(sun|mon|tue|wed|thu|fri|sat)(day)?$/.exec(s);
  if (thisWd) return nextWeekday(base, thisWd[2], false);
  const nth = /^the\s+(\d{1,2})(st|nd|rd|th)?(\s+of\s+(\w+))?$/.exec(s);
  if (nth) {
    const day = parseInt(nth[1], 10);
    const monthName = nth[4];
    const month = monthName ? monthIndex(monthName) : base.month;
    if (month === null) return null;
    const year = base.year + (month < base.month || (month === base.month && day < base.day) ? 1 : 0);
    return fmt({ year, month, day });
  }
  return null;
}

interface YMD {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
}

function parseISO(s: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

function fmt(y: YMD): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${y.year}-${pad(y.month)}-${pad(y.day)}`;
}

function offsetDays(base: YMD, delta: number): string {
  const d = new Date(Date.UTC(base.year, base.month - 1, base.day));
  d.setUTCDate(d.getUTCDate() + delta);
  return fmt({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

function nextWeekday(base: YMD, name: string, force: boolean): string {
  const target = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(name);
  if (target < 0) return "";
  const baseDate = new Date(Date.UTC(base.year, base.month - 1, base.day));
  const baseDow = baseDate.getUTCDay();
  let diff = target - baseDow;
  if (diff <= 0) diff += 7;
  if (!force && diff === 0) diff = 7;
  return offsetDays(base, diff);
}

function monthIndex(name: string): number | null {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const i = months.indexOf(name.slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
}
