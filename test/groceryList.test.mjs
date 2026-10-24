// Deterministic grocery list builder — regression tests built from the
// real 2026-10-16 list (K&K Ranch HUB/Grocery List — 2026-10-16.md),
// which had duplicate eggs/flour/kielbasa, four butter lines, a staple
// ("salt and pepper") that slipped through, kielbasa in Bakery, and a
// missing arborio rice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGroceryUnits } from "../.test-build/smart/groceryUnits.js";
import {
  buildGroceryItems,
  cleanIngredientName,
  departmentFor,
  formatGroceryItem,
  mergeItemsIntoExtracted,
  bareName,
  sameDepartment,
  stripEmptyCheckboxes,
} from "../.test-build/smart/groceryList.js";
import { parseMenuItems, expandIds } from "../.test-build/smart/menuItems.js";
import { createSession, pickTemplate, submitCapture, answerGroceryExtras, prepareReview, GROCERY_EXTRAS_PROMPT } from "../.test-build/smart/session.js";
import { suggestFolder, pinnedFolderFor } from "../.test-build/smart/router.js";

const UNITS = `
| Ingredient | Store Unit | Store Unit Size | Recipe Unit | Aliases | Notes | Department |
| --- | --- | --- | --- | --- | --- | --- |
| eggs | dozen | 12 | whole | egg |  | Dairy & Refrigerated |
| butter | stick | 8 | tbsp | unsalted butter, salted butter, lard or butter |  | Dairy & Refrigerated |
| all-purpose flour | bag | 20 | cup | flour |  | Bakery & Pantry |
| arborio rice | bag | 5 | cup | arborio or bomba rice |  | Bakery & Pantry |
| kielbasa | lb | 16 | oz | smoked italian or kielbasa sausage, kielbasa sausage |  | Meat & Seafood |
| yellow onion | whole | 1 | whole | onion |  | Produce |
| whole milk | half-gallon | 8 | cup | milk, whole milk or cream |  | Dairy & Refrigerated |
| salt and black pepper | STAPLE |  |  | salt, black pepper, pepper, kosher salt |  |  |
| olive oil | STAPLE |  |  | olive oil or butter |  |  |
`;

const SECTIONS = ["🥑 Produce", "🥩 Meat & Seafood", "🧀 Dairy & Refrigerated", "🍞 Bakery & Pantry", "🛒 Snacks & Household", "🐾 Pets & Ranch"];

const ing = (name, n, unit, sourceId) => ({ name, quantityNumber: n, quantityUnit: unit, raw: `${n} ${unit}`, sourceId });

test("cleanIngredientName strips prep words, parentheticals and purpose clauses", () => {
  assert.equal(cleanIngredientName("sliced yellow onion"), "yellow onion");
  assert.equal(cleanIngredientName("vegetable oil for deep frying"), "vegetable oil");
  assert.equal(cleanIngredientName("boneless pork loin cutlets (2 whole, pounded thin)"), "pork loin cutlets");
  assert.equal(cleanIngredientName("butter for frying"), "butter");
  assert.equal(cleanIngredientName("melted butter"), "butter");
  assert.equal(cleanIngredientName("finely diced deli ham"), "deli ham");
  assert.equal(cleanIngredientName("hot sauce"), "hot sauce");
  assert.equal(cleanIngredientName("dry arborio rice"), "arborio rice");
});

test("same ingredient from several dishes merges into one store line, with origins", () => {
  const idx = parseGroceryUnits(UNITS);
  const items = buildGroceryItems(
    [
      ing("eggs", 3, "whole", "B26"),
      ing("egg", 1, "whole", "B27"),
      ing("eggs", 1, "whole", "L19"),
      ing("beaten egg", 1, "whole", "D9"),
    ],
    idx,
    SECTIONS,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].line, "1 dozen eggs");
  assert.deepEqual(items[0].sources, ["B26", "B27", "L19", "D9"]);
  assert.equal(formatGroceryItem(items[0], true), "1 dozen eggs (from B26, B27, L19, D9)");
  assert.equal(formatGroceryItem(items[0], false), "1 dozen eggs");
  assert.ok(sameDepartment(items[0].department, "Dairy & Refrigerated"));
});

