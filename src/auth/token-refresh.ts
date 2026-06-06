/**
 * Token Refresh
 * Auto-refreshes Kiro SSO access tokens. Two flows: social and IdC.
 */
import * as https from 'https';
import * as crypto from 'crypto';
import { KiroSSOToken, RefreshResult } from './types';
import { resolveMachineId } from '../utils/machine-id';
import { KIRO_VERSION, AWS_SDK_VERSION, NODE_VERSION, systemVersion } from '../utils/kiro-config';

const DEFAULT_AUTH_REGION = 'us-east-1';
const EXPIRED_BUFFER_MS = 5 * 60 * 1000;
const EXPIRING_SOON_BUFFER_MS = 10 * 60 * 1000;

export class RefreshTokenExpiredError extends Error {
  constructor(message: string) { super(message); this.name = 'RefreshTokenExpiredError'; }
}

export class TokenRefreshError extends Error {
  constructor(message: string) { super(message); this.name = 'TokenRefreshError'; }
}

export function isTokenExpired(token: KiroSSOToken): boolean {
  const exp = new Date(token.expiresAt).getTime();
  if (Number.isNaN(exp)) return true;
  return exp - Date.now() <= EXPIRED_BUFFER_MS;
}

export function isTokenExpiringSoon(token: KiroSSOToken): boolean {
  const exp = new Date(token.expiresAt).getTime();
  if (Number.isNaN(exp)) return true;
  return exp - Date.now() <= EXPIRING_SOON_BUFFER_MS;
}

export function isIdcToken(token: KiroSSOToken): boolean {
  const method = (token.authMethod || '').toLowerCase();
  if (method === 'social') return false;
  if (method === 'idc' || method === 'builder-id' || method === 'iam') {
    return !!(token.clientId && token.clientSecret);
  }
  return !!(token.clientId && token.clientSecret);
}

export function resolveAuthRegion(token: KiroSSOToken): string {
  if (token.authRegion && token.authRegion.trim()) return token.authRegion.trim();
  if (token.region && token.region.trim()) return token.region.trim();
  return DEFAULT_AUTH_REGION;
}

function postJson(url: string, headers: Record<string, string>, body: string, timeoutMs = 15000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', (err) => reject(new TokenRefreshError('Refresh request failed: ' + err.message)));
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new TokenRefreshError('Refresh request timed out')); });
    req.write(body);
    req.end();
  });
}

function isInvalidGrant(status: number, body: string): boolean {
  if (status !== 400) return false;
  const lower = body.toLowerCase();
  return lower.includes('invalid_grant') || lower.includes('invalid refresh token');
}

function computeExpiresAt(expiresIn?: number): string {
  const seconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export async function refreshSocialToken(token: KiroSSOToken): Promise<RefreshResult> {
  if (!token.refreshToken) {
    throw new RefreshTokenExpiredError('No refreshToken present — user must re-login to Kiro IDE.');
  }
  const authRegion = resolveAuthRegion(token);
  const host = 'prod.' + authRegion + '.auth.desktop.kiro.dev';
  const url = 'https://' + host + '/refreshToken';
  const machineId = resolveMachineId({ seed: token.refreshToken });
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': 'KiroIDE-' + KIRO_VERSION + '-' + machineId,
    'Accept-Encoding': 'gzip, deflate, br',
    host,
  };
  const body = JSON.stringify({ refreshToken: token.refreshToken });
  const res = await postJson(url, headers, body);

  if (isInvalidGrant(res.status, res.body)) {
    throw new RefreshTokenExpiredError('Refresh token rejected (invalid_grant) — user must re-login to Kiro IDE.');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new TokenRefreshError('Social refresh failed (HTTP ' + res.status + '): ' + res.body.substring(0, 300));
  }
  const parsed = JSON.parse(res.body);
  if (!parsed.accessToken) throw new TokenRefreshError('Social refresh response missing accessToken');
  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken || token.refreshToken,
    profileArn: parsed.profileArn || token.profileArn,
    expiresAt: computeExpiresAt(parsed.expiresIn),
  };
}

export async function refreshIdcToken(token: KiroSSOToken): Promise<RefreshResult> {
  if (!token.refreshToken) {
    throw new RefreshTokenExpiredError('No refreshToken present — user must re-login to Kiro IDE.');
  }
  if (!token.clientId || !token.clientSecret) {
    throw new TokenRefreshError('IdC refresh requires clientId + clientSecret (not found in cache).');
  }
  const authRegion = resolveAuthRegion(token);
  const host = 'oidc.' + authRegion + '.amazonaws.com';
  const url = 'https://' + host + '/token';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-amz-user-agent': 'aws-sdk-js/' + AWS_SDK_VERSION + ' KiroIDE',
    'user-agent': 'aws-sdk-js/' + AWS_SDK_VERSION + ' ua/2.1 os/' + systemVersion() + ' lang/js md/nodejs#' + NODE_VERSION + ' api/sso-oidc#' + AWS_SDK_VERSION + ' m/E KiroIDE',
    host,
    'amz-sdk-invocation-id': crypto.randomUUID(),
    'amz-sdk-request': 'attempt=1; max=4',
  };
  const body = JSON.stringify({
    clientId: token.clientId,
    clientSecret: token.clientSecret,
    refreshToken: token.refreshToken,
    grantType: 'refresh_token',
  });
  const res = await postJson(url, headers, body);

  if (isInvalidGrant(res.status, res.body)) {
    throw new RefreshTokenExpiredError('Refresh token rejected (invalid_grant) — user must re-login to Kiro IDE.');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new TokenRefreshError('IdC refresh failed (HTTP ' + res.status + '): ' + res.body.substring(0, 300));
  }
  const parsed = JSON.parse(res.body);
  if (!parsed.accessToken) throw new TokenRefreshError('IdC refresh response missing accessToken');
  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken || token.refreshToken,
    profileArn: parsed.profileArn || token.profileArn,
    expiresAt: computeExpiresAt(parsed.expiresIn),
  };
}

export async function refreshToken(token: KiroSSOToken): Promise<RefreshResult> {
  if (isIdcToken(token)) return refreshIdcToken(token);
  return refreshSocialToken(token);
}
