// Spoken dish NAMES (no ID) must not become grocery items.
// Real cases from Kevin's 2026-10-27 list: "Maple bacon corn fritters",
// whisper's "Riddled pumpkin whoopie pie cakes" (Griddled …), "Chicken
// fried steak" while D2 was already on the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMenuItems, matchDishNames } from "../.test-build/smart/menuItems.js";
import { parseGroceryUnits } from "../.test-build/smart/groceryUnits.js";
import {
  createSession,
  pickTemplate,
  submitCapture,
  answerFollowUp,
  answerGroceryExtras,
  answerGroceryDishConfirm,
} from "../.test-build/smart/session.js";

const MENU = `
# Menu Items

## Lunch

| ID | Dish | Ingredients |
|---|---|---|
| L2 | Buttermilk Onion Rings | sweet onion: 1 large; buttermilk: 1 cup |
| L21 | Maple-Bacon Corn Fritters | frozen corn: 1.5 cup; bacon: 4 slice; maple syrup: 2 tbsp |

## Dinner

| ID | Dish | Ingredients |
|---|---|---|
| D2 | Chicken-Fried Steak with Cream Gravy | cube steaks: 10 oz; whole milk: 1 cup |

## Dessert

| ID | Dish | Ingredients |
|---|---|---|
| DS19 | Griddled Pumpkin Whoopie Pie Cakes | pancake mix: 1 cup; canned pumpkin puree: 0.5 can |

## Pinterest Sides

| ID | Dish | Ingredients |
|---|---|---|
| PS7 | Air Fryer Onion Rings | yellow onion: 1 whole |

## Middle Kitchen

| ID | Dish | Ingredients |
|---|---|---|
| MK8 | Smothered Pork Chops | bone-in pork chops: 2 whole |
| BM74 | Tostadas (Beef, Chicken, or Bean) | tostada shells: 4 whole |
`;

const UNITS = `
| Ingredient | Store Unit | Store Unit Size | Recipe Unit | Aliases | Notes | Department |
| --- | --- | --- | --- | --- | --- | --- |
| bacon | pack | 12 | slice |  |  | Meat & Seafood |
| frozen corn | bag | 4 | cup |  |  | Frozen |
| whole milk | half-gallon | 8 | cup | milk |  | Dairy & Refrigerated |
`;

const GROCERY_TEMPLATE = `---
tags:
  - list
  - grocery
created: {{date}}
period:
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

## 🧊 Frozen
- [ ] 

## 🛒 Snacks & Household
- [ ] 

## 🐾 Pets & Ranch
- [ ] 
`;

const menu = () => parseMenuItems(MENU);
const ids = (r) => r.matches.map((m) => m.id);

test("matchDishNames: an exact dish name maps to its ID", () => {
  const r = matchDishNames("maple bacon corn fritters", menu());
  assert.deepEqual(ids(r), ["L21"]);
  assert.equal(r.rest.trim(), "");
});

test("matchDishNames: a one-letter whisper slip still matches (Riddled → Griddled)", () => {
  assert.deepEqual(ids(matchDishNames("Riddled pumpkin whoopie pie cakes", menu())), ["DS19"]);
});

test("matchDishNames: a dish named without its 'with …' tail matches", () => {
  assert.deepEqual(ids(matchDishNames("Chicken fried steak", menu())), ["D2"]);
});

test("matchDishNames: plain grocery items and dish fragments do not match", () => {
  for (const s of ["cream gravy", "bacon", "ham", "fryer oil", "deodorant", "dog food"]) {
    assert.deepEqual(ids(matchDishNames(s, menu())), [], s);
  }
});

test("matchDishNames: a dish already on the list wins a tie-ish match", () => {
  assert.deepEqual(ids(matchDishNames("onion rings", menu(), ["L2"])), ["L2"]);
});

test("matchDishNames: run-on dictation keeps the real items in rest", () => {
  const r = matchDishNames("bacon, ham, maple bacon corn fritters and dog food", menu());
  assert.deepEqual(ids(r), ["L21"]);
  assert.match(r.rest, /bacon/);
  assert.match(r.rest, /ham/);
  assert.match(r.rest, /dog food/);
  assert.doesNotMatch(r.rest, /fritters/);
});

function session(calls) {
  const deps = {
    templates: [{ basename: "Grocery List Template", path: "Templates HUB/Grocery List Template.md", raw: GROCERY_TEMPLATE }],
    chat: async (req) => {
      calls.push(req);
      return { parsed: { "🛒 Snacks & Household": ["deodorant"] }, retried: false };
    },
    nowISODate: () => "2026-10-27",
    nowISOTime: () => "12:00",
    folderEnum: ["Shopping HUB"],
    lastUsedByTemplate: new Map(),
  };
  return pickTemplate(createSession(deps), "grocery").session;
}

