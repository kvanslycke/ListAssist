// Deterministic grocery list builder for Smart Note's Grocery mode.
//
// Menu-derived ingredients never pass through the LLM any more. The
// 2026-10-16 list showed why: handed "preserve quantity text" lines,
// gemma4 rewrote names ("1 whole, sliced yellow onion"), duplicated
// eggs/flour/butter, dropped arborio rice and put kielbasa in Bakery.
// This module does the whole job in code:
//
//   1. clean each ingredient name (prep words, parentheticals, trailing
//      qualifiers like "for frying"),
//   2. convert to a store unit via Grocery Units.md and MERGE by the
//      table's canonical row, so "1 stick butter" + "2 tbsp butter"
//      + "3 tbsp lard or butter" become one butter line,
//   3. drop STAPLE rows, including partial matches on a staple alias
//      ("salt and pepper" → the "salt and black pepper" row),
//   4. assign a department from the table's Department column, else a
//      small keyword table, else the catch-all section,
//   5. annotate each line with the dish IDs it came from.
//
// The LLM sees only the free-text remainder of the utterance (extra
// items, meal names when that toggle is on).

import type { Ingredient } from "./menuItems";
import {
  convertIngredient,
  formatStoreLine,
  lookupRow,
  normalizeName,
  normalizeUnit,
  type GroceryUnitIndex,
  type GroceryUnitRow,
} from "./groceryUnits";

export interface SourcedIngredient extends Ingredient {
  /** Menu Items ID the ingredient came from ("" for ad-hoc). */
  sourceId: string;
}

export interface GroceryItem {
  /** Display line without the origin suffix, e.g. "1 dozen eggs". */
  line: string;
  /** Department name without emoji, e.g. "Dairy & Refrigerated". */
  department: string;
  /** Dish IDs in first-seen order. */
  sources: string[];
  /** True when the line came from a Grocery Units row (store unit). */
  fromTable: boolean;
}

export const DEFAULT_DEPARTMENT = "Bakery & Pantry";

export const DEPARTMENTS = [
  "Produce",
  "Meat & Seafood",
  "Dairy & Refrigerated",
  "Bakery & Pantry",
  "Frozen",
  "Snacks & Household",
  "Pets & Ranch",
] as const;

// -- Name cleaning ------------------------------------------------

// Prep / state words that describe what you do to the ingredient, not
// what you buy. Removed wherever they appear as whole words.
const PREP_WORDS = [
  "sliced", "diced", "chopped", "minced", "melted", "beaten", "grated",
  "crushed", "cubed", "shredded", "finely", "thinly", "roughly", "coarsely",
  "fresh", "freshly", "peeled", "seeded", "halved", "quartered", "trimmed",
  "pounded", "softened", "cooked", "uncooked", "dry", "dried",
  "lightly", "large", "medium",
  "small", "ripe", "boneless", "skinless",
];
const PREP_RE = new RegExp(`\\b(?:${PREP_WORDS.join("|")})\\b`, "gi");
// Trailing purpose clauses: "for frying", "for serving", "to garnish".
const PURPOSE_RE = /\b(?:for|to)\s+(?:(?:deep[- ]|pan[- ]|shallow[- ])?frying|serving|garnish(?:ing)?|dusting|greasing|brushing|drizzling|the pan|taste)\b.*$/i;

// Units in older Menu Items cells carry prep text: "whole, sliced",
// "oz, finely diced", "tbsp for frying", "oz (2 whole, pounded thin)".
// Keep only the leading unit word(s).
export function cleanUnit(unit: string): string {
  const u = unit.replace(/\([^)]*\)/g, " ").split(/[,;]/)[0].replace(PURPOSE_RE, " ").trim();
  return u.split(/\s+/)[0]?.toLowerCase() ?? "";
}

// Volume and weight families, in cups and ounces, so a 2 tbsp sugar
// line joins the "sugar | bag | 10 | cup" row instead of standing alone.
const TO_CUP: Record<string, number> = { tsp: 1 / 48, tbsp: 1 / 16, cup: 1, pint: 2, quart: 4, gallon: 16, "fl oz": 1 / 8 };
const TO_OZ: Record<string, number> = { oz: 1, lb: 16 };
export function convertUnitQty(qty: number, from: string, to: string): number | null {
  if (from === to) return qty;
  if (from in TO_CUP && to in TO_CUP) return (qty * TO_CUP[from]) / TO_CUP[to];
  if (from in TO_OZ && to in TO_OZ) return (qty * TO_OZ[from]) / TO_OZ[to];
  return null;
}

