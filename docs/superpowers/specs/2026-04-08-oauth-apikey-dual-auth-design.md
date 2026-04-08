# Design: OAuth + API Key Dual Authentication

**Date:** 2026-04-08
**Branch:** `feat/oauth-apikey-dual`
**Status:** Approved (via brainstorming)

## Problem

PR #1 (`feat/api-key-migration`, merged 2026-04-05) removed OAuth passthrough
entirely, forcing users onto `ANTHROPIC_API_KEY`. Users with a Claude Max plan
lose significant value by paying per-token instead of using their included
OAuth-backed quota. We want OAuth support back **without** removing API key
support — both modes must coexist, selected at startup.

## Goals

- Restore OAuth authentication as a supported mode.
- Keep API key mode fully functional and unchanged when configured.
- Zero new config surface for users who already have a working install.
- Preserve the resilience fixes from `fb67117` and `bd848bb` (dead-token
  recovery, owner alerts, silent-refresh prevention).

## Non-Goals

- Runtime toggling between modes (restart required to switch).
- UI or channel-facing auth mode indicator beyond startup logs and `/debug`.
- Migration tooling — users just set or unset `ANTHROPIC_API_KEY` in `.env`.

## Auth Mode Selection

Decided **once at process startup** in `src/config.ts`:

```
authMode = process.env.ANTHROPIC_API_KEY ? "apikey" : "oauth"
```

- **API key wins when present.** This matches user preference from
  brainstorming: "C — API key always wins when set".
- Logged at startup: `[auth] mode=oauth` or `[auth] mode=apikey`.
- Exposed via `getAuthMode()` accessor so other modules don't re-read env.
- `/debug` skill surfaces the active mode.

## Credential Proxy (`src/credential-proxy.ts`)

Restore the OAuth branch from `4e9467e^` (the commit just before OAuth was
removed) as a **conditional path** gated on `authMode === "oauth"`. The
current API-key injection path is preserved unchanged for
`authMode === "apikey"`.

Restored OAuth functions:

- `readCredentials()` — read `~/.claude/.credentials.json`.
- `refreshOAuthToken()` — exchange refresh token, write back to disk.
- Proactive refresh timer — periodic check, refresh when < N minutes from expiry.
- Dead-token recovery — detect permanently-broken refresh tokens, alert owner.
- Owner alert plumbing — send a notification via the main channel on refresh
  failure (routed through the existing outbound router).

Both auth modes share the same HTTP proxy shell (listener, routing,
request mutation hook). Only the header/credential injection differs:

- `apikey` mode: inject `x-api-key: $ANTHROPIC_API_KEY`.
- `oauth` mode: inject `Authorization: Bearer <current access token>` from the
  refreshed credentials.

## Container Runner (`src/container-runner.ts`)

Restore the OAuth credential-file staging branch from `4963744^` as a
conditional path gated on `authMode === "oauth"`. When OAuth is active:

- Stage `~/.claude/.credentials.json` into a per-container temp dir.
- Mount the staged file read-only into the container at the expected path.
- Update the staged file when the proxy refreshes tokens (restore
  `e6802c6`'s propagation logic — refreshed token written to all staged files).

When API key is active: current behavior unchanged (no mounting, key injected
via proxy headers).

## Config (`src/config.ts`)

Add:

```ts
export type AuthMode = "oauth" | "apikey";
export function getAuthMode(): AuthMode { ... }
```

Read `ANTHROPIC_API_KEY` once, cache, export.

## Environment (`.env.example`)

Keep the existing `ANTHROPIC_API_KEY=` line, but add a comment:

```
# Leave ANTHROPIC_API_KEY blank to use OAuth via ~/.claude/.credentials.json
# (required for Claude Max plan users to benefit from included quota).
ANTHROPIC_API_KEY=
```

## Testing

- **Restore** OAuth credential-proxy tests from `e0ee0ee^` as a separate
  `describe("oauth mode")` block.
- **Keep** current API-key tests as `describe("apikey mode")`.
- Both suites run unconditionally; OAuth tests mock the credentials file and
  refresh endpoint.
- Restore the 5 deleted lines in `container-runner.test.ts` covering OAuth
  mount behavior, behind a mode-switch in test setup.
- New small test: `config.test.ts` verifying `getAuthMode()` returns the right
  value based on env presence.

## Out of Scope / Risks

- **Risk:** Silent drift between the two modes as the codebase evolves. Mitigated
  by making the mode-switching branches small and localized.
- **Risk:** The current `container-runner.ts` has grown 69 lines since the
  pre-removal version. Reintegration must be manual, not a raw cherry-pick.
- **Out of scope:** Exposing auth mode to subagents or passing it through to
  individual tool calls.

## Files Touched

| File | Change |
|---|---|
| `src/config.ts` | Add `AuthMode`, `getAuthMode()`, startup log |
| `src/credential-proxy.ts` | Reintroduce OAuth branch + resilience |
| `src/credential-proxy.test.ts` | Restore OAuth tests, keep API key tests |
| `src/container-runner.ts` | Reintroduce OAuth credential staging |
| `src/container-runner.test.ts` | Restore OAuth mount test |
| `src/config.test.ts` | New small test for `getAuthMode()` |
| `.env.example` | Update comment for OAuth fallback |
| `docs/superpowers/specs/...` | This file |
| `docs/superpowers/plans/...` | Implementation plan |