async function atExtras(calls) {
  let s = session(calls);
  s = await submitCapture(s, "D2", { expandMenuNumbers: true, menuIndex: menu(), groceryUnits: parseGroceryUnits(UNITS) });
  s = answerFollowUp(s, "Weekend");
  assert.equal(s.followUps[0].kind, "grocery-extras");
  return s;
}

test("extras: a dish name is held back from the model and asked about", async () => {
  const calls = [];
  let s = await atExtras(calls);
  s = await answerGroceryExtras(s, "deodorant, maple bacon corn fritters");
  assert.equal(calls.length, 1);
  const sent = calls[0].messages[1].content;
  assert.match(sent, /deodorant/);
  assert.doesNotMatch(sent, /fritters/);
  assert.equal(s.state, "followUp");
  assert.equal(s.followUps[0].kind, "grocery-dish-confirm");
  assert.match(s.followUps[0].prompt, /L21/);
  assert.match(s.followUps[0].prompt, /Maple-Bacon Corn Fritters/);
});

test("dish confirm 'yes' adds the dish: its ingredients join the list, no model call", async () => {
  const calls = [];
  let s = await atExtras(calls);
  s = await answerGroceryExtras(s, "deodorant, maple bacon corn fritters");
  const before = calls.length;
  s = await answerGroceryDishConfirm(s, "yes");
  assert.equal(calls.length, before, "confirming a dish makes no model call");
  assert.deepEqual(s.menuExpansion.found.map((d) => d.id), ["D2", "L21"]);
  assert.deepEqual(s.extracted["🥩 Meat & Seafood"].filter((l) => /bacon/.test(l)), ["1 pack bacon (from L21)"]);
  assert.ok(s.extracted["🧊 Frozen"].some((l) => /frozen corn/.test(l)));
  // D2's milk line is not duplicated by the rebuild
  assert.equal(s.extracted["🧀 Dairy & Refrigerated"].filter((l) => /milk/.test(l)).length, 1);
  assert.deepEqual(s.extracted["🛒 Snacks & Household"], ["deodorant"]);
  assert.equal(s.state, "review");
});

test("dish confirm 'no' sends the phrase to the model as an ordinary item", async () => {
  const calls = [];
  let s = await atExtras(calls);
  s = await answerGroceryExtras(s, "deodorant, maple bacon corn fritters");
  const before = calls.length;
  s = await answerGroceryDishConfirm(s, "no");
  assert.equal(calls.length, before + 1);
  assert.match(calls.at(-1).messages[1].content, /maple bacon corn fritters/);
  assert.deepEqual(s.menuExpansion.found.map((d) => d.id), ["D2"]);
});

test("dish confirm: a dish already on the list is just dropped on 'yes'", async () => {
  const calls = [];
  let s = await atExtras(calls);
  s = await answerGroceryExtras(s, "chicken fried steak");
  assert.equal(calls.length, 0, "nothing left for the model");
  assert.match(s.followUps[0].prompt, /D2.*already on the list/);
  s = await answerGroceryDishConfirm(s, "yes");
  assert.deepEqual(s.menuExpansion.found.map((d) => d.id), ["D2"]);
  assert.equal(s.state, "review");
});

test("first capture: a dish name in the free-text remainder is asked about too", async () => {
  const calls = [];
  let s = session(calls);
  s = await submitCapture(s, "D2 plus deodorant and maple bacon corn fritters", {
    expandMenuNumbers: true,
    menuIndex: menu(),
    groceryUnits: parseGroceryUnits(UNITS),
  });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].messages[1].content, /fritters/);
  assert.ok(s.followUps.some((q) => q.kind === "grocery-dish-confirm" && /L21/.test(q.prompt)));
});

test("matchDishNames: a phrase that is a known grocery item is never asked about", () => {
  assert.deepEqual(ids(matchDishNames("pork chops", menu())), ["MK8"], "without the grocery table it looks like a dish");
  assert.deepEqual(ids(matchDishNames("pork chops", menu(), [], new Set(["pork chops"]))), []);
  assert.deepEqual(ids(matchDishNames("pork chop", menu(), [], new Set(["pork chops"]))), [], "singular/plural");
});

test("matchDishNames: 'or' is filler, not a dish word", () => {
  assert.deepEqual(ids(matchDishNames("beef or chicken broth", menu())), []);
});

test("knownGroceryNames: ingredients and aliases from Grocery Units", async () => {
  const { knownGroceryNames } = await import("../.test-build/smart/groceryUnits.js");
  const names = knownGroceryNames(parseGroceryUnits(UNITS));
  assert.ok(names.has("bacon"));
  assert.ok(names.has("milk"));
  assert.ok(names.has("whole milk"));
});