test("butter in four spellings becomes one line; tbsp totals round up once", () => {
  const idx = parseGroceryUnits(UNITS);
  const items = buildGroceryItems(
    [
      ing("butter", 2, "tbsp", "B26"),
      ing("melted butter", 2, "tbsp", "B27"),
      ing("butter for frying", 2, "tbsp", "L19"),
      ing("lard or butter for frying", 3, "tbsp", "D9"),
    ],
    idx,
    SECTIONS,
  );
  assert.equal(items.length, 1);
  // 9 tbsp / 8 per stick → 2 sticks (not 4 lines, not 1+1+1+1 = 4 sticks)
  assert.equal(items[0].line, "2 sticks butter");
});

test("staples drop, including partial alias matches like 'salt and pepper'", () => {
  const idx = parseGroceryUnits(UNITS);
  const items = buildGroceryItems(
    [
      ing("salt and pepper", 0.75, "tsp", "D22"),
      ing("salt and black pepper", 0.5, "tsp", "D9"),
      ing("olive oil", 1, "tbsp", "D43"),
      ing("kosher salt", 1, "tsp", "L33"),
    ],
    idx,
    SECTIONS,
  );
  assert.deepEqual(items, []);
});

test("departments come from the table column, then keywords, then the Pantry default", () => {
  const idx = parseGroceryUnits(UNITS);
  const items = buildGroceryItems(
    [
      ing("smoked Italian or kielbasa sausage", 8, "oz", "D22"),      // table → Meat
      ing("roasted green chiles", 0.33, "cup", "L33"),               // no row → keyword Produce
      ing("vegetable oil for deep frying", 2, "cup", "DS4"),         // no row, no keyword → Pantry
      ing("paper towels", 1, "whole", ""),                           // keyword → Household
    ],
    idx,
    SECTIONS,
  );
  const dept = (line) => items.find((i) => i.line.includes(line)).department;
  assert.ok(sameDepartment(dept("kielbasa"), "Meat & Seafood"));
  assert.ok(sameDepartment(dept("green chiles"), "Produce"));
  assert.ok(sameDepartment(dept("vegetable oil"), "Bakery & Pantry"));
  assert.ok(sameDepartment(dept("paper towels"), "Snacks & Household"));
  assert.equal(dept("kielbasa"), "🥩 Meat & Seafood"); // canonical = template heading
});

test("unmatched ingredients keep recipe units and still merge by cleaned name", () => {
  const items = buildGroceryItems(
    [ing("sliced leeks", 1, "cup", "D43"), ing("leeks", 0.5, "cup", "BM78"), ing("dry arborio rice", 1, "cup", "D43")],
    parseGroceryUnits(UNITS),
    SECTIONS,
  );
  const leeks = items.find((i) => i.line.includes("leeks"));
  assert.equal(leeks.line, "1.5 cup leeks");
  const rice = items.find((i) => i.line.includes("arborio"));
  assert.equal(rice.line, "1 bag arborio rice");
});

test("works with no Grocery Units table at all", () => {
  const items = buildGroceryItems([ing("eggs", 3, "whole", "B26"), ing("eggs", 2, "whole", "B27")], null, SECTIONS);
  assert.equal(items.length, 1);
  assert.equal(items[0].line, "5 eggs");
});

test("mergeItemsIntoExtracted puts menu items first and dedupes the model's extras", () => {
  const idx = parseGroceryUnits(UNITS);
  const items = buildGroceryItems([ing("eggs", 3, "whole", "B26"), ing("yellow onion", 1, "whole", "D22")], idx, SECTIONS);
  const out = mergeItemsIntoExtracted(
    { "🥑 Produce": ["bananas", "1 yellow onion (from D22)"], "🧀 Dairy & Refrigerated": [] },
    items,
    SECTIONS,
    true,
  );
  assert.deepEqual(out["🥑 Produce"], ["1 yellow onion (from D22)", "bananas"]);
  assert.deepEqual(out["🧀 Dairy & Refrigerated"], ["1 dozen eggs (from B26)"]);
  assert.equal(out["🐾 Pets & Ranch"], undefined);
});

