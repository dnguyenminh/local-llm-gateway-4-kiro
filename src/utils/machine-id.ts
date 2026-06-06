/**
 * Machine ID Generator
 * Generates/persists a stable 64-hex-char machineId for KiroIDE User-Agent headers.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const MACHINE_ID_FILE = 'kiro-ts-machine-id';

/**
 * Normalize a machineId into the canonical 64-hex-char form.
 */
export function normalizeMachineId(machineId: string | null | undefined): string | null {
  if (!machineId) return null;
  const trimmed = machineId.trim();
  if (trimmed.length === 64 && /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const withoutDashes = trimmed.replace(/-/g, '');
  if (withoutDashes.length === 32 && /^[0-9a-fA-F]{32}$/.test(withoutDashes)) {
    const lower = withoutDashes.toLowerCase();
    return `${lower}${lower}`;
  }
  return null;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Derive a stable machineId from a seed string (e.g. refresh token).
 */
export function deriveMachineId(seed: string, prefix = 'KotlinNativeAPI'): string {
  return sha256Hex(`${prefix}/${seed}`);
}

function getMachineIdPath(): string {
  return path.join(os.homedir(), '.aws', 'sso', 'cache', MACHINE_ID_FILE);
}

function getOrCreatePersistedMachineId(): string {
  const filePath = getMachineIdPath();
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      const normalized = normalizeMachineId(content);
      if (normalized) return normalized;
    }
  } catch {
    // ignore read errors
  }
  const seed = crypto.randomUUID();
  const derived = sha256Hex(`KiroFallback/${seed}`);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, derived, 'utf-8');
  } catch {
    // Non-fatal
  }
  return derived;
}

/**
 * Resolve the machineId to use for Kiro IDE headers.
 */
export function resolveMachineId(opts?: { explicit?: string | null; seed?: string | null }): string {
  const explicit = normalizeMachineId(opts?.explicit);
  if (explicit) return explicit;
  if (opts?.seed && opts.seed.length > 0) {
    return deriveMachineId(opts.seed);
  }
  return getOrCreatePersistedMachineId();
}
