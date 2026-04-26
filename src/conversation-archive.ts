/**
 * Archive a session's SDK transcript when it rotates due to idleness.
 *
 * v2 keeps Claude Code's conversation transcripts at
 *   data/v2-sessions/<agent-group>/.claude-shared/projects/-workspace-agent/<sdk-uuid>.jsonl
 *
 * The .claude-shared directory is shared across sessions in the same agent
 * group, but each SDK conversation has its own UUID-named jsonl. When a
 * v2 session rotates, we copy ITS transcript to
 *   data/v2-archives/<agent-group>/<v2-session-id>.jsonl
 * and append an index entry so future agents can find/read past chats.
 *
 * Limitations (deliberate, can be layered on later):
 *   - We copy the raw JSONL. v1 generated a markdown summary via PreCompact
 *     hook in agent-runner; v2 ports that later if needed.
 *   - We don't yet feed past archives back into a fresh session — agents
 *     can read the archive directory if they choose, but there's no
 *     auto-restore-summary-into-system-prompt yet.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';
import { openOutboundDb } from './session-manager.js';

const ARCHIVES_BASE = path.join(DATA_DIR, 'v2-archives');

function transcriptPath(agentGroupId: string, sdkUuid: string): string {
  return path.join(
    DATA_DIR,
    'v2-sessions',
    agentGroupId,
    '.claude-shared',
    'projects',
    '-workspace-agent',
    `${sdkUuid}.jsonl`,
  );
}

function archiveDir(agentGroupId: string): string {
  return path.join(ARCHIVES_BASE, agentGroupId);
}

function archivePath(agentGroupId: string, v2SessionId: string): string {
  return path.join(archiveDir(agentGroupId), `${v2SessionId}.jsonl`);
}

function indexPath(agentGroupId: string): string {
  return path.join(archiveDir(agentGroupId), 'index.json');
}

interface IndexEntry {
  v2SessionId: string;
  sdkUuid: string | null;
  archivedAt: string;
  transcriptBytes: number;
  reason: string;
}

function loadIndex(agentGroupId: string): IndexEntry[] {
  const p = indexPath(agentGroupId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as IndexEntry[];
  } catch (err) {
    log.warn('archive index parse failed; resetting', { err: (err as Error).message });
    return [];
  }
}

function saveIndex(agentGroupId: string, entries: IndexEntry[]): void {
  const p = indexPath(agentGroupId);
  fs.writeFileSync(p, JSON.stringify(entries, null, 2));
}

export function archiveSession(agentGroupId: string, v2SessionId: string, reason: string): boolean {
  fs.mkdirSync(archiveDir(agentGroupId), { recursive: true });

  // SDK UUID is stored by the agent-runner in outbound.db's session_state
  // table (see container/agent-runner/src/db/session-state.ts).
  let sdkUuid: string | null = null;
  try {
    const db = openOutboundDb(agentGroupId, v2SessionId);
    try {
      const row = db.prepare("SELECT value FROM session_state WHERE key = 'sdk_session_id'").get() as
        | { value: string }
        | undefined;
      sdkUuid = row?.value ?? null;
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('archive: cannot read session_state', { v2SessionId, err: (err as Error).message });
  }

  let transcriptBytes = 0;
  if (sdkUuid) {
    const src = transcriptPath(agentGroupId, sdkUuid);
    const dst = archivePath(agentGroupId, v2SessionId);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dst);
        transcriptBytes = fs.statSync(dst).size;
        // Don't delete the source — the .claude-shared dir is shared
        // across sessions and Claude Code may still reference the file
        // for background bookkeeping. The archive is a copy.
      } catch (err) {
        log.warn('archive: copy transcript failed', { src, dst, err: (err as Error).message });
      }
    } else {
      log.info('archive: no transcript file at expected path', { src });
    }
  }

  const entries = loadIndex(agentGroupId);
  entries.push({
    v2SessionId,
    sdkUuid,
    archivedAt: new Date().toISOString(),
    transcriptBytes,
    reason,
  });
  saveIndex(agentGroupId, entries);

  log.info('Session archived', { agentGroupId, v2SessionId, sdkUuid, transcriptBytes, reason });
  return true;
}
