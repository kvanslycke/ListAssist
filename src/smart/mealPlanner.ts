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

export function renderMealPlanner(
  dishes: readonly MenuItem[],
  todayISO: string,
): MealPlannerArtifact {
  const title = `Meal Planner — ${todayISO}`;
  const bucketed = bucket(dishes);
  const sections = MEAL_TYPE_ORDER.filter((m) => bucketed.get(m)?.length);

  const header = [
    "---",
    "tags: [meal-planner]",
    `created: ${todayISO}`,
    "---",
    "",
    `# ${title}`,
    "",
    "",
  ].join("\n");

  const summary = renderSummary(sections, bucketed);
  const body = sections.map((m) => renderSection(m, bucketed.get(m)!)).join("\n");
  const content = `${header}${summary}\n${body}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  return { body: content, suggestedBasename: title, folder: DEFAULT_MEAL_PLANNER_FOLDER };
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

function renderSection(meal: MealType, dishes: readonly MenuItem[]): string {
  const parts = [`## ${meal}`, ""];
  for (const d of dishes) {
    parts.push(`### ${d.id} — ${d.dish}`);
    parts.push(`Recipe: [[Recipes#${d.id}]]`);
    if (d.ingredients.length > 0) {
      for (const ing of d.ingredients) {
        parts.push(`- ${formatIngredient(ing)}`);
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}
