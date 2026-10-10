// Folder-routing suggestion for Smart Note's preview preselect.
// Pure — called by the obsidian-side session with the current vault
// folder list, settings seeds, settings last-used memory, and the
// model's enum pick.
//
// Priority order (first non-empty match wins):
//   1. Last-used folder for this template (user already overrode the
//      suggestion in a prior session; respect that).
//   2. The model's enum pick (text-only, must be in folderEnum).
//   3. The seed table (default per-template folder from the handoff).
//   4. Vault root ("").
//
// The result includes a one-line reason so the preview can show it
// under the folder dropdown.

export const DEFAULT_SEED_TABLE: ReadonlyMap<string, string> = new Map([
  ["Anger Log Template", "Health HUB/Anger MGMT/AngerLogs"],
  ["Auto Maintenance Checklist Template", "Automobile HUB"],
  ["Daily Note Template", "Daily Notes"],
  ["Grocery List Template", "Shopping HUB"],
  ["Menu Template", "K&K Ranch HUB"],
  ["Person Template", "People HUB"],
  ["Project Template", "Hobbies HUB/Projects"],
  ["Rapids System Template", "Reference HUB"],
  ["Trip Packing Checklist Template", "K&K Ranch HUB"],
  // Templates below are intentionally not seeded — the model picks:
  //   Plan Of The Day Template, Note Template, List Template,
  //   To-Do List Template, Inventory Template.
]);

export interface RoutingInput {
  templateBasename: string;                    // e.g. "Grocery List Template"
  folderEnum: readonly string[];               // all pickable vault folders (excludeList already applied)
  modelPick?: { folder: string; reason: string } | null;
  lastUsed?: string | null;                    // from settings.destinationFolderByTemplate[templateBasename]
  seedTable?: ReadonlyMap<string, string>;     // defaults to DEFAULT_SEED_TABLE
}

export interface RoutingResult {
  folder: string;    // "" means vault root
  reason: string;
}

export function suggestFolder(input: RoutingInput): RoutingResult {
  const seeds = input.seedTable ?? DEFAULT_SEED_TABLE;
  const inEnum = (f: string): boolean => input.folderEnum.includes(f);

  if (input.lastUsed && inEnum(input.lastUsed)) {
    return { folder: input.lastUsed, reason: "Last folder you used for this template." };
  }
  if (
    input.modelPick &&
    input.modelPick.folder &&
    inEnum(input.modelPick.folder)
  ) {
    return {
      folder: input.modelPick.folder,
      reason: input.modelPick.reason || "Model suggestion from note content.",
    };
  }
  const seed = seeds.get(input.templateBasename);
  if (seed && inEnum(seed)) {
    return { folder: seed, reason: seedReason(input.templateBasename, seed) };
  }
  return { folder: "", reason: "No seeded default — pick a folder." };
}

function seedReason(templateBasename: string, folder: string): string {
  // Short, human-readable justification tailored to a few templates.
  switch (templateBasename) {
    case "Grocery List Template":
      return `Grocery lists live in ${folder}.`;
    case "Anger Log Template":
      return `Anger logs are appended to ${folder}/Anger Log <MMMM YYYY>.md.`;
    case "Auto Maintenance Checklist Template":
      return `Vehicle maintenance belongs in ${folder}.`;
    case "Daily Note Template":
      return `Daily notes are organized by date in ${folder}.`;
    case "Menu Template":
      return `Ranch menu planning lives in ${folder}.`;
    case "Person Template":
      return `People notes live in ${folder}.`;
    case "Project Template":
      return `Projects live in ${folder}.`;
    case "Rapids System Template":
      return `Rapids reference notes live in ${folder}.`;
    case "Trip Packing Checklist Template":
      return `Trip gear lists default to ${folder}.`;
    default:
      return `Default folder for this template: ${folder}.`;
  }
}

// Convenience for the Trip Packing special case: the handoff's seed
// is "K&K Ranch HUB if about the ranch, else Adventures & Dates HUB".
// Session calls this after extraction so the model's description text
// can shift the destination.
export function tripPackingFolder(
  description: string,
  folderEnum: readonly string[],
): RoutingResult | null {
  const text = description.toLowerCase();
  const mentionsRanch = /\branch\b|k&k|k and k|kyle|karin|ranch/.test(text);
  const target = mentionsRanch ? "K&K Ranch HUB" : "Adventures & Dates HUB";
  if (!folderEnum.includes(target)) return null;
  return {
    folder: target,
    reason: mentionsRanch
      ? "Trip description mentions the ranch."
      : "No ranch cues — defaulting to Adventures & Dates HUB.",
  };
}
