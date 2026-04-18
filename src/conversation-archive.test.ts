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
    expect(parseTranscript(jsonl)).toEqual([{ role: 'user', content: 'ok' }]);
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
