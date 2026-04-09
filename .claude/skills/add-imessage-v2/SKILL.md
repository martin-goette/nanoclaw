---
name: add-imessage-v2
description: Add iMessage channel integration to NanoClaw v2 via Chat SDK. Local (macOS) or remote (Photon API) mode.
---

# Add iMessage Channel

Adds iMessage support to NanoClaw v2 using the Chat SDK bridge. Two modes: local (macOS with Full Disk Access) or remote (Photon API).

## Pre-flight

Check if `src/channels/imessage.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

```bash
npm install chat-adapter-imessage
```

Uncomment the iMessage import in `src/channels/index.ts`:

```typescript
import './imessage.js';
```

```bash
npm run build
```

## Credentials

### Local Mode (macOS)

Requirements: macOS with Full Disk Access granted to your terminal/Node.js process.

1. Go to **System Settings** > **Privacy & Security** > **Full Disk Access**
2. Add your terminal app (Terminal, iTerm2, etc.) or the Node.js binary
3. The adapter reads directly from the iMessage database on disk

### Remote Mode (Photon API)

1. Set up a [Photon](https://photon.im) account
2. Get your server URL and API key

### Configure environment

**Local mode** -- add to `.env`:

```bash
IMESSAGE_ENABLED=true
IMESSAGE_LOCAL=true
```

**Remote mode** -- add to `.env`:

```bash
IMESSAGE_LOCAL=false
IMESSAGE_SERVER_URL=https://your-photon-server.com
IMESSAGE_API_KEY=your-api-key
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `imessage`
- **terminology**: iMessage has "conversations." Each conversation is with a contact identified by phone number or email address. Group chats are also supported.
- **how-to-find-id**: The platform ID is the contact's phone number (e.g. `+15551234567`) or email address. For group chats, the ID is assigned by iMessage internally.
- **supports-threads**: no
- **typical-use**: Interactive 1:1 chat — personal messaging
- **default-isolation**: Same agent group if you're the only person messaging the bot across iMessage and other channels. Separate agent group if different contacts should have information isolation.
