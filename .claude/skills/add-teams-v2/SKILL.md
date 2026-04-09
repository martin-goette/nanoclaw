---
name: add-teams-v2
description: Add Microsoft Teams channel integration to NanoClaw v2 via Chat SDK.
---

# Add Microsoft Teams Channel

Connect NanoClaw to Microsoft Teams for interactive chat in team channels and direct messages.

## Pre-flight

Check if `src/channels/teams.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

```bash
npm install @chat-adapter/teams
```

Uncomment the Teams import in `src/channels/index.ts`:

```typescript
import './teams.js';
```

Build:

```bash
npm run build
```

## Credentials

1. Go to [Azure Portal](https://portal.azure.com) > **Azure Bot** > **Create**.
2. Configure the messaging endpoint: `https://your-domain/webhook/teams`.
3. Add the **Microsoft Teams** channel.
4. Note the **App ID** and **Password** from the Azure AD app registration.

### Configure environment

Add to `.env`:

```bash
TEAMS_APP_ID=your-app-id
TEAMS_APP_PASSWORD=your-app-password
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `teams`
- **terminology**: Teams has "teams" containing "channels." The bot can also receive direct messages. Teams channels can have threaded replies.
- **how-to-find-id**: Right-click a channel in Teams > "Get link to channel" -- the channel ID is in the URL. Or use the Microsoft Graph API to list channels.
- **supports-threads**: yes
- **typical-use**: Interactive chat -- team channels or direct messages
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or where different members have different information boundaries.
