import { test } from "node:test";
import assert from "node:assert/strict";

const { suggestFolder, tripPackingFolder, DEFAULT_SEED_TABLE } = await import(
  "../.test-build/smart/router.js"
);

const ENUM = [
  "Shopping HUB",
  "Health HUB/Anger MGMT/AngerLogs",
  "People HUB",
  "K&K Ranch HUB",
  "Adventures & Dates HUB",
  "Automobile HUB",
  "Hobbies HUB/Projects",
  "Reference HUB",
  "Daily Notes",
  "Weird Folder",
];

test("lastUsed wins when present and in enum", () => {
  const r = suggestFolder({
    templateBasename: "Grocery List Template",
    folderEnum: ENUM,
    lastUsed: "Weird Folder",
    modelPick: { folder: "People HUB", reason: "nope" },
  });
  assert.equal(r.folder, "Weird Folder");
  assert.match(r.reason, /Last folder/);
});

test("lastUsed ignored when not in enum", () => {
  const r = suggestFolder({
    templateBasename: "Grocery List Template",
    folderEnum: ENUM,
    lastUsed: "Deleted Folder",
  });
  assert.equal(r.folder, "Shopping HUB");
});

test("model pick wins over seed when enum-valid", () => {
  const r = suggestFolder({
    templateBasename: "Note Template",
    folderEnum: ENUM,
    modelPick: { folder: "Reference HUB", reason: "note is reference-y" },
  });
  assert.equal(r.folder, "Reference HUB");
  assert.equal(r.reason, "note is reference-y");
});

test("falls back to seed table when no lastUsed or modelPick", () => {
  const r = suggestFolder({
    templateBasename: "Anger Log Template",
    folderEnum: ENUM,
  });
  assert.equal(r.folder, "Health HUB/Anger MGMT/AngerLogs");
  assert.match(r.reason, /appended to/);
});

test("falls back to vault root when nothing matches", () => {
  const r = suggestFolder({
    templateBasename: "Totally Unknown Template",
    folderEnum: ENUM,
  });
  assert.equal(r.folder, "");
});

test("DEFAULT_SEED_TABLE lacks seeds for model-chosen templates", () => {
  for (const name of [
    "Plan Of The Day Template",
    "Note Template",
    "List Template",
    "To-Do List Template",
    "Inventory Template",
  ]) {
    assert.ok(!DEFAULT_SEED_TABLE.has(name), `${name} should not be seeded`);
  }
});

test("tripPackingFolder routes ranch mentions to K&K Ranch HUB", () => {
  const r = tripPackingFolder("Weekend at the ranch with Karin", ENUM);
  assert.equal(r.folder, "K&K Ranch HUB");
});

test("tripPackingFolder defaults to Adventures & Dates HUB otherwise", () => {
  const r = tripPackingFolder("Pagosa Springs weekend getaway", ENUM);
  assert.equal(r.folder, "Adventures & Dates HUB");
});
