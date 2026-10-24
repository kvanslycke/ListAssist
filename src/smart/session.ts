// Smart Note session: the state machine that coordinates template
// pick -> capture -> extract -> follow-up -> review -> write.
//
// Everything in this file is pure except where it calls an injected
// LLM client (ollamaClient-compatible). The obsidian-side modal is a
// thin shell over these functions.

import { classifyTemplate, type TemplateSchema, type ClassifiedField } from "./templateSchema";
import { renderNote, type RenderResult } from "./writer-core";
import { suggestFolder, tripPackingFolder, type RoutingResult } from "./router";
import {
  expandIds,
  extractMenuIds,
  formatIngredient,
  stripMenuIdsFromUtterance,
  type ExpansionResult,
  type Ingredient,
  type MenuIndex,
} from "./menuItems";
import {
  convertIngredient,
  type GroceryUnitIndex,
} from "./groceryUnits";
import {
  buildGroceryItems,
  mergeItemsIntoExtracted,
  stripEmptyCheckboxes,
  type GroceryItem,
  type SourcedIngredient,
} from "./groceryList";
import { renderMealPlanner, type MealPlannerArtifact } from "./mealPlanner";
import {
  createTodoLoop,
  parseLlmSubtasks,
  SUBTASK_FORMAT,
  SUBTASK_SYSTEM_PROMPT,
  type TodoLoopSession,
} from "./todoLoop";

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
  kind: "ask-field" | "gap" | "grocery-extras";
  field?: string;         // present for ask-field
  prompt: string;
}

export const GROCERY_EXTRAS_PROMPT =
  "Anything else not from the menu? Name items for Produce, Meat, Dairy, Pantry, Household or Pets/Ranch (or Skip).";

export type SessionKind = "default" | "todo-loop";

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
  warnings: string[];
  menuExpansion: ExpansionResult | null;
  // Grocery: the deterministic, merged, department-sorted items built
  // from the expanded menu IDs (never seen by the LLM).
  groceryItems: GroceryItem[];
  // Grocery: append "(from D9, L19)" to each menu-derived line.
  groceryOrigins: boolean;
  // The To-Do List template drives a multi-note loop instead of the
  // one-note extract/review flow. Non-null only when kind is
  // "todo-loop".
  kind: SessionKind;
  todoLoop: TodoLoopSession | null;
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
    warnings: [],
    menuExpansion: null,
    groceryItems: [],
    groceryOrigins: true,
    kind: "default",
    todoLoop: null,
  };
}

export function isTodoListTemplate(templateBasename: string): boolean {
  return /^to-?do list(?:\s+template)?$/i.test(templateBasename.trim());
}

