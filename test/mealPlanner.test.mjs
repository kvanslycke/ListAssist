import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mealTypeFor,
  renderMealPlanner,
  MEAL_TYPE_ORDER,
} from "../.test-build/smart/mealPlanner.js";

function dish(partial) {
  return {
    id: partial.id,
    dish: partial.dish ?? "Something",
    category: partial.category ?? "Breakfast",
    section: partial.section ?? "",
    ingredients: partial.ingredients ?? [],
  };
}

function ing(name, qty, unit, raw) {
  return { name, quantityNumber: qty, quantityUnit: unit, raw: raw ?? `${qty} ${unit}` };
}

test("mealTypeFor uses the Menu Items section for Breakfast/Lunch/Dinner dishes", () => {
  assert.equal(mealTypeFor(dish({ id: "BM9", section: "Breakfast" })), "Breakfast");
  assert.equal(mealTypeFor(dish({ id: "MK70", section: "Lunch" })), "Lunch");
  assert.equal(mealTypeFor(dish({ id: "TK10", section: "Dinner" })), "Dinner");
});

test("mealTypeFor folds Ranch dishes to a meal type by ID prefix", () => {
  assert.equal(mealTypeFor(dish({ id: "B2", section: "Ranch Dishes" })), "Breakfast");
  assert.equal(mealTypeFor(dish({ id: "L23", section: "Ranch Dishes" })), "Lunch");
  assert.equal(mealTypeFor(dish({ id: "D5", section: "Ranch Dishes" })), "Dinner");
  assert.equal(mealTypeFor(dish({ id: "DS1", section: "Ranch Dishes" })), "Dessert");
  assert.equal(mealTypeFor(dish({ id: "SD3", section: "Ranch Dishes" })), "Sides");
  assert.equal(mealTypeFor(dish({ id: "S5", section: "Ranch Dishes" })), "Snack");
});

test("mealTypeFor DS/SD win over D/S even though prefixes nest", () => {
  // "DS1" must not be read as "D...S1" and vice versa.
  assert.equal(mealTypeFor(dish({ id: "DS7", section: "Ranch Dishes" })), "Dessert");
  assert.equal(mealTypeFor(dish({ id: "SD12", section: "Ranch Dishes" })), "Sides");
  // And a plain D/S number is still Dinner/Snack.
  assert.equal(mealTypeFor(dish({ id: "D12", section: "Ranch Dishes" })), "Dinner");
  assert.equal(mealTypeFor(dish({ id: "S12", section: "Ranch Dishes" })), "Snack");
});

test("mealTypeFor accepts canonical sections that aren't yet in the vault", () => {
  // Future-proofing: if Kevin adds "## Baking" or "## Sides" to Menu
  // Items.md, those headers map straight through.
  assert.equal(mealTypeFor(dish({ id: "BK1", section: "Baking" })), "Baking");
  assert.equal(mealTypeFor(dish({ id: "FD1", section: "Fondue" })), "Fondue");
  assert.equal(mealTypeFor(dish({ id: "PZ1", section: "Pizza" })), "Pizza");
  assert.equal(mealTypeFor(dish({ id: "SD1", section: "Sides" })), "Sides");
  assert.equal(mealTypeFor(dish({ id: "SD1", section: "Side" })), "Sides"); // singular→plural
});

test("mealTypeFor unknown section + unknown prefix → Other", () => {
  assert.equal(mealTypeFor(dish({ id: "MK64", section: "Mystery Section" })), "Other");
  assert.equal(mealTypeFor(dish({ id: "ZZ1", section: "" })), "Other");
});

