import crypto from 'node:crypto';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Master key resolution — single source of truth for the file/env fallback
// chain used by both database management and user settings.
// ---------------------------------------------------------------------------

function readMasterSecret(): string | undefined {
  const envSecret = process.env.DOCKYARD_DATABASE_MASTER_KEY?.trim();
  if (envSecret) return envSecret;

  const secretFile = process.env.DOCKYARD_DATABASE_MASTER_KEY_FILE
    || '/run/secrets/dockyard_database_master_key';
  try {
    const fileSecret = fs.readFileSync(secretFile, 'utf8').trim();
    return fileSecret || undefined;
  } catch {
    return undefined;
  }
}

function resolveMasterKey(): Buffer {
  const secret = readMasterSecret();
  if (!secret?.trim()) throw new Error('DOCKYARD_DATABASE_MASTER_KEY not available.');
  return crypto.createHash('sha256').update(secret).digest();
}

// ---------------------------------------------------------------------------
// AES-256-GCM encrypt / decrypt
// ---------------------------------------------------------------------------

export function encryptValue(plaintext: string): string {
  const key = resolveMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

export function decryptValue(payload: string): string {
  const key = resolveMasterKey();
  const parsed = JSON.parse(payload) as { iv: string; tag: string; ciphertext: string };
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
