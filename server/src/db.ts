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

  // Migration: add role column so every user has one of 'admin' | 'operator' | 'viewer'.
  try {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  } catch {
    // Column already exists — fine.
  }

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(name, user_id)
    )
  `);

  // Migration: add user_id columns to existing resource tables.
  try { db.exec('ALTER TABLE functions ADD COLUMN user_id TEXT REFERENCES users(id)'); } catch { /* ok */ }

  // Migration: add project_id to functions and routes (these tables exist before
  // this point).  bucket_owners and database_connections migrations run after
  // their respective CREATE TABLE statements below.
  try { db.exec('ALTER TABLE functions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE routes ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL'); } catch { /* ok */ }

  initAuditTables(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bucket_owners (
      bucket_name TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Migration: add project_id to bucket_owners if upgrading from older schema.
  try { db.exec('ALTER TABLE bucket_owners ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL'); } catch { /* ok */ }

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

  // User-defined assistants — each user can create assistants with a custom
  // system prompt and a subset of available tools.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      tool_list TEXT NOT NULL DEFAULT '[]',
      voice TEXT NOT NULL DEFAULT 'alloy',
      icon TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  // Migration: add icon column for assistant emoji.
  try { db.exec("ALTER TABLE user_assistants ADD COLUMN icon TEXT"); } catch { /* ok */ }
  // Migration: add prompt_mode column and backfill existing assistants.
  try {
    db.exec("ALTER TABLE user_assistants ADD COLUMN prompt_mode TEXT NOT NULL DEFAULT 'append'");
    db.exec("UPDATE user_assistants SET prompt_mode = 'replace' WHERE system_prompt != ''");
  } catch { /* ok */ }

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

import { encryptValue, decryptValue } from './encryption.js';

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
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export function listFunctions(userId?: string, projectId?: string): LambdaFunctionRow[] {
  if (userId && projectId) {
    return db
      .prepare('SELECT * FROM functions WHERE (user_id = ? OR user_id IS NULL) AND project_id = ? ORDER BY updated_at DESC')
      .all(userId, projectId) as LambdaFunctionRow[];
  }
  if (userId) {
    return db
      .prepare('SELECT * FROM functions WHERE user_id = ? OR user_id IS NULL ORDER BY updated_at DESC')
      .all(userId) as LambdaFunctionRow[];
  }
  if (projectId) {
    return db
      .prepare('SELECT * FROM functions WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as LambdaFunctionRow[];
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
  projectId?: string | null,
): LambdaFunctionRow {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO functions (id, name, runtime, code, packages, entry_point, user_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, runtime, code, packages || '', entryPoint || null, userId || null, projectId || null, now, now);
  return getFunction(id)!;
}

export function updateFunction(
  id: string,
  fields: { name?: string; runtime?: string; code?: string; packages?: string; entryPoint?: string | null; projectId?: string | null },
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
      project_id = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    fields.name ?? existing.name,
    fields.runtime ?? existing.runtime,
    fields.code ?? existing.code,
    fields.entryPoint !== undefined ? fields.entryPoint : existing.entry_point,
    fields.packages ?? existing.packages,
    fields.projectId !== undefined ? fields.projectId : existing.project_id,
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
  role: string;
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

export function setBucketOwner(bucketName: string, userId: string, protect = false, projectId?: string | null): void {
  db.prepare(
    'INSERT OR REPLACE INTO bucket_owners (bucket_name, user_id, protected, project_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(bucketName, userId, protect ? 1 : 0, projectId || null, new Date().toISOString());
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

export function setBucketProjectId(bucketName: string, projectId: string | null, userId: string): void {
  db.prepare(
    'INSERT INTO bucket_owners (bucket_name, user_id, project_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(bucket_name) DO UPDATE SET project_id = excluded.project_id',
  ).run(bucketName, userId, projectId, new Date().toISOString());
}

export function listUserBuckets(userId: string): string[] {
  const rows = db.prepare('SELECT bucket_name FROM bucket_owners WHERE user_id = ?').all(userId) as { bucket_name: string }[];
  return rows.map((r) => r.bucket_name);
}

export function getBucketProjectId(bucketName: string): string | null {
  const row = db.prepare('SELECT project_id FROM bucket_owners WHERE bucket_name = ?').get(bucketName) as { project_id: string | null } | undefined;
  return row?.project_id ?? null;
}

export function createUser(email: string, passwordHash: string): UserRow {
  const id = `usr-${Math.random().toString(36).slice(2, 8)}`;
  const networkName = `dockyard-${id}`;
  const { start, end } = allocatePortRange();
  const now = new Date().toISOString();

  const isFirst = !hasUsers();

  db.prepare(
    'INSERT INTO users (id, email, password_hash, role, network_name, port_range_start, port_range_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, email.toLowerCase(), passwordHash, isFirst ? 'admin' : 'viewer', networkName, start, end, now);

  // First user claims all existing resources (legacy data with null user_id).
  if (isFirst) {
    db.prepare('UPDATE functions SET user_id = ? WHERE user_id IS NULL').run(id);
    db.prepare('UPDATE routes SET user_id = ? WHERE user_id IS NULL').run(id);
    db.prepare('UPDATE database_connections SET user_id = ? WHERE user_id IS NULL').run(id);
    db.prepare('UPDATE assistant_sessions SET user_id = ? WHERE user_id IS NULL').run(id);
  }

  return getUserById(id)!;
}

/** List all users (without password hashes).  Admin only. */
export function listUsers(): Array<{ id: string; email: string; role: string; created_at: string }> {
  return db
    .prepare('SELECT id, email, role, created_at FROM users ORDER BY created_at ASC')
    .all() as Array<{ id: string; email: string; role: string; created_at: string }>;
}

/** Update a user's role.  Returns true if the user existed. */
export function setUserRole(userId: string, role: 'admin' | 'operator' | 'viewer'): boolean {
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  return result.changes > 0;
}

/** Count users with a given role. */
export function countUsersByRole(role: string): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get(role) as { c: number };
  return row.c;
}

/** Delete a user by id.  Returns true if the user existed and was deleted. */
export function deleteUser(userId: string): boolean {
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Projects — named groupings of related resources
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export function listProjects(userId?: string): ProjectRow[] {
  if (userId) {
    return db
      .prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as ProjectRow[];
  }
  return db
    .prepare('SELECT * FROM projects ORDER BY created_at DESC')
    .all() as ProjectRow[];
}

export function getProject(id: string, userId?: string): ProjectRow | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (row && userId && row.user_id !== userId) return undefined;
  return row;
}

export function createProject(name: string, description: string, userId: string): ProjectRow {
  const id = `proj-${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO projects (id, name, description, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, name, description, userId, now, now);
  return getProject(id)!;
}

