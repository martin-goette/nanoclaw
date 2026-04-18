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
