import crypto from 'node:crypto';
import * as db from '../db/apiKeys.js';
import { getUserById } from '../db.js';
import { HttpError } from './HttpError.js';

const KEY_PREFIX = 'dky_';

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export function list(userId: string) {
  return db.listApiKeysForUser(userId).map(({ key_hash: _keyHash, ...rest }) => rest);
}

export function create(userId: string, name: string) {
  if (!name?.trim()) throw new HttpError(400, 'A name is required.');
  const rawBytes = crypto.randomBytes(32).toString('base64url');
  const rawKey = KEY_PREFIX + rawBytes;
  const id = `key-${crypto.randomBytes(9).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  db.createApiKey(id, userId, name.trim(), hashKey(rawKey), rawKey.slice(0, 12), createdAt);
  return {
    id,
    name: name.trim(),
    key: rawKey,
    keyPrefix: rawKey.slice(0, 12),
    createdAt,
  };
}

export function revoke(userId: string, id: string) {
  if (!db.revokeApiKey(id, userId, new Date().toISOString())) {
    throw new HttpError(404, 'API key not found.');
  }
  return { ok: true };
}

/** Called from requireAuth. Returns the resolved user, or undefined if the
 *  key is unknown/revoked. Updates last_used_at on success (best-effort). */
export function authenticate(rawKey: string) {
  const row = db.findApiKeyByHash(hashKey(rawKey));
  if (!row) return undefined;
  const user = getUserById(row.user_id);
  if (!user) return undefined;
  db.touchApiKeyLastUsed(row.id, new Date().toISOString());
  return { userId: user.id, email: user.email, role: user.role };
}