export function updateProject(id: string, fields: { name?: string; description?: string }): ProjectRow | undefined {
  const existing = getProject(id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?',
  ).run(fields.name ?? existing.name, fields.description ?? existing.description, now, id);
  return getProject(id)!;
}

export function deleteProject(id: string): boolean {
  // FK constraints (ON DELETE SET NULL) handle unlinking — no manual UPDATEs needed.
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Set the project for a resource.  Verifies the resource belongs to the
 *  requesting user before updating.  Returns true when the project column
 *  was changed, false if the resource was not found or not owned. */
export function setResourceProject(
  table: 'functions' | 'routes' | 'bucket_owners' | 'database_connections',
  idColumn: string,
  resourceId: string,
  projectId: string | null,
  userId: string,
): { ok: boolean; reason?: string } {
  // Verify the resource exists and belongs to this user (or is system-owned
  // with null user_id — legacy data the first user claims).
  const idCol = idColumn === 'bucket_name' ? idColumn : 'id';
  const userCol = table === 'bucket_owners' ? 'user_id' : 'user_id';
  const row = db.prepare(
    `SELECT ${userCol} FROM ${table} WHERE ${idCol} = ?`,
  ).get(resourceId) as { user_id: string | null } | undefined;
  if (!row) return { ok: false, reason: 'Resource not found.' };
  if (row.user_id !== null && row.user_id !== userId) return { ok: false, reason: 'Resource does not belong to you.' };

  const result = db.prepare(
    `UPDATE ${table} SET project_id = ? WHERE ${idCol} = ?`,
  ).run(projectId, resourceId);
  return { ok: result.changes > 0 };
}

/** Summarise all resources currently linked to a project.
 *  Container count must be resolved by the caller via Docker labels. */
export function getProjectResourceSummary(projectId: string): {
  containers: number;
  functions: number;
  buckets: number;
  routes: number;
  databases: number;
} {
  const fnCount = (db.prepare(
    'SELECT COUNT(*) AS c FROM functions WHERE project_id = ?',
  ).get(projectId) as { c: number }).c;
  const routeCount = (db.prepare(
    'SELECT COUNT(*) AS c FROM routes WHERE project_id = ?',
  ).get(projectId) as { c: number }).c;
  const bucketCount = (db.prepare(
    'SELECT COUNT(*) AS c FROM bucket_owners WHERE project_id = ?',
  ).get(projectId) as { c: number }).c;
  const dbCount = (db.prepare(
    'SELECT COUNT(*) AS c FROM database_connections WHERE project_id = ?',
  ).get(projectId) as { c: number }).c;
  return { containers: 0, functions: fnCount, buckets: bucketCount, routes: routeCount, databases: dbCount };
}

// ---------------------------------------------------------------------------
// User-defined assistants
// ---------------------------------------------------------------------------

export interface UserAssistantRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  system_prompt: string;
  tool_list: string;
  voice: string;
  icon: string | null;
  is_default: number;
  prompt_mode: string;
  created_at: string;
  updated_at: string;
}

