---
name: add-discord-v2
description: Add Discord bot channel integration to NanoClaw v2 via Chat SDK.
---

# Add Discord Channel

Adds Discord bot support to NanoClaw v2. Discord is built in — no adapter package to install.

## Pre-flight

Check if `src/channels/discord.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

Discord support is bundled with NanoClaw — there is no separate package to install.

### Enable the channel

Uncomment the Discord import in `src/channels/index.ts`:

```typescript
import './discord.js';
```

### Build

```bash
npm run build
```

## Credentials

### Create Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name (e.g., "NanoClaw Assistant")
3. Go to the **Bot** tab and click **Add Bot** if needed
4. Copy the Bot Token (click **Reset Token** if you need a new one — you can only see it once)
5. Under **Privileged Gateway Intents**, enable **Message Content Intent**
6. Go to **OAuth2** > **URL Generator**:
   - Scopes: select `bot`
   - Bot Permissions: select `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`, `Use Slash Commands`
7. Copy the generated URL and open it in your browser to invite the bot to your server

### Configure environment

Add to `.env`:

```bash
DISCORD_BOT_TOKEN=your-bot-token
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `discord`
- **terminology**: Discord has "servers" (also called "guilds") containing "channels." Text channels start with #. The bot can also receive direct messages.
- **how-to-find-id**: Enable Developer Mode in Discord (Settings > App Settings > Advanced > Developer Mode). Then right-click a server or channel and select "Copy ID."
- **supports-threads**: yes
- **typical-use**: Interactive chat — server channels or direct messages
- **default-isolation**: Same agent group for your personal server. Separate agent group for servers with different communities or where different members have different information boundaries.
