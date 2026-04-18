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
