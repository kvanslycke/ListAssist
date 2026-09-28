---
description: Full vault sweep — add missing tags & links, fix broken wikilinks. Uses the taxonomy in Tags.md. Never writes the `priority` field.
---

Do a full vault tag-and-link pass, like the one you did before.
Systematically go HUB folder by HUB folder. For each note:

1. **Frontmatter tags.** If a note has no `tags:` at all, or its
   tags don't reflect its content, add appropriate tags from the
   taxonomy documented in `Reference HUB/Tags.md`. If a genuinely
   new tag is needed to describe a real concept the taxonomy
   doesn't cover, add it AND update Tags.md's list to keep it
   canonical.

2. **Wikilinks.** For each note, add `[[wikilinks]]` connecting it
   to sibling notes in its hub, related notes in other hubs, and
   its hub's Main index note. If the note is a hub-index Main, link
   it to every sibling in its folder.

3. **Broken wikilinks.** For each `[[link]]` whose target doesn't
   resolve, either: (a) fix the target if there's an obvious real
   note the link meant, or (b) create the missing note with real
   content sourced from what other notes say about it — do NOT
   leave a placeholder stub.

4. **Empty stubs / suspected duplicates.** Flag them at the end for
   Kevin to confirm — do not delete anything without his explicit
   go-ahead in this session.

Follow the vault ground rules in `CLAUDE.md`:
- Never write or edit `priority:` on any note. Ever.
- Preserve existing content; add and augment, don't rewrite.
- Use the frontmatter contract for actionable notes: `priority`,
  `due`, `status`, `date`, `rapids-class`. Only touch `priority`
  by reading it, never by writing.

When done, print a summary listing: how many notes got new tags,
how many got new links, how many broken links were fixed, how many
new notes you created (and why), and any stubs/duplicates flagged
for Kevin's attention.
