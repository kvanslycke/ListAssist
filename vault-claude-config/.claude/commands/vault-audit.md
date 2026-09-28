---
description: Semantic audit — surface non-obvious cross-domain connections in the vault. Read-only.
---

Run a semantic audit of this Obsidian vault. Read every markdown
file in the vault (skip `Templates/`, `Daily Priorities/`, and
`Vault Audits/`). Look specifically for patterns a mechanical linter
would miss:

1. **Cross-domain bridges** — notes in different hubs that describe
   the same underlying capability, idea, or infrastructure aimed at
   different targets. (Example from a prior audit: a hydrology
   website and a truck-mounted cyberdeck are the same GIS/hydrology
   capability pointed at different problems.)

2. **Thematic patterns** — a philosophy, worldview, or value that
   shows up across notes in different domains. (Example: names on a
   watch list matching a system's stated intellectual lineage.)

3. **Suggested links between existing notes** — pairs of notes whose
   content clearly relates but which don't currently link to each
   other. Cite both note paths.

4. **Suggested new notes** — clusters of mentions that would benefit
   from a hub or MOC note, but no such note exists yet. Cite the
   evidence notes.

Do NOT flag things the plugin's deterministic auditor already
handles: untagged notes, broken wikilinks, unlinked mentions,
frequently-mentioned entities without a note, orphans, or stubs.
That layer already exists in `Vault Audits/YYYY-MM-DD.md` — if a
recent one is present, read it first and skip anything it covers.

**Report only.** Write findings to `Vault Audits/<today>-semantic.md`
with frontmatter `tags: [vault, audit, semantic]` and `date:
<today>`. Group by category. For each finding: a short title, one
to three sentences explaining why it matters, and the list of note
paths that ground it. Do not edit any note.

Prefer 5–15 high-confidence findings over an exhaustive list. If
nothing meaningful stands out, say so and write a short report
noting that.
