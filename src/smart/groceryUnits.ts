// Translate a summed recipe ingredient (e.g. "4 whole eggs", "2 cup
// chopped broccoli") into the store purchase unit you actually buy
// ("1 dozen eggs", "1 bunch broccoli"). Driven by a vault-side
// Reference HUB/Grocery Units.md table that Kevin can edit in
// Obsidian. Pure logic — no Obsidian imports — so tests drive it
// directly. SmartNoteView reads the file and injects it.
//
// Table shape (markdown; parser is permissive about alignment):
//
//   | Ingredient | Store Unit | Store Unit Size | Recipe Unit | Aliases | Notes |
//   | --- | --- | --- | --- | --- | --- |
//   | broccoli | bunch | 2 | cup | broccoli florets, chopped broccoli | 1 bunch ≈ 2 cups |
//   | eggs | dozen | 12 | whole | egg | |
//   | green chilies | can | 1 | can | green chile | |
//   | salt and black pepper | STAPLE | | | salt, pepper | pantry |
//
// A row whose Store Unit is the literal word "STAPLE" (case-insensitive)
// marks the ingredient as always-on-hand pantry stock — the converter
// returns `{ staple: true }` so the caller can drop it from the output.
//
// Lookup matches on (lowercased, singular-normalized) ingredient OR
// any comma-separated alias, AND recipe-unit synonym match. Unit
// synonyms let a Menu Items entry of "cups" match a Grocery Units row
// of "cup". No match → the caller falls back to the raw formatting
// (never a hard failure).

import type { Ingredient } from "./menuItems";

export interface GroceryUnitRow {
  ingredient: string;           // canonical display name, as it appears in output
  storeUnit: string;            // "bunch" / "dozen" / "can" / "bottle" / ""
  storeUnitSize: number;        // 1 Store Unit = this many Recipe Units
  recipeUnit: string;           // matches Menu Items' quantityUnit (lowercased)
  aliases: string[];            // alternate names (lowercased, singular)
  isStaple: boolean;            // drop from output when true
  notes: string;
  department: string;           // optional "Department" column: store aisle for the deterministic list ("" when absent)
}

export interface GroceryUnitIndex {
  rows: GroceryUnitRow[];
  byLookupKey: Map<string, GroceryUnitRow>;  // "<name>|<unit>" → row
}

export interface ConversionResult {
  /** Line formatted for display, e.g. "1 bunch broccoli". Empty if staple. */
  line: string;
  /** True when the ingredient's row is marked STAPLE — caller should hide it. */
  staple: boolean;
  /** True when the converter looked the ingredient up and emitted a store-unit line. */
  matched: boolean;
  /** The matched table row (null when unmatched). */
  row?: GroceryUnitRow | null;
  /** Store-unit count emitted (0 when unmatched / staple). */
  count?: number;
}

const ROW_RE = /^\s*\|(.+)\|\s*$/;

export function parseGroceryUnits(content: string): GroceryUnitIndex {
  const rows: GroceryUnitRow[] = [];
  const byLookupKey = new Map<string, GroceryUnitRow>();
  const lines = content.split(/\r?\n/);
  let headerCols: string[] | null = null;
  for (const line of lines) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const cells = m[1].split("|").map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue; // separator row
    if (!headerCols) {
      // Header row: first table encountered. Must look like a header.
      if (cells[0].toLowerCase() === "ingredient") {
        headerCols = cells.map((c) => c.toLowerCase());
      }
      continue;
    }
    const row = buildRowFromCells(cells, headerCols);
    if (!row) continue;
    rows.push(row);
    const canonicalKey = `${normalizeName(row.ingredient)}|${row.recipeUnit}`;
    byLookupKey.set(canonicalKey, row);
    for (const alias of row.aliases) {
      byLookupKey.set(`${alias}|${row.recipeUnit}`, row);
    }
  }
  return { rows, byLookupKey };
}

function buildRowFromCells(
  cells: string[],
  headerCols: string[],
): GroceryUnitRow | null {
  const col = (name: string): string => {
    const idx = headerCols.indexOf(name);
    if (idx < 0 || idx >= cells.length) return "";
    return cells[idx];
  };
  const ingredient = col("ingredient");
  if (!ingredient) return null;
  const storeUnitRaw = col("store unit");
  const sizeRaw = col("store unit size");
  // Normalize both sides so `cloves`→`clove`, `cups`→`cup`, etc.
  // match whether written singular or plural in the table.
  const recipeUnit = normalizeUnit(col("recipe unit"));
  const aliasesRaw = col("aliases");
  const notes = col("notes");
  const department = col("department");
  const isStaple = /^staple$/i.test(storeUnitRaw);
  const storeUnit = isStaple ? "" : storeUnitRaw.toLowerCase();
  const parsedSize = parseFloat(sizeRaw);
  const storeUnitSize = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 1;
  const aliases = aliasesRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .map(normalizeName);
  return {
    ingredient,
    storeUnit,
    storeUnitSize,
    recipeUnit,
    aliases,
    isStaple,
    notes,
    department,
  };
}

