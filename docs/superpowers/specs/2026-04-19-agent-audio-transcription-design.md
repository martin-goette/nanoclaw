# Design: Agent-Side Audio Transcription Tool

**Date:** 2026-04-19
**Status:** Approved (via brainstorming)

## Problem

Container agents can't process audio files. The host-side Slack channel
transcribes audio on receipt, but agents have no way to independently
transcribe audio files from `/workspace/group/attachments/` — whether
old files, re-transcriptions, or files shared without host-side
transcription. Sam reported this directly.

## Solution

Add a `transcribe_audio` MCP tool to the nanoclaw container MCP server
(`ipc-mcp-stdio.ts`). All agents get it automatically since they all
run with `mcp__nanoclaw__*` tools.

## Tool Definition

- **Name:** `transcribe_audio`
- **Input:** `{ file_path: string }` — absolute path to audio file
- **Validation:**
  - File must exist
  - Extension must be supported: m4a, mp3, ogg, opus, wav, webm
  - File size must be < 25 MB
- **Behavior:** Reads the file, sends to OpenAI Whisper API, returns
  transcript text
- **Model:** `TRANSCRIPTION_MODEL` env var, default `gpt-4o-mini-transcribe`
- **Output:** Transcript text only (no language detection, no metadata)

## API Key Delivery

`OPENAI_API_KEY` is read from `process.env` inside the container. The
key reaches the container via MCP env resolution in `container-runner.ts`
— same pattern used for `PERPLEXITY_API_KEY` and Google Workspace keys.

If the key is missing, the tool returns an error message telling the
agent that transcription is not configured.

## Dependencies

The `openai` npm package is added to `container/agent-runner/package.json`.
The host-side `src/transcription.ts` already uses this package but is
not available inside containers.

## Files Touched

| File | Change |
|---|---|
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `transcribe_audio` tool |
| `container/agent-runner/package.json` | Add `openai` dependency |
| `src/container-runner.ts` | Ensure `OPENAI_API_KEY` reaches container |

## Out of Scope

- Host-side transcription changes (continues as-is)
- Accent detection
- URL-based audio fetching
- Language detection metadata
