# List Assistant

An Obsidian plugin that helps run a vault as a personal executive-function
system. Ships in phases:

| Phase | Ships | Status |
|---|---|---|
| 1 | Template walkthrough — command + ribbon icon that scans your Templates folder, infers prompts from frontmatter fields and `{{placeholders}}`, and creates the note. | **Current** |
| 2 | Daily Eisenhower triage — scans notes with `priority:` set, writes `/Daily Priorities/YYYY-MM-DD.md`. | Next |
| 3 | Google Calendar sync — `due:` becomes an event (Q1 at 16:00 America/Denver on due date; Q2 reminder 3 days before); Plan of the Day `rapids-class` → full time-blocked chain. | After |
| 4 | Windows Task Scheduler + desktop shortcut to fire triage at midnight and on demand. | Last |

## Design tenets

- **Mobile-safe.** One codebase, runs on Surface Pro and Android via Obsidian
  Mobile. No Node APIs, no `fs`, no `child_process`.
- **You own priorities.** The plugin never writes or edits any `priority:`
  field. It reads them for triage and calendar sync; you set them.
- **Vault is source of truth.** All state lives in markdown files. Obsidian
  Sync handles cross-device propagation.

## Frontmatter contract

See [`docs/FRONTMATTER.md`](docs/FRONTMATTER.md) for the fields the plugin
recognizes and how each is treated.

## Install (dev)

Requires [Git](https://git-scm.com/download/win) and
[Node.js](https://nodejs.org) (LTS) on PATH.

### Windows (Surface Pro)

Clone, check out the current feature branch, install and build:

```cmd
cd C:\Users\kevin
git clone https://github.com/kvanslycke/ListAssist.git
cd ListAssist
git checkout claude/blissful-keller-dxphie
npm install
npm run build
```

Copy the built plugin into the vault (adjust the vault path if yours
differs):

```cmd
mkdir "C:\Users\kevin\KevinsRoots\Obsidian Vault\KevlarMainVault\.obsidian\plugins\list-assistant"
copy manifest.json "C:\Users\kevin\KevinsRoots\Obsidian Vault\KevlarMainVault\.obsidian\plugins\list-assistant\"
copy main.js "C:\Users\kevin\KevinsRoots\Obsidian Vault\KevlarMainVault\.obsidian\plugins\list-assistant\"
```

In Obsidian: **Settings → Community plugins**, disable Restricted mode
if needed, reload plugins, find **List Assistant** and toggle it on.
Obsidian Sync propagates the plugin folder to the Android app
automatically.

### macOS / Linux

```bash
git clone https://github.com/kvanslycke/ListAssist.git
cd ListAssist
git checkout claude/blissful-keller-dxphie
npm install
npm run build
cp manifest.json main.js "$VAULT/.obsidian/plugins/list-assistant/"
```

### Live-reloading during development

```
npm run dev
```

## Commands

- **List Assistant: Create note from template** — command palette entry,
  also available as the file-plus ribbon icon.

## Repo layout

```
manifest.json         Obsidian plugin manifest
package.json          npm deps and scripts
tsconfig.json         TypeScript config
esbuild.config.mjs    Bundler
src/
  main.ts             Plugin entry, commands, ribbon
  settings.ts         Settings tab
  template-parser.ts  YAML frontmatter + placeholder inference
  template-picker.ts  Fuzzy-suggest for template selection
  create-note-modal.ts Fill-in modal
  util.ts             Date, slug, substitution helpers
docs/
  FRONTMATTER.md      Field schema the plugin recognizes
```
