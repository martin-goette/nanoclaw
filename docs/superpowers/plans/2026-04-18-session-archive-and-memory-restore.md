# Session Archive & Memory Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore cross-conversation memory without giving up the cost ceiling of idle-timeout rotation — archive on rotation, raise the idle timeout, and restore 1M context so the 200k auto-compact threshold is meaningful again.

**Architecture:** Three independent, revertible changes landing as separate commits. A new host-side `src/conversation-archive.ts` module mirrors the container's `PreCompact` hook parsing/formatting; a new `archiveRotatedSession` helper in `src/session-rotation.ts` is called fire-and-forget from `src/index.ts` `runAgent` and `src/task-scheduler.ts` `runTask` whenever rotation fires. `SESSION_IDLE_TIMEOUT_MIN` default moves 15→60. Container `selectModel` switches the interactive default to `claude-sonnet-4-6[1m]`, keeping Haiku for simple scheduled reminders.

**Tech Stack:** TypeScript, Node.js, vitest, Claude Agent SDK.

**Spec:** [docs/superpowers/specs/2026-04-18-session-archive-and-memory-restore-design.md](../specs/2026-04-18-session-archive-and-memory-restore-design.md)

---

## Background for the implementer

NanoClaw is a host process that spawns per-group Claude Agent SDK containers. The host persists `{sessionId, lastTurnAt}` per group in SQLite (`sessions` table). On every turn, `src/index.ts` `runAgent` and `src/task-scheduler.ts` `runTask` consult `shouldRotateSession` (in `src/session-rotation.ts`) and either resume the stored session or pass `sessionId: undefined` for a fresh one. The per-group session `.jsonl` transcripts are written by the SDK under `data/sessions/<groupFolder>/.claude/projects/-workspace-group/<sessionId>.jsonl` (host-readable, since `data/sessions/<groupFolder>/.claude` is what the host bind-mounts into the container at `/home/node/.claude`).

Inside the container, a `PreCompact` hook at `container/agent-runner/src/index.ts:208` archives the session transcript to `/workspace/group/conversations/YYYY-MM-DD-<summary>.md` on SDK-initiated compaction. The helpers it uses — `parseTranscript`, `formatTranscriptMarkdown`, `sanitizeFilename`, `generateFallbackName`, `getSessionSummary` — live in that same file.

**The problem:** host-side rotation bypasses that hook entirely. Since rotation went in (2026-04-07), `conversations/` archives stopped for most groups. This plan adds a host-side mirror of the archiving logic and calls it from the two rotation decision points.

**Key paths:**
- Host sessions dir for a group: `data/sessions/<groupFolder>/.claude/projects/-workspace-group/`
- Group conversations dir: `groups/<groupFolder>/conversations/`
- `DATA_DIR` and `GROUPS_DIR` are exported from `src/config.ts`.

**Key conventions:**
- `vitest` with `describe`/`it`, `_initTestDatabase()` for DB tests in `beforeEach`.
- Host-side file I/O uses `node:fs` sync APIs.
- Logger is `pino`-style: `logger.info({ ... }, 'message')`.
- Env-var config: `parseInt(process.env.X || 'default', 10)` exported as a top-level const.
- Pre-commit runs `prettier --write "src/**/*.ts"` (auto-formats on commit).

---

## File Structure

**New files:**
- `src/conversation-archive.ts` — pure transcript parser + markdown formatter + filesystem archiver. Mirrors the container-side helpers. Not exported from `index.ts`; only used internally.
- `src/conversation-archive.test.ts` — unit tests for parsing, formatting, sanitization, archiving.

**Modified files:**
- `src/session-rotation.ts` — add `archiveRotatedSession(groupFolder, oldSessionId, assistantName?)` that resolves the transcript path and delegates to `conversation-archive.ts`.
- `src/session-rotation.test.ts` — add tests for `archiveRotatedSession` (happy path + failure-is-swallowed).
- `src/index.ts` — in `runAgent`, fire-and-forget `archiveRotatedSession` when rotation is decided.
- `src/task-scheduler.ts` — in `runTask` group-context rotation branch, same fire-and-forget call.
- `src/config.ts` — `SESSION_IDLE_TIMEOUT_MIN` default 15 → 60.
- `.env.example` — update default comment/value to 60.
- `container/agent-runner/src/index.ts` — add `SONNET_1M` constant, update `selectModel`, update `VALID_MODELS`.

