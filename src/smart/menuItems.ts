// Parse the Reference HUB/Menu Items.md table into a lookup index,
// recognise dish IDs in a user utterance, and expand selected IDs
// into a combined ingredient list with (name, unit) quantity sums.
//
// Pure logic — no Obsidian imports — so tests can drive it directly.
// The modal reads the file content and injects it in; this file
// never does disk I/O.

export interface Ingredient {
  name: string;
  quantityNumber: number | null; // null when the quantity is free-form
  quantityUnit: string;          // "lb", "cup", "whole"; or free-form text when quantityNumber is null
  raw: string;                   // original "2 lb" / "to taste" string
}

export interface MenuItem {
  id: string;          // "B11", "L47", "DS7"
  dish: string;
  category: string;    // ID-prefix category: "Breakfast" | "Lunch" | "Dinner" | "Dessert" | "Snack" | "Side" | "Baking" | "Middle Kitchen" | ...
  section: string;     // Containing Menu Items.md H2 heading: "Breakfast" | "Lunch" | "Dinner" | "Ranch Dishes" | ...; "" if the row preceded any heading.
  ingredients: Ingredient[]; // empty array when the Ingredients cell is blank
  meal: string;        // optional 4th "Meal" column: Breakfast | Lunch | Dinner | Snack | Dessert | Sides | Baking | Fondue | Pizza; "" when absent. Overrides the section on the Meal Planner.
}

export interface MenuIndex {
  byId: Map<string, MenuItem>;
}

const PREFIX_TO_CATEGORY: Record<string, string> = {
  // Ranch Menu (seeded 2026-10-10)
  B: "Breakfast",
  L: "Lunch",
  D: "Dinner",
  DS: "Dessert",
  S: "Snack",
  SD: "Side",
  // Pinterest boards (seeded 2026-10-10)
  BK: "Baking",
  MK: "Middle Kitchen",
  BM: "Basement Kitchen",
  NV: "Nearly Vegetarian",
  FD: "Fondue",
  PS: "Pinterest Sides",
  TK: "Top Kitchen",
  PZ: "Pizza",
  ZE: "Zero Effort",   // 2026-10-24: 8 ZE rows existed in the vault but were unreachable (prefix unknown)
};

