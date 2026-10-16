// Obsidian-side writer: takes a RenderResult + session context, picks
// a non-colliding path, writes the file through the Obsidian API,
// appends the new note's wikilink to the hub Main note, and handles
// append-mode (Anger Log monthly). Never touches raw fs.

import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import {
  assembleNote,
  assertNoPriorityWrite,
  fileWithAppendedEntry,
  hubMainWithAppendedLink,
  renderAppendEntry,
  resolveCollision,
  type RenderResult,
} from "./writer-core";
import { hubMainLinkFor, buildVaultIndex } from "./vaultIndex";

export interface WriteContext {
  app: App;
  folder: string;                             // vault-relative; "" = root
  linkToHub: boolean;                         // preview checkbox state
  hubLinkHeading?: string;                    // "Notes" or "Projects" (step 12 picks)
  append?: AppendModeContext;                 // non-null for Anger Log
}

export interface AppendModeContext {
  monthlyPath: string;                        // target monthly file path, vault-relative
  entry: string;                              // from renderAppendEntry
  today: string;                              // "YYYY-MM-DD"
}

export interface WriteOutcome {
  file: TFile;
  wasAppend: boolean;
  hubMainUpdated: string | null;              // path updated, or null if not applicable
  path: string;
}

export async function writeSmartNote(
  rendered: RenderResult,
  ctx: WriteContext,
): Promise<WriteOutcome> {
  // Final defence in depth — the writer-core already enforced this.
  assertNoPriorityWrite(rendered.frontmatter);

  const folder = ctx.folder.trim();
  if (folder) await ensureFolder(ctx.app, folder);

  if (ctx.append) {
    return handleAppend(rendered, ctx, ctx.append);
  }

  const basename = rendered.filename;
  const takenInFolder = listFilenamesInFolder(ctx.app, folder);
  const finalName = resolveCollision(basename, takenInFolder);
  const path = folder ? normalizePath(`${folder}/${finalName}`) : finalName;
  const content = assembleNote(rendered);
  const created = (await ctx.app.vault.create(path, content)) as TFile;

  let hubMainUpdated: string | null = null;
  if (ctx.linkToHub) {
    hubMainUpdated = await appendHubLink(ctx.app, folder, created.basename, ctx.hubLinkHeading);
  }
  return { file: created, wasAppend: false, hubMainUpdated, path };
}

async function handleAppend(
  rendered: RenderResult,
  ctx: WriteContext,
  append: AppendModeContext,
): Promise<WriteOutcome> {
  const existing = ctx.app.vault.getAbstractFileByPath(normalizePath(append.monthlyPath));
  if (existing instanceof TFile) {
    await ctx.app.vault.process(existing, (current) =>
      fileWithAppendedEntry(current, append.entry, append.today),
    );
    let hubMainUpdated: string | null = null;
    if (ctx.linkToHub) {
      const folder = parentFolderOf(append.monthlyPath);
      hubMainUpdated = await appendHubLink(ctx.app, folder, existing.basename, ctx.hubLinkHeading);
    }
    return {
      file: existing,
      wasAppend: true,
      hubMainUpdated,
      path: append.monthlyPath,
    };
  }
  // Monthly file doesn't exist yet — create from the rendered template.
  const parent = parentFolderOf(append.monthlyPath);
  if (parent) await ensureFolder(ctx.app, parent);
  const content = assembleNote(rendered);
  // Insert the first entry below the body.
  const withEntry = content.includes("\n---\n") ? `${content.trimEnd()}\n\n${append.entry}\n` : `${content.trimEnd()}\n\n${append.entry}\n`;
  const created = (await ctx.app.vault.create(normalizePath(append.monthlyPath), withEntry)) as TFile;
  let hubMainUpdated: string | null = null;
  if (ctx.linkToHub && parent) {
    hubMainUpdated = await appendHubLink(ctx.app, parent, created.basename, ctx.hubLinkHeading);
  }
  return { file: created, wasAppend: false, hubMainUpdated, path: append.monthlyPath };
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (!path) return;
  const existing = app.vault.getAbstractFileByPath(normalizePath(path));
  if (existing instanceof TFolder) return;
  await app.vault.createFolder(normalizePath(path));
}

function listFilenamesInFolder(app: App, folder: string): Set<string> {
  const out = new Set<string>();
  const path = folder ? normalizePath(folder) : "";
  const target = path ? app.vault.getAbstractFileByPath(path) : app.vault.getRoot();
  if (!(target instanceof TFolder)) return out;
  for (const child of target.children) {
    if (child instanceof TFile && child.extension === "md") out.add(child.name);
  }
  return out;
}

function parentFolderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

async function appendHubLink(
  app: App,
  folder: string,
  noteBasename: string,
  heading?: string,
): Promise<string | null> {
  const files = app.vault.getMarkdownFiles().map((f) => ({ path: f.path, basename: f.basename }));
  const index = buildVaultIndex(files);
  const linkTarget = hubMainLinkFor(index, folder);
  if (!linkTarget) return null;
  const mainPath = findMainNotePath(app, folder, linkTarget);
  if (!mainPath) return null;
  const file = app.vault.getAbstractFileByPath(mainPath);
  if (!(file instanceof TFile)) return null;
  const effectiveHeading = heading ?? "Notes";
  await app.vault.process(file, (current) =>
    hubMainWithAppendedLink(current, noteBasename, effectiveHeading),
  );
  return mainPath;
}

function findMainNotePath(app: App, folder: string, mainBasename: string): string | null {
  const topFolder = folder.includes("/") ? folder.slice(0, folder.indexOf("/")) : folder;
  const candidate = normalizePath(`${topFolder}/${mainBasename}.md`);
  const file = app.vault.getAbstractFileByPath(candidate);
  if (file instanceof TFile) return candidate;
  return null;
}

// Write an auxiliary note (e.g. the Meal Planner emitted alongside a
// Grocery note). Same folder as the main note, no frontmatter
// assembly, no hub-link side-effect — the body is already fully
// rendered markdown.
export async function writeExtraArtifact(
  app: App,
  folder: string,
  basename: string,
  body: string,
): Promise<TFile> {
  const trimmed = folder.trim();
  if (trimmed) await ensureFolder(app, trimmed);
  const taken = listFilenamesInFolder(app, trimmed);
  const safeBase = `${basename}.md`;
  const finalName = resolveCollision(safeBase, taken);
  const path = trimmed ? normalizePath(`${trimmed}/${finalName}`) : finalName;
  return (await app.vault.create(path, body)) as TFile;
}

export function notifyWritten(outcome: WriteOutcome): void {
  const kind = outcome.wasAppend ? "Appended to" : "Created";
  const hub = outcome.hubMainUpdated ? `\nLinked in ${outcome.hubMainUpdated}` : "";
  new Notice(`${kind} ${outcome.path}${hub}`);
}
