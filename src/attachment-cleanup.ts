/**
 * Periodic cleanup of old Slack attachments.
 *
 * The Slack adapter saves inbound files to `~/nanoclaw-files/<agent-folder>/attachments/`.
 * Without pruning, audio clips and other files accumulate indefinitely. This
 * job runs once on startup and then daily, deleting anything older than the
 * retention window.
 *
 * Scope: only the `attachments` subdir under each per-group `~/nanoclaw-files`
 * folder. Other files in the shared-files mount are user-owned and never touched.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from './log.js';

const NANOCLAW_FILES_DIR = path.join(os.homedir(), 'nanoclaw-files');
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | undefined;

function pruneOnce(): void {
  if (!fs.existsSync(NANOCLAW_FILES_DIR)) return;
  const cutoff = Date.now() - RETENTION_MS;
  let deleted = 0;
  let bytesFreed = 0;

  let groups: string[];
  try {
    groups = fs.readdirSync(NANOCLAW_FILES_DIR);
  } catch (err) {
    log.warn('attachment cleanup: cannot read nanoclaw-files dir', { err: (err as Error).message });
    return;
  }

  for (const group of groups) {
    const attachDir = path.join(NANOCLAW_FILES_DIR, group, 'attachments');
    let entries: string[];
    try {
      entries = fs.readdirSync(attachDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const filePath = path.join(attachDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs >= cutoff) continue;
        bytesFreed += stat.size;
        fs.unlinkSync(filePath);
        deleted++;
      } catch (err) {
        log.warn('attachment cleanup: failed to remove file', { filePath, err: (err as Error).message });
      }
    }
  }

  if (deleted > 0) {
    log.info('Attachment cleanup pruned old files', {
      deleted,
      mbFreed: Math.round(bytesFreed / 1024 / 1024),
      retentionDays: RETENTION_MS / (24 * 60 * 60 * 1000),
    });
  }
}

export function startAttachmentCleanup(): void {
  pruneOnce();
  timer = setInterval(pruneOnce, RUN_INTERVAL_MS);
  timer.unref();
  log.info('Attachment cleanup started', {
    intervalMs: RUN_INTERVAL_MS,
    retentionDays: RETENTION_MS / (24 * 60 * 60 * 1000),
  });
}

export function stopAttachmentCleanup(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