---

## Task 1: Extract host-side conversation-archive module

**Files:**
- Create: `src/conversation-archive.ts`
- Create: `src/conversation-archive.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/conversation-archive.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archiveTranscriptFromPath,
  formatTranscriptMarkdown,
  parseTranscript,
  sanitizeFilename,
} from './conversation-archive.js';

describe('parseTranscript', () => {
  it('parses user and assistant messages from a JSONL transcript', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
        },
      }),
    ].join('\n');

    expect(parseTranscript(jsonl)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('handles user messages with array content', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ text: 'part 1 ' }, { text: 'part 2' }],
      },
    });
    expect(parseTranscript(jsonl)).toEqual([
      { role: 'user', content: 'part 1 part 2' },
    ]);
  });

  it('skips assistant messages with no text parts', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash' }],
      },
    });
    expect(parseTranscript(jsonl)).toEqual([]);
  });

  it('skips malformed JSON lines', () => {
    const jsonl = [
      'not json at all',
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'ok' },
      }),
    ].join('\n');
    expect(parseTranscript(jsonl)).toEqual([
      { role: 'user', content: 'ok' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseTranscript('')).toEqual([]);
  });
});

describe('formatTranscriptMarkdown', () => {
  it('renders a heading, archived-at line, and role-labelled messages', () => {
    const md = formatTranscriptMarkdown(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      'My Title',
      'Dana',
    );
    expect(md).toContain('# My Title');
    expect(md).toContain('Archived:');
    expect(md).toContain('**User**: hi');
    expect(md).toContain('**Dana**: hello');
  });

  it('uses "Conversation" when no title is given', () => {
    const md = formatTranscriptMarkdown(
      [{ role: 'user', content: 'hi' }],
      null,
    );
    expect(md).toContain('# Conversation');
  });

  it('uses "Assistant" when no assistantName is given', () => {
    const md = formatTranscriptMarkdown(
      [{ role: 'assistant', content: 'hello' }],
      null,
    );
    expect(md).toContain('**Assistant**: hello');
  });

  it('truncates messages longer than 2000 chars with an ellipsis', () => {
    const long = 'x'.repeat(2500);
    const md = formatTranscriptMarkdown(
      [{ role: 'user', content: long }],
      null,
    );
    expect(md).toContain('x'.repeat(2000) + '...');
    expect(md).not.toContain('x'.repeat(2001));
  });
});

describe('sanitizeFilename', () => {
  it('lowercases and replaces non-alphanumeric runs with single hyphens', () => {
    expect(sanitizeFilename('Hello, World! 123')).toBe('hello-world-123');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeFilename('!!foo!!')).toBe('foo');
  });

  it('truncates to 50 chars', () => {
    expect(sanitizeFilename('a'.repeat(100))).toHaveLength(50);
  });
});

describe('archiveTranscriptFromPath', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let conversationsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convo-archive-'));
    transcriptPath = path.join(tmpDir, 'session.jsonl');
    conversationsDir = path.join(tmpDir, 'conversations');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns { skipped: "missing" } when the transcript does not exist', () => {
    const result = archiveTranscriptFromPath(transcriptPath, conversationsDir, {
      sessionId: 's1',
    });
    expect(result).toEqual({ skipped: 'missing' });
    expect(fs.existsSync(conversationsDir)).toBe(false);
  });

  it('returns { skipped: "empty" } when the transcript has no user/assistant text', () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n',
    );
    const result = archiveTranscriptFromPath(transcriptPath, conversationsDir, {
      sessionId: 's1',
    });
    expect(result).toEqual({ skipped: 'empty' });
  });

  it('writes a dated markdown file to conversationsDir and returns its path', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello back' }],
        },
      }),
    ].join('\n');
    fs.writeFileSync(transcriptPath, jsonl);

    const fixedNow = new Date('2026-04-18T09:30:00Z');
    const result = archiveTranscriptFromPath(transcriptPath, conversationsDir, {
      sessionId: 's1',
      assistantName: 'Dana',
      now: fixedNow,
    });

    expect('archivedTo' in result).toBe(true);
    if (!('archivedTo' in result)) throw new Error('unreachable');
    expect(result.archivedTo).toMatch(/conversations\/2026-04-18-.+\.md$/);
    const body = fs.readFileSync(result.archivedTo, 'utf-8');
    expect(body).toContain('**User**: hi');
    expect(body).toContain('**Dana**: hello back');
  });

  it('uses a time-based fallback name when no sessions-index.json exists', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hi' },
    });
    fs.writeFileSync(transcriptPath, jsonl);

    const fixedNow = new Date('2026-04-18T09:30:00Z');
    const result = archiveTranscriptFromPath(transcriptPath, conversationsDir, {
      sessionId: 's1',
      now: fixedNow,
    });
    if (!('archivedTo' in result)) throw new Error('expected success');
    expect(path.basename(result.archivedTo)).toMatch(
      /^2026-04-18-conversation-\d{4}\.md$/,
    );
  });

  it('uses the summary from sessions-index.json when present', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hi' },
    });
    fs.writeFileSync(transcriptPath, jsonl);
    fs.writeFileSync(
      path.join(tmpDir, 'sessions-index.json'),
      JSON.stringify({
        entries: [
          {
            sessionId: 's1',
            fullPath: transcriptPath,
            summary: 'Planning the weekend trip',
            firstPrompt: 'hi',
          },
        ],
      }),
    );

    const fixedNow = new Date('2026-04-18T09:30:00Z');
    const result = archiveTranscriptFromPath(transcriptPath, conversationsDir, {
      sessionId: 's1',
      now: fixedNow,
    });
    if (!('archivedTo' in result)) throw new Error('expected success');
    expect(path.basename(result.archivedTo)).toBe(
      '2026-04-18-planning-the-weekend-trip.md',
    );
  });

  it('creates the conversations directory if it does not exist', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hi' },
    });
    fs.writeFileSync(transcriptPath, jsonl);
    expect(fs.existsSync(conversationsDir)).toBe(false);

    const result = archiveTranscriptFromPath(transcriptPath, conversationsDir, {
      sessionId: 's1',
    });
    if (!('archivedTo' in result)) throw new Error('expected success');
    expect(fs.existsSync(conversationsDir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/conversation-archive.test.ts`
