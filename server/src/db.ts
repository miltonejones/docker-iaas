import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { initAuditTables } from './db/audit.js';
import { initGatewayTables } from './db/gateway.js';
import { initAssistantSessionTables } from './db/assistantSessions.js';
import { initAssistantIssueTables } from './db/assistantIssues.js';
import { initDatabaseOpsTables } from './db/databaseOps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/iaas.db');

let db: Database.Database;

export function initDb(dbPath?: string): void {
  const targetPath = dbPath ?? DB_PATH;

  // Ensure the data directory exists (skip for in-memory databases).
  if (targetPath !== ':memory:') {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS functions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'node',
      code TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Migration: add packages column if it doesn't exist.
  try {
    db.exec('ALTER TABLE functions ADD COLUMN packages TEXT NOT NULL DEFAULT \'\'');
  } catch {
    // Column already exists — fine.
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  initGatewayTables(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      network_name TEXT NOT NULL,
      port_range_start INTEGER NOT NULL,
      port_range_end INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Per-user encrypted credentials and preferences.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL REFERENCES users(id),
      key TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    )
  `);

  // Migration: add user_id columns to existing resource tables.
  try { db.exec('ALTER TABLE functions ADD COLUMN user_id TEXT REFERENCES users(id)'); } catch { /* ok */ }
  initAuditTables(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bucket_owners (
      bucket_name TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Migration: add protected column for bucket-level deletion guard.
  try { db.exec('ALTER TABLE bucket_owners ADD COLUMN protected INTEGER NOT NULL DEFAULT 0'); } catch { /* ok */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS function_env (
      function_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (function_id, key),
      FOREIGN KEY (function_id) REFERENCES functions(id) ON DELETE CASCADE
    )
  `);

  // Multi-file support: a function's `code` column remains the entry-point
  // file's content for backward compatibility (single-file functions never
  // touch this table). Additional files — barrel files, lib modules, etc —
  // live here, addressed by their path relative to the function's working
  // directory (e.g. "lib/util.js").
  db.exec(`
    CREATE TABLE IF NOT EXISTS function_files (
      function_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (function_id, path),
      FOREIGN KEY (function_id) REFERENCES functions(id) ON DELETE CASCADE
    )
  `);

  // Migration: entry_point column names which file (by path) is the one
  // actually executed. NULL means "use the legacy `code` column as-is".
  try { db.exec("ALTER TABLE functions ADD COLUMN entry_point TEXT"); } catch { /* ok */ }

  initAssistantSessionTables(db);
  initDatabaseOpsTables(db);
  initAssistantIssueTables(db);
}

// ---------------------------------------------------------------------------
// Generic settings (key/value)
// ---------------------------------------------------------------------------

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Per-user encrypted credentials
// ---------------------------------------------------------------------------

function resolveMasterKey(): Buffer {
  const MASTER_KEY_FILE = process.env.DOCKYARD_DATABASE_MASTER_KEY_FILE
    || path.join(process.env.HOME || '/root', '.dockyard_database_master_key');
  try {
    const raw = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
    return crypto.createHash('sha256').update(raw).digest();
  } catch {
    // Fall back to env var for dev/test
    const envKey = process.env.DOCKYARD_DATABASE_MASTER_KEY;
    if (envKey) return crypto.createHash('sha256').update(envKey).digest();
    throw new Error('DOCKYARD_DATABASE_MASTER_KEY not available.');
  }
}

function encryptValue(plaintext: string): string {
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

function decryptValue(payload: string): string {
  const key = resolveMasterKey();
  const parsed = JSON.parse(payload) as { iv: string; tag: string; ciphertext: string };
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function getUserSetting(userId: string, key: string): string | undefined {
  const row = db.prepare(
    'SELECT encrypted_value FROM user_settings WHERE user_id = ? AND key = ?',
  ).get(userId, key) as { encrypted_value: string } | undefined;
  if (!row) return undefined;
  try { return decryptValue(row.encrypted_value); } catch { return undefined; }
}

/** Returns all settings for a user as a plain object.  Values are decrypted. */
export function getAllUserSettings(userId: string): Record<string, string> {
  const rows = db.prepare(
    'SELECT key, encrypted_value FROM user_settings WHERE user_id = ?',
  ).all(userId) as { key: string; encrypted_value: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) {
    try { out[row.key] = decryptValue(row.encrypted_value); } catch { /* skip */ }
  }
  return out;
}

export function setUserSetting(userId: string, key: string, value: string): void {
  const encrypted = encryptValue(value);
  db.prepare(
    `INSERT INTO user_settings (user_id, key, encrypted_value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at`,
  ).run(userId, key, encrypted, new Date().toISOString());
}

export function deleteUserSetting(userId: string, key: string): void {
  db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
}

// ---------------------------------------------------------------------------
// Lambda function CRUD
// ---------------------------------------------------------------------------

export interface LambdaFunctionRow {
  id: string;
  name: string;
  runtime: string;
  code: string;
  packages: string;
  entry_point: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export function listFunctions(userId?: string): LambdaFunctionRow[] {
  if (userId) {
    return db
      .prepare('SELECT * FROM functions WHERE user_id = ? OR user_id IS NULL ORDER BY updated_at DESC')
      .all(userId) as LambdaFunctionRow[];
  }
  return db
    .prepare('SELECT * FROM functions ORDER BY updated_at DESC')
    .all() as LambdaFunctionRow[];
}

export function getFunction(id: string, userId?: string): LambdaFunctionRow | undefined {
  const row = db.prepare('SELECT * FROM functions WHERE id = ?').get(id) as LambdaFunctionRow | undefined;
  if (row && userId && row.user_id !== userId && row.user_id !== null) return undefined;
  return row;
}

export function createFunction(
  id: string,
  name: string,
  runtime: string,
  code: string,
  packages?: string,
  entryPoint?: string | null,
  userId?: string,
): LambdaFunctionRow {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO functions (id, name, runtime, code, packages, entry_point, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, runtime, code, packages || '', entryPoint || null, userId || null, now, now);
  return getFunction(id)!;
}

export function updateFunction(
  id: string,
  fields: { name?: string; runtime?: string; code?: string; packages?: string; entryPoint?: string | null },
): LambdaFunctionRow | undefined {
  const existing = getFunction(id);
  if (!existing) return undefined;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE functions SET
      name = ?,
      runtime = ?,
      code = ?,
      entry_point = ?,
      packages = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    fields.name ?? existing.name,
    fields.runtime ?? existing.runtime,
    fields.code ?? existing.code,
    fields.entryPoint !== undefined ? fields.entryPoint : existing.entry_point,
    fields.packages ?? existing.packages,
    now,
    id,
  );
  return getFunction(id)!;
}

export function deleteFunction(id: string): boolean {
  const result = db.prepare('DELETE FROM functions WHERE id = ?').run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Per-function environment variables ("secrets") — stored separately from
// code so they never end up rendered inline in the function's source text.
// ---------------------------------------------------------------------------

export function getFunctionEnv(functionId: string): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM function_env WHERE function_id = ?')
    .all(functionId) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setFunctionEnv(functionId: string, env: Record<string, string>): void {
  const replace = db.transaction((entries: [string, string][]) => {
    db.prepare('DELETE FROM function_env WHERE function_id = ?').run(functionId);
    const insert = db.prepare('INSERT INTO function_env (function_id, key, value) VALUES (?, ?, ?)');
    for (const [key, value] of entries) insert.run(functionId, key, value);
  });
  replace(Object.entries(env));
}

// ---------------------------------------------------------------------------
// Per-function additional files — barrel files, lib modules, etc, addressed
// by path relative to the function's working directory. The entry-point
// file's content still lives on functions.code for backward compatibility.
// ---------------------------------------------------------------------------

export interface FunctionFileRow {
  path: string;
  content: string;
}

export function getFunctionFiles(functionId: string): FunctionFileRow[] {
  return db
    .prepare('SELECT path, content FROM function_files WHERE function_id = ? ORDER BY path')
    .all(functionId) as FunctionFileRow[];
}

export function setFunctionFiles(functionId: string, files: FunctionFileRow[]): void {
  const replace = db.transaction((rows: FunctionFileRow[]) => {
    db.prepare('DELETE FROM function_files WHERE function_id = ?').run(functionId);
    const insert = db.prepare('INSERT INTO function_files (function_id, path, content) VALUES (?, ?, ?)');
    for (const row of rows) insert.run(functionId, row.path, row.content);
  });
  replace(files);
}

// ---------------------------------------------------------------------------
// Users (multi-tenant auth)
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  network_name: string;
  port_range_start: number;
  port_range_end: number;
  created_at: string;
}

const USER_PORT_RANGE_SIZE = 100;
const USER_PORT_BASE = 5000;

/** Allocate the next available port range for a new user. */
function allocatePortRange(): { start: number; end: number } {
  const existing = db.prepare('SELECT MAX(port_range_end) AS max_end FROM users').get() as { max_end: number | null };
  const start = (existing?.max_end ?? USER_PORT_BASE - 1) + 1;
  return { start, end: start + USER_PORT_RANGE_SIZE - 1 };
}

export function getUserById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function hasUsers(): boolean {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  return row.count > 0;
}

/** Return the first user record (by creation order), or undefined if the
 *  users table is empty.  Used by the consumer token endpoint to pick a
 *  tenant identity when the consumer authenticates with an API key rather
 *  than user credentials. */
export function getFirstUser(): UserRow | undefined {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT 1').get() as UserRow | undefined;
}

export function getUserByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as UserRow | undefined;
}

// ---------------------------------------------------------------------------
// Bucket ownership — buckets are in MinIO, not SQLite, so we track ownership
// separately.
// ---------------------------------------------------------------------------

export function setBucketOwner(bucketName: string, userId: string, protect = false): void {
  db.prepare(
    'INSERT OR REPLACE INTO bucket_owners (bucket_name, user_id, protected, created_at) VALUES (?, ?, ?, ?)',
  ).run(bucketName, userId, protect ? 1 : 0, new Date().toISOString());
}

export function getBucketOwner(bucketName: string): string | null {
  const row = db.prepare('SELECT user_id FROM bucket_owners WHERE bucket_name = ?').get(bucketName) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function isBucketProtected(bucketName: string): boolean {
  const row = db.prepare('SELECT protected FROM bucket_owners WHERE bucket_name = ?').get(bucketName) as { protected: number } | undefined;
  return !!row?.protected;
}

export function setBucketProtected(bucketName: string, protect: boolean): void {
  db.prepare('UPDATE bucket_owners SET protected = ? WHERE bucket_name = ?').run(protect ? 1 : 0, bucketName);
}

export function listUserBuckets(userId: string): string[] {
  const rows = db.prepare('SELECT bucket_name FROM bucket_owners WHERE user_id = ?').all(userId) as { bucket_name: string }[];
  return rows.map((r) => r.bucket_name);
}

export function createUser(email: string, passwordHash: string): UserRow {
  const id = `usr-${Math.random().toString(36).slice(2, 8)}`;
  const networkName = `dockyard-${id}`;
  const { start, end } = allocatePortRange();
  const now = new Date().toISOString();

  const isFirst = !hasUsers();

  db.prepare(
    'INSERT INTO users (id, email, password_hash, network_name, port_range_start, port_range_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, email.toLowerCase(), passwordHash, networkName, start, end, now);

  // First user claims all existing resources (legacy data with null user_id).
  if (isFirst) {
    db.prepare('UPDATE functions SET user_id = ? WHERE user_id IS NULL').run(id);
    db.prepare('UPDATE routes SET user_id = ? WHERE user_id IS NULL').run(id);
    db.prepare('UPDATE database_connections SET user_id = ? WHERE user_id IS NULL').run(id);
    db.prepare('UPDATE assistant_sessions SET user_id = ? WHERE user_id IS NULL').run(id);
  }

  return getUserById(id)!;
}
