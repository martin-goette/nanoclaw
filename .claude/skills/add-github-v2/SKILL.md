---
name: add-github-v2
description: Add GitHub channel integration to NanoClaw v2 via Chat SDK. PR and issue comment threads as conversations.
---

# Add GitHub Channel

Adds GitHub support to NanoClaw v2 using the Chat SDK bridge. The agent participates in PR and issue comment threads.

## Pre-flight

Check if `src/channels/github.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

```bash
npm install @chat-adapter/github
```

Uncomment the GitHub import in `src/channels/index.ts`:

```typescript
import './github.js';
```

```bash
npm run build
```

## Credentials

> 1. Go to [GitHub Settings > Developer Settings > Personal Access Tokens](https://github.com/settings/tokens)
> 2. Create a **Fine-grained token** with:
>    - Repository access: select the repos you want the bot to monitor
>    - Permissions: **Pull requests** (Read & Write), **Issues** (Read & Write)
> 3. Copy the token
> 4. Set up a webhook on your repo(s):
>    - Go to **Settings** > **Webhooks** > **Add webhook**
>    - Payload URL: `https://your-domain/webhook/github`
>    - Content type: `application/json`
>    - Secret: generate a random string
>    - Events: select **Issue comments**, **Pull request review comments**

### Configure environment

Add to `.env`:

```bash
GITHUB_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `github`
- **terminology**: GitHub has "repositories" containing "pull requests" and "issues." Each PR or issue comment thread is a separate conversation.
- **how-to-find-id**: The platform ID is `owner/repo` (e.g. `acme/backend`). Each PR/issue becomes its own thread automatically.
- **supports-threads**: yes (PR and issue comment threads are native conversations)
- **typical-use**: Webhook/notification — the agent receives PR and issue events and responds in comment threads
- **default-isolation**: Typically shares a session with a chat channel (e.g. Slack) so the agent can summarize PRs and respond to reviews in the same context. Use a separate agent group if the repo contains sensitive code that other channels shouldn't access.
