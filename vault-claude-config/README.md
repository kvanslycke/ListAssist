# Vault Claude Code config

Drop this into your Obsidian vault's root so that a `claude` session
started from the vault directory picks up the vault primer and slash
commands automatically. Zero API cost — runs against your existing
Claude subscription, not per-token API billing.

## Install (one-time, on your Surface)

Copy the files into your vault:

```cmd
xcopy /E /I "C:\Users\kevin\ListAssist\vault-claude-config\.claude" ^
      "C:\Users\kevin\KevinsRoots\Obsidian Vault\KevlarMainVault\.claude"
```

Or manually: create `<vault>/.claude/`, copy `CLAUDE.md` in there, and
copy `commands/` in as `<vault>/.claude/commands/`.

Verify:

```
<vault>/.claude/
    CLAUDE.md
    commands/
        vault-audit.md
        vault-tag-pass.md
        frontmatter-check.md
```

## Use it

Open a terminal, cd into your vault:

```cmd
cd "C:\Users\kevin\KevinsRoots\Obsidian Vault\KevlarMainVault"
claude
```

Claude Code starts, reads `.claude/CLAUDE.md` as the vault primer,
and makes three slash commands available:

- **`/vault-audit`** — semantic audit; writes a report to
  `Vault Audits/YYYY-MM-DD-semantic.md`. Read-only, doesn't touch
  your notes.
- **`/vault-tag-pass`** — full sweep: adds missing tags and links,
  fixes broken wikilinks, uses your existing tag taxonomy from
  `Reference HUB/Tags.md`. Never writes the `priority` field. This
  is the workflow that produced the results you already liked.
- **`/frontmatter-check`** — verifies that actionable notes carry
  the List Assistant frontmatter contract (`priority`, `due`,
  `status`). Read-only.

## Sync note

Obsidian Sync excludes hidden folders (`.claude/` starts with a dot)
by default, so this config stays on your Surface — which is fine,
Claude Code is desktop-only. If you want to sync it to your Android
too, enable **Sync configuration** in Obsidian → Settings → Sync,
though there's no point unless you're planning to run Claude Code
from your phone.
