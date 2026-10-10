// Compile Smart Note core modules (anything under src/smart/ that does
// NOT import the obsidian runtime) into .test-build/ so node:test can
// load them. Keeps tests zero-dep: esbuild is already a devDep.
//
// The plugin's own `src/main.ts` bundle still goes through
// esbuild.config.mjs; this is a separate, test-only build.

import { build } from "esbuild";
import { glob } from "node:fs/promises";
import path from "node:path";

const entries = [];
for await (const match of glob("src/smart/*.ts")) {
  entries.push(match);
}

if (entries.length === 0) {
  // No Smart Note modules yet — nothing to compile. Tests that import
  // from .test-build/ will fail at import time, which is the expected
  // behavior before the real modules land.
  console.log("test-build: no src/smart/*.ts files yet; skipping.");
  process.exit(0);
}

await build({
  entryPoints: entries,
  outdir: ".test-build",
  outbase: "src",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: "inline",
  logLevel: "info",
  // obsidian runtime is NOT installed in a Node process. Core modules
  // are expected to be free of it; declaring it external just gives a
  // clearer error if someone accidentally imports it.
  external: ["obsidian"],
});

console.log(`test-build: compiled ${entries.length} entry points to .test-build/`);
