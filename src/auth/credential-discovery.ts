/**
 * Credential Discovery
 * Auto-discover Kiro SSO token from filesystem.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KiroSSOToken } from './types';

let cachedDiscoveredPath: string | null = null;

function getDefaultKiroTokenPath(): string {
  return path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
}

function candidateTokenDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.aws', 'sso', 'cache'),
    path.join(home, '.kiro', 'cache'),
    path.join(home, '.kiro'),
  ];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appData, 'Kiro', 'User', 'globalStorage'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage'));
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    dirs.push(path.join(cfg, 'Kiro', 'User', 'globalStorage'));
  }
  return dirs;
}

function looksLikeKiroToken(obj: Record<string, unknown>): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.accessToken !== 'string' || !obj.accessToken) return false;
  if (!obj.expiresAt) return false;
  const startUrl = typeof obj.startUrl === 'string' ? obj.startUrl.toLowerCase() : '';
  return (
    typeof obj.refreshToken === 'string' ||
    obj.authMethod !== undefined ||
    obj.clientIdHash !== undefined ||
    startUrl.includes('kiro') ||
    obj.provider !== undefined
  );
}

function tokenScore(obj: Record<string, unknown>): number {
  let score = 0;
  const exp = new Date(obj.expiresAt as string).getTime();
  if (!Number.isNaN(exp)) {
    if (exp > Date.now()) score += 1_000_000_000_000;
    score += Math.floor(exp / 1000);
  }
  if (typeof obj.refreshToken === 'string' && (obj.refreshToken as string).length > 0)
    score += 500_000_000_000;
  return score;
}

export function discoverKiroTokenPath(opts?: { forceRescan?: boolean }): string | null {
  if (opts?.forceRescan) cachedDiscoveredPath = null;
  if (cachedDiscoveredPath) return cachedDiscoveredPath;

  // 1. explicit env override
  const envPath = process.env.KIRO_AUTH_TOKEN_PATH;
  if (envPath && envPath.trim().length > 0) {
    const p = envPath.trim();
    if (fs.existsSync(p)) {
      cachedDiscoveredPath = p;
      console.error(`[kiro-gateway] Using KIRO_AUTH_TOKEN_PATH override: ${p}`);
      return p;
    }
    console.error(`[kiro-gateway] KIRO_AUTH_TOKEN_PATH set but file not found: ${p}`);
  }

  // 2. default well-known path
  const defaultPath = getDefaultKiroTokenPath();
  if (fs.existsSync(defaultPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
      if (looksLikeKiroToken(parsed)) {
        cachedDiscoveredPath = defaultPath;
        console.error(`[kiro-gateway] Discovered Kiro credential at default path: ${defaultPath}`);
        return defaultPath;
      }
    } catch { /* fall through */ }
  }

  // 3. scan candidate directories
  let best: { path: string; score: number } | null = null;
  for (const dir of candidateTokenDirs()) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const full = path.join(dir, file);
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
          if (!looksLikeKiroToken(parsed)) continue;
          const score = tokenScore(parsed);
          if (!best || score > best.score) best = { path: full, score };
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  if (best) {
    cachedDiscoveredPath = best.path;
    console.error(`[kiro-gateway] Discovered Kiro credential by scan: ${best.path}`);
    return best.path;
  }
  return null;
}

export function readTokenFromPath(tokenPath: string): KiroSSOToken | null {
  try {
    if (!fs.existsSync(tokenPath)) return null;
    const content = fs.readFileSync(tokenPath, 'utf-8');
    const token = JSON.parse(content) as KiroSSOToken;
    if (!token.accessToken || !token.expiresAt) return null;
    enrichWithClientCredentials(token, tokenPath);
    return token;
  } catch (err: any) {
    console.error('[kiro-gateway] Failed to read Kiro SSO token:', err.message);
    return null;
  }
}

function enrichWithClientCredentials(token: KiroSSOToken, tokenPath: string): void {
  if (token.clientId && token.clientSecret) return;
  if (!token.clientIdHash) return;
  try {
    const dir = path.dirname(tokenPath);
    const clientFile = path.join(dir, `${token.clientIdHash}.json`);
    if (fs.existsSync(clientFile)) {
      const parsed = JSON.parse(fs.readFileSync(clientFile, 'utf-8'));
      if (parsed.clientId) token.clientId = parsed.clientId;
      if (parsed.clientSecret) token.clientSecret = parsed.clientSecret;
    }
  } catch { /* best effort */ }
}

export function writeBackToken(updated: { accessToken: string; refreshToken?: string; expiresAt: string; profileArn?: string }, tokenPath: string): void {
  try {
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(tokenPath)) {
      try { existing = JSON.parse(fs.readFileSync(tokenPath, 'utf-8')); } catch { existing = {}; }
    }
    existing.accessToken = updated.accessToken;
    if (updated.refreshToken) existing.refreshToken = updated.refreshToken;
    existing.expiresAt = updated.expiresAt;
    if (updated.profileArn) existing.profileArn = updated.profileArn;
    fs.writeFileSync(tokenPath, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
    console.error(`[kiro-gateway] Wrote refreshed token back to ${tokenPath}`);
  } catch (err: any) {
    console.error('[kiro-gateway] Failed to write back refreshed token:', err.message);
  }
}