export function cleanIngredientName(name: string): string {
  let s = name;
  s = s.replace(/\([^)]*\)/g, " ");          // parentheticals
  s = s.replace(PURPOSE_RE, " ");
  s = s.replace(PREP_RE, " ");
  s = s.replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, "");
  s = s.replace(/\s*,\s*/g, " ");             // "whole, sliced onion" → "whole sliced onion" → cleaned above
  s = s.replace(/\s{2,}/g, " ").trim();
  // "boneless skinless" may leave a bare "or" at an edge.
  s = s.replace(/^(?:or|and)\s+|\s+(?:or|and)$/gi, "").trim();
  return s.length > 0 ? s : name.trim();
}

// -- Department keyword fallback --------------------------------

const KEYWORDS: Array<[department: (typeof DEPARTMENTS)[number], re: RegExp]> = [
  // Pantry first: "chicken broth", "cream of mushroom soup" and
  // "garlic powder" are shelf items, not meat/dairy/produce.
  ["Bakery & Pantry", /\b(broth|stock|bouillon|soup|sauce|marinara|salsa|paste|puree|canned|can of|jarred|flour|sugar|syrup|honey|rice|pasta|penne|spaghetti|noodle|bread|brioche|sourdough|bun|roll|tortilla|crepe|cracker|oil|vinegar|spice|seasoning|powder|extract|baking|cornstarch|breadcrumb|panko|oats|oatmeal|cereal|bean|lentil|chickpea|peanut butter|jam|jelly|mix|wine|cider|coffee|tea|water|juice)\b/i],
  ["Pets & Ranch", /\b(dog|puppy|kibble|dog food|dog treat|flapjack|kingston|ranch supply|hay|feed)\b/i],
  ["Snacks & Household", /\b(paper towel|toilet paper|foil|aluminum|parchment|plastic wrap|ziploc|trash bag|garbage bag|soap|detergent|sponge|toothpick|skewer|napkin|cleaner|bleach|dishwasher|chips|crackers|pretzel|popcorn|candy|cookie|granola bar)\b/i],
  ["Frozen", /\b(frozen|ice cream|waffles|tater tots|hash browns|fries)\b/i],
  ["Meat & Seafood", /\b(chicken|beef|steak|pork|sausage|kielbasa|chorizo|bratwurst|brat|bacon|ham|prosciutto|salami|pepperoni|lamb|turkey|shrimp|salmon|cod|tilapia|halibut|trout|fish|scallop|crab|lobster|deli meat|ground round|roast|ribs|cutlet|tenderloin|loin|brisket|meatball|hot dog)\b/i],
  ["Dairy & Refrigerated", /\b(milk|cream|half and half|butter|cheese|cheddar|mozzarella|parmesan|swiss|feta|ricotta|gouda|provolone|monterey jack|jack|brie|yogurt|egg|eggs|sour cream|cream cheese|cottage|buttermilk|whipped|crescent|biscuit dough|pizza dough|pie crust|hummus|tofu|lard)\b/i],
  ["Produce", /\b(onion|garlic|shallot|leek|scallion|green onion|chive|pepper|jalape[nñ]o|poblano|chile|chili|lettuce|romaine|spinach|kale|arugula|cabbage|broccoli|cauliflower|carrot|celery|potato|yam|squash|zucchini|pumpkin|cucumber|tomato|avocado|mushroom|corn|peas|green bean|asparagus|beet|radish|turnip|parsnip|ginger|herb|cilantro|parsley|basil|dill|rosemary|thyme|oregano|mint|sage|lemon|lime|orange|apple|banana|berry|berries|grape|melon|peach|pear|plum|cherry|mango|pineapple|papaya|kiwi|fruit|salad|slaw|sprouts|fennel|eggplant|okra|artichoke)\b/i],
];

export function departmentFor(name: string, row: GroceryUnitRow | null, departmentsInTemplate: readonly string[]): string {
  const inTemplate = (d: string): boolean => departmentsInTemplate.some((t) => sameDepartment(t, d));
  if (row && row.department && inTemplate(row.department)) return canonicalDepartment(row.department, departmentsInTemplate);
  // Match singular keywords against plural names ("paper towels",
  // "green chiles") by testing a de-pluralized copy as well.
  const variants = [name, name.replace(/(\w)s\b/g, "$1"), name.replace(/(\w)es\b/g, "$1")];
  for (const [dept, re] of KEYWORDS) {
    if (variants.some((v) => re.test(v)) && inTemplate(dept)) return canonicalDepartment(dept, departmentsInTemplate);
  }
  if (inTemplate(DEFAULT_DEPARTMENT)) return canonicalDepartment(DEFAULT_DEPARTMENT, departmentsInTemplate);
  return departmentsInTemplate[0] ?? DEFAULT_DEPARTMENT;
}

