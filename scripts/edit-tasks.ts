/**
 * One-shot script: apply user-requested task edits + recompute every
 * pending task's process_after under the new TZ (Europe/Berlin).
 *
 * Edits:
 *  - vitamins: keep one task at 50 11 * * * (delete the other vitamins+cream pair)
 *  - cream: night-cream task moved from 0 20 * * * → 0 21 * * *
 *  - shave: keep one task, weekly Sunday 17:00 (delete two duplicates)
 *  - friday 15:00: consolidate three reminders into one
 *
 * Then re-parses every remaining row's recurrence under Europe/Berlin and
 * rewrites process_after, so future fires happen at user-local times.
 */
import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

const TZ = 'Europe/Berlin';
const DANA_INBOUND = '/home/martin/nanoclaw-v2/data/v2-sessions/ag_c652b9e486a5/sess-schedule-c652b9e486a5-mofjs4te/inbound.db';

const KEEP_VITAMINS = 'task-1775464769171-o8tp40';
const DELETE_VITAMINS = ['task-1776492050415-qiis0i'];

const KEEP_CREAM = 'task-1775464770036-1pr97x';

const KEEP_SHAVE = 'task-1775464770733-5mtxqi';
const DELETE_SHAVE = ['task-1777096871948-sg1u29', 'task-1776492098505-gbgyms'];

const KEEP_FRIDAY = 'task-1775464773073-h6zg9l';
const DELETE_FRIDAY = ['task-1775464772370-n7e7zd', 'task-1774941830407-wbrhfk'];

const FRIDAY_PROMPT =
  'Send Martin his Friday end-of-week reminder (one message, three bullets):\n\n' +
  '⏰ *Friday wrap-up*\n' +
  '• 🧾 Submit weekly expenses\n' +
  '• 📊 Log weekly activities (what you worked on)\n' +
  '• 💌 Send weekly thank-you note to the full team';

function nextRunBerlin(cron: string): string {
  return CronExpressionParser.parse(cron, { tz: TZ }).next().toISOString();
}

function applyUpdate(
  db: Database.Database,
  id: string,
  changes: { recurrence?: string; prompt?: string },
): void {
  const row = db.prepare("SELECT content FROM messages_in WHERE id = ? AND kind='task'").get(id) as { content: string } | undefined;
  if (!row) {
    console.log(`  SKIP update ${id} — not found`);
    return;
  }
  const parsed = JSON.parse(row.content);
  if (changes.prompt !== undefined) parsed.prompt = changes.prompt;

  const sets: string[] = ['content = ?'];
  const params: unknown[] = [JSON.stringify(parsed)];
  if (changes.recurrence !== undefined) {
    sets.push('recurrence = ?', 'process_after = ?');
    params.push(changes.recurrence, nextRunBerlin(changes.recurrence));
  }
  params.push(id);
  db.prepare(`UPDATE messages_in SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  console.log(`  UPDATED ${id} ${JSON.stringify(changes).slice(0, 80)}`);
}

function deleteRow(db: Database.Database, id: string): void {
  const r = db.prepare("DELETE FROM messages_in WHERE id = ? AND kind='task'").run(id);
  console.log(`  DELETED ${id} (${r.changes} row)`);
}

function main(): void {
  const db = new Database(DANA_INBOUND);

  console.log(`Timezone for cron parsing: ${TZ}`);
  console.log();
  console.log('Edits:');

  const tx = db.transaction(() => {
    // Vitamins: keep one at 50 11, prompt = "💊 Vitamins"
    applyUpdate(db, KEEP_VITAMINS, {
      recurrence: '50 11 * * *',
      prompt: 'Send Martin this reminder: 💊 Vitamins',
    });
    for (const id of DELETE_VITAMINS) deleteRow(db, id);

    // Cream: night cream → 21:00, keep prompt
    applyUpdate(db, KEEP_CREAM, { recurrence: '0 21 * * *' });

    // Shave: weekly Sunday 17:00
    applyUpdate(db, KEEP_SHAVE, {
      recurrence: '0 17 * * 0',
      prompt: 'Send Martin this weekly reminder: 🪒 Shave',
    });
    for (const id of DELETE_SHAVE) deleteRow(db, id);

    // Friday: consolidate three reminders, keep cron 0 15 * * 5
    applyUpdate(db, KEEP_FRIDAY, { prompt: FRIDAY_PROMPT });
    for (const id of DELETE_FRIDAY) deleteRow(db, id);

    // Recompute every remaining task's process_after under Europe/Berlin
    console.log();
    console.log('Recomputing process_after for all remaining tasks under Europe/Berlin...');
    const all = db.prepare("SELECT id, recurrence FROM messages_in WHERE kind='task' AND status='pending' AND recurrence IS NOT NULL").all() as Array<{ id: string; recurrence: string }>;
    let bumped = 0;
    for (const r of all) {
      try {
        const next = nextRunBerlin(r.recurrence);
        db.prepare('UPDATE messages_in SET process_after = ? WHERE id = ?').run(next, r.id);
        bumped++;
      } catch (err) {
        console.error(`  recompute failed for ${r.id}: ${(err as Error).message}`);
      }
    }
    console.log(`  Recomputed ${bumped} task(s)`);
  });
  tx();

  console.log();
  console.log('Final pending count:');
  const n = db.prepare("SELECT count(*) as n FROM messages_in WHERE kind='task' AND status='pending'").get() as { n: number };
  console.log(`  ${n.n} pending tasks`);

  db.close();
}

main();
