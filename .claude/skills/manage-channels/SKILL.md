---
name: manage-channels
description: Wire channels to agent groups, manage isolation levels, add new channel groups. Use after adding a channel, during setup, or standalone to reconfigure.
---

# Manage Channels

Wire messaging channels to agent groups. See `docs/v2-isolation-model.md` for the full isolation model.

## Assess Current State

Read the v2 central DB (`data/v2.db`) — query `agent_groups`, `messaging_groups`, and `messaging_group_agents` tables. Also check `.env` for channel tokens and `src/channels/index.ts` for uncommented imports.

Categorize channels as: **wired** (has DB entities), **configured but unwired** (has credentials + barrel import, no DB entities), or **not configured**.

## First Channel (No Agent Groups Exist)

1. Ask the assistant name (default: project name or "Andy")
2. Ask which channel is the primary/admin channel
3. Ask for the platform ID — read the channel's SKILL.md `## Channel Info` > `how-to-find-id` to guide them
4. Register:

```bash
npx tsx setup/index.ts --step register -- \
  --platform-id "<id>" --name "<name>" --folder "main" \
  --channel "<type>" --is-main --no-trigger-required \
  --assistant-name "<name>" --session-mode "shared"
```

5. Continue to "Wire New Channel" for any remaining configured channels.

## Wire New Channel

For each unwired channel:

1. Read its SKILL.md `## Channel Info` for terminology, how-to-find-id, typical-use, and default-isolation
2. Ask for the platform ID using the platform's terminology
3. Ask the isolation question (see below)
4. Register with the appropriate flags

### Isolation Question

Present a multiple-choice with a contextual recommendation. The three options:

- **Same conversation** (`--session-mode "agent-shared"` + existing folder) — all messages land in one session. Recommend for webhook + chat combos (GitHub + Slack).
- **Same agent, separate conversations** (`--session-mode "shared"` + existing folder) — shared workspace/memory, independent threads. Recommend for same user across platforms.
- **Separate agent** (new `--folder`) — full isolation. Recommend when different people are involved.

Use the channel's `typical-use` and `default-isolation` fields to pick the recommendation. Offer to explain more if the user is unsure — reference `docs/v2-isolation-model.md` for the detailed explanation.

### Register Command

```bash
npx tsx setup/index.ts --step register -- \
  --platform-id "<id>" --name "<name>" \
  --folder "<folder>" --channel "<type>" \
  --session-mode "<shared|agent-shared>" \
  --assistant-name "<name>"
```

For separate agents, also ask for a folder name and optionally a different assistant name.

## Add Channel Group

When adding another group/chat on an already-configured platform (e.g. a second Telegram group):

1. Read the channel's SKILL.md `## Channel Info` for terminology and how-to-find-id
2. Ask for the new group/chat ID
3. Ask the isolation question
4. Register — no package or credential changes needed

## Change Wiring

1. Show current wiring
2. Ask which channel to move and to which agent group
3. Delete the old `messaging_group_agents` entry, create a new one
4. Note: existing sessions stay with the old agent group; new messages route to the new one

## Show Configuration

Display a readable summary showing agent groups with their wired channels, configured-but-unwired channels, and unconfigured channels.
