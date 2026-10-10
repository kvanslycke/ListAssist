# Agent Update — 2026-10-10

Technical state of the world after the 2026-10-09 → 2026-10-10 build session. Read before touching `C:\Users\kevin\ListAssist\` or `C:\Users\kevin\KevinsRoots\Projects\RapidsResolver\`.

## Binding constraints (unchanged, non-negotiable)

- **Never write `priority:` with a value.** The `assertNoPriorityWrite` guard in `src/smart/writer-core.ts` enforces this on every outgoing frontmatter object. If a future module needs to touch frontmatter, call that guard.
- **Never fabricate.** Fields the user didn't speak about stay as the template left them.
- Vault at `C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\` (no space in `ObsidianVault`). Any file that writes a Windows path to the vault must use that exact spelling.
- Use Obsidian API (`app.vault.create` / `app.vault.process` / `app.fileManager.processFrontMatter`) for all vault writes. Never raw fs.
- Tags come only from `Reference HUB/Tags.md`. New tags land under "Suggested — general life" only on explicit user confirmation.

## Repo state

- **Repo:** `C:\Users\kevin\ListAssist\`
- **Branch:** `claude/blissful-keller-dxphie` (14 new commits this session on top of `1b72d93`)
- **Build:** `npm run build` — clean. Output `main.js` at 127 577 bytes.
- **Tests:** `npm test` → 141/141 pass across 7 test files. Runner: `node:test` built-in.
- **Installed to vault:** `main.js` + `manifest.json` copied to `KevlarMainVault\.obsidian\plugins\list-assistant\`. Reload the plugin to pick up changes.
- **Stray untracked:** `^/` directory in repo root (artifact of a bad shell command in a prior session; harmless, flagged for cleanup).
- Package deps unchanged. No new runtime or dev dependencies added. `esbuild` reused for the test-build step.

## New top-level files

| Path | Purpose |
|---|---|
| `src/smart/` | 16 new TS modules — Smart Note implementation (details below) |
| `test/` | 141 tests + fixtures |
| `test/fixtures/templates/` | Read-only copies of all 14 vault templates |
| `test/fixtures/Tags.md` | Read-only copy of the vault's Tags.md |
| `scripts/test-build.mjs` | esbuild-based compiler for test consumption |
| `windows/setup-whisper.ps1` | whisper.cpp installer / Task Scheduler wrapper |
| `docs/USER-MANUAL.md` | Extended with full "Smart Note mode" section |
| `docs/AGENT-UPDATE-2026-10-10.md` | This file |

## Smart Note architecture

Module graph (arrows = `import`):

```
SmartNoteModal ─┬─> session ───┬─> templateSchema ──> yaml-tiny
                │               ├─> writer-core ─────> templateSchema
                │               ├─> router
                │               └─> ollamaClient
                ├─> writer ────> writer-core
                ├─>             └─> vaultIndex
                ├─> audioCapture
                ├─> whisperTranscriber ─> transcriber
                ├─> gemmaTranscriber ───> transcriber
                ├─> tagIndex
                └─> logger
