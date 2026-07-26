import type Database from 'better-sqlite3';

let db: Database.Database;

export function initDatabaseOpsTables(database: Database.Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS database_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      engine TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      encrypted_config TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_tested_at TEXT,
      last_test_status TEXT,
      last_test_error TEXT
    )
  `);

  // Migration: add user_id — this table is created after the bulk user_id block.
  try { db.exec('ALTER TABLE database_connections ADD COLUMN user_id TEXT REFERENCES users(id)'); } catch { /* ok */ }

  // Migration: add project_id to database_connections if upgrading from older schema.
  try { db.exec('ALTER TABLE database_connections ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL'); } catch { /* ok */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS database_operations (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
    )
  `);


  db.exec(`
    CREATE TABLE IF NOT EXISTS database_jobs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      artifact_format TEXT,
      artifact_path TEXT,
      artifact_size INTEGER,
      request_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
    )
  `);

}

// ---------------------------------------------------------------------------
// Saved external database connections
// ---------------------------------------------------------------------------

export interface DatabaseConnectionRow {
  id: string;
  name: string;
  engine: string;
  summary_json: string;
  encrypted_config: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
  last_test_status: string | null;
  last_test_error: string | null;
}

export function listDatabaseConnections(userId?: string, projectId?: string): DatabaseConnectionRow[] {
  if (userId && projectId) {
    return db
      .prepare('SELECT * FROM database_connections WHERE (user_id = ? OR user_id IS NULL) AND project_id = ? ORDER BY updated_at DESC')
      .all(userId, projectId) as DatabaseConnectionRow[];
  }
  if (userId) {
    return db
      .prepare('SELECT * FROM database_connections WHERE user_id = ? OR user_id IS NULL ORDER BY updated_at DESC')
      .all(userId) as DatabaseConnectionRow[];
  }
  if (projectId) {
    return db
      .prepare('SELECT * FROM database_connections WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as DatabaseConnectionRow[];
  }
  return db
    .prepare('SELECT * FROM database_connections ORDER BY updated_at DESC')
    .all() as DatabaseConnectionRow[];
}

export function getDatabaseConnection(id: string, userId?: string): DatabaseConnectionRow | undefined {
  const row = db.prepare('SELECT * FROM database_connections WHERE id = ?').get(id) as DatabaseConnectionRow | undefined;
  if (row && userId && (row as unknown as { user_id: string | null }).user_id !== userId && (row as unknown as { user_id: string | null }).user_id !== null) return undefined;
  return row;
}

export function createDatabaseConnection(
  id: string,
  name: string,
  engine: string,
  summaryJson: string,
  encryptedConfig: string,
  userId?: string,
  projectId?: string | null,
): DatabaseConnectionRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO database_connections
      (id, name, engine, summary_json, encrypted_config, user_id, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, engine, summaryJson, encryptedConfig, userId || null, projectId || null, now, now);
  return getDatabaseConnection(id)!;
}

