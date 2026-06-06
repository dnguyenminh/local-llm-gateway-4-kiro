/**
 * Credential Discovery Extension
 * High-level auth functions: resolveAuth, ensureFreshKiroToken, API region auto-detect.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dns from 'dns';
import { KiroSSOToken, AuthResult, KiroAuthResult } from './types';
import { getGatewayApiKey } from './gateway-key';
import { discoverKiroTokenPath, readTokenFromPath, writeBackToken } from './credential-discovery';
import { isTokenExpired, isTokenExpiringSoon, refreshToken, RefreshTokenExpiredError } from './token-refresh';

let kiroToken: KiroSSOToken | null = null;
let discoveredTokenPath: string | null = null;
let cachedApiRegion: string | null = null;
let inFlightRefresh: Promise<KiroSSOToken | null> | null = null;

const KNOWN_API_REGIONS = ['us-east-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1', 'us-west-2'];
const DEFAULT_API_REGION = 'us-east-1';
const PROBE_TIMEOUT_MS = 2000;
const API_REGION_CACHE_FILE = 'kiro-ts-api-region';

function isRealAnthropicKey(key: string): boolean { return key.startsWith('sk-ant-'); }

function readKiroSSOToken(): KiroSSOToken | null {
  const tokenPath = discoverKiroTokenPath();
  if (!tokenPath) return null;
  discoveredTokenPath = tokenPath;
  return readTokenFromPath(tokenPath);
}

export function resolveAuth(apiKeyHeader?: string): AuthResult {
  const gatewayKey = getGatewayApiKey();
  const headerKey = (apiKeyHeader || '').trim();

  if (!kiroToken || isTokenExpired(kiroToken)) {
    kiroToken = readKiroSSOToken();
  }
  if (kiroToken && !isTokenExpired(kiroToken)) {
    if (headerKey.length > 0 && isRealAnthropicKey(headerKey)) return { mode: 'api_key', apiKey: headerKey };
    if (headerKey.length > 0 && headerKey !== gatewayKey)
      console.error('[kiro-gateway] x-api-key does not match gateway key — serving Kiro mode anyway');
    return buildKiroAuthResult(kiroToken);
  }
  if (headerKey.length > 0) return { mode: 'api_key', apiKey: headerKey };
  return { mode: 'api_key', apiKey: 'local-trusted' };
}

export function buildKiroAuthResult(token: KiroSSOToken): KiroAuthResult {
  return {
    mode: 'kiro',
    credentials: { accessKeyId: '', secretAccessKey: '', sessionToken: token.accessToken, expiration: new Date(token.expiresAt) },
    region: token.region || 'us-east-1',
    apiRegion: resolveApiRegion(token),
    bearerToken: token.accessToken,
    refreshToken: token.refreshToken,
    profileArn: resolveProfileArn(token),
  };
}

export function hasValidCredentials(): boolean {
  if (!kiroToken) kiroToken = readKiroSSOToken();
  return kiroToken !== null && !isTokenExpired(kiroToken);
}

export async function ensureFreshKiroToken(): Promise<KiroSSOToken | null> {
  if (!kiroToken) kiroToken = readKiroSSOToken();
  if (!kiroToken) { discoverKiroTokenPath({ forceRescan: true }); kiroToken = readKiroSSOToken(); }
  if (!kiroToken) return null;
  if (!isTokenExpired(kiroToken) && !isTokenExpiringSoon(kiroToken)) return kiroToken;
  if (!kiroToken.refreshToken) {
    if (isTokenExpired(kiroToken)) throw new RefreshTokenExpiredError('Kiro token expired and no refreshToken present — please re-login to Kiro IDE.');
    return kiroToken;
  }
  if (inFlightRefresh) return inFlightRefresh;
  const tokenToRefresh = kiroToken;
  inFlightRefresh = (async () => {
    try {
      console.error(`[kiro-gateway] Refreshing Kiro token (authMethod: ${tokenToRefresh.authMethod || 'social'})...`);
      const result = await refreshToken(tokenToRefresh);
      const updated: KiroSSOToken = { ...tokenToRefresh, accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt };
      if (result.profileArn) updated.profileArn = result.profileArn;
      kiroToken = updated;
      if (discoveredTokenPath) writeBackToken(result, discoveredTokenPath);
      console.error(`[kiro-gateway] Token refreshed successfully (new expiry: ${result.expiresAt})`);
      return updated;
    } finally { inFlightRefresh = null; }
  })();
  return inFlightRefresh;
}

// --- API Region ---
function getApiRegionCachePath(): string { return path.join(os.homedir(), '.aws', 'sso', 'cache', API_REGION_CACHE_FILE); }
function readPersistedApiRegion(): string | null { try { const p = getApiRegionCachePath(); if (!fs.existsSync(p)) return null; const r = fs.readFileSync(p, 'utf-8').trim(); return r || null; } catch { return null; } }
function persistApiRegion(region: string): void { try { fs.writeFileSync(getApiRegionCachePath(), region, 'utf-8'); } catch {} }

export function invalidateApiRegionCache(): void {
  cachedApiRegion = null;
  try { const p = getApiRegionCachePath(); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function explicitApiRegion(token?: KiroSSOToken | null): string | null {
  if (token?.apiRegion?.trim()) return token.apiRegion.trim();
  const envRegion = process.env.KIRO_API_REGION;
  if (envRegion?.trim()) return envRegion.trim();
  return null;
}

export function resolveApiRegion(token?: KiroSSOToken | null): string {
  const explicit = explicitApiRegion(token);
  if (explicit) return explicit;
  if (cachedApiRegion) return cachedApiRegion;
  const persisted = readPersistedApiRegion();
  if (persisted) { cachedApiRegion = persisted; return persisted; }
  return DEFAULT_API_REGION;
}

export async function resolveApiRegionAsync(token?: KiroSSOToken | null): Promise<string> {
  const explicit = explicitApiRegion(token);
  if (explicit) return explicit;
  if (cachedApiRegion) return cachedApiRegion;
  const persisted = readPersistedApiRegion();
  if (persisted) { cachedApiRegion = persisted; return persisted; }

  const candidates: string[] = [];
  const ssoRegion = (token ?? kiroToken)?.region?.trim();
  if (ssoRegion) candidates.push(ssoRegion);
  for (const r of KNOWN_API_REGIONS) if (!candidates.includes(r)) candidates.push(r);

  for (const region of candidates) {
    const host = `q.${region}.amazonaws.com`;
    const ok = await dnsResolves(host, PROBE_TIMEOUT_MS);
    if (ok) {
      console.error(`[kiro-gateway] API region auto-detected via DNS: ${region}`);
      cachedApiRegion = region; persistApiRegion(region); return region;
    }
  }
  cachedApiRegion = DEFAULT_API_REGION; return DEFAULT_API_REGION;
}

function dnsResolves(host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    dns.promises.lookup(host).then(() => { clearTimeout(timer); finish(true); }).catch(() => { clearTimeout(timer); finish(false); });
  });
}

function resolveProfileArn(token?: KiroSSOToken | null): string | undefined {
  const t = token ?? kiroToken;
  if (t?.profileArn?.startsWith('arn:aws:codewhisperer:')) return t.profileArn;
  const envArn = process.env.KIRO_PROFILE_ARN || process.env.AWS_CODEWHISPERER_PROFILE_ARN;
  if (envArn?.startsWith('arn:aws:codewhisperer:')) return envArn;
  try {
    const cacheDir = path.join(os.homedir(), '.aws', 'sso', 'cache');
    if (fs.existsSync(cacheDir)) {
      for (const file of fs.readdirSync(cacheDir)) {
        if (!file.endsWith('.json')) continue;
        try { const p = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf-8')); const arn = p?.profileArn || p?.profile_arn; if (typeof arn === 'string' && arn.startsWith('arn:aws:codewhisperer:')) return arn; } catch {}
      }
    }
  } catch {}
  return undefined;
}