// Template headings carry emoji ("🥑 Produce"); the table and the
// keyword map do not. Compare on letters/&/digits only.
export function departmentKey(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function sameDepartment(a: string, b: string): boolean {
  return departmentKey(a) === departmentKey(b);
}
function canonicalDepartment(dept: string, departmentsInTemplate: readonly string[]): string {
  return departmentsInTemplate.find((t) => sameDepartment(t, dept)) ?? dept;
}

// -- Staple detection beyond exact row match --------------------

function isStapleByAlias(cleanName: string, index: GroceryUnitIndex): boolean {
  const norm = normalizeName(cleanName);
  const words = norm.split(/\s+/);
  for (const r of index.rows) {
    if (!r.isStaple) continue;
    const names = [normalizeName(r.ingredient), ...r.aliases];
    for (const n of names) {
      if (!n) continue;
      if (n === norm) return true;
      // Whole-phrase containment, both directions: "salt and pepper"
      // ⊂ "salt and black pepper" alias set, "kosher salt" ⊃ "salt".
      if (n.length >= 4 && new RegExp(`(^|\\s)${escapeRe(n)}(\\s|$)`).test(norm)) return true;
      if (norm.length >= 4 && n.includes(" ") && new RegExp(`(^|\\s)${escapeRe(norm)}(\\s|$)`).test(n)) return true;
    }
    void words;
  }
  return false;
}
// Name-only match on a non-staple row, any recipe unit. Used when the
// unit differs from the row's ("sugar: 2 tbsp" vs a "cup" row).
function lookupRowByName(index: GroceryUnitIndex, cleanName: string): GroceryUnitRow | null {
  const norm = normalizeName(cleanName);
  for (const r of index.rows) {
    if (r.isStaple) continue;
    if (normalizeName(r.ingredient) === norm || r.aliases.includes(norm)) return r;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -- Build ------------------------------------------------------

interface Acc {
  row: GroceryUnitRow | null;
  // Table rows: per recipe unit, summed recipe qty (so 2 tbsp + 6 tbsp
  // butter → ceil(8/8) = 1 stick, not 1 + 1 = 2).
  recipeQtyByUnit: Map<string, number>;
  // Unmatched rows: numeric sum per unit, plus free-form strings.
  freeform: Set<string>;
  displayName: string;
  sources: string[];
}

export function buildGroceryItems(
  ingredients: readonly SourcedIngredient[],
  index: GroceryUnitIndex | null,
  departmentsInTemplate: readonly string[],
): GroceryItem[] {
  const accs = new Map<string, Acc>();
  const order: string[] = [];

  for (const raw of ingredients) {
    const cleanName = cleanIngredientName(raw.name);
    const unitClean = raw.quantityNumber !== null ? cleanUnit(raw.quantityUnit ?? "") : (raw.quantityUnit ?? "");
    const ing: SourcedIngredient = { ...raw, name: cleanName, quantityUnit: unitClean };
    let row: GroceryUnitRow | null = null;
    if (index) {
      const conv = convertIngredient(ing, index);
      if (conv.staple) continue;
      row = conv.row ?? lookupRow(index, cleanName, unitClean) ?? lookupRow(index, raw.name, unitClean) ?? lookupRowByName(index, cleanName);
      if (!row && isStapleByAlias(cleanName, index)) continue;
      if (row && row.isStaple) continue;
    }
    const unitKey = unitClean.toLowerCase().trim();
    const key = row ? `T|${normalizeName(row.ingredient)}` : `R|${normalizeName(cleanName)}|${unitKey}`;
    let acc = accs.get(key);
    if (!acc) {
      acc = { row, recipeQtyByUnit: new Map(), freeform: new Set(), displayName: cleanName, sources: [] };
      accs.set(key, acc);
      order.push(key);
    }
    if (ing.quantityNumber !== null) {
      let u = unitKey;
      let q = ing.quantityNumber;
      if (row) {
        const conv = convertUnitQty(q, normalizeUnit(unitKey), row.recipeUnit);
        if (conv !== null) {
          u = row.recipeUnit;
          q = conv;
        }
      }
      acc.recipeQtyByUnit.set(u, (acc.recipeQtyByUnit.get(u) ?? 0) + q);
    } else if (ing.quantityUnit && ing.quantityUnit.trim()) {
      acc.freeform.add(ing.quantityUnit.trim());
    }
    if (ing.sourceId && !acc.sources.includes(ing.sourceId)) acc.sources.push(ing.sourceId);
  }

  const out: GroceryItem[] = [];
  for (const key of order) {
    const acc = accs.get(key)!;
    let line: string;
    if (acc.row) {
      // Sum store-unit counts across recipe units (each unit's total
      // rounded up on its own; only the row's own recipe unit converts
      // by size, any other unit counts 1 store unit per occurrence).
      let count = 0;
      for (const [u, qty] of acc.recipeQtyByUnit) {
        count += u === acc.row.recipeUnit ? Math.ceil(qty / acc.row.storeUnitSize) : 1;
      }
      if (count === 0) count = 1; // free-form only ("to taste") → one shelf item
      line = formatStoreLine(acc.row, Math.max(1, count));
    } else {
      const parts: string[] = [];
      for (const [u, qty] of acc.recipeQtyByUnit) {
        const unit = u && u !== "whole" ? ` ${u}` : "";
        parts.push(`${formatQty(qty)}${unit}`);
      }
      const qtyText = parts.join(" + ");
      const ff = acc.freeform.size > 0 ? ` (${[...acc.freeform].join(", ")})` : "";
      line = qtyText ? `${qtyText} ${acc.displayName}${ff}` : `${acc.displayName}${ff}`;
    }
    out.push({
      line: line.replace(/\s{2,}/g, " ").trim(),
      department: departmentFor(acc.row?.ingredient ?? acc.displayName, acc.row, departmentsInTemplate),
      sources: acc.sources,
      fromTable: acc.row !== null,
    });
  }
  return out;
}

function formatQty(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

// Final text per item, with optional "(from D9, L19)" suffix.
export function formatGroceryItem(item: GroceryItem, withOrigins: boolean): string {
  if (withOrigins && item.sources.length > 0) return `${item.line} (from ${item.sources.join(", ")})`;
  return item.line;
}

// Merge items into the extracted record the writer consumes
// (section heading → array of item strings). Menu items come first,
// then whatever the LLM extracted from the free-text remainder, with
// exact-duplicate lines dropped.
export function mergeItemsIntoExtracted(
  extracted: Record<string, unknown>,
  items: readonly GroceryItem[],
  sectionHeadings: readonly string[],
  withOrigins: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extracted };
  const bySection = new Map<string, string[]>();
  for (const item of items) {
    const heading = sectionHeadings.find((h) => sameDepartment(h, item.department)) ?? sectionHeadings[0];
    if (!heading) continue;
    const arr = bySection.get(heading) ?? [];
    arr.push(formatGroceryItem(item, withOrigins));
    bySection.set(heading, arr);
  }
  // Every menu line's bare name, so an extra the user names ("milk")
  // that is already covered by a menu line ("1 half-gallon milk") is
  // dropped wherever the model filed it.
  const covered = items.map((i) => bareName(i.line));
  const isCovered = (s: string): boolean => {
    const b = bareName(s);
    if (b.length < 3) return false;
    // "milk" is covered by "whole milk"; "butter" by "butter".
    return covered.some((c) => c === b || new RegExp(`(^|\\s)${escapeRe(b)}(\\s|$)`).test(c));
  };
  for (const heading of sectionHeadings) {
    const mine = bySection.get(heading) ?? [];
    const prev = out[heading];
    const theirs = Array.isArray(prev) ? prev.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const s of mine) {
      const k = s.trim().toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(s.trim());
    }
    for (const s of theirs) {
      const k = s.trim().toLowerCase();
      if (seen.has(k) || isCovered(s)) continue;
      seen.add(k);
      merged.push(s.trim());
    }
    if (merged.length > 0) out[heading] = merged;
    else delete out[heading];
  }
  return out;
}

// "1 half-gallon milk (from B26)" → "milk"; "2 sticks butter" → "butter";
// "milk" → "milk". Strips a leading quantity + unit word, the origin
// suffix, and a plural "s".
export function bareName(line: string): string {
  let s = line.replace(/\s*\(from [^)]*\)\s*$/i, "").trim().toLowerCase();
  s = s.replace(/^\d+(?:\.\d+)?\s*(?:\+\s*\d+(?:\.\d+)?\s*)*/, "");
  s = s.replace(/^(?:cups?|tbsps?|tsps?|oz|lbs?|cans?|jars?|packets?|packs?|boxe?s?|bags?|bottles?|slices?|cloves?|heads?|stalks?|bunch(?:es)?|pints?|quarts?|dozen|sticks?|tubs?|blocks?|cartons?|loa(?:f|ves)|half-gallons?|gallons?|pieces?|sheets?|wheels?|whole)\s+/, "");
  s = s.replace(/\s+/g, " ").trim();
  return normalizeName(s);
}

// Grocery notes: remove the template's empty "- [ ] " placeholder lines
// so an unused department reads as an empty heading, not a blank box.
export function stripEmptyCheckboxes(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*-\s+\[\s*\]\s*$/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
