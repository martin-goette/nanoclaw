# Implementation Plan: OAuth + API Key Dual Auth

Spec: `docs/superpowers/specs/2026-04-08-oauth-apikey-dual-auth-design.md`
Branch: `feat/oauth-apikey-dual` (worktree `../nanoclaw-oauth-dual`)

## Insight

The pre-removal `src/credential-proxy.ts` at `4e9467e^` was **already dual-mode**
and already selected modes exactly the way we want: `ANTHROPIC_API_KEY` present
→ `api-key`, else → `oauth`. So restoring it is almost a wholesale copy of
that file plus a surgical merge of `src/container-runner.ts`.

## Steps

### 1. Restore `src/credential-proxy.ts`

`git show 4e9467e^:src/credential-proxy.ts > src/credential-proxy.ts`

Exports restored:
- `AuthMode`, `credentialsPath`, `readCredentials`
- `OAuthRefreshError`, `refreshOAuthToken`, `ensureValidToken`, `proactiveRefresh`
- `detectAuthMode`, `copyFreshCredentials`
- `startCredentialProxy(port, host, credsPath?, onAuthFailure?)`

No modifications needed — imports (`./env`, `./config`, `./logger`) all still exist.

### 2. Restore `src/credential-proxy.test.ts`

`git show e0ee0ee^:src/credential-proxy.test.ts > src/credential-proxy.test.ts`

Restores OAuth test suite alongside the API key tests that this file already
contained pre-migration. No manual merge needed — pre-migration file had both.

### 3. Update `src/index.ts` credential proxy call

Replace the current 2-arg call with 4-arg call that wires `onAuthFailure` to
send a message to the main group via the existing channel registry. Use the
pattern from `5f04f04^`:

```ts
const proxyServer = await startCredentialProxy(
  CREDENTIAL_PROXY_PORT,
  PROXY_BIND_HOST,
  undefined,
  (message) => {
    const jid =
      Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0] ??
      Object.keys(registeredGroups)[0];
    if (!jid) return;
    const channel = findChannel(channels, jid);
    if (channel) channel.sendMessage(jid, message).catch(() => {});
  },
);
```

Verify `registeredGroups`, `channels`, and `findChannel` still exist in current
`src/index.ts`. If renamed, adapt.

### 4. Merge `src/container-runner.ts`

Apply these three surgical changes **on top of current code** (do not revert;
current has unrelated MCP env-handling we must keep):

**4a.** Add import:
```ts
import { copyFreshCredentials, detectAuthMode } from './credential-proxy.js';
```

**4b.** In `buildVolumeMounts`, after the session dir mount, add conditional
credentials mount block from `4963744^`:
```ts
const credStagingPath = path.join(
  DATA_DIR, 'credentials', group.folder, '.credentials.json',
);
if (fs.existsSync(credStagingPath)) {
  mounts.push({
    hostPath: credStagingPath,
    containerPath: '/home/node/.claude/.credentials.json',
    readonly: true,
  });
}
```

**4c.** In `buildContainerArgs`, wrap the `ANTHROPIC_BASE_URL` and
`ANTHROPIC_API_KEY=placeholder` envs in a mode conditional:
```ts
const authMode = detectAuthMode();
if (authMode === 'api-key') {
  args.push('-e', `ANTHROPIC_BASE_URL=...`);
  args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
}
```
OAuth mode: no env vars set — SDK uses mounted credentials file natively.
Keep the MCP env-vars loop untouched.

**4d.** In `runContainerAgent`, before `buildVolumeMounts`, stage fresh
credentials when in OAuth mode:
```ts
if (detectAuthMode() === 'oauth') {
  const stagedCredPath = path.join(
    DATA_DIR, 'credentials', group.folder, '.credentials.json',
  );
  try {
    await copyFreshCredentials(stagedCredPath);
  } catch (err) {
    logger.error({ err, group: group.name }, 'Failed to stage OAuth credentials');
  }
}
```
Keep all the current MCP server resolution logic unchanged.

### 5. Restore `src/container-runner.test.ts` OAuth lines

Pull the 5 deleted test lines from `4963744^:src/container-runner.test.ts`
back into the current file. Likely a new test case verifying the credentials
mount path.

### 6. Update `.env.example`

Add comment above `ANTHROPIC_API_KEY`:
```
# Leave ANTHROPIC_API_KEY blank to use OAuth via ~/.claude/.credentials.json
# (required for Claude Max plan users to benefit from included quota).
```

### 7. Build + test

```
npm run build
npm test -- credential-proxy container-runner
```

Fix any type errors. Most likely suspects:
- `registeredGroups`/`channels`/`findChannel` name drift in `index.ts`
- `DATA_DIR` export still in `./config`
- `ContainerInput`/mount type compatibility

### 8. Commit

Single commit on `feat/oauth-apikey-dual`:
`feat: restore OAuth auth alongside API key support`

Body references the spec and explains the `ANTHROPIC_API_KEY`-gated selection.

## Deferred

- Changelog entry (will add after successful build).
- `/debug` skill update to surface auth mode — low priority, file a follow-up
  if user wants it.