// Row accepts a 3rd Ingredients column and an optional 4th Source column.
const ROW_RE = /^\s*\|\s*([A-Z]{1,2}\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*(?:\|\s*([^|]*?)\s*)?\|\s*$/;
// Longest-first alternation so DS/SD/BK/MK/BM/NV/FD/PS/TK/PZ match before single letters.
const ID_PREFIX_RE = /^(DS|SD|BK|MK|BM|NV|FD|PS|TK|PZ|ZE|B|L|D|S)(\d+)$/;

// Captures "## Breakfast" / "## Ranch Dishes" / etc. so each parsed
// row carries the containing section as well as the prefix-derived
// category.
const H2_RE = /^##\s+(.+?)\s*$/;

export function parseMenuItems(content: string): MenuIndex {
  const byId = new Map<string, MenuItem>();
  const lines = content.split(/\r?\n/);
  let currentSection = "";
  for (const line of lines) {
    const h = H2_RE.exec(line);
    if (h) {
      currentSection = h[1].trim();
      continue;
    }
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const id = m[1].toUpperCase();
    const dish = m[2].trim();
    const ingredientsCell = m[3].trim();
    const meal = normalizeMeal(m[4] ?? "");
    if (!dish || dish.toLowerCase() === "dish") continue; // skip header rows
    const prefixMatch = ID_PREFIX_RE.exec(id);
    if (!prefixMatch) continue;
    const prefix = prefixMatch[1];
    const category = PREFIX_TO_CATEGORY[prefix];
    if (!category) continue;
    byId.set(id, {
      id,
      dish,
      category,
      section: currentSection,
      ingredients: ingredientsCell ? parseIngredientList(ingredientsCell) : [],
      meal,
    });
  }
  return { byId };
}

const MEAL_WORDS: Record<string, string> = {
  breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", snacks: "Snack",
  dessert: "Dessert", desserts: "Dessert", side: "Sides", sides: "Sides", baking: "Baking",
  fondue: "Fondue", pizza: "Pizza",
};
// 4th-column value → canonical meal type, "" when blank/unknown.
export function normalizeMeal(cell: string): string {
  return MEAL_WORDS[cell.trim().toLowerCase()] ?? "";
}

function parseIngredientList(cell: string): Ingredient[] {
  const parts = cell.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  const out: Ingredient[] = [];
  for (const part of parts) {
    const colonIdx = part.indexOf(":");
    if (colonIdx < 0) {
      // No colon — treat the whole thing as a name with free-form quantity "1".
      out.push({ name: part.trim(), quantityNumber: 1, quantityUnit: "", raw: "1" });
      continue;
    }
    const name = part.slice(0, colonIdx).trim();
    const rawQty = part.slice(colonIdx + 1).trim();
    const num = /^(-?\d+(?:\.\d+)?)\s+(.+)$/.exec(rawQty);
    if (num) {
      out.push({
        name,
        quantityNumber: parseFloat(num[1]),
        quantityUnit: num[2].trim().toLowerCase(),
        raw: rawQty,
      });
    } else {
      // Free-form quantity like "to taste" or "a pinch" — pass through.
      out.push({
        name,
        quantityNumber: null,
        quantityUnit: rawQty,
        raw: rawQty,
      });
    }
  }
  return out;
}

// IDs can appear in utterances like:
//   "L47"
//   "L47, D32"
//   "number L47 and D32"
//   "menu D12, lunch 25"       (bare "lunch 25" → L25)
// The modal passes which template is active; for Grocery we treat
// "breakfast N", "lunch N", "dinner N", "dessert N", "snack N",
// "side N" as a category-plus-number form that maps back to the
// prefixed ID.
export function extractMenuIds(utterance: string): string[] {
  const found = new Set<string>();
  // Longest-prefix-first via regex alternation; filter against known set.
  const direct = /\b(DS|SD|BK|MK|BM|NV|FD|PS|TK|PZ|ZE|B|L|D|S)(\d{1,3})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = direct.exec(utterance)) !== null) {
    const prefix = m[1].toUpperCase();
    if (!(prefix in PREFIX_TO_CATEGORY)) continue;
    found.add(`${prefix}${m[2]}`);
  }
  const words = /\b(breakfast|lunch|dinner|dessert|snack|side|sides|baking|fondue|pizza)\s+(\d{1,3})\b/gi;
  while ((m = words.exec(utterance)) !== null) {
    const prefix = categoryToPrefix(m[1]);
    if (!prefix) continue;
    found.add(`${prefix}${m[2]}`);
  }
  return [...found].sort(sortById);
}

function categoryToPrefix(word: string): string | null {
  const w = word.toLowerCase();
  if (w === "breakfast") return "B";
  if (w === "lunch") return "L";
  if (w === "dinner") return "D";
  if (w === "dessert") return "DS";
  if (w === "snack") return "S";
  if (w === "side" || w === "sides") return "SD";
  if (w === "baking") return "BK";
  if (w === "fondue") return "FD";
  if (w === "pizza") return "PZ";
  return null;
}

function sortById(a: string, b: string): number {
  const am = ID_PREFIX_RE.exec(a);
  const bm = ID_PREFIX_RE.exec(b);
  if (!am || !bm) return a.localeCompare(b);
  if (am[1] !== bm[1]) return am[1].localeCompare(bm[1]);
  return parseInt(am[2], 10) - parseInt(bm[2], 10);
}

