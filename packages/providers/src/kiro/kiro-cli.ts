/**
 * Read the Kiro bearer access token from the local kiro-cli SQLite store, so
 * users who are logged in via kiro-cli don't have to paste a token. Mirrors
 * the standalone pi-provider-kiro behaviour but trimmed to what WrongStack
 * needs: read the IDC (or social) token, and refresh via the kiro-cli binary
 * when it has expired.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export interface KiroCliToken {
  accessToken: string;
  region: string;
  profileArn?: string;
}

function dbPath(): string | undefined {
  const p = platform();
  let path: string;
  if (p === 'win32')
    path = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'kiro-cli', 'data.sqlite3');
  else if (p === 'darwin') path = join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  else path = join(homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3');
  return existsSync(path) ? path : undefined;
}

function query(path: string, key: string): string | undefined {
  try {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key) as
        | { value?: string }
        | undefined;
      return row?.value;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function readToken(path: string, allowExpired: boolean): KiroCliToken | undefined {
  for (const key of ['kirocli:odic:token', 'kirocli:social:token']) {
    const raw = query(path, key);
    if (!raw) continue;
    try {
      const d = JSON.parse(raw);
      if (!d.access_token) continue;
      const expiresAt = d.expires_at ? new Date(d.expires_at).getTime() : Date.now() + 3_600_000;
      if (!allowExpired && Date.now() >= expiresAt - 2 * 60 * 1000) continue;
      return {
        accessToken: d.access_token,
        region: d.region || 'us-east-1',
        profileArn: d.profile_arn || d.profileArn,
      };
    } catch {
      /* try next key */
    }
  }
  return undefined;
}

/**
 * Resolve a usable kiro-cli token: a fresh one if present, otherwise ask
 * `kiro-cli debug refresh-auth-token` to rotate it and re-read. Returns
 * undefined when kiro-cli isn't installed/logged-in.
 */
export function getKiroCliToken(): KiroCliToken | undefined {
  const path = dbPath();
  if (!path) return undefined;
  const fresh = readToken(path, false);
  if (fresh) return fresh;
  // Token missing or expired — try a refresh via the kiro-cli binary.
  try {
    execFileSync('kiro-cli', ['debug', 'refresh-auth-token'], {
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
  return readToken(path, false) ?? readToken(path, true);
}
