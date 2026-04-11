# Idle-Timeout Session Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound cache-read token growth on long-lived agents by starting a fresh Claude Agent SDK session whenever the time since the last turn exceeds a configurable idle window (default 15 minutes).

**Architecture:** Additive SQLite column (`sessions.last_turn_at`), a pure rotation-decision helper, one env var in `config.ts`, and a small patch to the dispatch path in `src/index.ts` to consult the timestamp before passing `sessionId` to the container runner and to write the timestamp back on successful turns. No container changes.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, vitest.

**Spec:** [docs/superpowers/specs/2026-04-07-idle-timeout-session-rotation-design.md](../specs/2026-04-07-idle-timeout-session-rotation-design.md)

---

## Background for the implementer

NanoClaw runs per-group Claude Agent SDK containers. The host (`src/index.ts`) persists the SDK session ID per group in a SQLite table called `sessions` (group_folder PK, session_id). On each turn, the host reads the stored sessionId and passes it into `runContainerAgent(..., { sessionId, ... })`. The container resumes that session if the ID is set, or starts a fresh one if `undefined`. After a successful turn, the container emits a `newSessionId` which the host writes back via `setSession(folder, id)`.

The problem: there is no idle timeout. One session on the `slack_dana` group has grown to 33 MB since 2026-04-03 and keeps getting resumed, re-reading its entire prefix as cache-read tokens every turn.

This plan wires an idle timestamp through the existing session path with the smallest possible surface area.

Key files you will touch:
- `src/db.ts` — schema, migration, and session accessors (lines 72–75 for schema, 578–606 for accessors, 87–108 for the additive migration pattern).
- `src/config.ts` — add one constant.
- `src/index.ts` — rotation decision at dispatch time (around line 316–381 — function `runAgent`).
- `src/db.test.ts` — unit tests for the new accessor.
- New file: `src/session-rotation.ts` — the pure decision helper.
- New file: `src/session-rotation.test.ts` — unit tests for the helper.

Key conventions to follow:
- Additive migrations are wrapped in `try { db.exec('ALTER TABLE ...') } catch { /* column already exists */ }` — see `src/db.ts:87–108` for examples.
- Tests use `vitest` and `_initTestDatabase()` to set up an in-memory DB in `beforeEach`.
- Env-var config uses `parseInt(process.env.X || 'default', 10)` and is exported as a top-level const from `src/config.ts`.

---

## File Structure

**New files:**
- `src/session-rotation.ts` — pure `shouldRotateSession(lastTurnAt, now, timeoutMin)` helper. Single responsibility, no imports from the rest of the app, trivially testable.
- `src/session-rotation.test.ts` — unit tests for the helper.

**Modified files:**
- `src/db.ts`
  - Extend `sessions` table with a nullable `last_turn_at INTEGER` column (additive migration).
  - Replace the string-returning `getSession` with `getSessionMeta(folder)` returning `{ sessionId, lastTurnAt } | undefined`. Keep `getSession` as a thin wrapper for backward compatibility (it's also used by `task-scheduler.ts` via `getAllSessions`, which we leave unchanged).
  - Extend `setSession` to accept an optional `lastTurnAt` parameter and persist it.
- `src/config.ts` — add `SESSION_IDLE_TIMEOUT_MIN` exported constant.
- `src/index.ts`
  - In `runAgent`, before dispatch: read `{ sessionId, lastTurnAt }` via `getSessionMeta`, decide rotation with `shouldRotateSession`, log the decision, pass either the stored sessionId or `undefined` to the container.
  - At the two write-back sites (the wrapped-output callback around line 354–357 and the post-run block around line 378–381): also pass `Date.now()` as `lastTurnAt` to `setSession`.
- `src/db.test.ts` — add a `describe('session metadata')` block covering the new accessor signatures.

**`.env.example`** — document the new env var.

---

## Task 1: Add `last_turn_at` column to `sessions` table

**Files:**
- Modify: `src/db.ts` (schema ~line 72–75, migration block ~line 87–167)

- [ ] **Step 1: Add additive migration for `last_turn_at`**

In `src/db.ts`, find the existing migration try/catch blocks (starting around line 87). Add a new block after the last one (after the reply-context migration that ends around line 166):

```ts
  // Add last_turn_at column to sessions if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE sessions ADD COLUMN last_turn_at INTEGER`,
    );
  } catch {
    /* column already exists */
  }