// Strip the IDs we recognised out of the utterance, so the model
// isn't told to classify "L47" as a grocery item. Also strips the
// "menu", "number", "no.", "#" prefixes and the "breakfast N" /
// "lunch N" / ... forms.
export function stripMenuIdsFromUtterance(utterance: string): string {
  let s = utterance;
  s = s.replace(/\b(menu|number|no\.?|#)\s+/gi, " ");
  s = s.replace(/\b(breakfast|lunch|dinner|dessert|snack|sides?|baking|fondue|pizza)\s+\d{1,3}\b/gi, " ");
  s = s.replace(/\b(?:DS|SD|BK|MK|BM|NV|FD|PS|TK|PZ|ZE|B|L|D|S)\d{1,3}\b/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  // Trim any trailing dangling commas / "and" / "with" produced by the strip.
  s = s.replace(/^\s*(,|and|with|plus)\s+/i, "");
  s = s.replace(/\s+(,|and|with|plus)\s*$/i, "");
  return s;
}

// -- Dish names spoken without an ID ---------------------------
// "maple bacon corn fritters" is L21, not a grocery item. Whisper
// slips one letter ("Riddled" for "Griddled"), so words of 5+ letters
// match at edit distance 1. A match needs 2+ consecutive spoken words
// covering at least 60% of the dish name's words; commas, "plus" and
// "also" end a run, and "and"/"&" only continue one when the dish name
// itself contains them. Single-word dish names never match (too many
// real groceries share a word with a dish).

export interface DishMatch {
  phrase: string; // the words as spoken
  id: string;
  dish: string;
}

export interface DishNameResult {
  matches: DishMatch[];
  rest: string; // the text with matched phrases removed
}

const DISH_STOPWORDS = new Set(["with", "the", "a", "an", "of", "or", "in", "on", "some", "style", "s"]);
const MIN_DISH_COVERAGE = 0.6;

function dishWords(name: string): string[] {
  return (name.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !DISH_STOPWORDS.has(w) && w !== "and");
}

function singular(w: string): string {
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function wordsMatch(spoken: string, dish: string): boolean {
  if (spoken === dish || singular(spoken) === singular(dish)) return true;
  return Math.min(spoken.length, dish.length) >= 5 && editDistanceAtMostOne(spoken, dish);
}

interface SpokenToken {
  word: string;
  start: number;
  end: number;
  kind: "word" | "stop" | "conj" | "break";
}

function spokenTokens(text: string): SpokenToken[] {
  const out: SpokenToken[] = [];
  const re = /[A-Za-z0-9]+|[,;.\n&]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const w = m[0].toLowerCase();
    let kind: SpokenToken["kind"] = "word";
    if (/^[,;.\n]$/.test(w) || w === "plus" || w === "also") kind = "break";
    else if (w === "and" || w === "&") kind = "conj";
    else if (DISH_STOPWORDS.has(w)) kind = "stop";
    out.push({ word: w, start: m.index, end: m.index + m[0].length, kind });
  }
  return out;
}

function phraseKey(s: string): string {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(singular).join(" ");
}

interface Candidate {
  item: MenuItem;
  first: number; // token index
  last: number;
  run: number;
  coverage: number;
  preferred: boolean;
}

export function matchDishNames(
  text: string,
  index: MenuIndex,
  preferIds: readonly string[] = [],
  knownItems: ReadonlySet<string> = new Set(),
): DishNameResult {
  // A phrase that IS a grocery item ("pork chops") stays an item.
  const known = new Set([...knownItems].map((n) => phraseKey(n)));
  const toks = spokenTokens(text);
  const prefer = new Set(preferIds);
  const candidates: Candidate[] = [];
  for (const item of index.byId.values()) {
    const dw = dishWords(item.dish);
    if (dw.length < 2) continue;
    const allowsConj = /&|\band\b/i.test(item.dish);
    for (let s = 0; s < toks.length; s++) {
      if (toks[s].kind !== "word") continue;
      const used = new Set<number>();
      let run = 0;
      let last = s;
      for (let k = s; k < toks.length; k++) {
        const tk = toks[k];
        if (tk.kind === "break") break;
        if (tk.kind === "conj" && !allowsConj) break;
        if (tk.kind !== "word") continue;
        const hit = dw.findIndex((d, di) => !used.has(di) && wordsMatch(tk.word, d));
        if (hit < 0) break;
        used.add(hit);
        run++;
        last = k;
      }
      const coverage = run / dw.length;
      if (run >= 2 && coverage >= MIN_DISH_COVERAGE && !known.has(phraseKey(text.slice(toks[s].start, toks[last].end)))) {
        candidates.push({ item, first: s, last, run, coverage, preferred: prefer.has(item.id) });
      }
    }
  }
  candidates.sort(
    (a, b) =>
      b.run - a.run ||
      Number(b.preferred) - Number(a.preferred) ||
      b.coverage - a.coverage ||
      a.first - b.first,
  );
  const taken = new Set<number>();
  const chosen: Candidate[] = [];
  const chosenIds = new Set<string>();
  for (const c of candidates) {
    let free = true;
    for (let k = c.first; k <= c.last; k++) if (taken.has(k)) free = false;
    if (!free || chosenIds.has(c.item.id)) continue;
    for (let k = c.first; k <= c.last; k++) taken.add(k);
    chosen.push(c);
    chosenIds.add(c.item.id);
  }
  chosen.sort((a, b) => a.first - b.first);
  let rest = "";
  let pos = 0;
  const matches: DishMatch[] = [];
  for (const c of chosen) {
    const from = toks[c.first].start;
    const to = toks[c.last].end;
    matches.push({ phrase: text.slice(from, to), id: c.item.id, dish: c.item.dish });
    rest += text.slice(pos, from) + " ";
    pos = to;
  }
  rest += text.slice(pos);
  rest = rest
    .replace(/\s+/g, " ")
    .replace(/\s+([,;.])/g, "$1")
    .replace(/([,;])\s*(?:(?:and|plus)\s*)?(?=[,;]|$)/gi, "")
    .replace(/^\s*(?:[,;.]|and|plus|also)\s*/i, "")
    .replace(/\s*(?:[,;]|\band|\bplus)\s*$/i, "")
    .trim();
  return { matches, rest };
}

export interface ExpansionResult {
  ingredients: Ingredient[];
  found: MenuItem[];
  missingIds: string[];
  unfilledIds: string[];
}

export function expandIds(ids: readonly string[], index: MenuIndex): ExpansionResult {
  const found: MenuItem[] = [];
  const missingIds: string[] = [];
  const unfilledIds: string[] = [];
  const all: Ingredient[] = [];
  for (const id of ids) {
    const dish = index.byId.get(id);
    if (!dish) {
      missingIds.push(id);
      continue;
    }
    if (dish.ingredients.length === 0) {
      unfilledIds.push(id);
      found.push(dish);
      continue;
    }
    found.push(dish);
    for (const ing of dish.ingredients) all.push(ing);
  }
  return {
    ingredients: sumIngredients(all),
    found,
    missingIds,
    unfilledIds,
  };
}

// Combine ingredients: same name + same unit sums the numeric qty.
// Different units (e.g. "lb" vs "oz") stay as separate rows.
// Free-form quantities ("to taste") stay separate rows unless an
// identical free-form string exists for the same name, in which case
// one copy is kept.
export function sumIngredients(ingredients: readonly Ingredient[]): Ingredient[] {
  interface Key { name: string; unit: string; isNumeric: boolean }
  const groups = new Map<string, { ing: Ingredient; qty: number | null; dedupeFreeform: Set<string> }>();
  for (const ing of ingredients) {
    const nameKey = ing.name.toLowerCase();
    const unitKey = ing.quantityUnit.toLowerCase();
    const isNumeric = ing.quantityNumber !== null;
    const groupKey = isNumeric
      ? `N|${nameKey}|${unitKey}`
      : `F|${nameKey}|${unitKey}`;
    const existing = groups.get(groupKey);
    if (existing) {
      if (isNumeric && existing.qty !== null && ing.quantityNumber !== null) {
        existing.qty = existing.qty + ing.quantityNumber;
      }
      // Free-form path: already deduped by groupKey, so just skip.
      continue;
    }
    groups.set(groupKey, {
      ing: { ...ing },
      qty: ing.quantityNumber,
      dedupeFreeform: new Set<string>(),
    });
  }
  const out: Ingredient[] = [];
  for (const g of groups.values()) {
    if (g.ing.quantityNumber !== null) {
      out.push({
        name: g.ing.name,
        quantityNumber: g.qty,
        quantityUnit: g.ing.quantityUnit,
        raw: `${g.qty} ${g.ing.quantityUnit}`.trim(),
      });
    } else {
      out.push({ ...g.ing });
    }
  }
  return out;
}

// Format an ingredient for display in a grocery item line.
// Numeric: "3 lb chicken breast"; strips trailing ".0".
// Free-form: "chicken breast (to taste)".
export function formatIngredient(ing: Ingredient): string {
  if (ing.quantityNumber !== null) {
    const qty = formatQuantity(ing.quantityNumber);
    const unit = ing.quantityUnit && ing.quantityUnit !== "whole" ? ing.quantityUnit : "";
    if (unit) return `${qty} ${unit} ${ing.name}`.replace(/\s+/g, " ").trim();
    return `${qty} ${ing.name}`.trim();
  }
  return `${ing.name} (${ing.quantityUnit})`;
}

function formatQuantity(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Keep up to 2 decimal places, strip trailing zeros.
  return n.toFixed(2).replace(/\.?0+$/, "");
}
