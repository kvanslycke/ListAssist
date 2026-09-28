---
tags: [sentinel, handoff, list-assistant]
system: List Assistant
version: 0.1.0
handoff-to: Sentinel Overseer
date: 2026-09-28
---

# List Assistant — Handoff to Sentinel Overseer

Kevin runs a second Obsidian-native system alongside Sentinel:
**List Assistant** — an Obsidian plugin plus a Claude Code companion
that manages templates, priority triage, Google Calendar sync, and
vault audit. This document tells you where it touches surfaces you
already own, and what safety guarantees it holds itself to.

## Identification

- **Source repo:** `C:\Users\kevin\ListAssist\` (`github.com/kvanslycke/ListAssist`, branch `claude/blissful-keller-dxphie` at time of handoff)
- **Plugin install path:** `<vault>\.obsidian\plugins\list-assistant\`
- **Vault Claude Code config:** `<vault>\.claude\` (`CLAUDE.md` + `commands/`)
- **Plugin binary:** ~62 KB, `main.js` + `manifest.json`; TypeScript source in repo, no obfuscation, no telemetry, no auto-update
- **Author of this handoff:** Claude Opus 4.7 session `session_013gmeCvXvJGBKmKDRDERVFT`

## Runs where, when, and why

Everything below runs **only on SP7 (`surfacewaterpro`)** and its
Obsidian instance. Nothing touches EdgePI, SP4, cameras, PowellMesh,
Ranch Brain, SkySentinel CamBox, DreamHost, or the tailnet.

| Trigger | Effect | Human in loop? |
|---|---|---|
| Ribbon icon `file-plus` / cmd `Create note from template` | Modal, then writes one new note | Yes |
| Ribbon icon `list-checks` / cmd `Run daily triage` | Writes `Daily Priorities\YYYY-MM-DD.md` | Yes (button/URI) |
| Ribbon icon `calendar-sync` / cmd `Sync Google Calendar` | Creates/updates Google Calendar events tagged `[list-assistant]` | Yes (button/URI) |
| Ribbon icon `search-check` / cmd `Run vault audit` | Writes `Vault Audits\YYYY-MM-DD.md`; **never edits notes** | Yes (button/URI) |
| Windows Task Scheduler `\ListAssistant\Nightly triage and sync` | Fires `obsidian://list-assistant?action=triage-and-sync` at 00:00 America/Denver daily | No (autonomous once installed) |
| `/vault-tag-pass`, `/vault-audit`, `/frontmatter-check` in Claude Code from vault directory | Semantic sweep; may edit notes (`/vault-tag-pass` only) | Yes (Kevin invokes) |

## Vault footprint

Read scope: **all markdown files under the vault**, excluded folders
`Templates`, `Daily Priorities`, `Vault Audits` (configurable).

Write scope, unattended (via scheduled task or user-invoked ribbon):

- New note creation via template — target `notesFolder` setting (default: vault root)
- `Daily Priorities\YYYY-MM-DD.md` — overwrites the day's file
- `Vault Audits\YYYY-MM-DD.md` — overwrites the day's file

Write scope, human-invoked (Claude Code `/vault-tag-pass`):

- Any note in the vault. This slash command runs with a `CLAUDE.md`
  primer that forbids writing `priority:`, forbids fabricating
  notes, and instructs Claude Code to preserve existing content.

**Hard invariant:** the plugin binary never writes the `priority:`
frontmatter field on any note. Ever. It reads it for triage
bucketing and calendar event dispatch; it never sets it.

## Frontmatter contract (fields the system observes)

| Property | Type | Values | Semantic |
|---|---|---|---|
| `priority` | Text | `q1`, `q2`, `q3`, `q4`, empty | Eisenhower quadrant; **user-owned** |
| `Priority Level` | Text | `1: …` … `4: …` | Legacy alias for `priority` |
| `due` | Date | `YYYY-MM-DD` | Drives calendar event date |
| `status` | Text | `not-started` / `doing` / `done` / `completed` / `complete` / `cancelled` / `canceled` | Anything "done"-like excludes from triage/sync |
| `date` | Date | `YYYY-MM-DD` | Anchor day for Plan of the Day |
| `rapids-class` | Number | `1`–`5` | Fires timed event chain from Rapids System template |
| `tags` | Tags | Free-form | Obsidian graph; taxonomy in `Reference HUB\Tags.md` |

Sentinel Manual v3 notes currently carry `tags: [sentinel]` or
`[sentinel, manual]` and no `priority:`. They are consequently
invisible to triage and calendar sync. If Sentinel adds `priority:`
to any note, that note enters triage and — with `due:` set — gets a
calendar event on Kevin's Google Calendar (`primary` calendar unless
he changes the setting).

## External surfaces

### Google Calendar API

- **Auth:** Kevin's own Google Cloud OAuth 2.0 Desktop client. Client
  ID + secret + refresh token stored in `<vault>\.obsidian\plugins\list-assistant\data.json`
- **Scope:** `https://www.googleapis.com/auth/calendar.events` only.
  Cannot list, create, or delete calendars themselves; cannot read
  contacts, mail, or drive
- **Calendar targeted:** `primary` by default, configurable
- **Event ownership:** every event carries the extended property
  `listAssistantOwned=1` plus `listAssistantSource=<note-path>` and
  `listAssistantKind=<due-q1|due-q2-reminder|rapids-class>`. The
  event description begins with `[list-assistant]`. The plugin
  touches only events it created; it does not read or modify events
  from anything else
