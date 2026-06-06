/**
 * Gateway Key
 * Stable sk-kiro-... API key persisted to disk.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const GATEWAY_KEY_FILE = 'kiro-ts-gateway-key';
let gatewayApiKey: string | null = null;

function getGatewayKeyPath(): string {
  return path.join(os.homedir(), '.aws', 'sso', 'cache', GATEWAY_KEY_FILE);
}

export function getGatewayApiKey(): string {
  if (gatewayApiKey) return gatewayApiKey;

  // 1. Environment override
  const envKey = process.env.KIRO_GATEWAY_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    gatewayApiKey = envKey.trim();
    return gatewayApiKey;
  }

  // 2. Persisted key
  const keyPath = getGatewayKeyPath();
  try {
    if (fs.existsSync(keyPath)) {
      const persisted = fs.readFileSync(keyPath, 'utf-8').trim();
      if (persisted.length > 0) {
        gatewayApiKey = persisted;
        return gatewayApiKey;
      }
    }
  } catch (err: any) {
    console.error('[kiro-gateway] Failed to read persisted gateway key:', err.message);
  }

  // 3. Generate + persist
  gatewayApiKey = `sk-kiro-${crypto.randomBytes(24).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, gatewayApiKey, { encoding: 'utf-8', mode: 0o600 });
    console.error(`[kiro-gateway] Generated new stable gateway API key (persisted to ${keyPath})`);
  } catch (err: any) {
    console.error('[kiro-gateway] Failed to persist gateway key (using in-memory only):', err.message);
  }
  return gatewayApiKey;
}
