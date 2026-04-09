---
name: add-gchat-v2
description: Add Google Chat channel integration to NanoClaw v2 via Chat SDK.
---

# Add Google Chat Channel

Adds Google Chat support to NanoClaw v2 using the Chat SDK bridge.

## Pre-flight

Check if `src/channels/gchat.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

```bash
npm install @chat-adapter/gchat
```

Uncomment the Google Chat import in `src/channels/index.ts`:

```typescript
import './gchat.js';
```

```bash
npm run build
```

## Credentials

> 1. Go to [Google Cloud Console](https://console.cloud.google.com)
> 2. Create or select a project
> 3. Enable the **Google Chat API**
> 4. Go to **Google Chat API** > **Configuration**:
>    - App name and description
>    - Connection settings: select **HTTP endpoint URL** and set to `https://your-domain/webhook/gchat`
> 5. Create a **Service Account**:
>    - Go to **IAM & Admin** > **Service Accounts** > **Create Service Account**
>    - Grant the Chat Bot role
>    - Create a JSON key and download it

### Configure environment

Add the service account JSON as a single-line string to `.env`:

```bash
GCHAT_CREDENTIALS={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `gchat`
- **terminology**: Google Chat has "spaces." A space can be a group conversation or a direct message with the bot.
- **how-to-find-id**: Open the space in Google Chat, look at the URL — the space ID is the segment after `/space/` (e.g. `spaces/AAAA...`). Or use the Google Chat API to list spaces.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team spaces or direct messages
- **default-isolation**: Same agent group for spaces where you're the primary user. Separate agent group for spaces with different teams or sensitive contexts.
