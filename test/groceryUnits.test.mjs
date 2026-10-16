import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGroceryUnits,
  lookupRow,
  convertIngredient,
  pluralizeStoreUnit,
  normalizeName,
  normalizeUnit,
} from "../.test-build/smart/groceryUnits.js";
import { formatForGroceryPrompt, injectDishesSection } from "../.test-build/smart/session.js";

const SAMPLE_TABLE = `
# Grocery Units

| Ingredient | Store Unit | Store Unit Size | Recipe Unit | Aliases | Notes |
| --- | --- | --- | --- | --- | --- |
| broccoli | bunch | 2 | cup | broccoli florets, chopped broccoli | 1 bunch ≈ 2 cups |
| eggs | dozen | 12 | whole | egg | buy by the dozen |
| green chilies | can | 1 | can | green chile, canned green chilies |  |
| chicken breasts | lb | 16 | oz |  | 1 lb = 16 oz |
| milk | half-gallon | 8 | cup |  |  |
| banana | whole | 1 | whole | bananas |  |
| olive oil | STAPLE |  |  | olive oil or butter, cooking oil | pantry |
| salt and black pepper | STAPLE |  |  | salt, pepper, kosher salt |  |
| apples | whole | 1 | medium | apple |  |
`;

test("parseGroceryUnits reads the real columns", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  assert.equal(idx.rows.length, 9);
  const broccoli = idx.rows.find((r) => r.ingredient === "broccoli");
  assert.ok(broccoli);
  assert.equal(broccoli.storeUnit, "bunch");
  assert.equal(broccoli.storeUnitSize, 2);
  assert.equal(broccoli.recipeUnit, "cup");
  assert.deepEqual(broccoli.aliases, ["broccoli floret", "chopped broccoli"]);
  assert.equal(broccoli.isStaple, false);
});

test("parseGroceryUnits marks STAPLE rows", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const oil = idx.rows.find((r) => r.ingredient === "olive oil");
  assert.ok(oil);
  assert.equal(oil.isStaple, true);
  assert.equal(oil.storeUnit, "");
});

test("lookupRow matches by canonical name + unit", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = lookupRow(idx, "broccoli", "cup");
  assert.ok(r);
  assert.equal(r.ingredient, "broccoli");
});

test("lookupRow matches by alias", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = lookupRow(idx, "chopped broccoli", "cup");
  assert.ok(r);
  assert.equal(r.ingredient, "broccoli");
});

test("lookupRow matches staples regardless of unit", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = lookupRow(idx, "salt and black pepper", "tsp");
  assert.ok(r);
  assert.equal(r.isStaple, true);
});

test("normalizeName strips trailing s", () => {
  assert.equal(normalizeName("eggs"), "egg");
  assert.equal(normalizeName("Bananas"), "banana");
  assert.equal(normalizeName("peas"), "pea");
  assert.equal(normalizeName("berries"), "berrie"); // acceptable; aliases handle it
});

test("normalizeUnit collapses synonyms", () => {
  assert.equal(normalizeUnit("Cups"), "cup");
  assert.equal(normalizeUnit("tablespoon"), "tbsp");
  assert.equal(normalizeUnit("Pounds"), "lb");
  assert.equal(normalizeUnit("cloves"), "clove");
});

test("pluralizeStoreUnit", () => {
  assert.equal(pluralizeStoreUnit("bunch", 1), "bunch");
  assert.equal(pluralizeStoreUnit("bunch", 2), "bunches");
  assert.equal(pluralizeStoreUnit("can", 3), "cans");
  assert.equal(pluralizeStoreUnit("box", 2), "boxes");
  assert.equal(pluralizeStoreUnit("dozen", 3), "dozen"); // idiomatic
  assert.equal(pluralizeStoreUnit("whole", 2), "wholes"); // never emitted anyway
});

test("convertIngredient rounds up to whole store units", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = convertIngredient(
    { name: "broccoli", quantityNumber: 2.5, quantityUnit: "cup", raw: "2.5 cup" },
    idx,
  );
  assert.equal(r.matched, true);
  assert.equal(r.staple, false);
  assert.equal(r.line, "2 bunches broccoli"); // ceil(2.5 / 2) = 2
});

test("convertIngredient collapses eggs to dozens", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = convertIngredient(
    { name: "eggs", quantityNumber: 4, quantityUnit: "whole", raw: "4 whole" },
    idx,
  );
  assert.equal(r.line, "1 dozen eggs"); // ceil(4/12) = 1
});