Expected: FAIL — `Cannot find module './conversation-archive.js'`.

- [ ] **Step 3: Implement the module**

Create `src/conversation-archive.ts`:

```ts
// KEEP-IN-SYNC with container/agent-runner/src/index.ts (PreCompact hook
// helpers). If you change the markdown format or filename rules here, mirror
// the change in the container file.

import fs from 'fs';
import path from 'path';

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionIndexEntry[];
}

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return messages;
}

export function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title: string | null | undefined,
  assistantName?: string,
  now: Date = new Date(),
): string {
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function generateFallbackName(now: Date = new Date()): string {
  const hh = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  return `conversation-${hh}${mm}`;
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');
  if (!fs.existsSync(indexPath)) return null;
  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    return entry?.summary ?? null;
  } catch {
    return null;
  }
}

export type ArchiveResult =
  | { archivedTo: string }
  | { skipped: 'missing' | 'empty' };

export function archiveTranscriptFromPath(
  transcriptPath: string,
  conversationsDir: string,
  opts: { sessionId: string; assistantName?: string; now?: Date },
): ArchiveResult {
  if (!fs.existsSync(transcriptPath)) {
    return { skipped: 'missing' };
  }
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const messages = parseTranscript(content);
  if (messages.length === 0) {
    return { skipped: 'empty' };
  }

  const now = opts.now ?? new Date();
  const summary = getSessionSummary(opts.sessionId, transcriptPath);
  const name = summary ? sanitizeFilename(summary) : generateFallbackName(now);

  fs.mkdirSync(conversationsDir, { recursive: true });
  const date = now.toISOString().split('T')[0];
  const filename = `${date}-${name}.md`;
  const filePath = path.join(conversationsDir, filename);

  const markdown = formatTranscriptMarkdown(
    messages,
    summary,
    opts.assistantName,
    now,
  );
  fs.writeFileSync(filePath, markdown);
  return { archivedTo: filePath };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/conversation-archive.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Verify the build passes**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/conversation-archive.ts src/conversation-archive.test.ts
git commit -m "feat: add host-side conversation-archive module

Mirrors the container's PreCompact hook transcript parser and archiver
so host-initiated session rotation can archive before rotating. Kept as
a separate copy from the container (KEEP-IN-SYNC comment) to avoid
threading shared code through the container build."
```

