---
name: add-webex-v2
description: Add Webex channel integration to NanoClaw v2 via Chat SDK.
---

# Add Webex Channel

Adds Cisco Webex support to NanoClaw v2 using the Chat SDK bridge.

## Pre-flight

Check if `src/channels/webex.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

```bash
npm install @bitbasti/chat-adapter-webex
```

Uncomment the Webex import in `src/channels/index.ts`:

```typescript
import './webex.js';
```

```bash
npm run build
```

## Credentials

1. Go to [developer.webex.com](https://developer.webex.com/my-apps/new/bot) and create a new bot
2. Copy the **Bot Access Token**
3. Set up a webhook:
   - Use the Webex API or Developer Portal to create a webhook pointing to `https://your-domain/webhook/webex`
   - Set a webhook secret for signature verification

### Configure environment

Add to `.env`:

```bash
WEBEX_BOT_TOKEN=your-bot-token
WEBEX_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `webex`
- **terminology**: Webex has "spaces." A space can be a group conversation or a 1:1 direct message with the bot.
- **how-to-find-id**: Open the space in Webex, click the space name > Settings — the Space ID is listed there. Or use the Webex API (`GET /rooms`) to list spaces and their IDs.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team spaces or direct messages
- **default-isolation**: Same agent group for spaces where you're the primary user. Separate agent group for spaces with different teams or sensitive information.
