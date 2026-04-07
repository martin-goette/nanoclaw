# Idle-Timeout Session Rotation

**Date:** 2026-04-07
**Status:** Design approved, pending implementation plan

## Problem

Dana's agent container resumes the same Claude Agent SDK session indefinitely. One session file (`267a2f54-….jsonl`) has grown to 33 MB since Apr 3, 2026. Every turn re-reads the full prefix as cache-read tokens, driving ~14.5M Sonnet cache-read tokens in ~36 hours and dominating dana's post-optimization cost (~$25/week Sonnet on dana alone, ~68% of the 5-agent post-optimization spend).

Root cause: the host persists `sessionId` per group and threads it back into every `ContainerInput`, with no rotation policy. Auto-compact archives transcripts but does not bound cache-read growth between compactions.

## Goal

Bound cache-read growth on long-lived agents by rotating to a fresh session after a configurable idle window, while preserving short-burst conversational continuity (target: 10–15 minutes).

## Non-Goals

- Retroactively compacting the existing 33 MB dana session. It will age out naturally on the next idle gap.
- Per-group timeout configurability. Global only.
- Changing SDK auto-compact behavior.
- Altering scheduled-task behavior. Scheduled tasks are already stateless and stay unchanged.

## Design

### Overview

One change point in the host. Zero changes inside the container. The host already owns `session_id` per group; we add a `last_turn_at` timestamp alongside it and decide at dispatch time whether to pass the stored `sessionId` or start fresh.

### Components

**1. Schema — `src/db.ts`**

Add a nullable column to the groups table:

```sql
ALTER TABLE groups ADD COLUMN last_turn_at INTEGER;
```

Additive migration. `NULL` means "treat as idle → rotate". No backfill needed.

**2. Rotation decision — in the dispatch path (`src/ipc.ts` or wherever `ContainerInput` is assembled)**

Pure function, easy to unit test:

```ts
export function shouldRotateSession(
  lastTurnAt: number | null,
  now: number,
  timeoutMin: number,
): boolean {
  if (lastTurnAt == null) return true;
  return now - lastTurnAt > timeoutMin * 60_000;
}
```

At dispatch:

```ts
const rotate = shouldRotateSession(group.lastTurnAt, Date.now(), cfg.sessionIdleTimeoutMin);
const sessionId = rotate ? undefined : group.sessionId;
log(rotate
  ? `[ipc] group=${group.name} idle → rotating session`
  : `[ipc] group=${group.name} resuming session ${sessionId}`);
```

The container already treats `sessionId: undefined` as "start new" (`container/agent-runner/src/index.ts:690`). No container changes needed.

**3. State writeback**

After a successful turn, persist both the returned `newSessionId` and `last_turn_at = Date.now()` in a single DB update. The host already writes `newSessionId` today; this piggybacks the timestamp.

On container failure (no successful turn), neither field is updated, which naturally promotes the next message to rotation.

**4. Config — `src/config.ts`**

Add a single env var:

```ts
sessionIdleTimeoutMin: Number(process.env.SESSION_IDLE_TIMEOUT_MIN) || 15,
```

Default 15 minutes. Document in `.env.example`.

### Data Flow

```
inbound message
  → load group state { sessionId, lastTurnAt }
  → shouldRotateSession(lastTurnAt, now, timeoutMin)
  → dispatch container with sessionId (or undefined)
  → container returns newSessionId
  → persist { session_id: newSessionId, last_turn_at: now }
```

### Edge Cases

| Case | Behavior |
|---|---|
| First message ever (`last_turn_at IS NULL`) | Rotate → fresh session. Correct. |
| Two messages 1 min apart | Resume same session. Matches intent. |
| Two messages 20 min apart | Rotate. Matches intent. |
| Container crash mid-turn | `last_turn_at` not written → next message rotates. Safe degradation. |
| Scheduled tasks | Already pass `isScheduledTask: true` and do not persist sessionId (`container/agent-runner/src/index.ts:786`). Unchanged. |
| `SESSION_IDLE_TIMEOUT_MIN` unset or `0` | Falls through to default 15. No "disable" mode (YAGNI — set a huge value if needed). |
| Burst extending past the timeout | A message at minute 14 extends the window by another 15 min from that point. Desired behavior. |

### Testing

**Unit tests** (pure function, trivial):
- `shouldRotateSession(null, t, 15) === true`
- `shouldRotateSession(t - 60_000, t, 15) === false`
- `shouldRotateSession(t - 20 * 60_000, t, 15) === true`
- Boundary: exactly `timeoutMin` minutes elapsed → `false` (strict `>`).

**Integration test** (against host dispatch):
- Two messages 1 min apart → same `sessionId` passed to container runner both times.
- Two messages 20 min apart (mock clock) → second call receives `sessionId: undefined`.
- Message after a simulated container failure → rotates regardless of elapsed time (because `last_turn_at` wasn't written).

**Manual verification on dana post-deploy:**
- Watch `data/sessions/slack_dana/.claude/projects/-workspace-group/*.jsonl`: should see multiple smaller session files appearing instead of one file growing unbounded.
- Re-run the token analysis script after 48 h; expect cache-read tokens per session to drop substantially.

### Observability

Log every rotation decision at info level in the host:

```
[ipc] group=dana idle=22min → rotating session
[ipc] group=dana resuming session 267a2f54-…
```

Makes behavior verifiable from host logs without instrumentation.

## Expected Impact

Dana's 14.5M Sonnet cache-read tokens over ~36 h are concentrated in one long-lived session. Rotating at 15 min idle should fragment that into many short sessions, each with a small prefix. Rough estimate: 60–80% reduction in dana's Sonnet cache-read cost, taking her from ~$25/week to ~$5–10/week. The other four agents are small enough that the effect is marginal, but they get the same safety net for free.

## Rollout

1. Land the change behind the env var (default 15 min).
2. Deploy; watch host logs for rotation decisions over 24 h.
3. Re-run the token analysis script; compare dana's cache-read tokens per day against the pre-change baseline.
4. If the 33 MB legacy session is still being resumed (it will be, until the first 15-min gap), either wait it out or manually clear `session_id` on the dana row to force rotation.