commands ──────> SmartNoteModal, ollamaClient, audioCapture, whisperTranscriber, gemmaTranscriber
main ──────────> commands (plus everything the pre-existing plugin did)
```

### Module interfaces

- `yaml-tiny.ts` — `parseFrontmatter(raw) → { yaml, body, rawFrontmatter, keyOrder }`. Scoped YAML subset — scalars, block/flow sequences, quoted keys/values. Preserves `{{placeholder}}` tokens as scalar strings.
- `templateSchema.ts` — `classifyTemplate(raw) → TemplateSchema`. Classifies each frontmatter key as `auto-date` / `auto-status` / `auto-title` / `ask` / `forbidden` / `passthrough`. Body parse: section headings, inline bold fields (`**Label:**`), tables, checkbox lists. `isActionable` is "has a `priority` key".
- `tagIndex.ts` — `parseTags(md) → TagIndex`, `isValidTag`, `enforceEnum(idx, proposed) → {accepted, rejected}`, `tagsFileWithAppendedSuggestion(current, tag, today)` — pure transform producing the new Tags.md content.
- `vaultIndex.ts` — `buildVaultIndex(files, {maxTitlesPerHub}) → VaultIndex` (files = `{path, basename}[]`). Recognizes both `<Name> HUB` and the typo'd `Work HUb`. `hubMainLinkFor(index, folderPath)` returns the link target for any depth under a hub.
- `ollamaClient.ts` — `healthCheck(cfg) → {ok, models, modelPresent}`, `chat(cfg, {messages, format}) → {content, parsed, retried}`. 30 s timeout via AbortController. One retry on invalid JSON before `throw InvalidChatJsonError`. Fetch injectable via `cfg.fetchImpl`.
- `writer-core.ts` — pure render path. `renderNote({raw, title, today, extracted}) → RenderResult`. `assembleNote(result)` → final string. `assertNoPriorityWrite(fm)` throws if `fm.priority` is non-empty (does NOT touch `Priority Level` — that's passthrough-locked). `resolveCollision` → `name (2).md`, `name (3).md`, … `fileWithAppendedEntry(current, entry, today)` for Anger Log monthlies. `hubMainWithAppendedLink(current, link, heading)` idempotent bullet append.
- `writer.ts` — Obsidian-side wrapper. `writeSmartNote(rendered, ctx) → WriteOutcome`. Calls `app.vault.create` or `app.vault.process`, ensures folders exist, updates hub Main via `app.vault.process`. `AppendModeContext` triggers monthly-file append.
- `router.ts` — `suggestFolder({templateBasename, folderEnum, modelPick, lastUsed, seedTable}) → {folder, reason}`. Priority: lastUsed > modelPick > seed > "". `DEFAULT_SEED_TABLE` matches the handoff. `tripPackingFolder(description, folderEnum)` for ranch/not-ranch disambiguation.
- `session.ts` — state machine. States: `pickTemplate` → `awaitCapture` → `extract` → `followUp` → `review` → `writing` → `done`/`error`. `createSession(deps)`, `pickTemplate(session, utterance)`, `submitCapture(session, text)` (calls `deps.chat`), `answerFollowUp(session, answer)` where answer ∈ `string | "skip" | "done"`. `prepareReview(session)` returns `{rendered, folder, title}`. `resolveDate(input, today)` handles ISO / today / tomorrow / yesterday / `next <wd>` / `the Nth [of Month]`.
- `transcriber.ts` — `interface Transcriber { name: string; transcribe(wav: ArrayBuffer): Promise<string> }` + `TranscriberError`.
- `audioCapture.ts` — class with `start() / stop() → ArrayBuffer`. `getUserMedia` → `ScriptProcessor` (deprecated but Electron-stable) → `OfflineAudioContext` resample to 16 kHz mono → Float32 to Int16 PCM → 44-byte WAV header. No ffmpeg.
- `whisperTranscriber.ts` — multipart POST to `http://127.0.0.1:8080/inference` with `file` + `response_format: json`. 60 s timeout. `whisperHealth(url)` for the mic-button gate.
- `gemmaTranscriber.ts` — Ollama's OpenAI-compatible `/v1/chat/completions` with `input_audio` content part BEFORE text part (order matters). 3 min timeout. Experimental; off by default.
- `logger.ts` — `appendLog(app, pluginDir, entry)`. JSONL at `.obsidian/plugins/list-assistant/smart-note-log.jsonl`. Best-effort; a logger failure never fails the user flow. Fields: `timestamp, template, folder, follow_ups_asked, follow_ups_answered, latency_ms, transcriber, model, outcome, error`.
- `commands.ts` — `openSmartNote(plugin)` (health-check → modal or fallback), `openStandardWalkthrough(plugin)` (the Ollama-down fallback — reuses the existing `TemplatePickerModal` + `CreateNoteModal` path), `benchmarkTranscribers(plugin)` (records 10 s, console.table + Notice).
- `SmartNoteModal.ts` — the Obsidian `Modal` subclass. Renders phases via `renderPhase()`. Preloaded templates passed in (`commands.ts` does the async template-content load before `modal.open()`).

### Hard-rule enforcement points (each has unit tests)

