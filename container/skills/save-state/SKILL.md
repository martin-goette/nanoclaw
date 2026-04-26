---
name: save-state
description: Save session state to STATE.md so a fresh thread, a scheduled task, or a cross-channel hand-off can pick up with full context. Captures recent work, pending items, active projects, and key decisions.
---

# /save-state

Write or merge `/workspace/agent/STATE.md` so the next *fresh* session has the
context it needs. Lives in the per-group filesystem, so it's visible to every
session in this agent group regardless of which Slack thread the user starts.

## Why this exists

Per-thread Slack sessions persist indefinitely — replies in the same thread
resume the same SDK conversation with full history. STATE.md is for the
cases where that history isn't available:

- **A new top-level Slack post** opens a fresh thread and a fresh session
  with zero memory of older threads. The agent's first move should be to
  read STATE.md.
- **A scheduled task fires in its own session** — it sees CLAUDE.local.md
  and STATE.md, not the chat threads.
- **Memory rotation, group hand-offs, or anything that resets context**.

Within a single live thread STATE.md doesn't matter — the SDK already has
full conversation context. Don't pollute the doc with mid-thread snapshots.

## When to run

Trigger save-state when *something the next session would need to know*
just happened. Concretely:

- A multi-step task closed (project shipped, decision finalized, plan
  signed off).
- Pending items changed (new commitments accepted, deadlines moved,
  blockers added).
- A regular checkpoint cadence the user has asked for (e.g. weekly Sunday
  recap, end-of-day shutdown).
- The user explicitly types `/save-state` or asks for a state save.

Skip it for chit-chat, single-question Q&A, or work that's already
captured elsewhere (CLAUDE.local.md, a project file, an issue tracker).

## What to capture

Write or merge `/workspace/agent/STATE.md` with these sections:

```markdown
# State

**Last updated:** <ISO datetime>

---

## Active Projects
- Project name, repo path, current sprint/phase

## Recent Work (This Session)
- Bullet list of what was done, with enough detail to resume

## Pending / Carry Forward
- Items that still need attention, with deadlines if known

## Key Decisions
- Decisions made this session that affect future work

## Important References
- IDs, URLs, file paths that will be needed again

## Previous Sessions
- One-line summary per past session (roll off entries older than 2 weeks)
```

## Rules

- **Merge, don't overwrite.** Read STATE.md first; preserve unrelated content.
- Move completed items out of "Pending" into "Recent Work" before saving.
- Keep it concise — STATE.md is a handoff doc, not a journal.
- Use absolute dates ("2026-04-26"), never relative ("today", "yesterday").
- Don't duplicate things that belong in CLAUDE.local.md (durable memory like
  user preferences, persistent facts). STATE.md is *current state*.

## Reading STATE.md (the consumer side)

When a fresh session starts and the user's first message references work
that doesn't appear in CLAUDE.local.md or the current thread, read
STATE.md before responding. If the file is missing, proceed without it —
it's optional context, not a hard dependency.
