/**
 * MCP tool: transcribe_audio
 *
 * Lets the agent transcribe an audio file already on disk (typically in
 * /workspace/extra/shared-files/attachments/, populated by the Slack
 * adapter when a voice message arrives). Returns the transcript text.
 *
 * For inbound Slack voice messages, the host adapter already prepends
 * `[Voice: <transcript>]` automatically — this tool is for ad-hoc cases
 * where the agent wants to transcribe a different file later.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const SUPPORTED_AUDIO_EXTS = new Set(['m4a', 'mp3', 'ogg', 'opus', 'wav', 'webm']);
const AUDIO_MIME: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  webm: 'audio/webm',
};
const MAX_AUDIO_SIZE = 25 * 1024 * 1024;

let openaiClient: import('openai').default | null = null;

async function getClient(): Promise<import('openai').default | null> {
  if (openaiClient) return openaiClient;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const { default: OpenAI } = await import('openai');
  openaiClient = new OpenAI({ apiKey: key });
  return openaiClient;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const tool: McpToolDefinition = {
  tool: {
    name: 'transcribe_audio',
    description:
      'Transcribe an audio file to text using OpenAI. Pass an absolute path to a file on disk ' +
      '(typically inside /workspace/extra/shared-files/attachments/). ' +
      'Supports m4a, mp3, ogg, opus, wav, webm. Maximum 25MB.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the audio file.',
        },
      },
      required: ['file_path'],
    },
  },
  async handler(args) {
    const filePath = args.file_path as string | undefined;
    if (!filePath) return err('file_path is required');

    const openai = await getClient();
    if (!openai) return err('OPENAI_API_KEY is not set in this container.');

    if (!fs.existsSync(filePath)) return err(`File not found: ${filePath}`);

    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!SUPPORTED_AUDIO_EXTS.has(ext)) {
      return err(`Unsupported audio format: .${ext}. Supported: ${[...SUPPORTED_AUDIO_EXTS].join(', ')}`);
    }

    const stat = fs.statSync(filePath);
    if (stat.size > MAX_AUDIO_SIZE) {
      return err(`File too large (${Math.round(stat.size / 1024 / 1024)}MB). Maximum: 25MB.`);
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const mime = AUDIO_MIME[ext] || 'audio/mp4';
      const file = new File([new Uint8Array(buffer)], path.basename(filePath), { type: mime });
      const model = process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';

      const response = await openai.audio.transcriptions.create({ model, file });
      const text = response.text?.trim();
      if (!text) return ok('Transcription returned empty text — the audio may be silent or too short.');
      return ok(text);
    } catch (e) {
      return err(`Transcription failed: ${(e as Error).message}`);
    }
  },
};

registerTools([tool]);
