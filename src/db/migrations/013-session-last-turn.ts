/**
 * `sessions.last_turn_at` — used by host-sweep to rotate idle sessions.
 *
 * Set on every inbound message routed into a session; host-sweep finds
 * sessions where last_turn_at < now - IDLE_TIMEOUT_MS, marks them
 * status='archived', and copies the SDK transcript out (see
 * conversation-archive.ts). The next inbound on the same (mg, thread)
 * pair opens a fresh session.
 *
 * Schedule sessions (thread_id = 'schedule') hold long-running scheduled
 * tasks; rotation logic excludes them by thread_id, not by absence of
 * last_turn_at, so this column applies to them too (it just isn't acted on).
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration013: Migration = {
  version: 13,
  name: 'session-last-turn',
  up: (db: Database.Database) => {
    const cols = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'last_turn_at')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN last_turn_at TEXT`);
      // Bootstrap existing rows with last_active so the first sweep doesn't
      // immediately treat every existing session as eternally idle.
      db.exec(`UPDATE sessions SET last_turn_at = last_active WHERE last_turn_at IS NULL`);
    }
  },
};
