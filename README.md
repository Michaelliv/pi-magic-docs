# pi-magic-docs

Self-updating markdown docs for [pi](https://github.com/badlogic/pi-mono).

Mark a doc with `# MAGIC DOC:`, work normally, and pi will periodically nudge itself to keep that file current with what happened in the conversation.

## Install

```bash
pi install npm:pi-magic-docs
```

Or add it to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-magic-docs"]
}
```

## What it does

Magic Docs are markdown files that pi keeps fresh as you work.

Good fits:
- architecture notes
- subsystem overviews
- onboarding docs
- entry-point maps for large codebases
- docs that should explain **why** things exist, not mirror the code

When pi sees a magic doc, it starts tracking it for the session. After the conversation goes idle, the extension injects a follow-up message (via `sendMessage` with `customType: "magic-docs-update"`) telling the agent to re-read the doc and update it in place.

## Magic doc format

A magic doc must start with this header as the first non-empty line:

```md
# MAGIC DOC: Auth System Design
*Focus on auth flow, permission model, and error handling*
```

Rules:
- `# MAGIC DOC: ...` is required
- the title is everything after the colon
- the italic line is optional
- the header must be the first non-empty line in the file

## How it works

1. pi reads, edits, or writes a magic doc
2. the extension starts tracking that file for the current session
3. after **2 consecutive idle agent runs** (no tool calls in either), the extension injects an update prompt
4. the agent re-reads the tracked docs and updates them in place if anything meaningful changed
5. a 5-minute cooldown prevents rapid-fire reminders

This keeps docs aligned with the actual conversation, not just the current file contents.

## Update behavior

Magic Docs are for high-signal documentation:

- terse
- current-state only
- architecture and rationale over code walkthroughs
- no changelog-style "previously..." notes
- stale sections should be replaced or deleted

If nothing meaningful changed, the agent should skip the update.

## Why this exists

Most docs rot because updating them is a separate task.

Magic Docs turns documentation maintenance into a background habit:
- work on the code
- talk through decisions
- let pi notice the idle moment
- refresh the important docs before context disappears

## License

MIT
