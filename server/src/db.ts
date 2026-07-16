import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/iaas.db');

let db: Database.Database;

export function initDb(): void {
  // Ensure the data directory exists.
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_port INTEGER,
      method TEXT,
      path_pattern TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Migration: add method and path_pattern columns if upgrading from older schema.
  try { db.exec('ALTER TABLE routes ADD COLUMN method TEXT'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE routes ADD COLUMN path_pattern TEXT'); } catch { /* ok */ }

  // Migration: drop the UNIQUE constraint on name so multiple routes can share
  // the same name with different method/path combos. SQLite can't ALTER TABLE
  // DROP CONSTRAINT, so we recreate the table.
  {
    const cols = db.prepare("PRAGMA table_info('routes')").all() as { name: string }[];
    const hasMethod = cols.some((c) => c.name === 'method');
    const hasPath = cols.some((c) => c.name === 'path_pattern');
    if (hasMethod && hasPath) {
      // Check if the old UNIQUE constraint still exists by looking at the
      // original CREATE TABLE SQL.
      const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='routes'").get() as { sql: string } | undefined)?.sql || '';
      if (createSql.includes('UNIQUE')) {
        db.exec(`
          CREATE TABLE routes_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            target_port INTEGER,
            method TEXT,
            path_pattern TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO routes_new SELECT id, name, target_type, target_id, target_port, method, path_pattern, created_at, updated_at FROM routes;
          DROP TABLE routes;
          ALTER TABLE routes_new RENAME TO routes;
        `);
      }
    }
  }

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

  // Ask Dockyard sessions — `state` is an opaque JSON blob owned entirely by
  // the client (conversation history, action log, pending confirmations).
  // The server never inspects it, just stores and returns it verbatim.
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
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
// Gateway route CRUD
// ---------------------------------------------------------------------------

export interface RouteRow {
  id: string;
  name: string;
  target_type: string;
  target_id: string;
  target_port: number | null;
  method: string | null;
  path_pattern: string | null;
  created_at: string;
  updated_at: string;
}

export function listRoutes(): RouteRow[] {
  return db.prepare('SELECT * FROM routes ORDER BY created_at DESC').all() as RouteRow[];
}

export function getRoute(id: string): RouteRow | undefined {
  return db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as RouteRow | undefined;
}

export function getRouteByName(name: string): RouteRow | undefined {
  return db.prepare('SELECT * FROM routes WHERE name = ?').get(name) as RouteRow | undefined;
}

export function getRoutesByName(name: string): RouteRow[] {
  return db.prepare('SELECT * FROM routes WHERE name = ? ORDER BY method DESC, path_pattern DESC').all(name) as RouteRow[];
}

export function createRoute(
  id: string,
  name: string,
  targetType: string,
  targetId: string,
  targetPort: number | null,
  method?: string | null,
  pathPattern?: string | null,
): RouteRow {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO routes (id, name, target_type, target_id, target_port, method, path_pattern, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, targetType, targetId, targetPort, method || null, pathPattern || null, now, now);
  return getRoute(id)!;
}

export function deleteRoute(id: string): boolean {
  const result = db.prepare('DELETE FROM routes WHERE id = ?').run(id);
  return result.changes > 0;
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
  created_at: string;
  updated_at: string;
}

export function listFunctions(): LambdaFunctionRow[] {
  return db
    .prepare('SELECT * FROM functions ORDER BY updated_at DESC')
    .all() as LambdaFunctionRow[];
}

export function getFunction(id: string): LambdaFunctionRow | undefined {
  return db.prepare('SELECT * FROM functions WHERE id = ?').get(id) as
    | LambdaFunctionRow
    | undefined;
}

export function createFunction(
  id: string,
  name: string,
  runtime: string,
  code: string,
  packages?: string,
  entryPoint?: string | null,
): LambdaFunctionRow {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO functions (id, name, runtime, code, packages, entry_point, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, runtime, code, packages || '', entryPoint || null, now, now);
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
// Ask Dockyard sessions — named, persisted assistant conversations.
// ---------------------------------------------------------------------------

export interface AssistantSessionRow {
  id: string;
  name: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantSessionSummaryRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export function listAssistantSessions(): AssistantSessionSummaryRow[] {
  return db
    .prepare('SELECT id, name, created_at, updated_at FROM assistant_sessions ORDER BY updated_at DESC')
    .all() as AssistantSessionSummaryRow[];
}

export function getAssistantSession(id: string): AssistantSessionRow | undefined {
  return db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id) as AssistantSessionRow | undefined;
}

export function createAssistantSession(id: string, name: string, state: string): AssistantSessionRow {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO assistant_sessions (id, name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, name, state, now, now);
  return getAssistantSession(id)!;
}

export function updateAssistantSession(
  id: string,
  fields: { name?: string; state?: string },
): AssistantSessionRow | undefined {
  const existing = getAssistantSession(id);
  if (!existing) return undefined;

  const now = new Date().toISOString();
  db.prepare('UPDATE assistant_sessions SET name = ?, state = ?, updated_at = ? WHERE id = ?').run(
    fields.name ?? existing.name,
    fields.state ?? existing.state,
    now,
    id,
  );
  return getAssistantSession(id)!;
}

export function deleteAssistantSession(id: string): boolean {
  const result = db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(id);
  return result.changes > 0;
}
