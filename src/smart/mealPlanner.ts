// Render the per-grocery-session Meal Planner note. Takes the dishes
// expanded by the Grocery Smart Note session and produces a sibling
// markdown note that lists them bucketed by meal type (Breakfast,
// Lunch, Dinner, Snack, Dessert, Sides, Baking, Fondue, Pizza, Other).
//
// Ranch Dishes (which live under Menu Items.md's ## Ranch Dishes
// section) are folded into those meal-type buckets by ID prefix:
// B→Breakfast, L→Lunch, D→Dinner, DS→Dessert, SD→Sides, S→Snack.
// Ranch is never a section header on the planner — the fold-in is
// planner-only; Menu Items.md and other notes keep "Ranch Dishes".
//
// Each dish gets a Recipe wikilink pointing at [[Recipes#<ID>]], so
// Kevin's separate persistent Recipes note is the home for the actual
// cooking instructions. The planner is a quick weekly reference.
//
// Pure logic — no Obsidian imports — so tests drive it directly.

import { formatIngredient, type MenuItem } from "./menuItems";

export const MEAL_TYPE_ORDER = [
  "Breakfast",
  "Lunch",
  "Dinner",
  "Snack",
  "Dessert",
  "Sides",
  "Baking",
  "Fondue",
  "Pizza",
  "Other",
] as const;

export type MealType = (typeof MEAL_TYPE_ORDER)[number];

const CANONICAL_MEAL_TYPES = new Set<string>(MEAL_TYPE_ORDER);

// Ranch Dishes section uses category-prefixed IDs. Longest-first so
// DS beats D and SD beats S.
const RANCH_PREFIX_TO_MEAL_TYPE: ReadonlyArray<[string, MealType]> = [
  ["DS", "Dessert"],
  ["SD", "Sides"],
  ["B", "Breakfast"],
  ["L", "Lunch"],
  ["D", "Dinner"],
  ["S", "Snack"],
];

// Match a Menu Items.md section name (or a section-ish synonym) to a
// canonical meal type when it is one of ours. "Side" (singular, from
// the ID-prefix map) also resolves to "Sides".
function sectionToMealType(section: string): MealType | null {
  const s = section.trim();
  if (!s) return null;
  if (CANONICAL_MEAL_TYPES.has(s)) return s as MealType;
  if (s === "Side") return "Sides";
  return null;
}

function ranchPrefixMealType(id: string): MealType | null {
  const upper = id.toUpperCase();
  for (const [prefix, meal] of RANCH_PREFIX_TO_MEAL_TYPE) {
    if (upper.startsWith(prefix) && /^\d+$/.test(upper.slice(prefix.length))) {
      return meal;
    }
  }
  return null;
}

// Decide which meal-type bucket a dish lands in on the planner.
//
// Precedence:
//   1. The dish's Menu Items.md section, if it is already a canonical
//      meal type (Breakfast / Lunch / Dinner / Snack / Dessert /
//      Sides / Baking / Fondue / Pizza).
//   2. For dishes in the "Ranch Dishes" section, the ID prefix
//      (DS/SD/B/L/D/S) decides.
//   3. Otherwise "Other".
export function mealTypeFor(dish: MenuItem): MealType {
  // 0. An explicit Meal column on the row wins (2026-10-24).
  const byColumn = sectionToMealType(dish.meal ?? "");
  if (byColumn) return byColumn;
  const bySection = sectionToMealType(dish.section);
  if (bySection) return bySection;
  if (/^ranch/i.test(dish.section.trim())) {
    const byPrefix = ranchPrefixMealType(dish.id);
    if (byPrefix) return byPrefix;
  }
  return "Other";
}

export interface MealPlannerArtifact {
  body: string;
  suggestedBasename: string;
  // Vault folder the planner note should land in, independent of
  // the Grocery note's folder. Null → fall back to the main note's
  // folder (preserves pre-routing behaviour).
  folder: string | null;
}