export function updateDatabaseConnection(
  id: string,
  fields: {
    name?: string;
    engine?: string;
    summaryJson?: string;
    encryptedConfig?: string;
    lastTestedAt?: string | null;
    lastTestStatus?: string | null;
    lastTestError?: string | null;
  },
): DatabaseConnectionRow | undefined {
  const existing = getDatabaseConnection(id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE database_connections SET
      name = ?,
      engine = ?,
      summary_json = ?,
      encrypted_config = ?,
      updated_at = ?,
      last_tested_at = ?,
      last_test_status = ?,
      last_test_error = ?
     WHERE id = ?`,
  ).run(
    fields.name ?? existing.name,
    fields.engine ?? existing.engine,
    fields.summaryJson ?? existing.summary_json,
    fields.encryptedConfig ?? existing.encrypted_config,
    now,
    fields.lastTestedAt !== undefined ? fields.lastTestedAt : existing.last_tested_at,
    fields.lastTestStatus !== undefined ? fields.lastTestStatus : existing.last_test_status,
    fields.lastTestError !== undefined ? fields.lastTestError : existing.last_test_error,
    id,
  );
  return getDatabaseConnection(id)!;
}

export function setDatabaseConnectionTestResult(
  id: string,
  status: string,
  error?: string | null,
): DatabaseConnectionRow | undefined {
  return updateDatabaseConnection(id, {
    lastTestedAt: new Date().toISOString(),
    lastTestStatus: status,
    lastTestError: error ?? null,
  });
}

export function deleteDatabaseConnection(id: string): boolean {
  const result = db.prepare('DELETE FROM database_connections WHERE id = ?').run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Database operation records
// ---------------------------------------------------------------------------

export interface DatabaseOperationRow {
  id: string;
  connection_id: string;
  engine: string;
  category: string;
  action: string;
  summary: string;
  status: string;
  request_json: string;
  result_json: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function listDatabaseOperations(limit = 25): DatabaseOperationRow[] {
  return db
    .prepare('SELECT * FROM database_operations ORDER BY created_at DESC LIMIT ?')
    .all(limit) as DatabaseOperationRow[];
}

export function listDatabaseOperationsForConnection(connectionId: string, limit = 25): DatabaseOperationRow[] {
  return db
    .prepare('SELECT * FROM database_operations WHERE connection_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(connectionId, limit) as DatabaseOperationRow[];
}

export function createDatabaseOperation(fields: {
  id: string;
  connectionId: string;
  engine: string;
  category: string;
  action: string;
  summary: string;
  status: string;
  requestJson?: string;
  resultJson?: string;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}): DatabaseOperationRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO database_operations
      (id, connection_id, engine, category, action, summary, status, request_json, result_json, error, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.id,
    fields.connectionId,
    fields.engine,
    fields.category,
    fields.action,
    fields.summary,
    fields.status,
    fields.requestJson ?? '{}',
    fields.resultJson ?? '{}',
    fields.error ?? null,
    now,
    fields.startedAt ?? now,
    fields.finishedAt ?? null,
  );
  return db.prepare('SELECT * FROM database_operations WHERE id = ?').get(fields.id) as DatabaseOperationRow;
}

export function updateDatabaseOperation(
  id: string,
  fields: {
    summary?: string;
    status?: string;
    requestJson?: string;
    resultJson?: string;
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  },
): DatabaseOperationRow | undefined {
  const existing = db.prepare('SELECT * FROM database_operations WHERE id = ?').get(id) as
    | DatabaseOperationRow
    | undefined;
  if (!existing) return undefined;
  db.prepare(
    `UPDATE database_operations SET
      summary = ?,
      status = ?,
      request_json = ?,
      result_json = ?,
      error = ?,
      started_at = ?,
      finished_at = ?
     WHERE id = ?`,
  ).run(
    fields.summary ?? existing.summary,
    fields.status ?? existing.status,
    fields.requestJson ?? existing.request_json,
    fields.resultJson ?? existing.result_json,
    fields.error !== undefined ? fields.error : existing.error,
    fields.startedAt !== undefined ? fields.startedAt : existing.started_at,
    fields.finishedAt !== undefined ? fields.finishedAt : existing.finished_at,
    id,
  );
  return db.prepare('SELECT * FROM database_operations WHERE id = ?').get(id) as DatabaseOperationRow;
}

// ---------------------------------------------------------------------------
// Database backup / restore jobs
// ---------------------------------------------------------------------------

export interface DatabaseJobRow {
  id: string;
  connection_id: string;
  engine: string;
  kind: string;
  summary: string;
  status: string;
  artifact_format: string | null;
  artifact_path: string | null;
  artifact_size: number | null;
  request_json: string;
  result_json: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function listDatabaseJobs(limit = 25): DatabaseJobRow[] {
  return db
    .prepare('SELECT * FROM database_jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as DatabaseJobRow[];
}

export function getDatabaseJob(id: string): DatabaseJobRow | undefined {
  return db.prepare('SELECT * FROM database_jobs WHERE id = ?').get(id) as
    | DatabaseJobRow
    | undefined;
}

export function createDatabaseJob(fields: {
  id: string;
  connectionId: string;
  engine: string;
  kind: string;
  summary: string;
  status: string;
  artifactFormat?: string | null;
  artifactPath?: string | null;
  artifactSize?: number | null;
  requestJson?: string;
  resultJson?: string;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}): DatabaseJobRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO database_jobs
      (id, connection_id, engine, kind, summary, status, artifact_format, artifact_path, artifact_size, request_json, result_json, error, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.id,
    fields.connectionId,
    fields.engine,
    fields.kind,
    fields.summary,
    fields.status,
    fields.artifactFormat ?? null,
    fields.artifactPath ?? null,
    fields.artifactSize ?? null,
    fields.requestJson ?? '{}',
    fields.resultJson ?? '{}',
    fields.error ?? null,
    now,
    fields.startedAt ?? now,
    fields.finishedAt ?? null,
  );
  return getDatabaseJob(fields.id)!;
}


export function updateDatabaseJob(
  id: string,
  fields: {
    summary?: string;
    status?: string;
    artifactFormat?: string | null;
    artifactPath?: string | null;
    artifactSize?: number | null;
    requestJson?: string;
    resultJson?: string;
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  },
): DatabaseJobRow | undefined {
  const existing = getDatabaseJob(id);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE database_jobs SET
      summary = ?,
      status = ?,
      artifact_format = ?,
      artifact_path = ?,
      artifact_size = ?,
      request_json = ?,
      result_json = ?,
      error = ?,
      started_at = ?,
      finished_at = ?
     WHERE id = ?`,
  ).run(
    fields.summary ?? existing.summary,
    fields.status ?? existing.status,
    fields.artifactFormat !== undefined ? fields.artifactFormat : existing.artifact_format,
    fields.artifactPath !== undefined ? fields.artifactPath : existing.artifact_path,
    fields.artifactSize !== undefined ? fields.artifactSize : existing.artifact_size,
    fields.requestJson ?? existing.request_json,
    fields.resultJson ?? existing.result_json,
    fields.error !== undefined ? fields.error : existing.error,
    fields.startedAt !== undefined ? fields.startedAt : existing.started_at,
    fields.finishedAt !== undefined ? fields.finishedAt : existing.finished_at,
    id,
  );
  return getDatabaseJob(id)!;
}
