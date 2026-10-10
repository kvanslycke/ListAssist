// Enumerate hub folders in the vault, locate each hub's Main note,
// and surface up to N existing note titles per hub for the model's
// related-note enum. Pure — accepts a passed-in list of files so the
// obsidian-side wrapper (main.ts / session.ts) stays thin and tests
// can drive this with synthetic data.
//
// The vault's hub-folder convention is "<Name> HUB" (one typo'd
// "Work HUb" is a known artifact of the vault's history). Both forms
// are recognized.

export interface VaultFileInfo {
  path: string;      // vault-relative, forward slashes
  basename: string;  // filename without extension
}

export interface HubInfo {
  hubFolder: string;              // vault-relative folder path, e.g. "Shopping HUB"
  hubName: string;                // "Shopping"
  mainNotePath: string | null;    // "Shopping HUB/Shopping Main.md" if found, else null
  noteTitles: string[];           // basenames (not including Main)
}

export interface VaultIndex {
  hubs: Map<string, HubInfo>;     // hubFolder -> HubInfo
}

export interface BuildOptions {
  maxTitlesPerHub?: number;       // default 10
}

const HUB_FOLDER_RE = /^(?<name>.+?)\s(?:HUB|HUb)$/;

export function buildVaultIndex(
  files: readonly VaultFileInfo[],
  opts: BuildOptions = {},
): VaultIndex {
  const max = opts.maxTitlesPerHub ?? 10;

  // Discover hub folders from file paths. Any top-level folder whose
  // basename matches HUB_FOLDER_RE is a hub.
  const hubs = new Map<string, HubInfo>();
  for (const f of files) {
    const topFolder = topFolderOf(f.path);
    if (!topFolder) continue;
    const m = HUB_FOLDER_RE.exec(topFolder);
    if (!m) continue;
    if (!hubs.has(topFolder)) {
      hubs.set(topFolder, {
        hubFolder: topFolder,
        hubName: m.groups!.name,
        mainNotePath: null,
        noteTitles: [],
      });
    }
  }

  // Second pass: for each file, if it belongs to a hub, see if it's
  // the Main note or append to the hub's note titles.
  for (const f of files) {
    const topFolder = topFolderOf(f.path);
    if (!topFolder) continue;
    const hub = hubs.get(topFolder);
    if (!hub) continue;
    if (f.basename === `${hub.hubName} Main`) {
      hub.mainNotePath = f.path;
      continue;
    }
    if (hub.noteTitles.length < max) {
      hub.noteTitles.push(f.basename);
    }
  }

  // Stable sort for deterministic enums.
  for (const hub of hubs.values()) {
    hub.noteTitles.sort((a, b) => a.localeCompare(b));
  }

  return { hubs };
}

function topFolderOf(path: string): string | null {
  const i = path.indexOf("/");
  if (i < 0) return null;
  return path.slice(0, i);
}

// Convenience: list of hub folders for a settings dropdown. Sorted.
export function hubFolders(index: VaultIndex): string[] {
  return Array.from(index.hubs.keys()).sort((a, b) => a.localeCompare(b));
}

// Convenience: lookup the Main-note wikilink for a given folder path
// (any depth beneath the hub, or the hub folder itself). Returns the
// link target (basename) or null if the folder isn't under a hub.
export function hubMainLinkFor(index: VaultIndex, folderPath: string): string | null {
  const topFolder = folderPath.includes("/")
    ? folderPath.slice(0, folderPath.indexOf("/"))
    : folderPath;
  const hub = index.hubs.get(topFolder);
  if (!hub) return null;
  // Prefer the real Main-note basename; fall back to the derived name.
  if (hub.mainNotePath) {
    const base = hub.mainNotePath.split("/").pop() ?? "";
    return base.replace(/\.md$/i, "");
  }
  return `${hub.hubName} Main`;
}
