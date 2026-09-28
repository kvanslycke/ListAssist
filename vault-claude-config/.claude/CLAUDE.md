# Kevin's Obsidian vault — primer for Claude Code

This is the KevlarMainVault: a personal knowledge base at
`C:\Users\kevin\KevinsRoots\Obsidian Vault\KevlarMainVault\`. It's
organized by HUB folders (Adventures HUB, Automobile HUB, Health HUB,
Hobbies HUB, K&K Ranch HUB, Reference HUB, Sentinel System, Templates
HUB, Websites HUB, People HUB, and so on), with each hub's `<Hub> Main.md`
acting as its index note.

## Ground rules (non-negotiable)

- **Never write or edit the `priority:` frontmatter field.** Kevin
  owns it. Reading it is fine; writing it is not, ever, on any note.
- **Use the existing tag taxonomy** documented in
  `Reference HUB/Tags.md`. When a new tag genuinely fills a gap, add
  it to Tags.md's list so it stays canonical, don't just start using
  it silently.
- **Don't fabricate notes.** If a wikilink points at nothing, either
  create a real note with real content sourced from what other notes
  say about it, or fix the link — don't leave a placeholder stub.
- **Preserve existing content.** Add and augment; don't rewrite a
  note's substance unless explicitly asked.
- **Obsidian Sync is the source of truth for cross-device state.**
  Don't move files into folders that Obsidian Sync excludes.
- **Report before deleting.** If a file looks like a stray duplicate,
  flag it for Kevin to confirm; only delete when he says so.

## List Assistant plugin frontmatter contract

The vault runs the List Assistant Obsidian plugin (source:
`C:\Users\kevin\ListAssist\`). It reads these frontmatter fields:

| Property | Values | What it drives |
|---|---|---|
| `priority` | `q1` \| `q2` \| `q3` \| `q4` (or empty = untriaged) | Daily triage bucketing; Q1/Q2 + `due:` → calendar events. |
| `Priority Level` | Legacy `1: …` through `4: …` | Same as `priority`, accepted for backward compat. |
| `due` | `YYYY-MM-DD` | Calendar event date. |
| `status` | `not-started` / `doing` / `done` / `completed` / `cancelled` | Anything "done"-ish excludes the note from triage and sync. |
| `date` | `YYYY-MM-DD` | The day a Plan-of-the-Day / Rapids System note is about. |
| `rapids-class` | `1`–`5` | Fires a full time-blocked event chain from the Rapids System template on `date`. |
| `tags` | list | Obsidian graph + taxonomy in Tags.md. |

The plugin **never writes** any of these except during initial note
creation from a template. Same rule applies to you: never write
`priority:`; the others are fair game only when the task explicitly
calls for it.

Only actionable notes (Project, Grocery, Inventory, List, To-Do, Trip
Packing when active) carry `priority`. Reference notes, journal
entries, dailies, and hub indexes don't need it — don't add it to
them.

## Where reports go

- Deterministic audit output (from the plugin): `Vault Audits/YYYY-MM-DD.md`
- Semantic audit output (from `/vault-audit`): `Vault Audits/YYYY-MM-DD-semantic.md`
- Daily priorities (from the plugin): `Daily Priorities/YYYY-MM-DD.md`
- Anything from `/vault-tag-pass`: report inline at the end of the
  session; the edits themselves go into the affected notes.

Create the folder if it doesn't exist yet.

## Style

- Kevin is direct and hates padding. Keep responses lean. Say what
  you did, not what you thought about doing.
- If you're about to spend an unusual amount of time or do something
  irreversible, name it first and wait for confirmation.