test("renderMealPlanner header, title, basename, folder", () => {
  const out = renderMealPlanner([dish({ id: "BM9", dish: "Ramekin Denver Egg Bake", section: "Breakfast" })], "2026-10-15");
  assert.equal(out.suggestedBasename, "Meal Planner — 2026-10-15");
  assert.equal(out.folder, "Health HUB/Meal Planning");
  assert.match(out.body, /^---\ntags: \[meal-planner\]\ncreated: 2026-10-15\nperiod: ""\nmeals:\n(?:  - \w+\n)+---\n\n# Meal Planner — 2026-10-15\n/);
});

test("renderMealPlanner top ## Dishes summary lists every dish", () => {
  const out = renderMealPlanner(
    [
      dish({ id: "BM9", dish: "Egg Bake", section: "Breakfast" }),
      dish({ id: "L22", dish: "Caesar Wrap", section: "Lunch" }),
      dish({ id: "B18", dish: "Carne Asada Tacos", section: "Ranch Dishes" }),
    ],
    "2026-10-15",
  );
  const summary = out.body.match(/## Dishes\n((?:- [^\n]+\n)+)/)[1];
  const lines = summary.trim().split("\n");
  assert.deepEqual(new Set(lines), new Set([
    "- BM9 — Egg Bake",
    "- L22 — Caesar Wrap",
    "- B18 — Carne Asada Tacos",
  ]));
});

test("renderMealPlanner section order and per-dish body", () => {
  const out = renderMealPlanner(
    [
      dish({ id: "DS1", dish: "Fried Ice Cream", section: "Ranch Dishes" }),
      dish({ id: "B2", dish: "Chorizo Burrito", section: "Ranch Dishes" }),
      dish({ id: "L22", dish: "Caesar Wrap", section: "Lunch" }),
    ],
    "2026-10-15",
  );
  // Section headings in order.
  const indices = ["## Breakfast", "## Lunch", "## Dessert"].map((h) => out.body.indexOf(h));
  assert.ok(indices[0] >= 0, "Breakfast present");
  assert.ok(indices[0] < indices[1], "Breakfast before Lunch");
  assert.ok(indices[1] < indices[2], "Lunch before Dessert");
  // Per-dish entries.
  assert.match(out.body, /### B2 — Chorizo Burrito\nRecipe: \[\[Health HUB\/Recipes#B2 — Chorizo Burrito\|B2\]\]/);
  assert.match(out.body, /### L22 — Caesar Wrap\nRecipe: \[\[Health HUB\/Recipes#L22 — Caesar Wrap\|L22\]\]/);
  assert.match(out.body, /### DS1 — Fried Ice Cream\nRecipe: \[\[Health HUB\/Recipes#DS1 — Fried Ice Cream\|DS1\]\]/);
});

test("renderMealPlanner hides empty sections", () => {
  const out = renderMealPlanner(
    [dish({ id: "B2", dish: "Chorizo Burrito", section: "Ranch Dishes" })],
    "2026-10-15",
  );
  // Only Breakfast should appear as a section header.
  for (const m of MEAL_TYPE_ORDER) {
    const header = `## ${m}`;
    if (m === "Breakfast") assert.ok(out.body.includes(header), `${header} present`);
    else assert.ok(!out.body.includes(header), `${header} absent`);
  }
});

test("renderMealPlanner emits ingredient lines when ingredients are present", () => {
  const out = renderMealPlanner(
    [
      dish({
        id: "BM9",
        dish: "Egg Bake",
        section: "Breakfast",
        ingredients: [ing("eggs", 4, "whole", "4 whole"), ing("milk", 2, "tbsp", "2 tbsp")],
      }),
    ],
    "2026-10-15",
  );
  assert.match(out.body, /### BM9 — Egg Bake\nRecipe: \[\[Health HUB\/Recipes#BM9 — Egg Bake\|BM9\]\]\n- 4 eggs\n- 2 tbsp milk/);
});

test("renderMealPlanner tolerates a dish with no ingredients", () => {
  const out = renderMealPlanner(
    [dish({ id: "B99", dish: "Mystery", section: "Ranch Dishes", ingredients: [] })],
    "2026-10-15",
  );
  // Heading + Recipe link present; no bullet lines follow before EOF.
  assert.match(out.body, /### B99 — Mystery\nRecipe: \[\[Health HUB\/Recipes#B99 — Mystery\|B99\]\]\n\n## Links/);
});

test("renderMealPlanner ends with a single trailing newline", () => {
  const out = renderMealPlanner(
    [dish({ id: "BM9", dish: "Egg Bake", section: "Breakfast" })],
    "2026-10-15",
  );
  assert.ok(out.body.endsWith("\n"));
  assert.ok(!out.body.endsWith("\n\n"));
});