- **Priority never written:** `assertNoPriorityWrite` in `writer-core.ts:63`. Tested in `test/priority.test.mjs` (14 fixtures × 4 adversarial payloads = 56 subtests) and `test/writer-core.test.mjs` (`assertNoPriorityWrite throws only on non-empty priority (Priority Level is passthrough)`).
- **Extracted-locked keys scrubbed:** `scrubExtracted` in `writer-core.ts` deletes `priority`, `Priority Level`, `Priority Matrix` from the extracted payload before field resolution.
- **Tag enum:** `enforceEnum` in `tagIndex.ts` splits proposed tags into `accepted` (lowercase canonical) and `rejected` (surface in preview as unchecked checkbox).
- **Collision:** `resolveCollision` in `writer-core.ts` produces `name (2).md`, …
- **No fabrication:** `renderNote` field resolver returns `ctx.currentValue ?? ""` for `ask` fields with no extracted value — i.e. keeps the template's empty state.
- **Date resolution in code:** `resolveDate` in `session.ts` — never asked of the LLM.

### What's NOT in the module graph but was shipped

- The Phase 0 path-string fix (13 occurrences across 3 docs files) is committed but has no runtime surface. It fixes install/uninstall snippets in `vault-claude-config/.claude/CLAUDE.md`, `docs/USER-MANUAL.md`, `docs/SENTINEL-HANDOFF.md`.

## Settings schema deltas

`src/settings.ts` adds 10 new fields to `ListAssistantSettings`, all with defaults in `DEFAULT_SETTINGS`:

```ts
smartNoteOllamaUrl: string;              // "http://localhost:11434"
smartNoteModel: string;                   // "gemma4:e2b"
smartNoteTemperature: number;             // 0.2
smartNoteMaxFollowUps: number;            // 3
smartNoteTranscriber: "whisper" | "gemma-experimental" | "none"; // "whisper"
smartNoteWhisperUrl: string;              // "http://127.0.0.1:8080/inference"
smartNoteWhisperModel: "base.en" | "small.en"; // "base.en"
smartNoteFolderExcludeList: string[];     // see settings.ts
smartNoteAppendModeTemplates: string[];   // ["Anger Log Template"]
smartNoteLastUsedByTemplate: Record<string, string>; // {}
```

No settings UI section was added yet (settings tab still shows the pre-Smart-Note sections). Values are editable via `data.json` or via a UI section that a follow-up commit should add.

## Calendar sync changes (`14ae12c`, `5976c4e`)

- `src/oauth.ts` — new export `InvalidGrantError`. `refreshAccessToken` parses the 400 body; if `error === "invalid_grant"`, throws `InvalidGrantError(error_description)`.
- `src/sync.ts` — pre-flight `client.probeAuth()` (one call) before the per-spec loop. If `InvalidGrantError` fires mid-loop, propagates up instead of cascading. `dedupeErrors` wraps identical strings with `N×` prefix.
- `src/calendar.ts` — new `probeAuth()` method on `CalendarClient` that calls `events.list` (same `calendar.events` scope as the actual upserts). `whoAmI` kept for the connect-flow name lookup; its failure there is already caught + ignored.
- `src/main.ts` — `syncCalendar()` catches `InvalidGrantError` → clears `settings.googleTokens`, saves, shows a 10 s Notice telling the user to Reconnect.

**Real root cause of the 5 errors was unrelated to code:** the Google Calendar API was disabled in Google Cloud project `936798099793`. Kevin enabled it; sync now works end-to-end. The code improvements are still correct and shipped.

## Rapids Resolver