---

## Task 2: Add `archiveRotatedSession` helper

**Files:**
- Modify: `src/session-rotation.ts`
- Modify: `src/session-rotation.test.ts`

- [ ] **Step 1: Write failing tests**

Replace the contents of `src/session-rotation.test.ts` with:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveRotatedSession,
  shouldRotateSession,
} from './session-rotation.js';

describe('shouldRotateSession', () => {
  const NOW = 1_000_000_000_000;
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

describe('archiveRotatedSession', () => {
  let tmpRoot: string;
  let dataDir: string;
  let groupsDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-rotation-'));
    dataDir = path.join(tmpRoot, 'data');
    groupsDir = path.join(tmpRoot, 'groups');
    vi.resetModules();
    vi.doMock('./config.js', async () => {
      const actual = await vi.importActual<typeof import('./config.js')>(
        './config.js',
      );
      return { ...actual, DATA_DIR: dataDir, GROUPS_DIR: groupsDir };
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.doUnmock('./config.js');
  });

  it('archives the transcript at the expected host path to the group conversations dir', async () => {
    const { archiveRotatedSession: archiveFn } = await import(
      './session-rotation.js'
    );
    const groupFolder = 'slack_test';
    const sessionId = 'abc-123';
    const transcriptDir = path.join(
      dataDir,
      'sessions',
      groupFolder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    );

    await archiveFn(groupFolder, sessionId, 'Dana');

    const conversationsDir = path.join(groupsDir, groupFolder, 'conversations');
    const files = fs.readdirSync(conversationsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-.+\.md$/);
    const body = fs.readFileSync(path.join(conversationsDir, files[0]), 'utf-8');
    expect(body).toContain('**User**: hi');
  });

  it('does not throw when the transcript is missing', async () => {
    const { archiveRotatedSession: archiveFn } = await import(
      './session-rotation.js'
    );
    await expect(
      archiveFn('nonexistent_group', 'nope-session', 'Dana'),
    ).resolves.toBeUndefined();
  });

  it('does not throw when the transcript is empty', async () => {
    const { archiveRotatedSession: archiveFn } = await import(
      './session-rotation.js'
    );
    const groupFolder = 'slack_empty';
    const transcriptDir = path.join(
      dataDir,
      'sessions',
      groupFolder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `s.jsonl`), '');
    await expect(
      archiveFn(groupFolder, 's', 'Dana'),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/session-rotation.test.ts`
Expected: FAIL — `archiveRotatedSession` is not exported.

- [ ] **Step 3: Implement `archiveRotatedSession`**

Replace the contents of `src/session-rotation.ts` with:

```ts
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { archiveTranscriptFromPath } from './conversation-archive.js';
import { logger } from './logger.js';

/**
 * Decide whether to rotate a group's Agent SDK session based on idle time.
 *
 * Returns true if there is no prior turn recorded, or if the time since the
 * last turn exceeds the configured idle window. The caller should then pass
 * `sessionId: undefined` to the container runner so a fresh session starts.
 *
 * Pure function — no side effects, no I/O.
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

/**
 * Archive the about-to-be-rotated session's transcript to the group's
 * conversations/ folder so the `PreCompact` hook's archive behaviour is
 * preserved when rotation (not compaction) is what ends the session.
 *
 * Fire-and-forget: never throws to the caller. Archive failure is logged
 * but must not block dispatch of the new session.
 */
export async function archiveRotatedSession(
  groupFolder: string,
  oldSessionId: string,
  assistantName?: string,
): Promise<void> {
  try {
    const transcriptPath = path.join(
      DATA_DIR,
      'sessions',
      groupFolder,
      '.claude',
      'projects',
      '-workspace-group',
      `${oldSessionId}.jsonl`,
    );
    const conversationsDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
    const result = archiveTranscriptFromPath(transcriptPath, conversationsDir, {
      sessionId: oldSessionId,
      assistantName,
    });
    if ('archivedTo' in result) {
      logger.info(
        { group: groupFolder, archivedTo: result.archivedTo },
        'Archive-on-rotation: wrote conversation archive',
      );
    } else {
      logger.info(
        { group: groupFolder, reason: result.skipped, oldSessionId },
        'Archive-on-rotation skipped',
      );
    }
  } catch (err) {
    logger.warn(
      {
        group: groupFolder,
        oldSessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'Archive-on-rotation failed',
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/session-rotation.test.ts`
Expected: PASS (all tests green, including the three new `archiveRotatedSession` tests).

- [ ] **Step 5: Verify the build passes**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/session-rotation.ts src/session-rotation.test.ts
git commit -m "feat: add archiveRotatedSession host-side helper

Resolves the transcript path under data/sessions/<group>/.claude/... and
archives to groups/<group>/conversations/ via conversation-archive.
Fire-and-forget: never throws; archive failure must not block dispatch."
```

---

## Task 3: Wire archive-on-rotation into `runAgent`

**Files:**
- Modify: `src/index.ts` (imports and the rotation decision block in `runAgent`)

- [ ] **Step 1: Update the import of `session-rotation`**

In `src/index.ts`, find the existing import (line 16):

```ts
import { shouldRotateSession } from './session-rotation.js';
```

Replace with:

```ts
import {
  archiveRotatedSession,
  shouldRotateSession,
} from './session-rotation.js';
```

- [ ] **Step 2: Add the archive call next to the rotation log**

In `src/index.ts`, find this block in `runAgent` (around lines 335–346):

```ts
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
    logger.debug({ group: group.name, sessionId }, 'Resuming agent session');
  }
```

Replace with:

```ts
  if (storedSessionId && rotate) {
    logger.info(
      {
        group: group.name,
        previousSessionId: storedSessionId,
        idleTimeoutMin: SESSION_IDLE_TIMEOUT_MIN,
      },
      'Rotating agent session after idle timeout',
    );
    // Fire-and-forget: archive the old session's transcript before the new
    // session begins writing. Never blocks dispatch; any failure is logged.
    void archiveRotatedSession(group.folder, storedSessionId, ASSISTANT_NAME);
  } else if (sessionId) {
    logger.debug({ group: group.name, sessionId }, 'Resuming agent session');
  }
```

- [ ] **Step 3: Verify the build passes**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS. All previously-green tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: archive old session on rotation in runAgent

Fire-and-forget archiveRotatedSession call alongside the existing
rotation log. Restores conversations/ archiving for the interactive
dispatch path, which has been silently dropped since d3b2c6a shipped
on 2026-04-07."
```

---

## Task 4: Wire archive-on-rotation into `runTask`

**Files:**
- Modify: `src/task-scheduler.ts` (imports and the rotation block in `runTask`)

- [ ] **Step 1: Update the import of `session-rotation`**

In `src/task-scheduler.ts`, find the existing import (line 28):

```ts
import { shouldRotateSession } from './session-rotation.js';
```

Replace with:

```ts
import {
  archiveRotatedSession,
  shouldRotateSession,
} from './session-rotation.js';
```

- [ ] **Step 2: Add the archive call next to the scheduled-task rotation log**

In `src/task-scheduler.ts`, find this block in `runTask` (around lines 165–185):

```ts
  let sessionId: string | undefined;
  if (task.context_mode === 'group') {
    const meta = getSessionMeta(task.group_folder);
    const rotate = shouldRotateSession(
      meta?.lastTurnAt ?? null,
      Date.now(),
      SESSION_IDLE_TIMEOUT_MIN,
    );
    sessionId = rotate ? undefined : meta?.sessionId;
    if (meta?.sessionId && rotate) {
      logger.info(
        {
          taskId: task.id,
          group: task.group_folder,
          previousSessionId: meta.sessionId,
          idleTimeoutMin: SESSION_IDLE_TIMEOUT_MIN,
        },
        'Rotating scheduled task session after idle timeout',
      );
    }
  }
```

Replace with:

```ts
  let sessionId: string | undefined;
  if (task.context_mode === 'group') {
    const meta = getSessionMeta(task.group_folder);
    const rotate = shouldRotateSession(
      meta?.lastTurnAt ?? null,
      Date.now(),
      SESSION_IDLE_TIMEOUT_MIN,
    );
    sessionId = rotate ? undefined : meta?.sessionId;
    if (meta?.sessionId && rotate) {
      logger.info(
        {
          taskId: task.id,
          group: task.group_folder,
          previousSessionId: meta.sessionId,
          idleTimeoutMin: SESSION_IDLE_TIMEOUT_MIN,
        },
        'Rotating scheduled task session after idle timeout',
      );
      // Fire-and-forget archive of the old session before rotation.
      void archiveRotatedSession(
        task.group_folder,
        meta.sessionId,
        ASSISTANT_NAME,
      );
    }
  }
```

- [ ] **Step 3: Verify the build passes**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/task-scheduler.ts
git commit -m "feat: archive old session on rotation in runTask

Mirrors the archive-on-rotation call from runAgent so scheduled tasks
running with context_mode='group' also archive the old transcript
before a new SDK session begins."
```

---

## Task 5: Raise `SESSION_IDLE_TIMEOUT_MIN` default to 60

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Update the default in `src/config.ts`**

In `src/config.ts`, find (lines 67–72):

```ts
// Idle window after which an agent session is rotated (new SDK session started).
// Bounds cache-read token growth on long-lived conversational agents.
export const SESSION_IDLE_TIMEOUT_MIN = Math.max(
  1,
  parseInt(process.env.SESSION_IDLE_TIMEOUT_MIN || '15', 10) || 15,
);
```

Replace with:

```ts
// Idle window after which an agent session is rotated (new SDK session started).
// With archive-on-rotation landing, rotation is lossless — so the default is
// relaxed from the original 15 min (cost-focused) to 60 min (memory-focused).
export const SESSION_IDLE_TIMEOUT_MIN = Math.max(
  1,
  parseInt(process.env.SESSION_IDLE_TIMEOUT_MIN || '60', 10) || 60,
);
```

- [ ] **Step 2: Update `.env.example`**

In `.env.example`, find (lines 18–20):

```
# Minutes of idleness before an agent's SDK session is rotated to a fresh one.
# Bounds cache-read token cost on long-lived agents. Default: 15.
SESSION_IDLE_TIMEOUT_MIN=15
```

Replace with:

```
# Minutes of idleness before an agent's SDK session is rotated to a fresh one.
# Rotation is lossless (old transcript is archived to conversations/). Default: 60.
SESSION_IDLE_TIMEOUT_MIN=60
```

- [ ] **Step 3: Verify the build passes**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts .env.example
git commit -m "config: raise SESSION_IDLE_TIMEOUT_MIN default 15 -> 60

With archive-on-rotation in place, rotation no longer loses history.
Loosen the default to 60 min so intermittent chat (lunch, meetings,
walks) doesn't rotate mid-conversation. Still env-configurable."
```

---

## Task 6: Restore 1M context as the default Sonnet

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Add the `SONNET_1M` constant and include it in `VALID_MODELS`**

In `container/agent-runner/src/index.ts`, find (lines 49–51):

```ts
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const OPUS = 'claude-opus-4-6';
```

Replace with:

```ts
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const SONNET_1M = 'claude-sonnet-4-6[1m]';
const OPUS = 'claude-opus-4-6';
```

Then find (line 63):

```ts
const VALID_MODELS = new Set([HAIKU, SONNET, OPUS]);
```

Replace with:

```ts
const VALID_MODELS = new Set([HAIKU, SONNET, SONNET_1M, OPUS]);
```

- [ ] **Step 2: Update `selectModel` to default to 1M**

In the same file, find (lines 65–82):

```ts
function selectModel(input: ContainerInput): string {
  // 1. Explicit model override from host — always respect (if valid)
  if (input.model) {
    return VALID_MODELS.has(input.model) ? input.model : SONNET;
  }

  // 2. Simple reminders → Haiku (just echo a message, no tools needed)
  if (input.isScheduledTask) {
    const isSimple = SIMPLE_REMINDER_PATTERNS.some((p) => p.test(input.prompt));
    if (isSimple) {
      log(`Using Haiku for simple reminder task`);
      return HAIKU;
    }
  }

  // 3. Default → Sonnet
  return SONNET;
}
```

Replace with:

```ts
function selectModel(input: ContainerInput): string {
  // 1. Explicit model override from host — always respect (if valid).
  //    Unknown models fall back to the 1M-context default (not plain 200k),
  //    since interactive traffic benefits from the larger window combined
  //    with CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000.
  if (input.model) {
    return VALID_MODELS.has(input.model) ? input.model : SONNET_1M;
  }

  // 2. Simple reminders → Haiku (just echo a message, no tools needed)
  if (input.isScheduledTask) {
    const isSimple = SIMPLE_REMINDER_PATTERNS.some((p) => p.test(input.prompt));
    if (isSimple) {
      log(`Using Haiku for simple reminder task`);
      return HAIKU;
    }
  }

  // 3. Default → Sonnet with 1M context. Auto-compact at 200k still applies
  //    (set via CLAUDE_CODE_AUTO_COMPACT_WINDOW), so cost is capped while the
  //    larger ceiling avoids hard context exhaustion mid-session.
  return SONNET_1M;
}
```

- [ ] **Step 3: Rebuild the container**

Run: `./container/build.sh`
Expected: build succeeds (may take a minute — it recompiles the agent-runner).

If build output suggests cache issues (stale COPY steps), follow the CLAUDE.md note: prune the builder then rerun `./container/build.sh`. This is a known issue documented in `CLAUDE.md` under "Container Build Cache".

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: default interactive Sonnet to 1M context

Pair the 200k auto-compact window (CLAUDE_CODE_AUTO_COMPACT_WINDOW)
with the 1M ceiling so compaction actually fires before context
exhaustion. Haiku remains the default for simple reminder tasks —
no reason to pay for 1M on a fixed-message relay.

Restores the pairing originally intended by db3440f before
6e53fa8 replaced sonnet[1m] with plain sonnet-4-6."
```

---

## Task 7: Manual verification

**Files:** none (runtime verification)

- [ ] **Step 1: Rebuild and restart**

Run:
```bash
npm run build
./container/build.sh
systemctl --user restart nanoclaw
```

Check `journalctl --user -u nanoclaw -n 50` — no startup errors.

- [ ] **Step 2: Confirm archive fires on next rotation for a quiet group**

Pick a group whose last activity is > 60 min ago (e.g. `slack_shelby`, last active 2026-04-17 per `groups/slack_shelby/` mtimes). Send any trigger message on Slack.

Expected in logs:
- `"Rotating agent session after idle timeout"` (existing)
- `"Archive-on-rotation: wrote conversation archive"` with a path under `groups/slack_shelby/conversations/`

Verify on disk:
```bash
ls -lt groups/slack_shelby/conversations/ | head -5
```
A new `2026-04-18-*.md` file should be on top.

- [ ] **Step 3: Confirm rotation threshold is now 60 min**

Send a second message to the same group within 60 min. Expected log: `"Resuming agent session"` (debug level — you may need `LOG_LEVEL=debug` to see it, otherwise the absence of a rotation log is enough). No new file in `conversations/`. No new `.jsonl` in the group's session dir.

- [ ] **Step 4: Confirm 1M context is in effect**

In the container logs for that turn (`journalctl --user -u nanoclaw -g "Selected model"`):
```
Selected model: claude-sonnet-4-6[1m]
```

- [ ] **Step 5: Confirm scheduled-task archive works**

Wait for the next scheduled daily digest to fire (check `groups/<group>/CLAUDE.md` or the tasks table for schedules). After it runs, verify a new file appears in that group's `conversations/` if its prior session was rotated.

Alternative: manually force a rotation for a scheduled-task group by clearing its session row, e.g.:
```bash
sqlite3 store/messages.db "UPDATE sessions SET last_turn_at = 0 WHERE group_folder='slack_dana';"
```
Then wait for the next task firing.

- [ ] **Step 6: Check dana's forgetfulness has improved over the next few days**

After 2–3 days of normal use, verify:
- `groups/slack_dana/conversations/` has several new 2026-04-19+ dated archives.
- Dana's chat memory across idle gaps is noticeably better — she recalls ongoing threads without being re-briefed.

No commit for this task — verification only.

---

## Self-Review

Checked against the spec at `docs/superpowers/specs/2026-04-18-session-archive-and-memory-restore-design.md`:

- **Spec §"Shared archive module — `src/conversation-archive.ts`":** covered by Task 1. Function signature `archiveTranscriptFromPath(transcriptPath, conversationsDir, { sessionId, assistantName?, now? })` matches the spec exactly. Return shape `{ archivedTo } | { skipped: 'missing' | 'empty' }` matches.
- **Spec §"Rotation call-site — `src/session-rotation.ts`":** covered by Task 2. `archiveRotatedSession(groupFolder, oldSessionId, assistantName?)` matches.
- **Spec §"Wire-in points":** covered by Tasks 3 (`runAgent`) and 4 (`runTask`). Both use `void archiveRotatedSession(...)` as fire-and-forget.
- **Spec §"Idle-timeout default":** covered by Task 5.
- **Spec §"Model restoration":** covered by Task 6. `SONNET_1M` constant added, `VALID_MODELS` extended, `selectModel` returns `SONNET_1M` as default. Haiku path for simple reminders preserved.
- **Spec §"Code sharing":** honoured — Task 1 adds `// KEEP-IN-SYNC` comment; no container build change. Container copy of the helpers stays as-is.
- **Spec §"Edge cases":**
  - No transcript → `{ skipped: 'missing' }` (Task 1 test).
  - Empty transcript → `{ skipped: 'empty' }` (Task 1 test).
  - Rotation on first message ever → `storedSessionId` is undefined, guarded by `if (storedSessionId && rotate)` in Tasks 3 and 4.
  - Archive write fails → caught in `archiveRotatedSession` try/catch (Task 2).
  - Model downgrade/override safety → `VALID_MODELS` guard (Task 6).
- **Spec §"Observability":** info log on success, info log on skip, warn log on exception — all in Task 2's `archiveRotatedSession`.
- **Spec §"Testing — unit tests":** covered by Tasks 1 and 2.
- **Spec §"Testing — manual verification":** covered by Task 7.
- **Spec §"Rollback":** each task is a separate commit, revertible independently. Task 1 and 2 are commit boundaries; Tasks 3/4 revert cleanly; Task 5 is a 1-line revert; Task 6 is a 4-line revert.

**Placeholder scan:** no TBD/TODO/hand-waves. Every code step shows full code.

**Type consistency:** `ArchiveResult` return type in Task 1 is used transitively by Task 2's `archiveRotatedSession` — same shape on both sides. `ParsedMessage` defined in Task 1 is internal to the module and not re-used elsewhere. `archiveRotatedSession` signature in Task 2 matches the calls in Tasks 3 and 4.

No gaps identified.
