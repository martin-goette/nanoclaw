---
name: add-matrix-v2
description: Add Matrix channel integration to NanoClaw v2 via Chat SDK. Works with any Matrix homeserver.
---

# Add Matrix Channel

Adds Matrix support to NanoClaw v2 using the Chat SDK bridge.

## Pre-flight

Check if `src/channels/matrix.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

```bash
npm install @beeper/chat-adapter-matrix
```

Uncomment the Matrix import in `src/channels/index.ts`:

```typescript
import './matrix.js';
```

```bash
npm run build
```

## Credentials

1. Register a bot account on your Matrix homeserver (e.g., via Element)
2. Get the homeserver URL (e.g., `https://matrix.org` or your self-hosted URL)
3. Get an access token:
   - In Element: **Settings** > **Help & About** > **Access Token** (advanced)
   - Or via API: `curl -XPOST 'https://matrix.org/_matrix/client/r0/login' -d '{"type":"m.login.password","user":"botuser","password":"..."}'`
4. Note the bot's user ID (e.g., `@botuser:matrix.org`)

### Configure environment

Add to `.env`:

```bash
MATRIX_BASE_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=your-access-token
MATRIX_USER_ID=@botuser:matrix.org
MATRIX_BOT_USERNAME=botuser
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `matrix`
- **terminology**: Matrix has "rooms." A room can be a group chat or a direct message. Rooms have internal IDs (like `!abc123:matrix.org`) and optional aliases (like `#general:matrix.org`).
- **how-to-find-id**: In Element, click the room name > Settings > Advanced — the "Internal room ID" is the platform ID (starts with `!`). Or use a room alias like `#general:matrix.org`.
- **supports-threads**: partial (some clients support threads, but not all — treat as no for reliability)
- **typical-use**: Interactive chat — rooms or direct messages
- **default-isolation**: Same agent group for rooms where you're the primary user. Separate agent group for rooms with different communities or sensitive contexts.