```

Also update the `CREATE TABLE IF NOT EXISTS sessions` statement around line 72 to include the new column for fresh databases:

```ts
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      last_turn_at INTEGER
    );
```

- [ ] **Step 2: Verify the project still builds**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "db: add last_turn_at column to sessions table"
```

---

## Task 2: Add `getSessionMeta` accessor and extend `setSession`

**Files:**
- Modify: `src/db.ts` (session accessors ~line 578–606)
- Modify: `src/db.test.ts` (add new describe block at end of file)

- [ ] **Step 1: Write failing tests for the new accessor shape**

Append to `src/db.test.ts`:

```ts
describe('session metadata', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns undefined when no session has been stored', () => {
    expect(getSessionMeta('nonexistent')).toBeUndefined();
  });

  it('stores and retrieves sessionId with lastTurnAt', () => {
    setSession('dana', 'sess-abc', 1_000_000);
    expect(getSessionMeta('dana')).toEqual({
      sessionId: 'sess-abc',
      lastTurnAt: 1_000_000,
    });
  });

  it('returns null lastTurnAt when only sessionId is set (legacy row)', () => {
    setSession('legacy', 'sess-xyz');
    expect(getSessionMeta('legacy')).toEqual({
      sessionId: 'sess-xyz',
      lastTurnAt: null,
    });
  });

  it('overwrites sessionId and lastTurnAt on subsequent writes', () => {
    setSession('dana', 'sess-1', 1_000);
    setSession('dana', 'sess-2', 2_000);
    expect(getSessionMeta('dana')).toEqual({
      sessionId: 'sess-2',
      lastTurnAt: 2_000,
    });
  });

  it('legacy getSession still returns just the sessionId string', () => {
    setSession('dana', 'sess-abc', 1_000);
    expect(getSession('dana')).toBe('sess-abc');
  });
});
```

Add `getSessionMeta` to the imports at the top of `src/db.test.ts`:

```ts
import {
  _initTestDatabase,
  _closeDatabase,
  // ... existing imports ...
  getSession,
  setSession,
  getSessionMeta,
} from './db.js';
```

(Only add `getSession` and `getSessionMeta` if not already imported; leave the other imports as-is.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts -t "session metadata"`
Expected: FAIL — `getSessionMeta is not exported` or similar import error.

- [ ] **Step 3: Implement `getSessionMeta` and extend `setSession`**

In `src/db.ts`, replace the existing `getSession` and `setSession` (lines 580–591) with:

```ts
export interface SessionMeta {
  sessionId: string;
  lastTurnAt: number | null;
}

export function getSession(groupFolder: string): string | undefined {
  return getSessionMeta(groupFolder)?.sessionId;
}

export function getSessionMeta(groupFolder: string): SessionMeta | undefined {
  const row = db
    .prepare(
      'SELECT session_id, last_turn_at FROM sessions WHERE group_folder = ?',
    )
    .get(groupFolder) as
    | { session_id: string; last_turn_at: number | null }
    | undefined;
  if (!row) return undefined;
  return { sessionId: row.session_id, lastTurnAt: row.last_turn_at };
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  lastTurnAt?: number,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id, last_turn_at) VALUES (?, ?, ?)',
  ).run(groupFolder, sessionId, lastTurnAt ?? null);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts -t "session metadata"`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full db test file to verify no regressions**

Run: `npx vitest run src/db.test.ts`
Expected: PASS (all existing tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "db: add getSessionMeta accessor and lastTurnAt support in setSession"
```

---

## Task 3: Add `SESSION_IDLE_TIMEOUT_MIN` config

**Files:**
- Modify: `src/config.ts` (add near the other CONTAINER_* / IDLE_TIMEOUT constants around line 66)
- Modify: `.env.example` (add new variable)

- [ ] **Step 1: Add the constant**

In `src/config.ts`, after the `IDLE_TIMEOUT` line (around line 66), add:

