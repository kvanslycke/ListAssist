---
description: Verify actionable notes carry the List Assistant frontmatter contract. Read-only.
---

Scan the vault for notes that should carry the List Assistant plugin's
frontmatter contract (see `CLAUDE.md`) and report inconsistencies.

For each actionable note (Project, Grocery, Inventory, List, To-Do,
Trip Packing when active) verify:

- Has `priority:` field (empty is OK — that lands in "Needs triage")
- Has `status:` field (any of `not-started` / `doing` / `done` /
  `completed` / `cancelled` / `canceled`)
- If `priority:` is `q1` or `q2`, warn if `due:` is missing (Q1/Q2
  events need a due date to sync to calendar)
- If the note is a Project, warn if `next-action:` is empty and
  `status:` isn't `not-started`

For each note that looks actionable by content (todo lists, dated
deliverables, shopping runs) but lacks the frontmatter contract
entirely: flag it — Kevin may want to add the fields so the plugin
picks it up.

**Report only.** Print findings grouped by issue type. Do not edit
any note. Do not touch `priority` values.
