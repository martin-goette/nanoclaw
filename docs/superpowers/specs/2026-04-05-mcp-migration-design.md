# Migration: Subscription OAuth → API Key + Self-Hosted Google Workspace MCP

**Date:** 2026-04-05
**Status:** Approved

## Background

Anthropic banned Claude Pro/Max subscription OAuth tokens in third-party tools (2026-04-04). NanoClaw currently passes the host Claude Code session (Max subscription) into containers via OAuth credential staging and a refresh proxy. This violates the new ToS. Migration switches to an employer-provided Anthropic API key and replaces Claude's built-in Google Workspace integrations with a self-hosted MCP server.

## Two PRs

### PR 1: API Key Migration + OAuth Removal

Switches auth from Claude Max subscription OAuth to an Anthropic API key and removes all OAuth passthrough code.

#### Config Changes

**`.env`:**
- Add `ANTHROPIC_API_KEY=<employer-provided key>`
- Remove dead `CLAUDE_AUTH_DIR` and `CLAUDE_CONFIG` lines (not referenced in code)

**`.env.example`:**
- Add `ANTHROPIC_API_KEY=` placeholder

#### Code Removal: `credential-proxy.ts`

Remove all OAuth machinery (~400 lines):
- `OAuthCredentials` type
- `OAuthRefreshError` class
- `credentialsPath()`
- `readCredentials()`
- `refreshOAuthToken()`
- `ensureValidToken()`
- `proactiveRefresh()`
- `updateStagedCredentials()`
- `copyFreshCredentials()`
- `AuthMode` type and `detectAuthMode()`

Simplify `startCredentialProxy()`:
- Remove OAuth branch (token reading, Bearer header injection)
- Remove refresh timer (`setInterval` for proactive refresh)
- Remove `onAuthFailure` callback parameter
- Remove `authDead` recovery logic
- Keep API key injection path (reads `ANTHROPIC_API_KEY` from `.env`, injects `x-api-key` header)
- Keep upstream proxy forwarding (containers still route through proxy)

Remove unused imports: `os` (used only by `credentialsPath()`), `DATA_DIR` from config (used only by `updateStagedCredentials()`).

#### Code Removal: `container-runner.ts`

- Remove OAuth credential staging block (lines 208-223): the `data/credentials/<group>/.credentials.json` mount
- Remove pre-run credential staging (lines 416-432): the `copyFreshCredentials()` call
- Remove `detectAuthMode()` branch in `buildContainerArgs()` — always inject proxy URL + placeholder key
- Update import: remove `copyFreshCredentials` and `detectAuthMode` from `credential-proxy.js` import

#### Code Removal: `index.ts`

- Remove `onAuthFailure` callback from `startCredentialProxy()` call (second positional arg becomes unnecessary)

#### What Stays

- The credential proxy itself — it still injects the API key so containers never see it
- The `.env` shadow mount (`/dev/null` → `/workspace/project/.env`) — still needed to protect secrets
- All MCP env var resolution logic — unchanged

---

### PR 2: Google Workspace MCP Server

Adds `taylorwilsdon/google_workspace_mcp` for Gmail, Calendar, Tasks, Drive, Docs, and Sheets.

#### Config Changes

**`.mcp.json`:**
```json
{
  "mcpServers": {
    "perplexity": { ... },
    "google-workspace": {
      "command": "uvx",
      "args": ["workspace-mcp", "--tool-tier", "core"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "${GOOGLE_OAUTH_CLIENT_ID}",
        "GOOGLE_OAUTH_CLIENT_SECRET": "${GOOGLE_OAUTH_CLIENT_SECRET}"
      }
    }
  }
}
```

**`.env`:**
- Add `GOOGLE_OAUTH_CLIENT_ID=<from GCP console>`
- Add `GOOGLE_OAUTH_CLIENT_SECRET=<from GCP console>`

**`.env.example`:**
- Add `GOOGLE_OAUTH_CLIENT_ID=` and `GOOGLE_OAUTH_CLIENT_SECRET=` placeholders

#### Code Change: Merge `.mcp.json` as Global MCP Defaults

Currently, containers only get MCP servers from per-group `containerConfig.mcpServers` in the database (set via `register_group` IPC). The host-level `.mcp.json` is only read by the host Claude Code session and is NOT passed to containers.

**Change in `container-runner.ts`:** Before resolving per-group MCP servers, read `.mcp.json` from the project root and merge its servers as defaults. Per-group servers override globals if they share a name.

```
globalMcpServers = readMcpJson()          // from .mcp.json
groupMcpServers  = group.containerConfig?.mcpServers || {}
mergedServers    = { ...globalMcpServers, ...groupMcpServers }
```

This makes `.mcp.json` the single source of truth for MCP servers available to all groups. Adding a new MCP server to `.mcp.json` makes it available to every container without touching the database.

The existing resolution pipeline then handles the merged config as before:
1. Resolves `${VAR}` references against `.env`
2. Injects resolved env vars into the container via `-e` flags
3. Forwards resolved server configs to the agent-runner via `ContainerInput.mcpServers`

#### First-Run OAuth Flow

The MCP server requires a one-time Google OAuth consent flow on first startup:
- On a machine with a browser: follow the prompt
- On a headless server: use SSH port forwarding (`ssh -L 3000:localhost:3000 server`)
- Token cache persists at `~/.workspace-mcp/credentials/` — survives restarts

#### Prerequisites

- `uv` installed (already present at `/home/martin/.local/bin/uv`)
- Google Cloud project with OAuth 2.0 Desktop credentials
- APIs enabled: Gmail, Calendar, Tasks, Drive, Docs, Sheets

## Testing

### PR 1 Verification
- NanoClaw starts without errors
- Credential proxy logs `authMode: api-key`
- Send a test message → model responds (API key working)
- Audio transcription still works (uses OpenAI, unaffected)

### PR 2 Verification
- MCP server starts: `uvx workspace-mcp --tool-tier core` lists tools
- Agent can search emails
- Agent can list calendar events
- Agent can list tasks
- Agent can search Drive files
- Agent can read a Google Doc
- Agent can read a Google Sheet

## Out of Scope

- Notion MCP (not needed)
- Changes to Perplexity MCP or other existing integrations
- Changes to container build/Dockerfile
- Hardcoded references to new Google tool names (MCP auto-discovery handles this)