```ts
// Idle window after which an agent session is rotated (new SDK session started).
// Bounds cache-read token growth on long-lived conversational agents.
export const SESSION_IDLE_TIMEOUT_MIN = Math.max(
  1,
  parseInt(process.env.SESSION_IDLE_TIMEOUT_MIN || '15', 10) || 15,
);
```

- [ ] **Step 2: Document the env var**

Append to `.env.example`:

```
# Minutes of idleness before an agent's SDK session is rotated to a fresh one.
# Bounds cache-read token cost on long-lived agents. Default: 15.
SESSION_IDLE_TIMEOUT_MIN=15
```

- [ ] **Step 3: Verify the build still passes**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts .env.example
git commit -m "config: add SESSION_IDLE_TIMEOUT_MIN env var"
```

---

## Task 4: Create the pure rotation-decision helper

**Files:**
- Create: `src/session-rotation.ts`
- Create: `src/session-rotation.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/session-rotation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldRotateSession } from './session-rotation.js';

describe('shouldRotateSession', () => {
  const NOW = 1_000_000_000_000; // arbitrary fixed "now"
  const MIN = 60_000;

  it('rotates when lastTurnAt is null (first turn ever)', () => {
    expect(shouldRotateSession(null, NOW, 15)).toBe(true);
  });

  it('does not rotate when elapsed < timeout', () => {
    expect(shouldRotateSession(NOW - 1 * MIN, NOW, 15)).toBe(false);
  });

  it('does not rotate when elapsed equals timeout exactly', () => {
    expect(shouldRotateSession(NOW - 15 * MIN, NOW, 15)).toBe(false);
  });

  it('rotates when elapsed > timeout', () => {
    expect(shouldRotateSession(NOW - 16 * MIN, NOW, 15)).toBe(true);
  });

  it('rotates after a long gap', () => {
    expect(shouldRotateSession(NOW - 24 * 60 * MIN, NOW, 15)).toBe(true);
  });

  it('respects a custom timeout', () => {
    expect(shouldRotateSession(NOW - 5 * MIN, NOW, 10)).toBe(false);
    expect(shouldRotateSession(NOW - 11 * MIN, NOW, 10)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/session-rotation.test.ts`
Expected: FAIL — `Cannot find module './session-rotation.js'`.

- [ ] **Step 3: Implement the helper**

Create `src/session-rotation.ts`:

```ts
/**
 * Decide whether to rotate a group's Agent SDK session based on idle time.
 *
 * Returns true if there is no prior turn recorded, or if the time since the
 * last turn exceeds the configured idle window. The caller should then pass
 * `sessionId: undefined` to the container runner so a fresh session starts.
 *
 * Pure function — no side effects, no I/O. Keep it that way.
 *
 * @param lastTurnAt  Epoch ms of the last successful turn, or null if none.
 * @param now         Epoch ms of the current moment (inject for testability).
 * @param timeoutMin  Idle window in minutes.
 */
export function shouldRotateSession(
  lastTurnAt: number | null,
  now: number,
  timeoutMin: number,
): boolean {
  if (lastTurnAt == null) return true;
  return now - lastTurnAt > timeoutMin * 60_000;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/session-rotation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/session-rotation.ts src/session-rotation.test.ts
git commit -m "feat: add shouldRotateSession pure helper for idle-based rotation"
```

---

## Task 5: Wire rotation into the dispatch path in `runAgent`

**Files:**
- Modify: `src/index.ts` (imports, `runAgent` around line 316–410)

- [ ] **Step 1: Add imports**

At the top of `src/index.ts`, add to the existing `./db.js` import (around line 37):

```ts
  getSessionMeta,
```

Add a new import block nearby for the config and helper:

```ts
import { SESSION_IDLE_TIMEOUT_MIN } from './config.js';
import { shouldRotateSession } from './session-rotation.js';
```

(If `./config.js` is already imported, add `SESSION_IDLE_TIMEOUT_MIN` to the existing import list instead of creating a new import line.)

- [ ] **Step 2: Replace the sessionId lookup in `runAgent`**

Find this block in `runAgent` (around line 322–323):

```ts
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];
```

Replace with:

```ts
  const isMain = group.isMain === true;
  const meta = getSessionMeta(group.folder);
  const storedSessionId = meta?.sessionId;
  const rotate = shouldRotateSession(
    meta?.lastTurnAt ?? null,
    Date.now(),
    SESSION_IDLE_TIMEOUT_MIN,
  );
  const sessionId = rotate ? undefined : storedSessionId;

  if (storedSessionId && rotate) {
    logger.info(
      {
        group: group.name,
        previousSessionId: storedSessionId,
        idleTimeoutMin: SESSION_IDLE_TIMEOUT_MIN,
      },
      'Rotating agent session after idle timeout',
    );
  } else if (sessionId) {
    logger.debug(
      { group: group.name, sessionId },
      'Resuming agent session',
    );
  }
```

- [ ] **Step 3: Update the two `setSession` write-back sites to persist `lastTurnAt`**

Find the wrapped output callback block (around lines 352–360):

```ts
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;
```

Replace the inner `setSession` call to include a timestamp:

```ts
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId, Date.now());
        }
        await onOutput(output);
      }
    : undefined;
```

Then find the post-run block (around lines 378–381):

```ts
    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
```

Replace with:

```ts
    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId, Date.now());
    }
