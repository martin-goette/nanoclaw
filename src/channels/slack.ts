/**
 * Slack channel adapter (v2) — socket-mode via @slack/bolt.
 *
 * Why bolt and not the Chat SDK adapter: the Chat SDK Slack adapter
 * (`@chat-adapter/slack`) is HTTP-webhook-only — it has no socket-mode
 * support, so it requires a public URL + signing-secret verification +
 * Slack Event Subscriptions config. For a personal install behind
 * Cloudflare with WAF rules, socket mode is simpler: no webhook URL, no
 * signature verification, no public ingress at all. v1 used bolt for the
 * same reason.
 *
 * Threads-as-conversation-unit semantics. Top-level channel posts open a
 * new thread; replies inside that thread continue the same session.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { App } from '@slack/bolt';

import { getDb } from '../db/connection.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { transcribeAudio } from '../transcription.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'slack';
const MAX_TRANSCRIPTION_SIZE = 25 * 1024 * 1024;
const NANOCLAW_FILES_DIR = path.join(os.homedir(), 'nanoclaw-files');

interface SlackFile {
  id: string;
  name?: string;
  url_private_download?: string;
  url_private?: string;
  mimetype?: string;
  size?: number;
}

function resolveAgentFolder(channelId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT ag.folder AS folder
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE mg.channel_type = 'slack' AND mg.platform_id = ?
        ORDER BY mga.priority DESC
        LIMIT 1`,
    )
    .get(`slack:${channelId}`) as { folder: string } | undefined;
  return row?.folder ?? null;
}

async function downloadSlackFile(url: string, botToken: string): Promise<Buffer | null> {
  // Slack 302-redirects to a CDN on a different origin. Fetch strips Authorization
  // across origins, so we have to manually re-attach the bearer on the redirect.
  const authHeader = { Authorization: `Bearer ${botToken}` };
  const resp = await fetch(url, { headers: authHeader, redirect: 'manual' });

  let finalResp: Response;
  if (resp.status >= 300 && resp.status < 400) {
    const redirectUrl = resp.headers.get('location');
    if (!redirectUrl) return null;
    finalResp = await fetch(redirectUrl, { headers: authHeader });
  } else {
    finalResp = resp;
  }

  if (!finalResp.ok) {
    log.warn('slack file download failed', { url, status: finalResp.status });
    return null;
  }

  const buf = Buffer.from(await finalResp.arrayBuffer());
  const ct = finalResp.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    log.warn('slack file download returned HTML — likely 200 with login page', { url });
    return null;
  }
  return buf;
}

async function processFiles(
  files: SlackFile[],
  channelId: string,
  botToken: string,
): Promise<{ transcript: string | null; pathsBlock: string | null }> {
  const agentFolder = resolveAgentFolder(channelId);
  if (!agentFolder) {
    log.warn('slack: no agent group for channel — skipping file processing', { channelId });
    return { transcript: null, pathsBlock: null };
  }
  const attachDir = path.join(NANOCLAW_FILES_DIR, agentFolder, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const savedPaths: string[] = [];
  let transcript: string | null = null;
  let audioTranscribed = false;

  for (const f of files) {
    const downloadUrl = f.url_private_download || f.url_private;
    if (!downloadUrl || !f.name) continue;
    const buf = await downloadSlackFile(downloadUrl, botToken);
    if (!buf) continue;

    const ts = Date.now();
    const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${ts}-${safeName}`;
    const hostPath = path.join(attachDir, filename);
    fs.writeFileSync(hostPath, buf);
    savedPaths.push(`/workspace/extra/shared-files/attachments/${filename}`);
    log.info('slack attachment saved', { file: f.name, size: buf.length, agentFolder });

    if (!audioTranscribed && f.mimetype?.startsWith('audio/')) {
      if (buf.length > MAX_TRANSCRIPTION_SIZE) {
        transcript = '__too-large__';
      } else {
        const result = await transcribeAudio(buf, f.name);
        transcript = result;
      }
      audioTranscribed = true;
    }
  }

  const pathsBlock = savedPaths.length
    ? `\n\n[Attached files — read them with the Read tool:\n${savedPaths.map((p) => `- ${p}`).join('\n')}\n]`
    : null;
  return { transcript, pathsBlock };
}

function platformIdFor(channelId: string): string {
  return `slack:${channelId}`;
}

function decodePlatformId(platformId: string): string | null {
  return platformId.startsWith('slack:') ? platformId.slice(6) : null;
}

function extractText(message: OutboundMessage): string | null {
  const c = message.content as Record<string, unknown> | string | undefined;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    if (typeof c.text === 'string') return c.text;
    if (typeof c.markdown === 'string') return c.markdown;
  }
  return null;
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) {
    log.warn('Slack credentials missing — set SLACK_BOT_TOKEN and SLACK_APP_TOKEN');
    return null;
  }

  let app: App | null = null;
  let connected = false;
  let botUserId: string | undefined;
  // Track ts of the last inbound message per (channel, thread) so we can
  // dedupe app_mention vs message events for the same payload.
  const seenIds = new Set<string>();

  const adapter: ChannelAdapter = {
    name: 'slack',
    channelType: CHANNEL_TYPE,
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      app = new App({
        token: env.SLACK_BOT_TOKEN,
        appToken: env.SLACK_APP_TOKEN,
        socketMode: true,
      });

      // Resolve bot user id once so we can filter self-messages and
      // identify mentions reliably.
      try {
        const auth = await app.client.auth.test({ token: env.SLACK_BOT_TOKEN });
        botUserId = auth.user_id as string | undefined;
        log.info('Slack auth completed', { botUserId, botName: auth.user });
      } catch (err) {
        log.warn('Slack auth.test failed (continuing without botUserId)', { err });
      }

      const dispatch = async (
        eventTs: string,
        clientMsgId: string | undefined,
        channelId: string,
        threadTs: string | undefined,
        userId: string | undefined,
        text: string,
        confirmedMention: boolean,
        files: SlackFile[] | undefined,
      ): Promise<void> => {
        const dedupeKey = `${channelId}:${eventTs}`;
        if (seenIds.has(dedupeKey)) return;
        seenIds.add(dedupeKey);
        // Cap memory: keep only the most recent ~5k events.
        if (seenIds.size > 5000) {
          const overflow = seenIds.size - 5000;
          let i = 0;
          for (const k of seenIds) {
            if (i++ >= overflow) break;
            seenIds.delete(k);
          }
        }

        // self-messages: skip
        if (userId && userId === botUserId) return;

        log.info('slack inbound', {
          channelId,
          threadTs,
          eventTs,
          userId,
          textLen: text.length,
          isMentionHint: confirmedMention,
          fileCount: files?.length ?? 0,
        });

        let augmentedText = text;
        if (files?.length) {
          const { transcript, pathsBlock } = await processFiles(files, channelId, env.SLACK_BOT_TOKEN);
          if (transcript === '__too-large__') {
            augmentedText = `${augmentedText}\n\n[Audio clip too large for transcription (max ~25 min)]`;
          } else if (transcript) {
            augmentedText = `[Voice: ${transcript}]\n${augmentedText}`;
          } else if (files.some((f) => f.mimetype?.startsWith('audio/'))) {
            augmentedText = `${augmentedText}\n\n[Audio clip — transcription unavailable]`;
          }
          if (pathsBlock) augmentedText += pathsBlock;
        }

        if (!augmentedText.trim()) return;

        const threadId = threadTs || eventTs;
        const senderId = userId ? `slack:${userId}` : 'slack:unknown';
        const isMention = confirmedMention || (botUserId ? augmentedText.includes(`<@${botUserId}>`) : false);

        const inbound: InboundMessage = {
          id: clientMsgId || eventTs,
          kind: 'chat',
          timestamp: new Date(parseFloat(eventTs) * 1000).toISOString(),
          isMention,
          content: {
            text: augmentedText,
            sender: senderId,
            senderId,
          },
        };

        try {
          await config.onInbound(platformIdFor(channelId), threadId, inbound);
        } catch (err) {
          log.error('slack onInbound threw', { err, channelId, threadId });
        }
      };

      // Bolt 4.x's app.message() / app.event('message') routing did not
      // dispatch events to handlers in our testing — but a global middleware
      // *does* fire with the raw event payload. So drive everything from
      // there directly. Slack ack is handled by bolt automatically.
      app.use(async (args) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = args as any;
        const payload = a.payload as Record<string, unknown> | undefined;
        const eventType = payload && typeof payload.type === 'string' ? payload.type : undefined;
        if (eventType === 'message' || eventType === 'app_mention') {
          if (typeof payload!.ts === 'string' && typeof payload!.channel === 'string') {
            const subtype = typeof payload!.subtype === 'string' ? payload!.subtype : undefined;
            // Allowed subtypes:
            //   - undefined: plain text message
            //   - 'thread_broadcast': reply also posted to channel
            //   - 'file_share': message with attached file(s) — voice notes,
            //     images, docs. Without this, audio messages drop silently.
            // Skipped: 'message_changed', 'message_deleted', 'channel_join',
            //   bot subtypes — those are noise we don't want to dispatch.
            if (!subtype || subtype === 'thread_broadcast' || subtype === 'file_share') {
              const text = typeof payload!.text === 'string' ? payload!.text : '';
              const userId = typeof payload!.user === 'string' ? payload!.user : undefined;
              const threadTs = typeof payload!.thread_ts === 'string' ? payload!.thread_ts : undefined;
              const clientMsgId = typeof payload!.client_msg_id === 'string' ? payload!.client_msg_id : undefined;
              const files = Array.isArray((payload as Record<string, unknown>).files)
                ? ((payload as Record<string, unknown>).files as SlackFile[])
                : undefined;
              await dispatch(
                payload!.ts as string,
                clientMsgId,
                payload!.channel as string,
                threadTs,
                userId,
                text,
                eventType === 'app_mention',
                files,
              );
            }
          }
        }
        await args.next();
      });

      await app.start();
      connected = true;
      log.info('Slack adapter started (socket mode)');
    },

    async teardown(): Promise<void> {
      if (app) {
        try {
          await app.stop();
        } catch (err) {
          log.warn('slack app.stop threw', { err });
        }
        app = null;
      }
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      if (!app) return undefined;
      const channelId = decodePlatformId(platformId);
      if (!channelId) return undefined;
      const text = extractText(message);
      if (text === null) return undefined;
      try {
        const result = await app.client.chat.postMessage({
          token: env.SLACK_BOT_TOKEN,
          channel: channelId,
          text,
          thread_ts: threadId || undefined,
        });
        return result.ts as string | undefined;
      } catch (err) {
        log.warn('slack chat.postMessage failed', { err, channelId, threadId });
        return undefined;
      }
    },
  };

  return adapter;
}

registerChannelAdapter('slack', { factory: createAdapter });
