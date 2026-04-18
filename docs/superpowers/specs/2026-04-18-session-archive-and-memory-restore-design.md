# Session Archive & Memory Restore

**Date:** 2026-04-18
**Status:** Design approved, pending implementation plan

## Problem

Agent memory across conversations has degraded noticeably over the past 2–3 weeks. Three commits landed in sequence and compounded:

1. **`db3440f` (Apr 4)** — hardcoded `model: 'sonnet[1m]'` with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000`. Sensible as a pair: 1M context, compact at 200k to cap cost.
2. **`6e53fa8` (Apr 6)** — replaced `sonnet[1m]` with 3-tier `HAIKU/SONNET/OPUS` model selection. `SONNET = 'claude-sonnet-4-6'` is the 200k variant, not 1M. The 200k auto-compact env var was left in place, so compact is now configured at the context ceiling — it effectively never fires cleanly.
3. **`d3b2c6a` + `a6dcc93` (Apr 7/11)** — idle-timeout session rotation at 15 minutes. Every 15 min of chat idle starts a fresh SDK session. The `PreCompact` archiver hook (`container/agent-runner/src/index.ts:208`) only fires on SDK compaction, not on host-side rotation — so rotation is lossy.

Evidence:
- `groups/slack_dana/conversations/` last entry is `2026-04-06-*.md`. No archives since rotation shipped on Apr 7.
- `data/sessions/slack_dana/.claude/projects/-workspace-group/` contains a pile of small-to-medium `.jsonl` files (~200KB–2MB), each a rotation fragment.
- `STATE.md` handoff relies on the agent remembering to invoke `/save-state` mid-session; 15-min rotation doesn't trigger it.

## Goal

Restore cross-conversation memory without giving up the cost ceiling that session rotation provides. Three changes together:

1. Archive old sessions on rotation (lossless rotation).
2. Raise the idle timeout default to a chat-friendly value.
3. Restore 1M context so the 200k auto-compact threshold is meaningful again.

## Non-Goals

- Retroactively extracting the lost rotation transcripts from Apr 7–18. Those stay on disk as `.jsonl`; we don't convert them.
- Changing the `STATE.md` / `/save-state` mechanism. It remains agent-invoked.
- Auto-injecting archived conversation summaries into fresh sessions. Discoverable via `conversations/` is enough for now; injection is a follow-up if archives alone don't close the gap.
- Per-group idle timeout. Global only.
- Touching Haiku for scheduled simple reminders — no reason to pay 1M there.

## Design

### Overview

Two host-side changes and one container-side change:

- **Host:** archive the old session's transcript to `groups/<folder>/conversations/` whenever `shouldRotateSession` decides to rotate, before passing `sessionId: undefined` to the container. Raise `SESSION_IDLE_TIMEOUT_MIN` default from 15 to 60.
- **Container:** make `selectModel` return `claude-sonnet-4-6[1m]` for interactive and non-simple scheduled work. Keep Haiku for simple reminders. The existing `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` env is correct for the 1M model and stays.

### Components

**1. Shared archive module — `src/conversation-archive.ts` (new, host-side)**

Extracts the transcript-archiving logic from `container/agent-runner/src/index.ts` (`parseTranscript`, `formatTranscriptMarkdown`, `sanitizeFilename`, `generateFallbackName`, `getSessionSummary`) into a standalone module with no SDK or filesystem-layout dependencies at the top level. Two entry points:

```ts
export function archiveTranscriptFromPath(
  transcriptPath: string,
  conversationsDir: string,
  opts: { sessionId: string; assistantName?: string; now?: Date },
): { archivedTo: string } | { skipped: 'missing' | 'empty' };
```

Pure where possible. The file I/O is concentrated in `archiveTranscriptFromPath`. Format and naming helpers are pure and exported for the container-side copy to import if the container build is wired to source the host module (see "Code sharing" below).

**Why host-side:** rotation happens in the host (`src/index.ts` `runAgent`, `src/task-scheduler.ts` `runTask`). The old session's `.jsonl` lives at `data/sessions/<groupFolder>/.claude/projects/-workspace-group/<sessionId>.jsonl` and is host-readable.

**2. Rotation call-site — `src/session-rotation.ts`**

Add a new host-side function:

```ts
export async function archiveRotatedSession(
  groupFolder: string,
  oldSessionId: string,
  assistantName?: string,
): Promise<void>;
```

Resolves the transcript path under `data/sessions/<groupFolder>/.claude/projects/-workspace-group/<oldSessionId>.jsonl`, calls `archiveTranscriptFromPath` targeting `groups/<groupFolder>/conversations/`, logs the result. Never throws to the caller — archive failure must not block dispatch.

**3. Wire-in points**

`src/index.ts` `runAgent`, around line 322 where `rotate` is decided:

```ts
if (storedSessionId && rotate) {
  logger.info({ ... }, 'Rotating agent session after idle timeout');
  archiveRotatedSession(group.folder, storedSessionId, ASSISTANT_NAME).catch(
    (err) => logger.warn({ err, group: group.name }, 'Archive-on-rotation failed'),
  );
}
```

Fire-and-forget: archive runs in parallel with dispatch. Correctness does not depend on it finishing before the new session starts.

`src/task-scheduler.ts` `runTask`, mirror site (around the new rotation block added in `a6dcc93`): same call.

**4. Idle-timeout default — `src/config.ts`**

```ts
export const SESSION_IDLE_TIMEOUT_MIN = Math.max(
  1,
  parseInt(process.env.SESSION_IDLE_TIMEOUT_MIN || '60', 10) || 60,
);
```

Update `.env.example` default to `60`.

**5. Model restoration — `container/agent-runner/src/index.ts`**

```ts
const HAIKU   = 'claude-haiku-4-5-20251001';
const SONNET  = 'claude-sonnet-4-6';
const SONNET_1M = 'claude-sonnet-4-6[1m]';
const OPUS    = 'claude-opus-4-6';