```

- [ ] **Step 4: Verify the build passes**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS. No previously-green tests should fail. (If the project's vitest setup emits unrelated warnings, ignore them as long as all tests pass.)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: rotate agent session after idle timeout in runAgent dispatch"
```

---

## Task 6: Manual verification on dana

**Files:** none (runtime verification)

- [ ] **Step 1: Build and restart the service**

Run: `npm run build`
Then restart the NanoClaw service. On Linux: `systemctl --user restart nanoclaw`. On macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.

- [ ] **Step 2: Force a rotation on dana to skip the 33 MB legacy session**

Because the existing 33 MB session is still valid, the very next dana message will still resume it (unless 15 min have elapsed since the last turn). To prove the new path immediately, manually clear dana's stored session before sending a test message:

```bash
# With sqlite3 available:
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='slack_dana';"
```

If `sqlite3` is not installed, skip this step and just wait 15 min of idle before sending the test message.

- [ ] **Step 3: Send a test message to dana and verify rotation log**

Send any normal message to dana on Slack. Then check the host logs for one of:

```
Rotating agent session after idle timeout
```

or

```
Resuming agent session
```

On the first post-change message for dana you should see the rotation log (because `last_turn_at` is null). On a second message sent within 15 min you should see the resume log.

- [ ] **Step 4: Verify a new session file appears on disk**

Run: `ls -lS data/sessions/slack_dana/.claude/projects/-workspace-group/*.jsonl | head`

Expected: a new small `.jsonl` file (< 200 KB) appears, alongside the old 33 MB file. The old file will stop growing.

- [ ] **Step 5: After 24 hours, re-run the token analysis script**

Compare cache-read token volume on dana against the pre-change baseline from the earlier audit. Expectation: cache-read tokens per day drop substantially (target: 60–80%).

No commit for this task — it's verification only.

---

## Self-Review

Checked against the spec:

- **Spec §"Schema extension":** covered by Task 1.
- **Spec §"Rotation decision":** covered by Task 4 (pure helper) + Task 5 (wiring).
- **Spec §"State writeback":** covered by Task 5, steps 3 (both write-back sites updated).
- **Spec §"Config":** covered by Task 3.
- **Spec §"Edge case: first message ever":** covered by Task 4 test "rotates when lastTurnAt is null".
- **Spec §"Edge case: scheduled tasks unchanged":** preserved by leaving `task-scheduler.ts` and `getAllSessions` untouched; scheduled tasks do not go through `runAgent`'s session path.
- **Spec §"Edge case: container crash":** implicit — `setSession` is only called on `output.newSessionId`, which is only set on successful turns, so `last_turn_at` is not written on failures.
- **Spec §"Observability":** covered by Task 5 step 2 (info log for rotation, debug log for resume).
- **Spec §"Testing — unit tests":** covered by Tasks 2 and 4.
- **Spec §"Testing — manual verification":** covered by Task 6.

No placeholders. No "add error handling later" hand-waves. Every code step shows the full code to write. Types are consistent across tasks (`SessionMeta` defined in Task 2 is used transitively; `shouldRotateSession` signature in Task 4 matches the call in Task 5).
