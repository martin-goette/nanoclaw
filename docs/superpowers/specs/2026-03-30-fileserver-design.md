# File Sharing via Mounted Directory

**Date:** 2026-03-30
**Status:** Approved

## Problem

NanoClaw agents can receive files from users (Slack attachments) but cannot share files back. Agents generate code, charts, CSVs, and other artifacts that are only accessible inside the container. Users need a way to view and download these files.

## Solution

Mount a shared directory into containers that maps to a Caddy-served path under `code.goette.co/files/`. Agents know the URL pattern and include download links inline in their responses. A cron job cleans up files older than 7 days.

## Infrastructure (already in place)

Caddy serves `/home/martin/nanoclaw-files/` at `code.goette.co/files/*`, protected by Cloudflare Access. The Caddyfile block:

```
handle /files/* {
    uri strip_prefix /files
    file_server
    root * /home/martin/nanoclaw-files
}
```

## Design

### 1. Container mount

Add a writable mount in `buildVolumeMounts()` in `src/container-runner.ts`:

- **Host path:** `/home/martin/nanoclaw-files/<group>/`
- **Container path:** `/workspace/shared-files/`
- **Permissions:** writable (agent needs to create files)
- Create the host directory if it doesn't exist before mounting

The group name provides namespace isolation — files from different groups don't collide.

### 2. Agent instructions

Add a container skill or append to the group CLAUDE.md telling agents:

> To share files with the user, save them to `/workspace/shared-files/`. They become accessible at `code.goette.co/files/<group>/`. Include the full URL in your response so the user can click it.

This goes into the global CLAUDE.md at `groups/global/CLAUDE.md` so all agents get it, or as a container skill at `container/skills/shared-files/SKILL.md`.

### 3. Cleanup cron

A cron job runs daily and deletes files older than 7 days:

```bash
find /home/martin/nanoclaw-files -type f -mtime +7 -delete
find /home/martin/nanoclaw-files -type d -empty -not -path /home/martin/nanoclaw-files -delete
```

## Files changed

- `src/container-runner.ts` — add writable mount for shared files directory in `buildVolumeMounts()`
- `src/config.ts` — add `SHARED_FILES_DIR` and `SHARED_FILES_URL` constants
- `container/skills/shared-files/SKILL.md` — agent instructions for file sharing (or `groups/global/CLAUDE.md`)
- System crontab — daily cleanup of files older than 7 days

## What doesn't change

- No new HTTP server (Caddy handles serving)
- No post-run file scanning or URL injection
- No channel-specific logic (URLs work in any channel)
- No new IPC commands or container tools
- Caddy config (already set up)

## Risk

Low. Adding a writable mount is a well-established pattern in the codebase. The only new concern is disk usage from uncleaned files, handled by the 7-day cron.
