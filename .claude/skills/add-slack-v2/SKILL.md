---
name: add-slack-v2
description: Add Slack channel integration to NanoClaw v2 via Chat SDK.
---

# Add Slack Channel

Adds Slack support to NanoClaw v2 using the Chat SDK bridge.

## Pre-flight

Check if `src/channels/slack.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

### Install the adapter package

```bash
npm install @chat-adapter/slack
```

### Enable the channel

Uncomment the Slack import in `src/channels/index.ts`:

```typescript
import './slack.js';
```

### Build

```bash
npm run build
```

## Credentials

### Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**
2. Name it (e.g., "NanoClaw") and select your workspace
3. Go to **OAuth & Permissions** and add Bot Token Scopes:
   - `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`, `reactions:write`
4. Click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-...`)
5. Go to **Basic Information** and copy the **Signing Secret**
6. Go to **Event Subscriptions**, enable events, and subscribe to:
   - `message.channels`, `message.groups`, `message.im`, `app_mention`
7. Set the Request URL to your webhook endpoint (e.g., `https://your-domain/webhook/slack`)

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `slack`
- **terminology**: Slack has "workspaces" containing "channels." Channels can be public (#general) or private. The bot can also receive direct messages.
- **how-to-find-id**: Right-click a channel name > "View channel details" — the Channel ID is at the bottom (starts with C). Or copy the channel link — the ID is the last segment of the URL.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team channels or direct messages
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or sensitive contexts.
