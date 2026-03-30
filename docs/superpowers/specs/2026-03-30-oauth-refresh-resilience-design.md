# OAuth Refresh Resilience

**Date:** 2026-03-30
**Status:** Approved
**Relates to:** 2026-03-29-oauth-auto-refresh-design.md

## Problem

The OAuth auto-refresh introduced in a4b85cf has a failure mode that causes permanent sign-out. When `ensureValidToken()` attempts a refresh, the server may accept the single-use refresh token (burning it) but the client fails to write back the new credentials. All subsequent retries use the now-dead refresh token, fail with `invalid_grant`, and the function silently returns stale credentials. The proxy then serves expired tokens indefinitely, producing 401s in containers.

**Evidence from logs (2026-03-30):**

- `10:19:52` — Refresh succeeds
- `18:15:52` — Refresh triggered, no success logged
- `18:19–18:43` — Repeated "expiring soon" with no success
- `18:39:56` — `invalid_grant: Refresh token not found or invalid`
- All subsequent attempts fail with the same error

## Design

Three changes to `src/credential-proxy.ts`, all within `ensureValidToken()`:

### Change 1: Re-read credentials before each retry

Move `readCredentials()` inside the retry loop. Each attempt reads the freshest token from disk before deciding whether to refresh. This handles:

- External refresh (e.g. `claude` CLI login) updating the file between retries
- Race conditions where another process refreshed the token

```
for each attempt:
  creds = readCredentials(credentialsPath)
  if creds.expiresAt - Date.now() > REFRESH_BUFFER_MS:
    return creds  // someone else refreshed it
  try refreshOAuthToken(creds.refreshToken)
  ...write back on success...
```

### Change 2: Throw on unrecoverable failure

After all retries fail, re-read credentials one final time. If the token on disk is still expired/near-expiry, throw an error instead of returning stale credentials. This prevents the proxy from silently serving dead tokens for hours.

The periodic timer's existing catch block handles the thrown error — it logs and leaves `currentToken` unchanged (last known-good value). The proxy stays running but the token naturally expires rather than being replaced with a known-dead one.

### Change 3: Log actual expiry minutes

Replace the vague "expires in minutes" log message with the actual number of minutes remaining, for easier diagnosis.

## What does not change

- `refreshInProgress` serialization logic (still needed for concurrent callers)
- 4-minute periodic timer interval
- `copyFreshCredentials()` — inherits the fix via `ensureValidToken()`
- Container runner error handling (existing catch block in container-runner.ts)
- Proxy request handler
- `readCredentials()` and `refreshOAuthToken()` signatures

## Files changed

- `src/credential-proxy.ts` — modify `ensureValidToken()`, update log messages
- `src/credential-proxy.test.ts` — add tests for re-read behavior and throw-on-failure

## Risk

Low. Changes are confined to the retry loop in one function. The worst case if the fix has a bug is the same as today (stale token), but now it throws instead of silently degrading.