export const DEFAULT_MEAL_PLANNER_FOLDER = "Health HUB/Meal Planning";
export const RECIPES_NOTE_PATH = "Health HUB/Recipes";

export interface MealPlannerOptions {
  /** The grocery session's period answer ("10/24 - 10/27", "2 weeks"); drives the schedule grid. */
  period?: string;
  /** Vault path (no .md) of the sibling grocery note, for the Links section. */
  groceryNotePath?: string;
}

export function renderMealPlanner(
  dishes: readonly MenuItem[],
  todayISO: string,
  opts: MealPlannerOptions = {},
): MealPlannerArtifact {
  const title = `Meal Planner — ${todayISO}`;
  const bucketed = bucket(dishes);
  const sections = MEAL_TYPE_ORDER.filter((m) => bucketed.get(m)?.length);
  const period = (opts.period ?? "").trim();

  const header = [
    "---",
    "tags: [meal-planner]",
    `created: ${todayISO}`,
    `period: ${period ? JSON.stringify(period) : '""'}`,
    "meals:",
    ...dishes.map((d) => `  - ${d.id}`),
    "---",
    "",
    `# ${title}`,
    "",
    "",
  ].join("\n");

  const summary = renderSummary(sections, bucketed);
  const schedule = renderSchedule(bucketed, periodDays(period, todayISO));
  const body = sections.map((m) => renderSection(m, bucketed.get(m)!)).join("\n");
  const links = [
    "## Links",
    ...(opts.groceryNotePath ? [`- [[${opts.groceryNotePath}|Grocery List]]`] : []),
    "- [[Reference HUB/Menu Items|Menu Items]]",
    `- [[${RECIPES_NOTE_PATH}|Recipes]]`,
    "",
  ].join("\n");
  const content = `${header}${summary}\n${schedule}\n${body}\n${links}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  return { body: content, suggestedBasename: title, folder: DEFAULT_MEAL_PLANNER_FOLDER };
}

// -- Schedule grid ------------------------------------------------
//
// Turns the period answer into a list of day labels, then spreads each
// meal-type bucket evenly across those days. It is a starting layout for
// Kevin to rearrange in Obsidian, not an assignment.

export interface PeriodDays {
  labels: string[];      // "Fri 10/24" … or "Day 1" …
  parsed: boolean;       // false → defaulted to 7 days
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function periodDays(period: string, todayISO: string): PeriodDays {
  const p = period.trim().toLowerCase();
  const start = new Date(`${todayISO}T00:00:00`);
  const fromToday = (n: number): PeriodDays => {
    const labels: string[] = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      labels.push(dayLabel(d));
    }
    return { labels, parsed: true };
  };
  // "10/24 - 10/27", "10/24-10/27", "10/24 to 10/27", "10/24 through 11/2"
  const range = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:-|–|—|to|through|thru)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(p);
  if (range) {
    const y = start.getFullYear();
    const y1 = range[3] ? normYear(range[3], y) : y;
    const y2 = range[6] ? normYear(range[6], y1) : y1;
    const a = new Date(y1, parseInt(range[1], 10) - 1, parseInt(range[2], 10));
    let b = new Date(y2, parseInt(range[4], 10) - 1, parseInt(range[5], 10));
    if (b < a) b = new Date(y2 + 1, b.getMonth(), b.getDate());
    const n = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
    if (n >= 1 && n <= 31) {
      const labels: string[] = [];
      for (let i = 0; i < n; i++) {
        const d = new Date(a);
        d.setDate(a.getDate() + i);
        labels.push(dayLabel(d));
      }
      return { labels, parsed: true };
    }
  }
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const n = /(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(day|days|week|weeks|wk|wks)\b/.exec(p);
  if (n) {
    const count = /^\d+$/.test(n[1]) ? parseInt(n[1], 10) : words[n[1]];
    const days = /week|wk/.test(n[2]) ? count * 7 : count;
    if (days >= 1 && days <= 31) return fromToday(days);
  }
  if (/\bweekend\b/.test(p)) return fromToday(3);
  const d7 = fromToday(7);
  return { labels: d7.labels, parsed: false };
}

function normYear(s: string, fallback: number): number {
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return s.length === 2 ? 2000 + n : n;
}

function dayLabel(d: Date): string {
  return `${DOW[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

// Columns: Breakfast / Lunch / Dinner always, plus any other bucket
// that has dishes. Dish i of a bucket with n dishes lands on day
// floor(i * days / n), so 5 dinners over 14 days fall on days
// 0, 2, 5, 8, 11.
export function renderSchedule(bucketed: ReadonlyMap<MealType, MenuItem[]>, days: PeriodDays): string {
  const cols: MealType[] = ["Breakfast", "Lunch", "Dinner"];
  for (const m of MEAL_TYPE_ORDER) {
    if (!cols.includes(m) && (bucketed.get(m)?.length ?? 0) > 0) cols.push(m);
  }
  const grid: string[][] = days.labels.map(() => cols.map(() => ""));
  for (let c = 0; c < cols.length; c++) {
    const list = bucketed.get(cols[c]) ?? [];
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const day = Math.min(days.labels.length - 1, Math.floor((i * days.labels.length) / n));
      const cell = grid[day][c];
      grid[day][c] = cell ? `${cell}<br>${list[i].id}` : list[i].id;
    }
  }
  const out: string[] = ["## Schedule", ""];
  out.push(days.parsed ? "Starting layout — drag dishes between days as you like." : "No period given — laid out over 7 days; move dishes as you like.");
  out.push("");
  out.push(`| Day | ${cols.join(" | ")} |`);
  out.push(`|---|${cols.map(() => "---").join("|")}|`);
  days.labels.forEach((label, r) => out.push(`| ${label} | ${grid[r].join(" | ")} |`));
  out.push("");
  return out.join("\n");
}

function bucket(dishes: readonly MenuItem[]): Map<MealType, MenuItem[]> {
  const out = new Map<MealType, MenuItem[]>();
  for (const m of MEAL_TYPE_ORDER) out.set(m, []);
  for (const d of dishes) {
    const t = mealTypeFor(d);
    out.get(t)!.push(d);
  }
  // Stable per-section order: by numeric suffix when IDs share a
  // prefix, else by ID string.
  for (const list of out.values()) list.sort(compareDishIds);
  return out;
}

function compareDishIds(a: MenuItem, b: MenuItem): number {
  const ap = idParts(a.id);
  const bp = idParts(b.id);
  if (ap.prefix !== bp.prefix) return ap.prefix.localeCompare(bp.prefix);
  return ap.num - bp.num;
}

function idParts(id: string): { prefix: string; num: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(id.toUpperCase());
  if (!m) return { prefix: id, num: 0 };
  return { prefix: m[1], num: parseInt(m[2], 10) };
}

function renderSummary(
  sections: readonly MealType[],
  bucketed: ReadonlyMap<MealType, MenuItem[]>,
): string {
  const lines = ["## Dishes"];
  for (const m of sections) {
    for (const d of bucketed.get(m)!) {
      lines.push(`- ${d.id} — ${d.dish}`);
    }
  }
  return lines.join("\n") + "\n";
}

// The heading text Recipes.md uses for a dish; must match exactly for
// Obsidian's #heading link to resolve. Kept in one place.
export function recipeHeading(d: { id: string; dish: string }): string {
  return `${d.id} — ${d.dish}`.replace(/[#|[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function renderSection(meal: MealType, dishes: readonly MenuItem[]): string {
  const parts = [`## ${meal}`, ""];
  for (const d of dishes) {
    parts.push(`### ${d.id} — ${d.dish}`);
    parts.push(`Recipe: [[${RECIPES_NOTE_PATH}#${recipeHeading(d)}|${d.id}]]`);
    if (d.ingredients.length > 0) {
      for (const ing of d.ingredients) {
        parts.push(`- ${formatIngredient(ing)}`);
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}