const VALID_MODELS = new Set([HAIKU, SONNET, SONNET_1M, OPUS]);

function selectModel(input: ContainerInput): string {
  if (input.model) {
    return VALID_MODELS.has(input.model) ? input.model : SONNET_1M;
  }
  if (input.isScheduledTask) {
    const isSimple = SIMPLE_REMINDER_PATTERNS.some((p) => p.test(input.prompt));
    if (isSimple) return HAIKU;
  }
  return SONNET_1M;
}
```

`CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` stays unchanged. With the 1M model, this means "compact when context hits 200k" — restoring the original intent of `db3440f`.

### Code sharing

The container's `PreCompact` hook already has an in-line copy of the parse/format/archive logic. We won't force these to share code via a build step — the duplication is small (<100 lines) and changes rarely.

Decision: **two copies, both marked `// KEEP-IN-SYNC with src/conversation-archive.ts`**. If the markdown format or filename rules change, fix both. Any drift is surface-visible (archive files look different) and cheap to repair.

If duplication pain shows up, promote the shared module into the container build later.

### Edge cases

- **No transcript on disk:** archive returns `{ skipped: 'missing' }`, logged at `info`. Happens when rotation fires on a group whose session has already been deleted externally.
- **Empty transcript (no user/assistant messages):** skipped, logged.
- **Rotation on first message ever for a group:** `storedSessionId` is undefined, `archiveRotatedSession` is not called. Handled by the `if (storedSessionId && rotate)` guard.
- **Concurrent archive + new session using the same `.jsonl`:** the old path is a different file from the new session's `.jsonl` (new sessionId ⇒ new file). No contention.
- **Archive write fails mid-write:** logged, partial file deleted on next rotation attempt is not our concern; next rotation archives the next session.
- **Model downgrade breakage:** `VALID_MODELS` guard: if a stored scheduled task has `model: "sonnet"` (200k), that still resolves; host-provided overrides pass through untouched.

### Observability

- Log `Archive-on-rotation: <filename>` at `info` on success.
- Log `Archive-on-rotation skipped (<reason>)` at `info` on skip.
- Log `Archive-on-rotation failed` at `warn` on exception (caught, swallowed).
- Existing rotation logs from `d3b2c6a` unchanged.

### Testing

**Unit — `src/conversation-archive.test.ts`:**
- Parses a fixture `.jsonl` into `{ role, content }[]`.
- Formats into the same markdown shape the container currently produces (snapshot-style).
- Filename sanitization + fallback naming (time-based).
- Skips on missing path, skips on empty transcript.

**Unit — extend `src/session-rotation.test.ts`:**
- `archiveRotatedSession` calls the archive function with the expected path and conversations dir for a given `groupFolder` + `sessionId`.
- Archive failure does not throw.

**Manual verification:**
1. Rebuild, restart service.
2. Send a message to a quiet group (`slack_shelby` — last active 2026-04-17). Wait >60 min. Send another message. Expect `groups/slack_shelby/conversations/2026-04-18-<summary>.md` to appear, and a fresh `.jsonl` to exist for the new session.
3. Scheduled daily digest on dana fires the next morning — check `conversations/` gets an archive from its rotation.
4. Send two messages to the same group within 60 min — no rotation, no new archive, no new `.jsonl` (confirms rotation threshold change).

### Rollback

All three changes are independent and revertible:
- Archive module: deleting the file + removing the two call-sites restores prior behavior.
- Idle timeout: single env var or one constant.
- Model: revert `selectModel` to return `SONNET`.

Each lands as a separate commit so `git revert` targets them individually.

## Out of scope / follow-ups

- Auto-inject most recent archived conversation summary into fresh sessions as prompt prefix.
- Retroactive archive of the orphaned `.jsonl` files from Apr 7–18.
- Per-group rotation timeouts.
- Measuring cache-read token deltas post-change (only matters if cost spikes; revisit if it does).
