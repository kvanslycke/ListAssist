# Semantic vault audit

The Phase 5 auditor is deterministic and free — it flags untagged
notes, broken links, orphans, stubs, and frequently-mentioned things
that lack a note. What it can't do is spot **meaning-level** patterns:

- Cross-domain bridges: two notes in different hubs describing the
  same underlying capability or idea (a hydrology website and a
  truck-mounted cyberdeck are both hydrology-GIS pointed at
  different targets).
- Thematic patterns: a philosophy or worldview showing up in
  different forms across notes (a media watchlist matching a
  system's stated intellectual lineage).
- Suggested links: pairs of existing notes that should point at each
  other but neither realizes it.
- Suggested new notes: emerging clusters that would benefit from a
  hub or MOC note that doesn't exist yet.

Those need judgment. The semantic auditor hands a compact index of
your vault (path, title, tags, outbound links, first ~280 chars of
each note) plus the deterministic audit's own report to Claude via
the Anthropic API and asks for structured findings back.

## Setup

1. **Get an API key.** Go to <https://console.anthropic.com/settings/keys>
   and create a key. Copy it.
2. **Paste it in.** Obsidian → Settings → List Assistant → **Semantic
   audit** → **Anthropic API key**. (Stored in plugin data, rides
   Obsidian Sync to your other devices.)
3. **Add credit if needed.** Under Billing on the Anthropic console.
   $5 lasts a long time at Sonnet or Opus pricing for a 100-note vault.

## Running it

- Command: **List Assistant: Run semantic vault audit (uses
  Anthropic API)**
- Ribbon: the `sparkles` icon (distinct from the deterministic
  `search-check` icon so you don't fire the paid one by accident)
- URI: `obsidian://list-assistant?action=semantic-audit`

Report lands at `Vault Audits/YYYY-MM-DD-semantic.md` alongside the
deterministic report for that day.

## Cost

Rough per-run costs for a 100-note vault at 280 chars/note excerpt:

| Model | Input ~$/MTok | Output ~$/MTok | Est. per run |
|---|---|---|---|
| `claude-opus-5` (default) | $5 | $25 | ≈ $0.15–0.25 |
| `claude-sonnet-5` | $2 | $10 | ≈ $0.06–0.10 |
| `claude-opus-4-8` | $5 | $25 | ≈ $0.15–0.25 |
| `claude-haiku-4-5` | $1 | $5 | ≈ $0.03–0.05 |

Each report shows the exact token count and cost at the top. The
plugin also uses prompt caching on the vault index — a second run
within a few minutes reads the cache at ~10% of input cost.

The plugin **defaults to Opus 5** because that's Anthropic's most
capable widely-released model and this is a judgment-heavy task.
Switch to Sonnet 5 in settings if you want daily runs at a fraction
of the cost — the pattern-finding quality is still very good.

## What the plugin sends to Claude

For every note (excluding folders in **Audit exclude folders**):

- Path
- Title (basename)
- Tags (frontmatter + inline)
- Outbound wikilinks
- First ~280 characters of body (configurable)

Plus the full deterministic audit report for context (togglable in
settings). Nothing else — Claude does not see full note contents.
For a 100-note vault this is typically 20–40 KB of prompt.

## What the plugin does not do

- **It does not edit notes.** Same policy as the deterministic
  auditor: judgment-level edits are yours (or Claude Code's) to
  make. The report is a punch list.
- **It does not run on a schedule by default.** Every run costs
  money. Add the URI to your Windows Task Scheduler entry manually
  if you want a scheduled run.

## Failure modes

- **"Set your Anthropic API key…"** — settings field is empty.
- **"Anthropic API 401"** — key is wrong or revoked.
- **"Anthropic API 429"** — rate-limited; wait and retry.
- **"Anthropic API 402" / "credit balance is too low"** — add
  credit at <https://console.anthropic.com/settings/billing>.
- **"Could not parse Claude's response as JSON"** — very rare on
  Opus 5 with a clean prompt. Retry once; if it persists, drop
  effort down one notch and try again.
- **"Anthropic refused the request"** — safety classifier hit;
  extremely unlikely for a vault audit. If it happens, the report
  says which category.
