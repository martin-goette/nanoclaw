/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { readEnvFile } from './env.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
// Anthropic Claude CLI OAuth client ID
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const RECOVERY_FRESHNESS_MS = 30 * 60 * 1000; // 30 minutes — refresh well before expiry

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class OAuthRefreshError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.code = code;
  }
}

/** Path to the shared CLI/NanoClaw credentials file. */
export function credentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

export function readCredentials(credentialsPath: string): OAuthCredentials {
  const raw = fs.readFileSync(credentialsPath, 'utf-8');
  const data = JSON.parse(raw);
  const oauth = data.claudeAiOauth;
  if (!oauth) {
    throw new Error(
      'credentials file missing claudeAiOauth — run "claude" to authenticate',
    );
  }
  if (
    !oauth.accessToken ||
    !oauth.refreshToken ||
    typeof oauth.expiresAt !== 'number'
  ) {
    throw new Error(
      'credentials file has incomplete claudeAiOauth fields (need accessToken, refreshToken, expiresAt)',
    );
  }
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
  };
}

const REFRESH_TIMEOUT_MS = 30_000; // 30 seconds

export async function refreshOAuthToken(
  refreshToken: string,
  tokenUrl = REFRESH_URL,
): Promise<OAuthCredentials> {
  const url = new URL(tokenUrl);
  const isHttps = url.protocol === 'https:';
  const makeReq = isHttps ? httpsRequest : httpRequest;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = makeReq(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        timeout: REFRESH_TIMEOUT_MS,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const responseBody = Buffer.concat(chunks).toString();
            if (res.statusCode !== 200) {
              let code = 'unknown';
              try {
                code = JSON.parse(responseBody).error || code;
              } catch {
                /* use default */
              }
              reject(
                new OAuthRefreshError(
                  `OAuth refresh failed (${res.statusCode}): ${responseBody}`,
                  code,
                ),
              );
              return;
            }
            const json = JSON.parse(responseBody);
            if (
              !json.access_token ||
              !json.refresh_token ||
              typeof json.expires_in !== 'number'
            ) {
              reject(
                new Error(
                  `OAuth refresh response missing required fields: ${responseBody}`,
                ),
              );
              return;
            }
            resolve({
              accessToken: json.access_token,
              refreshToken: json.refresh_token,
              expiresAt: Date.now() + json.expires_in * 1000,
            });
          } catch (err) {
            reject(
              new Error(
                `OAuth refresh response parse error: ${(err as Error).message}`,
              ),
            );
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(
        new Error(`OAuth refresh timed out after ${REFRESH_TIMEOUT_MS}ms`),
      );
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Serialize concurrent refresh attempts (refresh tokens are single-use)
let refreshInProgress: Promise<OAuthCredentials> | null = null;

export async function ensureValidToken(
  credentialsPath: string,
  tokenUrl = REFRESH_URL,
  maxRetries = 3,
  bufferMs = REFRESH_BUFFER_MS,
): Promise<OAuthCredentials> {
  // Initial check only — retries re-read via freshCreds inside the loop.
  const creds = readCredentials(credentialsPath);

  // Token still valid (outside buffer)
  const minutesRemaining = Math.round((creds.expiresAt - Date.now()) / 60000);
  if (creds.expiresAt - Date.now() > bufferMs) {
    logger.info({ minutesRemaining }, 'OAuth token valid');
    return creds;
  }

  // If another call is already refreshing, wait for it
  if (refreshInProgress) {
    return refreshInProgress;
  }

  logger.info(
    { minutesRemaining },
    bufferMs === Infinity
      ? 'Proactive OAuth refresh'
      : 'OAuth token expiring soon, refreshing...',
  );

  refreshInProgress = (async () => {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Re-read credentials from disk before each attempt — an external
        // process (e.g. `claude` CLI login) may have refreshed the token.
        const freshCreds = readCredentials(credentialsPath);
        const now = Date.now();
        if (freshCreds.expiresAt - now > bufferMs) {
          const freshMinutes = Math.round((freshCreds.expiresAt - now) / 60000);
          logger.info(
            { minutesRemaining: freshMinutes },
            'OAuth token refreshed externally, using disk credentials',
          );
          return freshCreds;
        }

        const refreshed = await refreshOAuthToken(
          freshCreds.refreshToken,
          tokenUrl,
        );

        // Write back to credentials file, preserving other fields.
        // Use atomic write (temp + rename) so a crash mid-write can't
        // leave a truncated file that breaks the refresh token chain.
        const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
        raw.claudeAiOauth = {
          ...raw.claudeAiOauth,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        };
        const tmpPath = credentialsPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2), {
          mode: 0o600,
        });
        fs.renameSync(tmpPath, credentialsPath);

        logger.info('OAuth token refreshed successfully');
        return refreshed;
      } catch (err) {
        lastError = err as Error;
        logger.warn(
          { err: lastError.message, attempt, maxRetries },
          'OAuth refresh attempt failed',
        );
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    // Final check: maybe an external process refreshed while we were retrying
    try {
      const finalCreds = readCredentials(credentialsPath);
      if (finalCreds.expiresAt - Date.now() > bufferMs) {
        logger.info('OAuth token refreshed externally after retries exhausted');
        return finalCreds;
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'Final credential read failed',
      );
    }

    throw new Error(
      `OAuth refresh failed after ${maxRetries} attempts: ${lastError?.message}`,
    );
  })();

  try {
    return await refreshInProgress;
  } finally {
    refreshInProgress = null;
  }
}

