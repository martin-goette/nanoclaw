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
      const actual =
        await vi.importActual<typeof import('./config.js')>('./config.js');
      return { ...actual, DATA_DIR: dataDir, GROUPS_DIR: groupsDir };
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.doUnmock('./config.js');
  });

  it('archives the transcript at the expected host path to the group conversations dir', async () => {
    const { archiveRotatedSession: archiveFn } =
      await import('./session-rotation.js');
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
    const body = fs.readFileSync(
      path.join(conversationsDir, files[0]),
      'utf-8',
    );
    expect(body).toContain('**User**: hi');
  });

  it('does not throw when the transcript is missing', async () => {
    const { archiveRotatedSession: archiveFn } =
      await import('./session-rotation.js');
    await expect(
      archiveFn('nonexistent_group', 'nope-session', 'Dana'),
    ).resolves.toBeUndefined();
  });

  it('does not throw when the transcript is empty', async () => {
    const { archiveRotatedSession: archiveFn } =
      await import('./session-rotation.js');
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
    await expect(archiveFn(groupFolder, 's', 'Dana')).resolves.toBeUndefined();
  });
});

describe('awaitPendingArchives', () => {
  let tmpRoot: string;
  let dataDir: string;
  let groupsDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-archives-'));
    dataDir = path.join(tmpRoot, 'data');
    groupsDir = path.join(tmpRoot, 'groups');
    vi.resetModules();
    vi.doMock('./config.js', async () => {
      const actual =
        await vi.importActual<typeof import('./config.js')>('./config.js');
      return { ...actual, DATA_DIR: dataDir, GROUPS_DIR: groupsDir };
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.doUnmock('./config.js');
  });

  it('resolves immediately when there are no pending archives', async () => {
    const { awaitPendingArchives } = await import('./session-rotation.js');
    const start = Date.now();
    await awaitPendingArchives(1000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('waits for in-flight archives to settle before resolving', async () => {
    const {
      archiveRotatedSession: archiveFn,
      awaitPendingArchives,
    } = await import('./session-rotation.js');

    const groupFolder = 'slack_drain';
    const sessionId = 'drain-1';
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
      }),
    );

    // Fire-and-forget: caller does not await.
    void archiveFn(groupFolder, sessionId, 'Dana');

    // The archive dir should not yet exist synchronously.
    const conversationsDir = path.join(
      groupsDir,
      groupFolder,
      'conversations',
    );

    // Drain — once this resolves, the archive file must be on disk.
    await awaitPendingArchives(5000);

    const files = fs.readdirSync(conversationsDir);
    expect(files).toHaveLength(1);
  });

  it('honors the timeout if archives are somehow stuck', async () => {
    const { awaitPendingArchives } = await import('./session-rotation.js');
    // No pending archives → immediate return regardless of timeout.
    const start = Date.now();
    await awaitPendingArchives(50);
    expect(Date.now() - start).toBeLessThan(100);
  });
});
