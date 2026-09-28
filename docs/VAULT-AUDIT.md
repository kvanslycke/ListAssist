# Vault audit

The auditor scans your vault and writes a report of things worth
attention. It does not edit your notes — deciding which tag or link
to add takes judgment. Use the report as a punch list.

Run it with:

- Command: **List Assistant: Run vault audit**
- Ribbon: the `search-check` (magnifying-glass-with-checkmark) icon
- URI: `obsidian://list-assistant?action=audit`
- URI chain: `obsidian://list-assistant?action=triage-sync-audit`
  fires triage, calendar sync, and audit in order.

The report lands in `Vault Audits/YYYY-MM-DD.md` (folder configurable
in settings) and overwrites any prior report for the same day.

## What each section flags

1. **Untagged notes** — no `tags:` in frontmatter and no `#inline`
   tags anywhere in the body.
2. **Stub files** — file size at or below the threshold (default
   400 bytes) or whose body (after stripping frontmatter) is under
   30 characters. Catches empty stubs and near-empty placeholder
   files.
3. **Broken wikilinks** — `[[Something]]` where no note titled
   "Something" (or matching the linkpath) exists. Shows the source
   note and line number so you can jump to it.
4. **Possible duplicates** — pairs of notes whose base names are
   very similar (e.g. "Business Main" vs "Business Main 1") where
   at least one is a stub. Doesn't guess which to keep; you decide.
5. **Orphans — no incoming links** — notes nothing else links to.
   Some of these should be linked from a hub; others may be
   deliberately isolated (dailies, one-off jots).
6. **Sinks — no outgoing links** — notes that link out to nothing.
   Notes tagged with any of the hub-exempt tags (default `hub`,
   `index`, `moc`) are excluded automatically.
7. **Unlinked mentions of existing notes** — bare text of a note's
   title appearing in another note's body without a wikilink. Ranked
   by total mentions across the vault; top 30 are shown, each with
   up to 5 source notes.
8. **Frequently-mentioned entities without a note** — capitalized
   2–4 word phrases appearing in at least the configured number of
   notes (default 3), that have no matching note yet. Weekdays,
   months, product names, and other common false positives are
   stopworded.
9. **Frequently-appearing URLs without a note** — hostnames of
   URLs found in your notes, appearing in at least the configured
   number of notes (default 2), with no matching note. Common
   hosts (github, google, youtube, wikipedia, amazon, obsidian.md,
   claude.ai) are stopworded.

## What the auditor does not do

- **It never edits notes.** Deciding the right tag or the right
  wikilink target takes reading the note; the plugin can't do that
  responsibly. Take the report to Claude Code (or Obsidian's
  Unlinked Mentions panel, one link at a time) and act on it there.
- **It doesn't run semantic analysis.** Patterns like "these three
  lists are the same theme in different forms" need an LLM. That's
  a possible Phase 6 that would add API cost and key management.

## Settings

Under **Settings → List Assistant → Vault audit**:

- **Audit reports folder** — where the report is written. Default
  `Vault Audits`.
- **Audit exclude folders** — comma-separated list; the auditor
  skips notes in these. Defaults to `Templates, Daily Priorities,
  Vault Audits` to avoid meta-noise.
- **Stub threshold (bytes)** — files at or below this size (or
  whose body is under 30 chars) are flagged as stubs. Default 400.
- **Entity minimum mentions** — a capitalized name must appear in
  at least this many notes to be flagged. Default 3.
- **URL minimum mentions** — a hostname must appear in at least
  this many notes to be flagged. Default 2.
- **Hub exempt tags** — comma-separated tag names; notes with any
  of these are exempt from the sinks list. Default `hub, index, moc`.