test("extras already covered by a menu line are dropped (the duplicate 'milk' of 2026-10-24)", () => {
  const idx = parseGroceryUnits(UNITS);
  const items = buildGroceryItems([ing("whole milk", 2, "cup", "BM5"), ing("eggs", 2, "whole", "BM9")], idx, SECTIONS);
  const out = mergeItemsIntoExtracted(
    { "🧀 Dairy & Refrigerated": ["milk", "Milk", "yogurt"], "🍞 Bakery & Pantry": ["coffee"] },
    items,
    SECTIONS,
    true,
  );
  assert.deepEqual(out["🧀 Dairy & Refrigerated"], ["1 half-gallon whole milk (from BM5)", "1 dozen eggs (from BM9)", "yogurt"]);
  assert.deepEqual(out["🍞 Bakery & Pantry"], ["coffee"]);
  assert.equal(bareName("1 half-gallon whole milk (from BM5)"), "whole milk");
  assert.equal(bareName("2 sticks butter"), "butter");
  assert.equal(bareName("eggs"), "egg");
});

test("stripEmptyCheckboxes removes blank placeholder boxes only", () => {
  const body = "## A\n- [ ] \n## B\n- [ ] milk\n- [x] done\n- [ ]\n";
  assert.equal(stripEmptyCheckboxes(body), "## A\n## B\n- [ ] milk\n- [x] done\n");
});

test("departmentFor honors the table's Department column over keywords", () => {
  const row = { ingredient: "pepperoni", department: "Snacks & Household", isStaple: false, storeUnit: "pack", storeUnitSize: 1, recipeUnit: "oz", aliases: [], notes: "" };
  assert.equal(departmentFor("pepperoni", row, SECTIONS), "🛒 Snacks & Household");
  assert.equal(departmentFor("pepperoni", null, SECTIONS), "🥩 Meat & Seafood");
});

// -- Session integration -----------------------------------------

const GROCERY_TEMPLATE = `---
tags: [list, grocery, shopping]
created: {{date}}
period: ""
meals: []
priority: q1
---

# Grocery List — {{date}}

## 🥑 Produce
- [ ] 

## 🥩 Meat & Seafood
- [ ] 

## 🧀 Dairy & Refrigerated
- [ ] 

## 🍞 Bakery & Pantry
- [ ] 

## 🛒 Snacks & Household
- [ ] 

## 🐾 Pets & Ranch
- [ ] 

## Links
- [[Shopping Main]]
`;

const MENU = `
# Menu Items

## Dinner

| ID | Dish | Ingredients |
|---|---|---|
| D22 | Sausage & Peppers Skillet | smoked Italian or kielbasa sausage: 8 oz; yellow onion: 1 whole; salt and pepper: 0.25 tsp |
| D43 | Campfire Mushroom & Leek Risotto | dry arborio rice: 1 cup; butter: 2 tbsp; salt and black pepper: 0.5 tsp |
`;

function grocerySession(chatCalls) {
  const deps = {
    templates: [{ basename: "Grocery List Template", path: "Templates HUB/Grocery List Template.md", raw: GROCERY_TEMPLATE }],
    chat: async (req) => {
      chatCalls.push(req);
      return { parsed: { "🥑 Produce": ["bananas"], "🛒 Snacks & Household": ["paper towels"] }, retried: false };
    },
    nowISODate: () => "2026-10-24",
    nowISOTime: () => "12:00",
    folderEnum: ["Shopping HUB", "Reference HUB", "K&K Ranch HUB"],
    lastUsedByTemplate: new Map([["Grocery List Template", "Reference HUB"]]),
  };
  return pickTemplate(createSession(deps), "grocery").session;
}

test("menu-only utterance never calls the model; items land in code-chosen sections", async () => {
  const calls = [];
  let s = grocerySession(calls);
  s = await submitCapture(s, "D22 and D43", {
    expandMenuNumbers: true,
    menuIndex: parseMenuItems(MENU),
    groceryUnits: parseGroceryUnits(UNITS),
  });
  assert.equal(calls.length, 0, "no LLM call for a menu-only list");
  assert.deepEqual(s.extracted["🥩 Meat & Seafood"], ["1 lb kielbasa (from D22)"]);
  assert.deepEqual(s.extracted["🥑 Produce"], ["1 yellow onion (from D22)"]);
  assert.deepEqual(s.extracted["🍞 Bakery & Pantry"], ["1 bag arborio rice (from D43)"]);
  assert.deepEqual(s.extracted["🧀 Dairy & Refrigerated"], ["1 stick butter (from D43)"]);
  // period is empty → ask-field follow-up, then the extras question
  assert.equal(s.state, "followUp");
  assert.deepEqual(s.followUps.map((q) => q.kind), ["ask-field", "grocery-extras"]);
  assert.equal(s.followUps[1].prompt, GROCERY_EXTRAS_PROMPT);
});