// Refresh when token has < 3 hours remaining (~halfway through the ~8h lifetime).
const PROACTIVE_BUFFER_MS = 3 * 60 * 60 * 1000;

/**
 * Proactive refresh — refreshes the token well before expiry so the agent
 * doesn't hit an expired token mid-conversation.
 */
export async function proactiveRefresh(
  credentialsPath: string,
  tokenUrl = REFRESH_URL,
): Promise<OAuthCredentials> {
  return ensureValidToken(credentialsPath, tokenUrl, 3, PROACTIVE_BUFFER_MS);
}

/**
 * Update all staged container credential files with the latest token.
 * Called after proactive refresh so running containers don't hold stale tokens.
 */
function updateStagedCredentials(credentialsPath: string): void {
  const credDir = path.join(DATA_DIR, 'credentials');
  let groups: string[];
  try {
    groups = fs.readdirSync(credDir);
  } catch {
    return; // no credentials dir yet
  }
  const source = fs.readFileSync(credentialsPath, 'utf-8');
  for (const group of groups) {
    const staged = path.join(credDir, group, '.credentials.json');
    try {
      if (fs.existsSync(staged)) {
        // Write in-place (truncate + write) instead of atomic rename.
        // Docker bind-mounts bind to the inode; rename() creates a new
        // inode so the container still sees the stale file.  In-place
        // write preserves the inode so running containers see the update.
        const fd = fs.openSync(staged, 'w', 0o600);
        fs.writeSync(fd, source);
        fs.closeSync(fd);
      }
    } catch (err) {
      logger.warn({ err, group }, 'Failed to update staged credentials');
    }
  }
  logger.info({ count: groups.length }, 'Updated staged container credentials');
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export async function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  credsPath = credentialsPath(),
  onAuthFailure?: (message: string) => void,
): Promise<Server> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  let currentToken: string | undefined;
  if (authMode === 'oauth') {
    const creds = await ensureValidToken(credsPath);
    currentToken = creds.accessToken;
  }

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  if (authMode === 'oauth') {
    let authDead = false;
    const refreshInterval = async () => {
      // If auth was dead, check if user re-logged in via CLI.
      // Since we share the credentials file, a fresh CLI login
      // is immediately visible — no bootstrap/copy needed.
      if (authDead) {
        try {
          const creds = readCredentials(credsPath);
          if (creds.expiresAt - Date.now() > RECOVERY_FRESHNESS_MS) {
            authDead = false;
            currentToken = creds.accessToken;
            updateStagedCredentials(credsPath);
            logger.info('OAuth credentials recovered after re-login');
            return;
          }
        } catch {
          /* still dead */
        }
        return;
      }
      try {
        const refreshed = await proactiveRefresh(credsPath);
        currentToken = refreshed.accessToken;
        updateStagedCredentials(credsPath);
      } catch (err) {
        const msg = (err as Error).message;
        logger.error(
          { err: msg },
          'Periodic OAuth refresh failed — clearing token to prevent stale 401s',
        );
        currentToken = undefined;

        // invalid_grant means the refresh token is permanently dead —
        // stop retrying and alert the owner to re-login
        if (err instanceof OAuthRefreshError && err.code === 'invalid_grant') {
          authDead = true;
          logger.error(
            'OAuth refresh token is permanently invalid. Stopping refresh timer. Run `claude` to re-login.',
          );
          if (onAuthFailure) {
            onAuthFailure(
              "⚠️ OAuth session expired — I can't process messages until you re-login. Run `claude` on the host to fix this.",
            );
          }
        }
      }
    };
    refreshTimer = setInterval(refreshInterval, 4 * 60 * 1000);
    refreshTimer.unref();
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (currentToken) {
              headers['authorization'] = `Bearer ${currentToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.on('close', () => {
      if (refreshTimer) clearInterval(refreshTimer);
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

/**
 * Copy fresh OAuth credentials to a staging path for container use.
 * Ensures the token is refreshed before copying.
 * Returns true if credentials were staged, false if not in OAuth mode.
 */
export async function copyFreshCredentials(
  targetPath: string,
  credsPath = credentialsPath(),
): Promise<boolean> {
  const creds = await ensureValidToken(credsPath);

  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  // Read the full credentials file to preserve all fields
  const raw = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  fs.writeFileSync(targetPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
  return true;
}
