---
name: add-linear-v2
description: Add Linear channel integration to NanoClaw v2 via Chat SDK. Issue comment threads as conversations.
---

# Add Linear Channel

Adds Linear support to NanoClaw v2 using the Chat SDK bridge. The agent participates in issue comment threads.

## Pre-flight

Check if `src/channels/linear.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

```bash
npm install @chat-adapter/linear
```

Uncomment the Linear import in `src/channels/index.ts`:

```typescript
import './linear.js';
```

```bash
npm run build
```

## Credentials

> 1. Go to [Linear Settings > API](https://linear.app/settings/api)
> 2. Create a **Personal API Key** (or use an OAuth application for team-wide access)
> 3. Copy the API key
> 4. Set up a webhook:
>    - Go to **Settings** > **API** > **Webhooks** > **New webhook**
>    - URL: `https://your-domain/webhook/linear`
>    - Select events: **Comment** (created, updated)
>    - Copy the signing secret

### Configure environment

Add to `.env`:

```bash
LINEAR_API_KEY=lin_api_...
LINEAR_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `linear`
- **terminology**: Linear has "teams" containing "issues." Each issue's comment thread is a separate conversation.
- **how-to-find-id**: The platform ID is your team key (e.g. `ENG`). Find it in Linear under Settings > Teams. Each issue becomes its own thread automatically.
- **supports-threads**: yes (issue comment threads are native conversations)
- **typical-use**: Webhook/notification — the agent receives issue comment events and responds in threads
- **default-isolation**: Typically shares a session with a chat channel (e.g. Slack) so the agent can discuss issues in the same context as team chat. Use a separate agent group if the Linear team tracks sensitive work.
