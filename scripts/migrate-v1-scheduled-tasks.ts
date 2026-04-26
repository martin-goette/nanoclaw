/**
 * One-shot migrator: v1 scheduled_tasks.json → v2 messages_in (kind='task').
 *
 * v1 stored tasks in a global `scheduled_tasks` table. v2 stores them as rows
 * in per-session `inbound.db` with kind='task'. This script:
 *
 *   1. Reads /home/martin/nanoclaw/.nanoclaw-migrations/v1-data/scheduled-tasks.json
 *   2. Maps each v1 chat_jid → v2 messaging_group + agent_group
 *   3. For each (agent_group, messaging_group) pair, creates (or reuses) a
 *      single session with thread_id='schedule' to host all that pair's tasks
 *   4. Inserts each v1 task into the session's inbound.db using the same
 *      shape that scheduling/db.ts insertTask() writes
 *
 * Schedule conversions:
 *   - cron     → recurrence = schedule_value, processAfter = next cron tick
 *   - interval → cron approximation (e.g. "every 2 days" → "0 9 *\/2 * *")
 *   - once     → if in the future, processAfter = schedule_value; if past, skip
 *
 * Idempotent: tasks are inserted with id = v1 id, so re-running is a no-op
 * (sqlite UNIQUE on id throws).
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR } from '../src/config.js';
import { TIMEZONE } from '../src/config.js';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createSession, findSessionForAgent } from '../src/db/sessions.js';
import { initSessionFolder, openInboundDb, sessionDir } from '../src/session-manager.js';
import { insertTask } from '../src/modules/scheduling/db.js';

const V1_TASKS_PATH = '/home/martin/nanoclaw/.nanoclaw-migrations/v1-data/scheduled-tasks.json';
const SCHEDULE_THREAD_ID = 'schedule';

interface V1Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: string;
  status: string;
  created_at: string;
  next_run?: string | null;
  last_run?: string | null;
  script?: string | null;
  model?: string | null;
}

function loadV1Tasks(): V1Task[] {
  const raw = fs.readFileSync(V1_TASKS_PATH, 'utf-8');
  return JSON.parse(raw) as V1Task[];
}

function buildJidLookup(): Map<string, { mgId: string; agId: string; agentName: string }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT mg.id AS mgId, mg.platform_id, mga.agent_group_id AS agId, ag.name AS agentName
       FROM messaging_groups mg
       JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       JOIN agent_groups ag ON ag.id = mga.agent_group_id`,
    )
    .all() as Array<{ mgId: string; platform_id: string; agId: string; agentName: string }>;
  const lookup = new Map<string, { mgId: string; agId: string; agentName: string }>();
  for (const r of rows) lookup.set(r.platform_id, { mgId: r.mgId, agId: r.agId, agentName: r.agentName });
  return lookup;
}

function ensureScheduleSession(agId: string, mgId: string): string {
  const existing = findSessionForAgent(agId, mgId, SCHEDULE_THREAD_ID);
  if (existing) {
    // Re-run initSessionFolder defensively — earlier failed runs may have
    // created the session row but not the on-disk schema.
    initSessionFolder(agId, existing.id);
    return existing.id;
  }

  const sessionId = `sess-schedule-${agId.slice(3)}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  createSession({
    id: sessionId,
    agent_group_id: agId,
    messaging_group_id: mgId,
    thread_id: SCHEDULE_THREAD_ID,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now,
    created_at: now,
  });

  initSessionFolder(agId, sessionId);

  return sessionId;
}

function nextCronRun(cronExpr: string): string {
  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  return interval.next().toISOString();
}

function intervalToCron(ms: number): string | null {
  const days = ms / (24 * 60 * 60 * 1000);
  if (Number.isInteger(days) && days >= 1 && days <= 31) return `0 9 */${days} * *`;
  const hours = ms / (60 * 60 * 1000);
  if (Number.isInteger(hours) && hours >= 1 && hours < 24) return `0 */${hours} * * *`;
  return null;
}

interface PreparedTask {
  id: string;
  prompt: string;
  processAfter: string;
  recurrence: string | null;
  platformId: string;
  channelType: string;
  threadId: string | null;
  agId: string;
  mgId: string;
  agentName: string;
  v1Type: string;
  v1Value: string;
}

function prepareTasks(): { ready: PreparedTask[]; skipped: Array<{ task: V1Task; reason: string }> } {
  const tasks = loadV1Tasks();
  const lookup = buildJidLookup();
  const ready: PreparedTask[] = [];
  const skipped: Array<{ task: V1Task; reason: string }> = [];

  // Dedup interval tasks per (agent, prompt-stem) — v1 had two "shave" duplicates.
  const seenInterval = new Set<string>();

  // Sort interval tasks by created_at desc so the newest wins on dup
  const sorted = [...tasks].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  for (const t of sorted) {
    if (t.status !== 'active') {
      skipped.push({ task: t, reason: `status=${t.status}` });
      continue;
    }

    const target = lookup.get(t.chat_jid);
    if (!target) {
      skipped.push({ task: t, reason: `no messaging_group for chat_jid=${t.chat_jid}` });
      continue;
    }

    let processAfter: string;
    let recurrence: string | null = null;

    try {
      if (t.schedule_type === 'cron') {
        recurrence = t.schedule_value;
        processAfter = nextCronRun(t.schedule_value);
      } else if (t.schedule_type === 'interval') {
        const ms = Number(t.schedule_value);
        if (!Number.isFinite(ms) || ms <= 0) {
          skipped.push({ task: t, reason: `bad interval=${t.schedule_value}` });
          continue;
        }
        const cronEquiv = intervalToCron(ms);
        if (!cronEquiv) {
          skipped.push({ task: t, reason: `cannot map interval ${ms}ms to cron` });
          continue;
        }
        const dedupKey = `${target.agId}::${t.prompt.slice(0, 50)}`;
        if (seenInterval.has(dedupKey)) {
          skipped.push({ task: t, reason: 'interval duplicate (kept newer one)' });
          continue;
        }
        seenInterval.add(dedupKey);
        recurrence = cronEquiv;
        processAfter = nextCronRun(cronEquiv);
      } else if (t.schedule_type === 'once') {
        const when = new Date(t.schedule_value);
        if (Number.isNaN(when.getTime())) {
          skipped.push({ task: t, reason: `bad once value=${t.schedule_value}` });
          continue;
        }
        if (when.getTime() <= Date.now()) {
          skipped.push({ task: t, reason: `once already past (${t.schedule_value})` });
          continue;
        }
        processAfter = when.toISOString();
      } else {
        skipped.push({ task: t, reason: `unknown schedule_type=${t.schedule_type}` });
        continue;
      }
    } catch (err) {
      skipped.push({ task: t, reason: `parse error: ${(err as Error).message}` });
      continue;
    }

    ready.push({
      id: t.id,
      prompt: t.prompt,
      processAfter,
      recurrence,
      platformId: t.chat_jid,
      channelType: 'slack',
      threadId: null,
      agId: target.agId,
      mgId: target.mgId,
      agentName: target.agentName,
      v1Type: t.schedule_type,
      v1Value: t.schedule_value,
    });
  }

  return { ready, skipped };
}

function main(): void {
  const dryRun = process.argv.includes('--dry');
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const { ready, skipped } = prepareTasks();
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes)' : 'WRITE'}`);
  console.log(`Timezone: ${TIMEZONE}`);
  console.log(`v1 tasks: ${ready.length} ready, ${skipped.length} skipped\n`);

  const perAgent = new Map<string, PreparedTask[]>();
  for (const t of ready) {
    if (!perAgent.has(t.agentName)) perAgent.set(t.agentName, []);
    perAgent.get(t.agentName)!.push(t);
  }

  console.log('Plan (by agent):');
  for (const [agent, tasks] of perAgent) {
    console.log(`\n  ${agent} (${tasks.length} tasks):`);
    for (const t of tasks) {
      const promptStub = t.prompt.replace(/\s+/g, ' ').slice(0, 70);
      console.log(`    ${t.id}  recur=${t.recurrence ?? '-'}  next=${t.processAfter}  → ${promptStub}`);
    }
  }

  if (skipped.length) {
    console.log('\nSkipped:');
    for (const { task, reason } of skipped) console.log(`  ${task.id} (${task.group_folder}): ${reason}`);
  }

  if (dryRun) {
    console.log('\nDry run complete — no writes performed.');
    return;
  }

  const sessionByPair = new Map<string, string>();
  let inserted = 0;
  let dupes = 0;

  for (const t of ready) {
    const pairKey = `${t.agId}::${t.mgId}`;
    let sessionId = sessionByPair.get(pairKey);
    if (!sessionId) {
      sessionId = ensureScheduleSession(t.agId, t.mgId);
      sessionByPair.set(pairKey, sessionId);
    }

    const inDb = openInboundDb(t.agId, sessionId);
    try {
      insertTask(inDb, {
        id: t.id,
        processAfter: t.processAfter,
        recurrence: t.recurrence,
        platformId: t.platformId,
        channelType: t.channelType,
        threadId: t.threadId,
        content: JSON.stringify({ prompt: t.prompt, script: null }),
      });
      inserted++;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
        dupes++;
      } else {
        console.error(`  insert failed for ${t.id}: ${msg}`);
      }
    } finally {
      inDb.close();
    }
  }

  console.log(`\nInserted: ${inserted}`);
  console.log(`Duplicates (already migrated): ${dupes}`);
}

main();