Standalone Python project at `C:\Users\kevin\KevinsRoots\Projects\RapidsResolver\`. Not in the ListAssist repo. Fully SP7-local — no calls to EdgePI / SP4 / 192.168.*/10.*/100.64.0.0-100.127.255.255.

### Files

- `resolve.py` (~370 lines) — CLI entry point. `--force` bypasses the already-resolved-today gate.
- `run_now.ps1` — thin wrapper that calls `python resolve.py --force` from the script's own directory.
- `config.json` — auto-created template. Placeholders for `ntfy_topic` + `ntfy_bearer_token`. Also carries `shift_calendar_id`, `shift_start_hour` (18), `shift_title_contains`, `karin_sat_calendar_id` (defaults to the family calendar), `karin_sat_title_contains` ("Karin"), and the class label map.
- `today_class.json` — written each run. Schema: `{date, class, label, kevin, karin, resolved_at}`.
- `resolver.log` — timestamped INFO/ERROR lines.
- `class5_override.flag` — optional. Presence = Class 5. Auto-cleared on consumption.
- `credentials.json` — **not shipped**. Kevin creates via Google Cloud Console (OAuth client ID → Desktop app → download → rename).
- `token.json` — created by the InstalledAppFlow on first run.

### Class resolution

- Class 1 = Kevin day off + Karin off — Family Float
- Class 2 = Kevin day off + Karin working — Gold Panning
- Class 3 = Kevin workday + Karin off — Canoe to Work
- Class 4 = Kevin workday + Karin working — Kayak to Work
- Class 5 = flag file — Rise & Whitewater

Kevin workday = calendar event starting at `shift_start_hour` (default 18) on `shift_calendar_id` (default `primary`). Karin: Tue-Fri hardcoded; Sat only if the family calendar has a matching event.

### Scheduled task

`RapidsResolver` — daily 14:00 America/Denver, `-StartWhenAvailable`, 10 min cap, Interactive logon. S4U registration failed on the first attempt with `Access is denied.` (needs elevated PowerShell). Upgrade to "run whether logged on or not" via Task Scheduler GUI (needs the user's password).

### Network isolation

`resolve.py:_block_lan_addresses()` monkey-patches `socket.getaddrinfo` to raise `OSError` on any address in `192.168.*`, `10.*`, or `100.64.0.0 – 100.127.255.255`. Called at startup before any Google API or ntfy call.

### Dependencies

User-site install (not venv): `google-api-python-client`, `google-auth-oauthlib`, `requests`. Python 3.14.3.

## Test infrastructure

```
test/
  fixtures/
    templates/              # 14 real templates, read-only
    Tags.md                 # real Tags.md
  priority.test.mjs         # 56 subtests, writer-core hard rule
  templateSchema.test.mjs   # 65 subtests, classification + body parse
  tagIndex.test.mjs         # 7
  vaultIndex.test.mjs       # 5
  ollamaClient.test.mjs     # 8 (mocked fetch)
  writer-core.test.mjs      # 14
  router.test.mjs           # 8
  session.test.mjs          # 19 (end-to-end with mocked LLM)
scripts/
  test-build.mjs            # esbuild compile src/smart/*.ts → .test-build/
