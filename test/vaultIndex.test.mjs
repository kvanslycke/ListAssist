import { test } from "node:test";
import assert from "node:assert/strict";

const { buildVaultIndex, hubFolders, hubMainLinkFor } = await import(
  "../.test-build/smart/vaultIndex.js"
);

const synthetic = [
  { path: "Shopping HUB/Shopping Main.md", basename: "Shopping Main" },
  { path: "Shopping HUB/Grocery List — 2026-10-10.md", basename: "Grocery List — 2026-10-10" },
  { path: "Shopping HUB/Grocery List — 2026-10-09.md", basename: "Grocery List — 2026-10-09" },
  { path: "People HUB/People Main.md", basename: "People Main" },
  { path: "People HUB/Dave.md", basename: "Dave" },
  { path: "People HUB/Karin.md", basename: "Karin" },
  { path: "Work HUb/Work Main.md", basename: "Work Main" },  // the "HUb" typo
  { path: "Work HUb/Project X.md", basename: "Project X" },
  { path: "Reference HUB/Rapids System.md", basename: "Rapids System" },  // hub with no Main
  { path: "Templates HUB/Grocery List Template.md", basename: "Grocery List Template" },
  { path: "loose-note.md", basename: "loose-note" }, // not under any hub
  { path: ".obsidian/plugins/list-assistant/data.json", basename: "data" }, // non-hub, not md
];

test("hub folders are discovered (HUB and HUb variants)", () => {
  const idx = buildVaultIndex(synthetic);
  const names = hubFolders(idx);
  assert.deepEqual(names, [
    "People HUB",
    "Reference HUB",
    "Shopping HUB",
    "Templates HUB",
    "Work HUb",
  ]);
});

test("Main notes are located per hub", () => {
  const idx = buildVaultIndex(synthetic);
  assert.equal(idx.hubs.get("Shopping HUB").mainNotePath, "Shopping HUB/Shopping Main.md");
  assert.equal(idx.hubs.get("People HUB").mainNotePath, "People HUB/People Main.md");
  assert.equal(idx.hubs.get("Work HUb").mainNotePath, "Work HUb/Work Main.md");
  assert.equal(idx.hubs.get("Reference HUB").mainNotePath, null);
});

test("note titles exclude the Main note and are sorted", () => {
  const idx = buildVaultIndex(synthetic);
  assert.deepEqual(idx.hubs.get("Shopping HUB").noteTitles, [
    "Grocery List — 2026-10-09",
    "Grocery List — 2026-10-10",
  ]);
  assert.deepEqual(idx.hubs.get("People HUB").noteTitles, ["Dave", "Karin"]);
});

test("maxTitlesPerHub caps the result", () => {
  const many = [];
  for (let i = 0; i < 25; i++) {
    many.push({ path: `Big HUB/Note ${String(i).padStart(2, "0")}.md`, basename: `Note ${String(i).padStart(2, "0")}` });
  }
  const idx = buildVaultIndex(many, { maxTitlesPerHub: 5 });
  assert.equal(idx.hubs.get("Big HUB").noteTitles.length, 5);
});

test("hubMainLinkFor resolves folder paths at any depth", () => {
  const idx = buildVaultIndex(synthetic);
  assert.equal(hubMainLinkFor(idx, "Shopping HUB"), "Shopping Main");
  assert.equal(hubMainLinkFor(idx, "Shopping HUB/Receipts/2026"), "Shopping Main");
  // Hub without a Main note — falls back to the derived name.
  assert.equal(hubMainLinkFor(idx, "Reference HUB"), "Reference Main");
  assert.equal(hubMainLinkFor(idx, "no-such-folder"), null);
});