// Normalize an ingredient name for lookup: lowercase, trim, strip a
// trailing "s" only when the result is still ≥ 3 characters (so
// "eggs" matches "egg", but "peas" doesn't collapse to "pea" if the
// row is written as "peas"). We also try the as-written form, so
// either spelling works in the table.
export function normalizeName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (lower.length <= 3) return lower;
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

// Unit synonyms: Menu Items uses "cups" while the table uses "cup",
// etc. Collapse to the shortest canonical form.
const UNIT_SYNONYMS: Record<string, string> = {
  cups: "cup",
  tbsps: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tsps: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  pounds: "lb",
  pound: "lb",
  lbs: "lb",
  ounces: "oz",
  ounce: "oz",
  cloves: "clove",
  heads: "head",
  stalks: "stalk",
  cans: "can",
  slices: "slice",
  strips: "strip",
  sprigs: "sprig",
  pieces: "piece",
  leaves: "leaf",
  links: "link",
  loaves: "loaf",
  bunches: "bunch",
  boxes: "box",
  bottles: "bottle",
  tortillas: "tortilla",
  wholes: "whole",
};

export function normalizeUnit(unit: string): string {
  const lower = unit.toLowerCase().trim();
  if (!lower) return "";
  return UNIT_SYNONYMS[lower] ?? lower;
}

export function lookupRow(
  index: GroceryUnitIndex,
  name: string,
  unit: string,
): GroceryUnitRow | null {
  const normName = normalizeName(name);
  const normUnit = normalizeUnit(unit);
  // Try name|unit, then alias|unit (already indexed), then name|"" for
  // unit-agnostic staples.
  const row = index.byLookupKey.get(`${normName}|${normUnit}`);
  if (row) return row;
  const staple = index.byLookupKey.get(`${normName}|`) ?? index.byLookupKey.get(`${normName}|${normUnit}`);
  // Last-ditch: scan rows for a staple match on name alone (recipe
  // unit may be blank in the table for pantry rows).
  for (const r of index.rows) {
    if (!r.isStaple) continue;
    if (normalizeName(r.ingredient) === normName) return r;
    if (r.aliases.includes(normName)) return r;
  }
  return staple ?? null;
}

export function pluralizeStoreUnit(unit: string, count: number): string {
  if (count === 1) return unit;
  const u = unit.toLowerCase();
  if (!u) return "";
  if (u === "dozen") return "dozen"; // "2 dozen eggs" idiomatic
  if (u.endsWith("ch") || u.endsWith("sh") || u.endsWith("x") || u.endsWith("s")) {
    return `${unit}es`;
  }
  if (u.endsWith("f")) return `${unit.slice(0, -1)}ves`;
  if (u.endsWith("y") && !/[aeiou]y$/.test(u)) return `${unit.slice(0, -1)}ies`;
  // Consonant + o → "-oes" (potato → potatoes, tomato → tomatoes).
  // Vowel + o (avocado, radio) stays "-os".
  if (u.endsWith("o") && !/[aeiou]o$/.test(u)) return `${unit}es`;
  return `${unit}s`;
}

function formatQty(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

export function convertIngredient(
  ing: Ingredient,
  index: GroceryUnitIndex,
): ConversionResult {
  const row = lookupRow(index, ing.name, ing.quantityUnit);
  if (!row) return { line: "", staple: false, matched: false, row: null, count: 0 };
  if (row.isStaple) return { line: "", staple: true, matched: true, row, count: 0 };
  if (ing.quantityNumber === null) {
    // Free-form quantity ("to taste") — leave as-is at the caller level.
    return { line: "", staple: false, matched: false, row, count: 0 };
  }
  const recipeQty = ing.quantityNumber;
  const storeCount = Math.max(1, Math.ceil(recipeQty / row.storeUnitSize));
  return { line: formatStoreLine(row, storeCount), staple: false, matched: true, row, count: storeCount };
}

// "1 dozen eggs", "2 bunches broccoli", "3 sweet potatoes". Shared by
// the single-ingredient converter and the merged grocery list builder.
export function formatStoreLine(row: GroceryUnitRow, storeCount: number): string {
  // "whole" is the no-unit sentinel — "2 bananas", not "2 wholes bananas".
  const emitUnit = row.storeUnit && row.storeUnit !== "whole";
  const unitWord = emitUnit ? pluralizeStoreUnit(row.storeUnit, storeCount) : "";
  // When the store unit is hidden we pluralize the ingredient name
  // itself ("2 sweet potatoes" not "2 sweet potato"). When a unit word
  // IS emitted it already carries the plural, so the ingredient stays
  // as written in the table ("2 bags shredded cheddar cheese").
  const nameOut = !emitUnit ? pluralizeIngredient(row.ingredient, storeCount) : row.ingredient;
  const qtyStr = formatQty(storeCount);
  const parts = [qtyStr, unitWord, nameOut].filter((p) => p.length > 0);
  return parts.join(" ");
}

function pluralizeIngredient(name: string, count: number): string {
  if (count === 1) return name;
  // Many ingredient names are already plural in the table ("eggs",
  // "green chilies", "chicken breasts") — don't double-pluralize.
  if (/(s|ies|oes)$/i.test(name)) return name;
  // Reuse the same word-shape rules as pluralizeStoreUnit.
  return pluralizeStoreUnit(name, count);
}
