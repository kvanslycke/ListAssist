# Windows automation

Fires the plugin's triage + calendar sync at midnight local time,
and gives you an on-demand desktop shortcut for the same URI.
Ship: a Task Scheduler XML, a `.url` desktop shortcut, and a
one-line PowerShell installer that puts both in place.

Prerequisite: the plugin is installed and Google Calendar is
connected (see [GOOGLE-CALENDAR.md](GOOGLE-CALENDAR.md)). Windows
timezone should be set to Mountain (America/Denver) so "midnight
local" is what you want.

## Automated install

From an elevated PowerShell session (right-click PowerShell →
"Run as Administrator"), in your `ListAssist` checkout:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\windows\install.ps1
```

That registers the scheduled task and drops the shortcut on your
desktop. Verify:

```powershell
Get-ScheduledTask -TaskPath '\ListAssistant\'
```

Fire it right now to test the plumbing:

```powershell
Start-ScheduledTask -TaskPath '\ListAssistant\' -TaskName 'Nightly triage and sync'
```

Obsidian should pop to the front, run triage, run calendar sync,
and settle. Check the ribbon Notice bubbles for the run summaries.

## Manual install (no PowerShell)

**Task Scheduler:**

1. Start → Task Scheduler.
2. **Action → Import Task…**
3. Pick `windows\ListAssistant_Nightly.xml`.
4. OK.

**Desktop shortcut:**

1. Copy `windows\ListAssistant_TriageAndSync.url` to your Desktop.
2. Double-click any time to run the sync on demand.

## What the task does

```
cmd.exe /c start "" "obsidian://list-assistant?action=triage-and-sync"
```

`start ""` hands the URI to Windows' registered protocol handler,
which is Obsidian. If Obsidian is already running the URI dispatches
into it; if not, Obsidian launches, then the plugin runs.

## Behavior notes

- **Machine asleep at midnight:** `WakeToRun` is off — we don't wake
  the Surface for this. `StartWhenAvailable` is on, so the task runs
  when the machine next boots or resumes, backdated to the missed
  time. Change `WakeToRun` in the XML to `true` if you'd rather wake.
- **Obsidian was closed:** it launches. If your vault requires a
  password, Obsidian prompts and the run stalls until you enter it.
- **Multiple instances:** `IgnoreNew` — if a run is somehow still
  going when the next trigger fires, the new one is skipped.
- **Battery:** runs on battery. Change `DisallowStartIfOnBatteries` to
  `true` if you'd rather skip on battery.

## Uninstall

```powershell
Unregister-ScheduledTask -TaskPath '\ListAssistant\' -TaskName 'Nightly triage and sync' -Confirm:$false
Remove-Item "$([Environment]::GetFolderPath('Desktop'))\List Assistant — Triage and Sync.url" -Force
```
