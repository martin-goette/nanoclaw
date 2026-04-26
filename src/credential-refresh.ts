/**
 * Host-side OAuth credential refresher.
 *
 * Containers bind-mount `~/.claude/.credentials.json` rw. The Anthropic Agent
 * SDK can refresh tokens on its own, but a single-file Docker bind-mount
 * pins the host inode at mount time — atomic-rename writes (write tmp +
 * rename) inside the container don't propagate back to the host file, and
 * subsequent containers mount the stale prior inode.
 *
 * This module runs a host-side proactive refresh: every 4 minutes it
 * checks expiry and, if within the buffer, exchanges the refresh token and
 * writes the new credentials back to `~/.claude/.credentials.json`
 * **in-place** (truncate + write, preserving the inode). Live containers
 * see the update through the bind-mount; new containers mount the same
 * (now-fresh) host file.
 *
 * Ported from v1 src/credential-proxy.ts (refresh helpers + in-place
 * write pattern). v2 doesn't run a credential proxy — containers go
 * direct to api.anthropic.com using the mounted file — so this module
 * only handles refresh + write-back, not request proxying.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';

import { log } from './log.js';

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PROACTIVE_BUFFER_MS = 3 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 4 * 60 * 1000;

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

class OAuthRefreshError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.code = code;
  }
}

function credentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function readCredentials(p: string): OAuthCredentials {
  const raw = fs.readFileSync(p, 'utf-8');
  const data = JSON.parse(raw);
  const oauth = data.claudeAiOauth;
  if (!oauth || !oauth.accessToken || !oauth.refreshToken || typeof oauth.expiresAt !== 'number') {
    throw new Error('credentials file missing or incomplete claudeAiOauth fields');
  }
  return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt };
}

async function refreshOAuthToken(refreshToken: string): Promise<OAuthCredentials> {
  const url = new URL(REFRESH_URL);
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
          const responseBody = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            let code = 'unknown';
            try {
              code = JSON.parse(responseBody).error || code;
            } catch {
              /* default */
            }
            reject(new OAuthRefreshError(`OAuth refresh failed (${res.statusCode}): ${responseBody}`, code));
            return;
          }
          try {
            const json = JSON.parse(responseBody);
            if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
              reject(new Error(`OAuth refresh response missing required fields: ${responseBody}`));
              return;
            }
            resolve({
              accessToken: json.access_token,
              refreshToken: json.refresh_token,
              expiresAt: Date.now() + json.expires_in * 1000,
            });
          } catch (err) {
            reject(new Error(`OAuth refresh response parse error: ${(err as Error).message}`));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`OAuth refresh timed out after ${REFRESH_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let refreshInProgress: Promise<OAuthCredentials> | null = null;

async function ensureValidToken(p: string, bufferMs = REFRESH_BUFFER_MS, maxRetries = 3): Promise<OAuthCredentials> {
  const creds = readCredentials(p);
  if (creds.expiresAt - Date.now() > bufferMs) return creds;
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = (async () => {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const fresh = readCredentials(p);
        if (fresh.expiresAt - Date.now() > bufferMs) {
          log.info('OAuth token refreshed externally, using disk credentials');
          return fresh;
        }
        const refreshed = await refreshOAuthToken(fresh.refreshToken);
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        raw.claudeAiOauth = {
          ...raw.claudeAiOauth,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        };
        // In-place write (truncate + write) preserves inode so Docker
        // single-file bind-mounts in running containers see the update.
        const fd = fs.openSync(p, 'w', 0o600);
        try {
          fs.writeSync(fd, JSON.stringify(raw, null, 2));
        } finally {
          fs.closeSync(fd);
        }
        log.info('OAuth token refreshed', { expiresAt: new Date(refreshed.expiresAt).toISOString() });
        return refreshed;
      } catch (err) {
        lastError = err as Error;
        log.warn('OAuth refresh attempt failed', { err: lastError.message, attempt, maxRetries });
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error(`OAuth refresh failed after ${maxRetries} attempts: ${lastError?.message}`);
  })();

  try {
    return await refreshInProgress;
  } finally {
    refreshInProgress = null;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let authDead = false;

export function startCredentialRefresher(): void {
  const p = credentialsPath();
  if (!fs.existsSync(p)) {
    log.warn('Credential refresher disabled — file missing', { path: p });
    return;
  }

  const tick = async () => {
    if (authDead) {
      try {
        const creds = readCredentials(p);
        if (creds.expiresAt - Date.now() > 30 * 60 * 1000) {
          authDead = false;
          log.info('OAuth credentials recovered after re-login');
        }
      } catch {
        /* still dead */
      }
      return;
    }
    try {
      await ensureValidToken(p, PROACTIVE_BUFFER_MS);
    } catch (err) {
      const msg = (err as Error).message;
      log.error('Periodic OAuth refresh failed', { err: msg });
      if (err instanceof OAuthRefreshError && err.code === 'invalid_grant') {
        authDead = true;
        log.error('OAuth refresh token is permanently invalid. Run `claude` on the host to re-login.');
      }
    }
  };

  // Kick once on startup, then on interval.
  void tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();
  log.info('Credential refresher started', { intervalMs: POLL_INTERVAL_MS, bufferMs: PROACTIVE_BUFFER_MS });
}

export function stopCredentialRefresher(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