export function listUserAssistants(userId: string): UserAssistantRow[] {
  return db.prepare(
    'SELECT * FROM user_assistants WHERE user_id = ? ORDER BY created_at ASC',
  ).all(userId) as UserAssistantRow[];
}

export function getUserAssistant(id: string, userId: string): UserAssistantRow | undefined {
  return db.prepare(
    'SELECT * FROM user_assistants WHERE id = ? AND user_id = ?',
  ).get(id, userId) as UserAssistantRow | undefined;
}

export function createUserAssistant(input: {
  userId: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  toolList?: string;
  voice?: string;
  icon?: string;
  isDefault?: boolean;
  promptMode?: string;
}): UserAssistantRow {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_assistants (id, user_id, name, description, system_prompt, tool_list, voice, icon, is_default, prompt_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `ast-${crypto.randomBytes(8).toString('hex')}`,
    input.userId,
    input.name.trim(),
    (input.description || '').trim(),
    (input.systemPrompt || '').trim(),
    input.toolList || '[]',
    input.voice || 'alloy',
    input.icon || null,
    input.isDefault ? 1 : 0,
    input.promptMode || 'append',
    now,
    now,
  );
  return db.prepare(
    'SELECT * FROM user_assistants WHERE user_id = ? ORDER BY rowid DESC LIMIT 1',
  ).get(input.userId) as UserAssistantRow;
}

export function updateUserAssistant(
  id: string,
  userId: string,
  fields: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    toolList?: string;
    voice?: string;
    icon?: string | null;
    isDefault?: boolean;
    promptMode?: string;
  },
): UserAssistantRow | undefined {
  const existing = getUserAssistant(id, userId);
  if (!existing) return undefined;

  const name = fields.name !== undefined ? fields.name.trim() : existing.name;
  const description = fields.description !== undefined ? fields.description.trim() : existing.description;
  const systemPrompt = fields.systemPrompt !== undefined ? fields.systemPrompt.trim() : existing.system_prompt;
  const toolList = fields.toolList ?? existing.tool_list;
  const voice = fields.voice ?? existing.voice;
  const icon = fields.icon !== undefined ? fields.icon : existing.icon;
  const isDefault = fields.isDefault !== undefined ? (fields.isDefault ? 1 : 0) : existing.is_default;
  const promptMode = fields.promptMode ?? existing.prompt_mode;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE user_assistants
    SET name = ?, description = ?, system_prompt = ?, tool_list = ?, voice = ?, icon = ?, is_default = ?, prompt_mode = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(name, description, systemPrompt, toolList, voice, icon, isDefault, promptMode, now, id, userId);

  return getUserAssistant(id, userId);
}

export function deleteUserAssistant(id: string, userId: string): boolean {
  const result = db.prepare(
    'DELETE FROM user_assistants WHERE id = ? AND user_id = ?',
  ).run(id, userId);
  return result.changes > 0;
}
