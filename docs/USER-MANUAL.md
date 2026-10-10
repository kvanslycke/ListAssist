---
tags: [reference, list-assistant, manual]
system: List Assistant
version: 0.1.0
updated: 2026-09-28
---

# List Assistant — User Manual

Personal executive-function system for the KevlarMainVault. Six
capabilities across an Obsidian plugin and a Claude Code companion:
template walkthroughs, daily Eisenhower triage, Google Calendar
sync, Windows nightly automation, deterministic vault audit, and
semantic vault work via Claude Code. Zero paid API dependencies.

## Contents

1. [What it does](#what-it-does)
2. [First-time install](#first-time-install)
3. [Daily use — the shape of the workflow](#daily-use)
4. [The frontmatter contract](#the-frontmatter-contract)
5. [Smart Note mode](#smart-note-mode)
6. [Commands, ribbon icons, URIs](#commands-ribbon-icons-uris)
7. [Google Calendar setup](#google-calendar-setup)
8. [Windows nightly automation](#windows-nightly-automation)
9. [Claude Code companion — the semantic layer](#claude-code-companion)
10. [Settings reference](#settings-reference)
11. [Troubleshooting](#troubleshooting)
12. [Uninstall](#uninstall)

---

## What it does

The system has two layers.

**Deterministic layer — the Obsidian plugin.** Runs on the Surface
Pro and (partially) on Android. Zero-cost. Does six things:

| Capability | Trigger | Result |
|---|---|---|
| Template walkthrough | Ribbon `file-plus` or cmd | Modal prompts for each frontmatter field with an empty value or `{{placeholder}}`, writes the new note |
| **Smart Note mode** | Ribbon `mic` or cmd | Fuzzy-match a template by voice/typing, extract fields from one freeform description via local Ollama + gemma4:e2b, up to 3 follow-ups, previewed before save. Fully offline. Falls back to the standard walkthrough when Ollama is down. |
| Daily Eisenhower triage | Ribbon `list-checks` or cmd | Scans every note with `priority:` set, groups by quadrant, writes `Daily Priorities\YYYY-MM-DD.md` |
| Google Calendar sync | Ribbon `calendar-sync` or cmd | Notes with `priority: q1` + `due:` become 16:00–17:00 events; `q2` become all-day reminders 3 days before; Plan of the Day with `rapids-class` fires the full timed chain |
| Vault audit | Ribbon `search-check` or cmd | Nine deterministic checks: untagged notes, broken wikilinks, stubs, duplicates, orphans, sinks, unlinked mentions, entities without a note, URLs without a note. Writes `Vault Audits\YYYY-MM-DD.md`. Never edits notes |
| Nightly automation | Windows Task Scheduler at 00:00 America/Denver | Fires triage + calendar sync automatically |

**Semantic layer — Claude Code companion.** Runs in Claude Code
against your existing Claude subscription (no API metering).
Three slash commands available when `claude` is run from the vault
directory:

- `/vault-audit` — semantic pattern-finding (cross-domain bridges, thematic patterns, suggested links, suggested new notes)
- `/vault-tag-pass` — full sweep: adds missing tags/links, fixes broken wikilinks, respects your taxonomy
- `/frontmatter-check` — verifies actionable notes carry the plugin's frontmatter contract

Both layers respect one non-negotiable rule: **the system never
writes the `priority:` frontmatter field.** You own priority
assignment. (Smart Note enforces this with a unit-tested hard-rule
guard — adversarial model output cannot slip a priority in.)

---

## First-time install

Prerequisites: [Git for Windows](https://git-scm.com/download/win),
[Node.js LTS](https://nodejs.org), Obsidian with Obsidian Sync,
Google account (for Phase 3), Claude subscription (for the semantic
layer).

### 1. Clone and build the plugin (on the Surface)

```cmd
cd C:\Users\kevin
git clone https://github.com/kvanslycke/ListAssist.git
cd ListAssist
git checkout claude/blissful-keller-dxphie
npm install
npm run build
```

That produces `main.js` in the ListAssist folder.

### 2. Install the plugin into the vault

```cmd
mkdir "C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\.obsidian\plugins\list-assistant"

copy manifest.json "C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\.obsidian\plugins\list-assistant\"

copy main.js "C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\.obsidian\plugins\list-assistant\"
```

Then in Obsidian → Settings → Community plugins:

- Toggle **Community plugins** on
- Disable **Restricted mode** if it's on
- Reload plugins, find **List Assistant**, toggle it on

Obsidian Sync propagates the plugin folder to your Android
automatically.

### 3. Set up Google Calendar (optional, one time)

See [Google Calendar setup](#google-calendar-setup) below. Takes
about 5 minutes; only needs to happen once per Google account.

### 4. Install the Windows nightly automation (optional)

From an elevated PowerShell in your ListAssist checkout:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\windows\install.ps1
```

Registers a Task Scheduler entry and drops a desktop shortcut. See
[Windows nightly automation](#windows-nightly-automation).

### 5. Install the Claude Code companion (optional)

```powershell
robocopy "C:\Users\kevin\ListAssist\vault-claude-config\.claude" `
         "C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\.claude" /E
```

That's it. See [Claude Code companion](#claude-code-companion).

---

## Daily use

A typical day, once everything is installed:

- **Morning.** Open Obsidian. The `Daily Priorities\<today>.md` note
  is already there — the nightly task wrote it at midnight.
- **Look at Q1.** Anything that needs to happen today.
- **Look at "Needs triage."** Notes you created recently that have
  a `priority:` field but haven't been set. Assign each one a
  quadrant.
- **Create new work as it comes up.** Ribbon `file-plus` →
  pick a template → fill in the modal. New note ships with the
  frontmatter contract already set; you assign `priority` after.
- **When something's actually urgent.** Set `priority: q1` and
  `due: YYYY-MM-DD` on that note. Click the calendar-sync ribbon
  icon. A blocked-time event appears on your Google Calendar at
  16:00–17:00 on the due date.
- **Plan of the Day.** Set `rapids-class:` to the number and
  `date:` to today. Sync calendar. The whole chain fires as timed
  events.
- **When the vault feels stale.** Click the search-check ribbon
  icon (or run the audit URI). Read `Vault Audits\<today>.md` for
  the punch list.
- **When you want the vault re-linked semantically.** Open a
  terminal in the vault directory, run `claude`, type
  `/vault-tag-pass`.

---

## The frontmatter contract

The properties the plugin reads. Set Obsidian property types in
**Settings → Files & Links → Property types** so autocomplete kicks
in.

| Property | Obsidian type | Valid values | Plugin writes? |
|---|---|---|---|
| `priority` | Text | `q1`, `q2`, `q3`, `q4` — or empty | **Never.** You own it |
| `Priority Level` | Text | `1: …` … `4: …` (legacy Grocery-style) | Never |
| `due` | Date | `YYYY-MM-DD` | Never |
| `status` | Text | `not-started`, `doing`, `done`, `completed`, `cancelled`, `canceled` | Never |
| `date` | Date | `YYYY-MM-DD` (the day a note is *about*) | Never |
| `rapids-class` | Number | `1`–`5` | Never |
| `tags` | Tags | Free-form | Never |
| `created` / `updated` | Date | `YYYY-MM-DD` | Written **once** at note creation from a template |

### What the combinations do

- `priority: q1` + `due:` → **1-hour event at 16:00 America/Denver on the due date.** Times configurable in settings.
- `priority: q2` + `due:` → **all-day reminder 3 days before due.** Days configurable.
- `priority: q3` or `q4` → **never touches the calendar.** Still shows up in triage.
- `priority:` present but empty → note lands in the daily report's **Needs triage** section.
- Any `status:` in `done | completed | complete | cancelled | canceled` → note is skipped by both triage and calendar sync.
- `rapids-class:` set + `date:` set on a Plan of the Day → creates the full time-blocked chain from the Rapids System template's `## Class N` block for that date.

### Which templates get which fields

| Template | Add these properties | Notes |
|---|---|---|
| Grocery List | `priority`, `due`, `status` | Or keep legacy `Priority Level`; both are accepted |
| Inventory | `priority`, `due`, `status` | Only if you treat items as actionable |
| List | `priority`, `due`, `status` | |
| Project | `priority` (already has `status`; add `due` when deadline exists) | |
| To-Do List | `priority`, `status` (already has `due`, `created`) | |
| Trip Packing Checklist | `priority`, `due`, `status` — while trip is active | Set `status: done` post-trip |
| Anger Log | *(none — journal)* | |
| Daily Note | *(none)* | |
| Note | *(none)* | |
| Person | *(none)* | |
| Plan of the Day | *(already has `date`, `rapids-class`)* | Set `rapids-class: 4` or `5` to fire the chain |
| Rapids System | *(already has `date`, `class`)* | Keep `## Class N` block structure exactly |

Full spec in [`FRONTMATTER.md`](FRONTMATTER.md).

---

## Smart Note mode

Turns a spoken or typed description into a fully formatted,
tagged, linked note built from one of your templates. Fully
offline: local [Ollama](https://ollama.com) running `gemma4:e2b`,
plus [whisper.cpp](https://github.com/ggerganov/whisper.cpp) for
voice. No cloud APIs.

### One-time setup

1. **Install Ollama**: download `OllamaSetup.exe` from
   https://ollama.com/download and run it. The installer sets up
   Ollama as a background service on `http://localhost:11434`.
2. **Pull the model**: in PowerShell, run `ollama pull gemma4:e2b`
   (~3.5 GB).
3. **(Optional, recommended) Install whisper.cpp for voice**: from
   this repo, run `windows\setup-whisper.ps1`. Pass
   `-RegisterLoginTask` to start the whisper server at login.
   Smart Note's mic button is disabled with a tooltip if the
   whisper server isn't reachable; typing still works.

### Daily use

- **Trigger**: ribbon mic icon or Command Palette → **"Smart note
  from template"**. Assign a hotkey from Obsidian's Hotkeys
  settings if you want one.
- **Pick template**: say or type the kind of note — "grocery
  list", "person", "anger log", "project", "trip packing". The
  modal fuzzy-matches against the Templates HUB folder. If
  there's ambiguity it offers the top 3.
- **Capture**: press the mic (toggle) and talk freely, or type.
  Every transcript lands in an editable textbox first so you can
  fix misheard words before extraction runs.
- **Extraction**: one call to Ollama with a JSON Schema matching
  the template's ask fields, inline bold fields (e.g. Anger Log's
  `**Trigger:**`), and body section headings. Only values you
  actually said are filled in — fields you didn't mention stay
  empty.
- **Follow-ups**: up to 3 (configurable). Priority: still-empty
  ask fields first, then model-judged gaps. Each follow-up
  accepts "answer", "skip", or "done".
- **Preview**: editable rendered markdown, editable title, folder
  dropdown (preselected with a one-line reason), hub-link toggle
  (default on). On actionable templates you'll see a reminder
  that `priority:` is intentionally empty — set it at daily
  triage.
- **Save**: writes through the Obsidian API (`vault.create` or
  `vault.process` for append-mode), opens the note, and
  optionally appends `- [[new note]]` to the hub's Main note
  under `## Notes` (or `## Projects` for Projects).

### Append-mode (Anger Log)

Anger Log doesn't create a new file per entry — it appends to a
monthly file (`Anger Log <MMMM YYYY>.md`) under
`Health HUB/Anger MGMT/AngerLogs`. Entry blocks go above any
trailing wikilink line, `updated:` is bumped, and the rest of the
file is preserved. If the month's file doesn't exist yet, Smart
Note creates it from the template with the first entry inside.

### Ollama-down fallback

If `/api/tags` isn't reachable or `gemma4:e2b` isn't pulled,
Smart Note shows a Notice ("Ollama not running — using standard
walkthrough") and opens the regular "Create note from template"
modal in its place. The standard walkthrough is untouched.

### Benchmark command

Command Palette → **"Smart Note: benchmark transcribers"** records
10 s and reports whisper vs Gemma-native latency + text side by
side (Notice + `console.table` in dev tools). Use it on the SP7
itself to decide which transcriber to run.

### Hard rules

- `priority:` is never written non-empty. The writer has a
  unit-tested `assertNoPriorityWrite` guard called on every
  outgoing frontmatter object. If you say "this is urgent", the
  note still saves with `priority:` empty and the preview shows a
  one-line reminder to set it at triage.
- `Priority Level` / `Priority Matrix` are template-locked:
  Smart Note preserves whatever value the template carries and
  never accepts a value from the extracted payload.
- Tags come only from `Reference HUB/Tags.md` plus the template's
  own defaults. The model's tag output is enum-constrained. If it
  proposes a brand-new tag it surfaces in the preview as an
  unchecked checkbox; only when you check it does Smart Note
  append it to Tags.md under "Suggested — general life" with a
  Log line.
- Never overwrites an existing file: collision suffix is `name
  (2).md`, `name (3).md`, …
- Never fabricates: if you didn't mention a section, it stays as
  the template left it (empty checkbox, blank field).

### Settings

Under List Assistant settings → Smart Note:

- `smartNoteOllamaUrl` — default `http://localhost:11434`
- `smartNoteModel` — default `gemma4:e2b`
- `smartNoteTemperature` — default `0.2`
- `smartNoteMaxFollowUps` — default `3`
- `smartNoteTranscriber` — `whisper` / `gemma-experimental` /
  `none`. Default `whisper`.
- `smartNoteWhisperUrl` — default `http://127.0.0.1:8080/inference`
- `smartNoteWhisperModel` — `base.en` / `small.en`
- `smartNoteAppendModeTemplates` — default `["Anger Log Template"]`
- `smartNoteFolderExcludeList` — defaults exclude `.obsidian`,
  `.claude`, `Templates HUB`, `Daily Priorities`,
  `Vault Audits`, `_backups`
- `smartNoteLastUsedByTemplate` — plugin-maintained memory of
  the folder you picked last time for each template

### Log

Every session appends one JSONL line to
`.obsidian/plugins/list-assistant/smart-note-log.jsonl` with
timestamp, template, folder, follow-up counts, latency, outcome.
No note content is ever logged.

---

## Commands, ribbon icons, URIs

Every capability has three ways to fire: command palette, ribbon
icon, and `obsidian://` URI. Pick whatever fits the moment.

| Capability | Command palette | Ribbon | URI |
|---|---|---|---|
| Create note from template | `List Assistant: Create note from template` | `file-plus` | (none) |
| Run daily triage | `List Assistant: Run daily triage` | `list-checks` | `obsidian://list-assistant?action=triage` |
| Sync Google Calendar | `List Assistant: Sync Google Calendar` | `calendar-sync` | `obsidian://list-assistant?action=sync-calendar` |
| Run vault audit | `List Assistant: Run vault audit` | `search-check` | `obsidian://list-assistant?action=audit` |
| Triage + Calendar sync | *(none — chained)* | *(none)* | `obsidian://list-assistant?action=triage-and-sync` (used by Task Scheduler) |
| Triage + Sync + Audit | *(none — chained)* | *(none)* | `obsidian://list-assistant?action=triage-sync-audit` |
| Connect Google Calendar (once) | `List Assistant: Connect Google Calendar` | (none) | (none) |

---

## Google Calendar setup

You use **your own** Google Cloud OAuth 2.0 Desktop client — no
shared credentials, no third-party relay. Takes ~5 minutes.

1. <https://console.cloud.google.com/> → **New Project** →
   `list-assistant`
2. **APIs & Services → Library** → search **Google Calendar API** →
   **Enable**
3. **APIs & Services → OAuth consent screen** → **External** →
   fill required fields → add yourself as a Test user
4. **APIs & Services → Credentials → + Create credentials → OAuth
   client ID → Desktop app** → copy the **Client ID** and
   **Client secret**
5. In Obsidian → Settings → List Assistant → **Google Calendar**:
   paste Client ID and Client secret. Leave port at `42816`
6. Click **Connect**. Browser opens on Google's consent screen.
   Because your app is in Testing mode, click **Advanced → Go to
   list-assistant (unsafe)** — it's your own app. Grant access. Tab
   closes. Notice appears in Obsidian: "Connected to calendar: …"

Detailed troubleshooting: [`GOOGLE-CALENDAR.md`](GOOGLE-CALENDAR.md).

---

## Windows nightly automation

Installer registers a Task Scheduler task that fires the
triage-and-sync URI daily at midnight local time, and drops a
desktop shortcut for on-demand runs.

**Install** (elevated PowerShell in your ListAssist checkout):

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\windows\install.ps1
```

**Verify:**

```powershell
Get-ScheduledTask -TaskPath '\ListAssistant\'
```

**Test it now:**

```powershell
Start-ScheduledTask -TaskPath '\ListAssistant\' -TaskName 'Nightly triage and sync'
```

Obsidian pops up, runs triage, runs calendar sync, and settles.

**Behavior:**

- Surface asleep at midnight → runs on wake (`WakeToRun=false`,
  `StartWhenAvailable=true`)
- Obsidian closed → Windows launches it via the URI handler
- On battery → runs (change `DisallowStartIfOnBatteries` to `true`
  in the XML if you'd rather skip)

Full docs: [`WINDOWS-AUTOMATION.md`](WINDOWS-AUTOMATION.md).

---

## Claude Code companion

For the meaning-level work the plugin deliberately doesn't do:

- semantic pattern-finding across notes
- full vault tag-and-link sweeps
- verifying frontmatter contract compliance

**Install once** (see step 5 of first-time install).

**Use anytime:**

```cmd
cd "C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault"
claude
```

Inside the Claude Code session, type `/` — three commands appear:

- `/vault-audit` — semantic audit. Writes findings to
  `Vault Audits\<today>-semantic.md`. Read-only.
- `/vault-tag-pass` — full sweep. Adds missing tags/links, fixes
  broken wikilinks, uses `Reference HUB\Tags.md` as the taxonomy.
  Edits notes. Never writes `priority:`.
- `/frontmatter-check` — verifies actionable notes carry the
  plugin's contract. Read-only.

The `.claude/CLAUDE.md` primer means Claude Code starts each session
already knowing the vault's structure, the frontmatter contract,
and the non-negotiable rules. You don't have to re-brief it.

Everything runs against your existing Claude subscription — the
plugin makes no API calls of its own. Zero per-run cost.

---

## Settings reference

Obsidian → Settings → **List Assistant**.

### Templates

| Setting | Default | Notes |
|---|---|---|
| Templates folder | `Templates` | Where the picker scans |
| New notes folder | *(empty = vault root)* | Where new notes from templates go |

### Daily triage

| Setting | Default | Notes |
|---|---|---|
| Daily Priorities folder | `Daily Priorities` | One file per day; overwrites |
| Exclude folders from triage | `Templates, Daily Priorities` | Comma-separated |

### Google Calendar

| Setting | Default | Notes |
|---|---|---|
| OAuth client ID | *(empty)* | Paste from Google Cloud Console |
| OAuth client secret | *(empty)* | Password-masked |
| Redirect port | `42816` | Loopback port for Connect flow |
| Calendar ID | `primary` | Or a specific calendar ID |

### Calendar sync tuning

| Setting | Default | Notes |
|---|---|---|
| Q1 event start (HH:MM) | `16:00` | Time-of-day for Q1 events |
| Q1 event end (HH:MM) | `17:00` | End time for Q1 events |
| Q2 reminder days before due | `3` | Days before due |
| Rapids System template path | `Templates/Rapids_System_Template.md` | Where the parser reads class schedules |

### Vault audit

| Setting | Default | Notes |
|---|---|---|
| Audit reports folder | `Vault Audits` | Overwrites the day's file |
| Audit exclude folders | `Templates, Daily Priorities, Vault Audits` | Comma-separated |
| Stub threshold (bytes) | `400` | Files at/below this or body under 30 chars |
| Entity minimum mentions | `3` | For "entities without a note" check |
| URL minimum mentions | `2` | For "URLs without a note" check |
| Hub exempt tags | `hub, index, moc` | Notes with any of these are exempt from Sinks |

---

## Troubleshooting

**Command not in palette / ribbon icons missing.** Plugin binary is
stale. Rebuild:

```cmd
cd C:\Users\kevin\ListAssist
git pull
npm run build
copy main.js "C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\.obsidian\plugins\list-assistant\"
```

Then Ctrl-R in Obsidian.

**"Google did not return a refresh token"** during Connect. You've
granted access before and Google is skipping consent. Revoke at
<https://myaccount.google.com/permissions>, then Connect again.

**Calendar sync says "Token refresh failed: invalid_grant".** Your
refresh token expired (6-month max in Testing mode, or manually
revoked). Reconnect.

**OAuth timeout during Connect.** Nothing hit the loopback within 5
minutes. Retry. If the port is in use, change it in settings.

**Plan of the Day doesn't fire a Rapids chain.** Check three
things: `rapids-class:` set to a number 1–5, `date:` set to a
`YYYY-MM-DD` string, and the Rapids System template at the
configured path exists with `## Class N` blocks matching that
number.

**Nightly task fired but no report appeared.** Task Scheduler
launched Obsidian via the URI but Obsidian didn't process it.
Usually: vault password prompt is blocking. Enter it and re-fire
the task manually.

**`/vault-audit` in Claude Code says "unknown command".** The
`.claude/` folder isn't in the vault, or `claude` was started from
a different directory. From PowerShell:

```powershell
dir -Force "C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\.claude\commands"
```

If nothing lists, re-run the robocopy step. Then `cd` into the
vault before running `claude`.

**Vault audit report says a Sentinel note is a "stub".** Sentinel
Manual v3 chapters carry `sentinel/manual` tags and modest content;
adjust the stub threshold in settings if false positives multiply.

---

## Uninstall

Full removal (elevated PowerShell):

```powershell
# Stop the scheduled task
Unregister-ScheduledTask -TaskPath '\ListAssistant\' -TaskName 'Nightly triage and sync' -Confirm:$false

# Remove the plugin from the vault
Remove-Item -Recurse "C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\.obsidian\plugins\list-assistant"

# Remove the Claude Code companion
Remove-Item -Recurse "C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\.claude"

# Remove the desktop shortcut
Remove-Item "$([Environment]::GetFolderPath('Desktop'))\List Assistant — Triage and Sync.url" -ErrorAction SilentlyContinue

# (Optional) delete the source repo
Remove-Item -Recurse C:\Users\kevin\ListAssist
```

To revoke Google Calendar access:
<https://myaccount.google.com/permissions>

To clean up plugin-created calendar events: search Google Calendar
for `[list-assistant]` — every event carries that tag in the
description. Multi-select and delete.

`Daily Priorities\`, `Vault Audits\`, and any notes you created via
templates are ordinary markdown files. Keep them or delete them at
your discretion.
