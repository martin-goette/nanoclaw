/**
 * Host-side audio transcription helper.
 *
 * Used by the Slack adapter to transcribe inbound voice messages before
 * routing them to an agent. The agent sees `[Voice: <transcript>]` prepended
 * to the message text so it can respond to the audio content directly.
 *
 * For in-container transcription (agent calling whisper on any file in its
 * shared-files mount), see container/agent-runner/src/mcp-tools/transcribe-audio.ts.
 */
import OpenAI from 'openai';

import { readEnvFile } from './env.js';
import { log } from './log.js';

const env = readEnvFile(['OPENAI_API_KEY', 'TRANSCRIPTION_MODEL']);
const OPENAI_API_KEY = env.OPENAI_API_KEY;
const TRANSCRIPTION_MODEL = env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';

let client: OpenAI | null = null;
let warnedMissingKey = false;

function getClient(): OpenAI | null {
  if (!OPENAI_API_KEY) {
    if (!warnedMissingKey) {
      log.warn('OPENAI_API_KEY not set — audio transcription disabled');
      warnedMissingKey = true;
    }
    return null;
  }
  if (!client) client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return client;
}

const MIME_TYPES: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<string | null> {
  const openai = getClient();
  if (!openai) return null;

  try {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const mimeType = MIME_TYPES[ext] || 'audio/mp4';
    const file = new File([audioBuffer], filename, { type: mimeType });

    const response = await openai.audio.transcriptions.create({ model: TRANSCRIPTION_MODEL, file });
    const text = response.text?.trim();
    if (!text) {
      log.info('Transcription returned empty text', { filename });
      return null;
    }
    log.info('Audio transcribed', { filename, length: text.length });
    return text;
  } catch (err) {
    log.error('Audio transcription failed', { err: (err as Error).message, filename });
    return null;
  }
}

export function isTranscriptionAvailable(): boolean {
  return !!OPENAI_API_KEY;
}
