# Frontmatter contract

The plugin reads these YAML frontmatter fields. Add them only to notes
that need the corresponding behavior; a plain note or reference doesn't
need any of them.

## Priority — you own this

```yaml
priority: q1 | q2 | q3 | q4
```

- `q1` — Urgent & Important (do today).
- `q2` — Not Urgent, Important (schedule).
- `q3` — Urgent, Not Important (delegate/batch).
- `q4` — Neither (question these).
- Field present but empty — untriaged; appears in the "Needs triage"
  section of the daily report so you can set it.
- Field absent — the note isn't scanned at all. Add the field to
  actionable notes; leave it off reference notes.

The plugin never writes this field. Ever. You set it.

The plugin also accepts the legacy `Priority Level:` key (e.g. as it
appears on the Grocery List template) with values starting with `1`,
`2`, `3`, or `4` — they map to `q1`–`q4`. New templates should use
`priority:` for consistency.

Only put this field on notes you'll need to act on — Project, Grocery,
Inventory, List, To-Do, Trip Packing when active. Reference notes,
people, journal entries, daily notes, the Rapids System, etc. don't
need it.

## Due date

```yaml
due: 2026-10-05
```

If both `due:` and `priority:` are set:

- `priority: q1` → time-blocked Google Calendar event, **16:00–17:00
  America/Denver on the due date**.
- `priority: q2` → all-day reminder 3 days before due.
- `priority: q3 | q4` → no calendar event; stays on the triage list.

If `due:` is set but `priority:` is empty, no event is created. The
plugin will not create calendar events for notes it hasn't been given a
priority for — priority stays yours.

## Status

```yaml
status: not-started | doing | done
```

- `done`, `completed`, `complete`, `cancelled`, `canceled` — excluded
  from the triage report and from calendar sync.
- Any other value or missing — considered active.

## Auto-managed placeholders

Template placeholders the plugin recognizes and substitutes at
creation time:

- `{{date}}` — today's date, `YYYY-MM-DD`.
- `{{title}}` — the note title, prompted at creation.

Any other `{{token}}` — you're prompted for the value when creating the
note.

## Rapids System / Plan of the Day

```yaml
rapids-class: 4
```

On a Plan of the Day note, setting `rapids-class` to a class number (1–5)
tells the plugin to create the full time-blocked event chain for that day
from the Rapids System template. Class 4 example:

- 16:30 Calisthenics
- 16:45 Mindfulness
- 17:00 BP Check
- 17:05 Shower
- 17:25 Pack
- 17:35 Depart

All events are tagged `[list-assistant]` in the description so you can
find or bulk-delete them later.
