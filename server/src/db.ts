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
): LambdaFunctionRow {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO functions (id, name, runtime, code, packages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, runtime, code, packages || '', now, now);
  return getFunction(id)!;
}

export function updateFunction(
  id: string,
  fields: { name?: string; runtime?: string; code?: string; packages?: string },
): LambdaFunctionRow | undefined {
  const existing = getFunction(id);
  if (!existing) return undefined;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE functions SET
      name = ?,
      runtime = ?,
      code = ?,
      packages = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    fields.name ?? existing.name,
    fields.runtime ?? existing.runtime,
    fields.code ?? existing.code,
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
