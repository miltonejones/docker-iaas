import type Database from 'better-sqlite3';

let db: Database.Database;

export function initApiKeyTables(database: Database.Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash)');
}

export function createApiKey(
  id: string,
  userId: string,
  name: string,
  keyHash: string,
  keyPrefix: string,
  createdAt: string,
): void {
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, userId, name, keyHash, keyPrefix, createdAt);
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function listApiKeysForUser(userId: string): ApiKeyRow[] {
  return db
    .prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as ApiKeyRow[];
}

export function findApiKeyByHash(keyHash: string): ApiKeyRow | undefined {
  return db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .get(keyHash) as ApiKeyRow | undefined;
}

export function touchApiKeyLastUsed(id: string, at: string): void {
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(at, id);
}

export function revokeApiKey(id: string, userId: string, revokedAt: string): boolean {
  const result = db
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(revokedAt, id, userId);
  return result.changes > 0;
}