```

### Running

```
npm run test:build          # compile only
npm test                    # test:build + node --test "test/*.test.mjs"
```

The glob is explicit — passing `test/` as a directory to `node --test` is a parse error on Node 24.

### Expanding

- All new pure modules under `src/smart/` get picked up by `test-build.mjs` automatically.
- Modules that `import "obsidian"` can still live under `src/smart/`; they just can't be imported from tests (`obsidian` is declared external in the test build and will fail at Node runtime).
- `test/*.test.mjs` imports from `.test-build/smart/<module>.js`. The `.test-build/` folder is gitignored and gets a `{"type":"module"}` package.json shim written by `test-build.mjs` to silence Node's module-type reparse warning.

## Known deviations from the spec

- **Model id**: used `gemma4:e2b` instead of the spec's `gemma3:2b`. The latter does not exist on Ollama's registry (`registry.ollama.ai/v2/library/gemma3/manifests/2b` returns 404). `gemma4:e2b` was the already-locked decision from the prior-session handoff. Settings default also reflects this.
- **Test runner**: `node:test` as per locked decision Q3. Zero new deps.
- **Rapids Resolver Task Scheduler logon type**: Interactive, not S4U. S4U needs admin elevation; verbatim error on registration was `Access is denied.`
- **Settings UI section for Smart Note**: not added yet (data.json path still works). Follow-up ticket.
- **windows/setup-whisper.ps1 not run**: the user hasn't installed whisper.cpp yet. The script is parameterized and idempotent — safe to run anytime.
- **`^/` directory in repo root**: untracked, harmless artifact of a bad shell command in a prior session. Flag for cleanup.
- **Priority Level in `assertNoPriorityWrite`**: the spec text said this assertion should throw on either `priority` OR `Priority Level` non-empty. That would spuriously fail on Grocery (template pre-sets `Priority Level: "2: Not Urgent, Important"`). Resolved semantically: `priority` is hard-empty (writer always sets ""); `Priority Level` and `Priority Matrix` are passthrough-locked (never set from extracted, template value preserved). `assertNoPriorityWrite` checks `priority` only.

## What NOT to touch

- `src/create-note-modal.ts` + `src/template-picker.ts` + `src/main.ts`'s existing commands — Smart Note is additive; the standard walkthrough stays as the Ollama-down fallback. If you refactor these, the fallback breaks.
- `src/triage.ts`, `src/sync.ts`, `src/audit.ts` — triage / calendar / audit paths. The only change made this session is in `src/sync.ts` (pre-flight auth probe + dedupe). Don't restructure.
- `src/smart/writer-core.ts`'s hard-rule constants (`HARD_EMPTY_KEYS`, `EXTRACTED_LOCKED_KEYS`) — these are what the test suite anchors to.
- `data.json` in the plugin dir — OAuth tokens live here. Never commit, never log, never dump into console output.
- Vault files during unprompted automation. The binding rule says "never modify files in the Obsidian vault directly unless a phase explicitly says to" — carry that forward.

## Commits (14, oldest first)

```
32c6e24  fix: correct vault path strings (no space in ObsidianVault)
77edcf7  test: harness + priority-never-written assertion on all 14 fixtures
cff7a20  feat(smart): templateSchema classifier with tests on all 14 fixtures
5736590  feat(smart): tagIndex parser, enforcer, suggested-tag file transform
11ea4d3  feat(smart): vaultIndex hub enumeration
6f84cde  feat(smart): ollamaClient with health check and structured chat
a071e7e  feat(smart): writer-core with priority guard, collision, append-mode
e6c0aed  feat(smart): router with seed table and last-used memory
5111f23  feat(smart): session state machine
80c959a  feat(smart): audio capture and transcribers
778457f  feat(smart): SmartNoteModal + writer I/O wrapper
f34d180  feat(smart): logger, commands, main wiring
ca4b21c  feat: setup-whisper.ps1
01b19bb  docs: Smart Note section in USER-MANUAL
14ae12c  (earlier) fix(sync): fail fast on invalid_grant, dedupe repeat errors
5976c4e  (earlier) fix(sync): use scope-compatible auth probe instead of whoAmI
```

Nothing has been pushed to a remote.

## Pending user actions (gate real-world use)

1. **Rapids Resolver `config.json`**: fill `ntfy_topic` + `ntfy_bearer_token`.
2. **Rapids Resolver `credentials.json`**: create at Google Cloud Console → OAuth client ID → Desktop app → download → rename → place at `C:\Users\kevin\KevinsRoots\Projects\RapidsResolver\credentials.json`.
3. **Rapids Resolver Task Scheduler elevation** (optional): switch LogonType from Interactive to Password/S4U so it runs when logged out.
4. **whisper.cpp install** (optional, enables Smart Note mic): run `windows\setup-whisper.ps1 -RegisterLoginTask`.
5. **Obsidian plugin reload** (required for new main.js to activate): `Ctrl+P` → "Reload app without saving".

## Resume checklist for the next agent

1. Read this file end-to-end.
2. Read `C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\.claude\CLAUDE.md` (binding ground rules — still non-negotiable).
3. Read `C:\Users\kevin\KevinsRoots\ObsidianVault\KevlarMainVault\Reference HUB\Session 2026-10-10 — User Manual.md` for the human-facing context.
4. For Smart Note changes: start with `writer-core.ts`'s hard-rule constants and the matching tests under `test/`.
5. For calendar sync changes: `src/sync.ts` + `src/calendar.ts` + `src/oauth.ts`. Always test with a dead refresh token AND a working one. Read the Google 403 `reason` field before writing code.
6. For Rapids Resolver changes: edit `C:\Users\kevin\KevinsRoots\Projects\RapidsResolver\resolve.py`. Keep `_block_lan_addresses` call at `main()` entry.
7. Never cross-pollinate: Smart Note is a plugin feature; Rapids Resolver is a separate Python daemon. They do not share state or imports.