- **Loopback port during Connect:** 127.0.0.1:42816 (configurable),
  bound only during the OAuth Connect flow (< 5 minutes) when Kevin
  clicks Connect in settings. Not bound at any other time

### Windows Task Scheduler

- **Task path:** `\ListAssistant\Nightly triage and sync`
- **Action:** `cmd.exe /c start "" "obsidian://list-assistant?action=triage-and-sync"`
- **Runs as:** interactive token (Kevin's user)
- **Trigger:** daily at 00:00 local. `StartWhenAvailable=true` so a
  missed midnight (SP7 asleep) runs on resume. `WakeToRun=false`
- **Coexistence:** ListAssist owns `\ListAssistant\`. If Sentinel
  needs a scheduled task, use a different path (e.g. `\Sentinel\`)
  to avoid collisions in Task Scheduler UI

### `obsidian://` URIs

Registered under scheme handler `list-assistant`. Actions:

- `?action=triage`
- `?action=sync-calendar`
- `?action=audit`
- `?action=triage-and-sync`
- `?action=triage-sync-audit`

## Non-negotiable behaviors

1. **Never writes `priority:`.** Enforced at code level in
   `src/create-note-modal.ts` (creation path) and in every reader
   in `src/triage.ts`, `src/sync.ts`, `src/audit.ts`
2. **Only touches its own calendar events.** Uses
   `privateExtendedProperty=listAssistantSource=<key>` for lookup;
   never falls back to name-matching
3. **Never uses Anthropic API from the plugin.** No API key field,
   no `api.anthropic.com` calls, no cost per run. Semantic work
   lives in Claude Code (`vault-claude-config/`), which runs on
   Kevin's existing Claude subscription
4. **Mobile-safe.** No Node built-in modules on the mobile code path;
   OAuth Connect gated behind `Platform.isMobile` check and errors
   cleanly on Android with instructions to complete Connect on
   desktop
5. **Backup-safe.** All writes go through Obsidian's Vault API;
   Obsidian Sync handles versioning and conflict resolution

## Coordination points with Sentinel

- **Shared vault at `~/KevinsRoots/Obsidian Vault/KevlarMainVault`.**
  Both systems read and (may) write. Neither system holds a lock;
  concurrent edits rely on Obsidian's own event queue and Obsidian
  Sync's conflict handling
- **`Reference HUB\Tags.md` is the taxonomy source of truth.** If
  `/vault-tag-pass` runs, it uses that file; if Sentinel adds tags
  outside of it, those tags will appear in the audit report as
  potential candidates for Tags.md
- **`CLAUDE.md` at vault root** (installed by `vault-claude-config/`)
  gives Claude Code sessions from the vault directory a primer.
  It documents the plugin's frontmatter contract and the "never
  write `priority:`" rule. If Sentinel needs its own primer for
  Claude Code sessions started elsewhere, they don't conflict —
  Claude Code reads only the `.claude/CLAUDE.md` in its working
  directory
- **No shared credentials.** Google Calendar OAuth is not shared
  with any Sentinel component. `10 Credentials.md` in the Sentinel
  Manual is not read or written by List Assistant

## Health check

There is no dedicated health check. Signals of a working install:

- Ribbon shows 4 icons: `file-plus`, `list-checks`, `calendar-sync`,
  `search-check`
- Command palette lists 4 List Assistant commands
- `Daily Priorities\` and `Vault Audits\` folders exist and contain
  recent files
- Google Calendar shows events tagged `[list-assistant]` in the
  description for notes with `priority:` and `due:` set

## Rollback and disable

To disable without uninstalling:

```
Obsidian → Settings → Community plugins → List Assistant → toggle off
```

To fully remove:

```powershell
# Stop scheduled task
Unregister-ScheduledTask -TaskPath '\ListAssistant\' -TaskName 'Nightly triage and sync' -Confirm:$false

# Remove plugin
Remove-Item -Recurse "C:\Users\kevin\KevinsRoots\Obsidian Vault\KevlarMainVault\.obsidian\plugins\list-assistant"

# Remove Claude Code config
Remove-Item -Recurse "C:\Users\kevin\KevinsRoots\Obsidian Vault\KevlarMainVault\.claude"

# Remove desktop shortcut
Remove-Item "$([Environment]::GetFolderPath('Desktop'))\List Assistant — Triage and Sync.url" -ErrorAction SilentlyContinue
```

To revoke Google Calendar access:
<https://myaccount.google.com/permissions>

To recover events created by the plugin: Google Calendar search
`[list-assistant]` (they all carry that tag in the description).

## Version and provenance

- Plugin version: `0.1.0`
- Repo: `github.com/kvanslycke/ListAssist`
- Feature branch at handoff: `claude/blissful-keller-dxphie`
- Commits at handoff: 9 (Phase 1 through Phase 5 + Phase 6 revert + `vault-claude-config`)
- No prior release; no version history to reconcile

## Overseer, please note

If a health-check ever reports that a Sentinel note has acquired a
`priority:` value it should not have, the plugin is **not** the
cause — plugin binary is read-only against that field. Investigate
`/vault-tag-pass` runs (Kevin's own manual sessions) or a manual
edit. The plugin binary is auditable at
`C:\Users\kevin\ListAssist\src\` and its git history.

To link this handoff into the standing orders: add a bullet under
`Projects/SentinelHQ/Overseer/Sentinel Overseer.md` referencing
`[[List Assistant Handoff]]`.