test("free-text remainder goes to the model and merges after the menu items", async () => {
  const calls = [];
  let s = grocerySession(calls);
  s = await submitCapture(s, "D22, plus bananas and paper towels", {
    expandMenuNumbers: true,
    menuIndex: parseMenuItems(MENU),
    groceryUnits: parseGroceryUnits(UNITS),
    groceryOrigins: false,
  });
  assert.equal(calls.length, 1);
  assert.ok(!/FROM MENU LOOKUP/.test(calls[0].messages[1].content), "menu lines must not reach the model");
  assert.ok(/bananas/.test(calls[0].messages[1].content));
  assert.deepEqual(s.extracted["🥑 Produce"], ["1 yellow onion", "bananas"]);
  assert.deepEqual(s.extracted["🛒 Snacks & Household"], ["paper towels"]);
});

test("extras follow-up: skip-words add nothing, an answer is classified and appended", async () => {
  const calls = [];
  let s = grocerySession(calls);
  s = await submitCapture(s, "D22", { expandMenuNumbers: true, menuIndex: parseMenuItems(MENU), groceryUnits: parseGroceryUnits(UNITS) });
  // answer the period ask-field first
  const { answerFollowUp } = await import("../.test-build/smart/session.js");
  s = answerFollowUp(s, "10/24 - 10/27");
  assert.equal(s.followUps[0].kind, "grocery-extras");
  const skipped = await answerGroceryExtras(s, "none");
  assert.equal(skipped.state, "review");
  assert.equal(calls.length, 0);
  const answered = await answerGroceryExtras(s, "bananas and paper towels");
  assert.equal(calls.length, 1);
  assert.deepEqual(answered.extracted["🥑 Produce"], ["1 yellow onion (from D22)", "bananas"]);
  assert.deepEqual(answered.extracted["🛒 Snacks & Household"], ["paper towels"]);
  assert.equal(answered.state, "review");
});

test("review: pinned Shopping HUB, meals frontmatter, no blank boxes, Dishes section", async () => {
  const calls = [];
  let s = grocerySession(calls);
  s = await submitCapture(s, "D22 and D43", { expandMenuNumbers: true, menuIndex: parseMenuItems(MENU), groceryUnits: parseGroceryUnits(UNITS) });
  const plan = prepareReview(s);
  assert.equal(plan.folder.folder, "Shopping HUB", "last-used Reference HUB must lose to the pin");
  assert.deepEqual(plan.rendered.frontmatter.meals, ["D22", "D43"]);
  assert.equal(plan.rendered.frontmatter.priority, "q1");
  assert.ok(!/- \[ \]\s*$/m.test(plan.rendered.body), "no empty checkbox placeholders");
  assert.ok(/## Dishes\n- D22 — Sausage & Peppers Skillet\n- D43 — Campfire Mushroom & Leek Risotto/.test(plan.rendered.body));
  assert.ok(/## 🥩 Meat & Seafood\n- \[ \] 1 lb kielbasa \(from D22\)/.test(plan.rendered.body));
  assert.equal(plan.title, "Grocery List — 2026-10-24");
});

test("router: pinned folder beats lastUsed and modelPick", () => {
  assert.equal(pinnedFolderFor("Grocery List Template"), "Shopping HUB");
  assert.equal(pinnedFolderFor("Person Template"), null);
  const r = suggestFolder({
    templateBasename: "Grocery List Template",
    folderEnum: ["Shopping HUB", "Reference HUB"],
    lastUsed: "Reference HUB",
    modelPick: { folder: "Reference HUB", reason: "x" },
  });
  assert.equal(r.folder, "Shopping HUB");
});

test("expandIds still sums for the Meal Planner path", () => {
  const exp = expandIds(["D22", "D43"], parseMenuItems(MENU));
  assert.equal(exp.found.length, 2);
  assert.ok(exp.ingredients.length >= 5);
});

test("ZE (Zero Effort) prefix resolves like the others", async () => {
  const { extractMenuIds, parseMenuItems: pmi } = await import("../.test-build/smart/menuItems.js");
  assert.deepEqual(extractMenuIds("ZE4 and D22").sort(), ["D22", "ZE4"]);
  const idx = pmi("## Breakfast\n| ID | Dish | Ingredients |\n|---|---|---|\n| ZE4 | Frozen Waffles | frozen waffles: 4 whole; maple syrup: 0.25 cup |\n");
  assert.equal(idx.byId.get("ZE4").category, "Zero Effort");
});