// Ask the local model to break a task title into 1–5 simple
// sub-actions. Called from the To-Do loop when the user skipped the
// subtasks step. Every failure mode (chat throws, model returns [],
// parse rejects garbage) collapses to [] so the renderer falls back
// to a single `- [ ] <title>` body. The caller stores the result on
// draft.llmSubtasks before rendering.
export async function expandTaskSubtasks(
  chat: ChatFn,
  title: string,
): Promise<string[]> {
  try {
    const res = await chat({
      messages: [
        { role: "system", content: SUBTASK_SYSTEM_PROMPT },
        { role: "user", content: `TASK TITLE: ${title}` },
      ],
      format: SUBTASK_FORMAT,
    });
    return parseLlmSubtasks(res.parsed);
  } catch {
    return [];
  }
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
  const kind: SessionKind = isTodoListTemplate(pick.primary.basename) ? "todo-loop" : "default";
  return {
    session: {
      ...session,
      state: "awaitCapture",
      template: pick.primary,
      schema: classifyTemplate(pick.primary.raw),
      kind,
      todoLoop: kind === "todo-loop" ? createTodoLoop() : null,
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

export interface CaptureOptions {
  expandMeals?: boolean;              // Grocery-only: expand named meals into ingredients via the LLM
  expandMenuNumbers?: boolean;        // Grocery-only: expand menu IDs via Reference HUB/Menu Items.md
  menuIndex?: MenuIndex | null;       // required when expandMenuNumbers is true
  groceryUnits?: GroceryUnitIndex | null; // optional; Grocery-only: translate recipe units into store purchase units + drop staples
  groceryOrigins?: boolean;           // Grocery-only: "(from D9, L19)" suffix on menu-derived lines (default true)
  askGroceryExtras?: boolean;         // Grocery-only: queue the "anything else?" follow-up after menu expansion (default true)
}

export async function submitCapture(
  session: SessionState,
  transcript: string,
  opts: CaptureOptions = {},
): Promise<SessionState> {
  if (!session.template || !session.schema) {
    return { ...session, state: "error", error: "No template selected" };
  }
  const base = { ...session, transcript, state: "extract" as State };
  const warnings: string[] = [];
  let menuExpansion: ExpansionResult | null = null;
  let groceryItems: GroceryItem[] = [];
  let promptTranscript = transcript;
  const isGrocery = /grocery/i.test(session.template.basename);
  const groceryOrigins = opts.groceryOrigins ?? session.groceryOrigins ?? true;
  const sectionHeadings = session.schema.bodySections.map((s) => s.heading);

  if (opts.expandMenuNumbers === true && opts.menuIndex) {
    const ids = extractMenuIds(transcript);
    if (ids.length > 0) {
      menuExpansion = expandIds(ids, opts.menuIndex);
      for (const id of menuExpansion.missingIds) {
        warnings.push(`Menu ID ${id} not found in Reference HUB/Menu Items.md`);
      }
      for (const id of menuExpansion.unfilledIds) {
        warnings.push(`Menu ID ${id} has no ingredients filled in yet`);
      }
      // Deterministic path: clean → convert → merge → department, in
      // code. The model never sees these lines (it used to rewrite,
      // duplicate and drop them).
      groceryItems = buildGroceryItems(
        sourcedIngredients(menuExpansion),
        opts.groceryUnits ?? null,
        sectionHeadings,
      );
      // Only the free-text remainder (extra items, ad-hoc meals) goes
      // to the model. Nothing left → no model call at all.
      promptTranscript = stripMenuIdsFromUtterance(transcript);
    }
  }

  try {
    let extracted: Record<string, unknown> = {};
    // "D22 and D43" leaves "and" after the IDs are stripped; connector
    // words alone are not content.
    const remainderHasContent = /[a-z0-9]/i.test(
      promptTranscript.replace(/\b(?:and|plus|also|then|with|too|please|menu|number|numbers|dishes?)\b/gi, ""),
    );
    if (remainderHasContent) {
      const prompt = buildExtractionPrompt(
        session.schema,
        promptTranscript,
        session.template.basename,
        opts,
      );
      const resp = await session.deps.chat(prompt);
      extracted = asRecord(resp.parsed);
    }
    if (groceryItems.length > 0) {
      extracted = mergeItemsIntoExtracted(extracted, groceryItems, sectionHeadings, groceryOrigins);
    }
    const queue = buildInitialFollowUpQueue(session.schema, extracted, session.deps.maxFollowUps ?? 3);
    if (isGrocery && menuExpansion && menuExpansion.found.length > 0 && (opts.askGroceryExtras ?? true)) {
      queue.push({ kind: "grocery-extras", prompt: GROCERY_EXTRAS_PROMPT });
    }
    return {
      ...base,
      extracted,
      followUps: queue,
      state: queue.length > 0 ? "followUp" : "review",
      warnings,
      menuExpansion,
      groceryItems,
      groceryOrigins,
    };
  } catch (e) {
    return { ...base, state: "error", error: (e as Error).message, warnings, menuExpansion, groceryItems, groceryOrigins };
  }
}

// Re-walk the found dishes so every ingredient carries its dish ID.
// (expandIds sums across dishes and loses provenance; we need it for
// the "(from …)" annotation and for merging by canonical row.)
function sourcedIngredients(exp: ExpansionResult): SourcedIngredient[] {
  const out: SourcedIngredient[] = [];
  for (const dish of exp.found) {
    for (const ing of dish.ingredients) out.push({ ...ing, sourceId: dish.id });
  }
  return out;
}

// The "anything else?" follow-up: classify the answer with the model
// (same classifier prompt, no menu lines) and merge into the sections.
// Async because it talks to Ollama; the view calls this instead of
// answerFollowUp when the head of the queue is kind "grocery-extras".
export async function answerGroceryExtras(
  session: SessionState,
  answer: string,
  opts: CaptureOptions = {},
): Promise<SessionState> {
  if (session.state !== "followUp" || !session.template || !session.schema) return session;
  const current = session.followUps[0];
  if (!current || current.kind !== "grocery-extras") return answerFollowUp(session, answer);
  const rest = session.followUps.slice(1);
  const asked = session.followUpsAsked + 1;
  const trimmed = answer.trim();
  if (!trimmed || /^(skip|none|no|nothing|nope|done)\.?$/i.test(trimmed)) {
    return { ...session, followUps: rest, followUpsAsked: asked, state: rest.length === 0 ? "review" : "followUp" };
  }
  try {
    const prompt = buildExtractionPrompt(session.schema, trimmed, session.template.basename, {
      ...opts,
      expandMenuNumbers: false,
    });
    const resp = await session.deps.chat(prompt);
    const more = asRecord(resp.parsed);
    const extracted = mergeSectionArrays(session.extracted, more, session.schema.bodySections.map((s) => s.heading));
    return { ...session, extracted, followUps: rest, followUpsAsked: asked, state: rest.length === 0 ? "review" : "followUp" };
  } catch (e) {
    return { ...session, state: "error", error: (e as Error).message };
  }
}

// Section arrays append (dedupe exact lines); scalar fields follow the
// usual non-empty-wins rule.
function mergeSectionArrays(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  sectionHeadings: readonly string[],
): Record<string, unknown> {
  const out = mergeExtracted(prev, next);
  for (const h of sectionHeadings) {
    const a = Array.isArray(prev[h]) ? (prev[h] as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const b = Array.isArray(next[h]) ? (next[h] as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (a.length === 0 && b.length === 0) continue;
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const s of [...a, ...b]) {
      const t = s.trim();
      if (!t || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      merged.push(t);
    }
    out[h] = merged;
  }
  return out;
}

// Format the summed ingredients as the prompt lines the LLM sees for
// Grocery mode. Rules:
//   - Staples (olive oil, salt, cooking spray, …) are dropped entirely.
//   - Ingredients present in Grocery Units.md emit the store-unit line
//     ("1 dozen eggs", "1 bunch broccoli").
//   - Ingredients NOT in the table fall back to the recipe-raw format
//     ("3 lb chicken breast", "0.25 cup diced bell pepper").
//   - Free-form quantities ("to taste") always fall through.
// Exported for tests; also used from submitCapture above.
export function formatForGroceryPrompt(
  ingredients: readonly Ingredient[],
  groceryUnits: GroceryUnitIndex | null,
): string[] {
  const out: string[] = [];
  for (const ing of ingredients) {
    if (groceryUnits) {
      const conv = convertIngredient(ing, groceryUnits);
      if (conv.staple) continue;
      if (conv.matched && conv.line) {
        out.push(`- ${conv.line}`);
        continue;
      }
    }
    out.push(`- ${formatIngredient(ing)}`);
  }
  return out;
}

// A template is a "list classifier" when it has multiple body sections
// and most of them are checkbox lists. Those templates get the
// classify-items prompt instead of the strict no-fabrication prompt,
// so the user can just name items without saying what section each
// goes in.
export function isListClassifierTemplate(schema: TemplateSchema): boolean {
  if (schema.bodySections.length < 2) return false;
  let withCheckboxes = 0;
  for (const sec of schema.bodySections) {
    if (/^\s*-\s+\[/m.test(sec.content)) withCheckboxes++;
  }
  return withCheckboxes >= Math.ceil(schema.bodySections.length / 2);
}

// For a list-classifier template, pick a sensible catch-all section
// the model should drop uncertain items into. Grocery => Pantry;
// otherwise fall back to the first section.
function defaultSectionFor(basename: string, sections: readonly string[]): string {
  const name = basename.replace(/\s+Template$/i, "");
  if (name === "Grocery List" && sections.includes("Pantry")) return "Pantry";
  return sections[0] ?? "";
}

export function buildExtractionPrompt(
  schema: TemplateSchema,
  transcript: string,
  templateBasename: string,
  opts: CaptureOptions = {},
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

  // Table-mode: when the template has a table and no body sections,
  // ask the model for an array of row objects whose keys match the
  // table headers. The writer merges each row into the body's first
  // table. Templates with BOTH sections and tables keep the section
  // path and ignore the table (first-table merge is deferred).
  const isTableTemplate = schema.tables.length > 0 && bodySectionNames.length === 0;
  const tableHeaders = isTableTemplate ? schema.tables[0].headers : [];
  if (isTableTemplate) {
    const rowProps: Record<string, unknown> = {};
    for (const h of tableHeaders) rowProps[h] = { type: "string" };
    schemaProps["rows"] = {
      type: "array",
      items: { type: "object", properties: rowProps },
    };
  }

  const format = { type: "object", properties: schemaProps, additionalProperties: false };

  const isClassifier = isListClassifierTemplate(schema);
  const isGrocery = /grocery/i.test(templateBasename);
  const expandMeals = opts.expandMeals === true && isGrocery;
  const defaultSection = defaultSectionFor(templateBasename, bodySectionNames);

  let system: string;
  if (isTableTemplate) {
    system =
      "You help the user build a tabular note from what they say or type. " +
      `The target table's columns are: ${tableHeaders.join(", ")}. ` +
      "For each item or batch the user mentions, return ONE row object under the \"rows\" array. " +
      "Fill only the columns the user actually said; leave the others empty. " +
      "Never invent items or column values. " +
      "Non-table fields (like dates) go in their matching ASK FIELD. " +
      "Never set `priority` or `Priority Level` — those keys are forbidden. " +
      "Return JSON matching the provided schema.";
  } else if (expandMeals) {
    system =
      "You help the user build a grocery list from what they say or type. " +
      `Each item goes into one of these sections: ${bodySectionNames.join(", ")}. ` +
      `If a section is uncertain, put the item under ${defaultSection}. ` +
      "If the user names a meal, dish, or recipe (e.g. \"chicken parmesan\", \"tacos\", \"pot roast for Sunday\"), " +
      "expand it into 4–8 typical ingredients. Keep ingredient names generic (e.g. \"chicken breast\", not a brand/weight). " +
      "Classify each ingredient into a section. " +
      "Never invent ingredients the user did not name or imply through a dish. " +
      "Never duplicate items: if the same ingredient is already listed, do not add it twice. " +
      "Non-item fields (like due dates) go in their matching ASK FIELD. " +
      "Never set `priority` or `Priority Level` — those keys are forbidden. " +
      "Return JSON matching the provided schema.";
  } else if (isClassifier) {
    system =
      "You help the user build a note from what they say or type. " +
      `Each item the user names goes into one of these sections: ${bodySectionNames.join(", ")}. ` +
      `If a section is uncertain, put the item under ${defaultSection}. ` +
      "Never invent items — only use what the user actually said. " +
      "Non-item fields (like due dates) go in their matching ASK FIELD. " +
      "Never set `priority` or `Priority Level` — those keys are forbidden. " +
      "Return JSON matching the provided schema.";
  } else {
    system =
      "You extract structured note content from a spoken or typed description. " +
      "Return JSON that matches the provided schema. Fill fields only with details the user actually said; " +
      "if the user did not mention something, leave that key out. Never invent facts. " +
      "Never set `priority` or `Priority Level` — those keys are forbidden.";
  }

  const user =
    (isTableTemplate ? `TABLE COLUMNS: ${tableHeaders.join(", ")}\n` : "") +
    `TEMPLATE SECTIONS: ${bodySectionNames.join(", ") || "(none)"}\n` +
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
  // Additional notes to write beside the main one. Grocery sessions
  // emit a Meal Planner artifact here; most templates emit none.
  extraArtifacts: MealPlannerArtifact[];
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
  // Grocery: inject a deterministic "## Dishes" section at the top of
  // the body listing the Menu Items IDs the user expanded. This runs
  // after the LLM has filled in Produce/Meat/Pantry/… so the dish
  // reference is always right, regardless of what the model wrote.
  const extraArtifacts: MealPlannerArtifact[] = [];
  if (
    /grocery/i.test(session.template.basename) &&
    session.menuExpansion &&
    session.menuExpansion.found.length > 0
  ) {
    rendered.body = injectDishesSection(rendered.body, session.menuExpansion.found);
    // `meals:` frontmatter lists the dish IDs (the template's `[]`
    // reads as pre-set, so the field resolver never fills it).
    if ("meals" in rendered.frontmatter) {
      rendered.frontmatter.meals = session.menuExpansion.found.map((d) => d.id);
    }
    // And emit the sibling Meal Planner note. Same date, same folder;
    // the writer handles filename collisions independently.
    extraArtifacts.push(renderMealPlanner(session.menuExpansion.found, session.deps.nowISODate()));
  }
  if (/grocery/i.test(session.template.basename)) {
    rendered.body = stripEmptyCheckboxes(rendered.body);
  }
  const folder = suggestFolder({
    templateBasename: session.template.basename,
    folderEnum: opts.folderEnum ?? session.deps.folderEnum ?? [],
    lastUsed: opts.lastUsed ?? session.deps.lastUsedByTemplate?.get(session.template.basename) ?? null,
    modelPick: opts.modelPick ?? null,
  });
  return { rendered, folder, title, extraArtifacts };
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
    case "Inventory": {
      // Prefer a model-supplied title if present; otherwise date-stamped.
      const t = asString(extracted.title);
      if (t) return titleCase(t.slice(0, 80));
      return `Inventory — ${today}`;
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

// Insert "## Dishes\n- ID — Dish\n…" right after the first H1 (so it
// lives above the Produce/Meat/Pantry sections but below the title).
// If no H1, prepend to the body. Idempotent on repeat renders —
// replaces any existing "## Dishes" section.
export function injectDishesSection(body: string, dishes: readonly { id: string; dish: string }[]): string {
  if (dishes.length === 0) return body;
  const lines = dishes.map((d) => `- ${d.id} — ${d.dish}`).join("\n");
  const section = `## Dishes\n${lines}\n`;
  // Strip any existing Dishes section first (idempotency).
  const stripped = body.replace(/(^|\n)## Dishes\n(?:- .+\n?)+/, "$1").replace(/\n{3,}/g, "\n\n");
  const h1 = /(^|\n)# [^\n]+\n/;
  const match = h1.exec(stripped);
  if (match) {
    const insertAt = match.index + match[0].length;
    return stripped.slice(0, insertAt) + "\n" + section + stripped.slice(insertAt);
  }
  return section + "\n" + stripped;
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