test("convertIngredient converts 20 eggs to 2 dozen", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = convertIngredient(
    { name: "eggs", quantityNumber: 20, quantityUnit: "whole", raw: "20 whole" },
    idx,
  );
  assert.equal(r.line, "2 dozen eggs");
});

test("convertIngredient marks staples", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = convertIngredient(
    { name: "olive oil or butter", quantityNumber: 2, quantityUnit: "tbsp", raw: "2 tbsp" },
    idx,
  );
  assert.equal(r.staple, true);
  assert.equal(r.matched, true);
  assert.equal(r.line, "");
});

test("convertIngredient falls through when ingredient is not in the table", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = convertIngredient(
    { name: "ground cumin", quantityNumber: 1, quantityUnit: "tsp", raw: "1 tsp" },
    idx,
  );
  assert.equal(r.matched, false);
  assert.equal(r.staple, false);
  assert.equal(r.line, "");
});

test("convertIngredient fractional under 1 rounds up to 1 store unit", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = convertIngredient(
    { name: "green chilies", quantityNumber: 0.5, quantityUnit: "can", raw: "0.5 can" },
    idx,
  );
  assert.equal(r.line, "1 can green chilies"); // ceil(0.5/1) = 1
});

test("convertIngredient free-form quantity returns no line (caller falls through)", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = convertIngredient(
    { name: "banana", quantityNumber: null, quantityUnit: "to taste", raw: "to taste" },
    idx,
  );
  assert.equal(r.matched, false);
  assert.equal(r.staple, false);
});

test("formatForGroceryPrompt swaps in store units, drops staples, falls back on misses", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const lines = formatForGroceryPrompt(
    [
      { name: "eggs", quantityNumber: 4, quantityUnit: "whole", raw: "4 whole" },
      { name: "broccoli", quantityNumber: 2.5, quantityUnit: "cup", raw: "2.5 cup" },
      { name: "olive oil or butter", quantityNumber: 2, quantityUnit: "tbsp", raw: "2 tbsp" },
      { name: "ground cumin", quantityNumber: 1, quantityUnit: "tsp", raw: "1 tsp" },
    ],
    idx,
  );
  assert.deepEqual(lines, [
    "- 1 dozen eggs",
    "- 2 bunches broccoli",
    "- 1 tsp ground cumin",
  ]);
});

test("formatForGroceryPrompt without a table falls through to raw formatIngredient", () => {
  const lines = formatForGroceryPrompt(
    [{ name: "broccoli", quantityNumber: 2, quantityUnit: "cup", raw: "2 cup" }],
    null,
  );
  assert.deepEqual(lines, ["- 2 cup broccoli"]);
});

test("injectDishesSection inserts after H1 and is idempotent", () => {
  const body = "# Grocery List — 2026-10-15\n\n## Produce\n- 1 bunch broccoli\n";
  const dishes = [
    { id: "L47", dish: "Grilled Chicken Breast" },
    { id: "D32", dish: "Butternut Bisque" },
  ];
  const once = injectDishesSection(body, dishes);
  assert.match(once, /## Dishes\n- L47 — Grilled Chicken Breast\n- D32 — Butternut Bisque/);
  assert.match(once, /## Produce\n- 1 bunch broccoli/);
  const twice = injectDishesSection(once, dishes);
  assert.equal((twice.match(/## Dishes/g) || []).length, 1);
});

test("injectDishesSection with no dishes returns body unchanged", () => {
  const body = "# Grocery List\n\n## Produce\n- milk\n";
  assert.equal(injectDishesSection(body, []), body);
});

test("convertIngredient converts weight oz to pounds (round up)", () => {
  const idx = parseGroceryUnits(SAMPLE_TABLE);
  const r = convertIngredient(
    { name: "chicken breasts", quantityNumber: 10, quantityUnit: "oz", raw: "10 oz" },
    idx,
  );
  assert.equal(r.line, "1 lb chicken breasts"); // ceil(10/16) = 1

  const r2 = convertIngredient(
    { name: "chicken breasts", quantityNumber: 20, quantityUnit: "oz", raw: "20 oz" },
    idx,
  );
  assert.equal(r2.line, "2 lbs chicken breasts"); // ceil(20/16) = 2
});
