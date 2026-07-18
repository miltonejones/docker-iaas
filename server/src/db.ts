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

  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_traffic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      gateway_name TEXT NOT NULL,
      route_id TEXT,
      target_type TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      request_bytes INTEGER NOT NULL,
      response_bytes INTEGER NOT NULL,
      error_classification TEXT
    )
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_gateway_traffic_events_occurred_at ON gateway_traffic_events (occurred_at DESC, id DESC)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_gateway_traffic_events_gateway_name ON gateway_traffic_events (gateway_name, occurred_at DESC, id DESC)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_gateway_traffic_events_route_id ON gateway_traffic_events (route_id, occurred_at DESC, id DESC)',
  );

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS database_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      engine TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      encrypted_config TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_tested_at TEXT,
      last_test_status TEXT,
      last_test_error TEXT
    )
  `);

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
// Gateway traffic telemetry
// ---------------------------------------------------------------------------

export const GATEWAY_TRAFFIC_RETENTION_LIMIT = 10_000;

export interface GatewayTrafficEventRow {
  id: number;
  occurred_at: string;
  gateway_name: string;
  route_id: string | null;
  target_type: string | null;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  request_bytes: number;
  response_bytes: number;
  error_classification: string | null;
}

export interface GatewayTrafficEventInput {
  occurredAt?: string;
  gatewayName: string;
  routeId?: string | null;
  targetType?: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBytes?: number;
  responseBytes?: number;
  errorClassification?: string | null;
}

export interface GatewayTrafficSummaryFilters {
  since: string;
  until?: string;
  gatewayName?: string | null;
  routeId?: string | null;
  targetType?: string | null;
}

export interface GatewayTrafficRequestsFilters extends GatewayTrafficSummaryFilters {
  method?: string | null;
  statusCode?: number | null;
  errorClassification?: string | null;
}

export interface GatewayTrafficSummaryRow {
  gateway_name: string;
  route_id: string | null;
  target_type: string | null;
  route_method: string | null;
  route_path_pattern: string | null;
  request_count: number;
  success_count: number;
  client_error_count: number;
  server_error_count: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
  last_seen_at: string;
  error_counts: Record<string, number>;
}

function gatewayTrafficWhere(filters: GatewayTrafficSummaryFilters) {
  const clauses = ['e.occurred_at >= ?'];
  const params: Array<string | number> = [filters.since];

  if (filters.until) {
    clauses.push('e.occurred_at <= ?');
    params.push(filters.until);
  }
  if (filters.gatewayName) {
    clauses.push('e.gateway_name = ?');
    params.push(filters.gatewayName);
  }
  if (filters.routeId) {
    clauses.push('e.route_id = ?');
    params.push(filters.routeId);
  }
  if (filters.targetType) {
    clauses.push('e.target_type = ?');
    params.push(filters.targetType);
  }

  return { whereSql: clauses.join(' AND '), params };
}

export function recordGatewayTrafficEvent(input: GatewayTrafficEventInput): void {
  db.transaction((event: GatewayTrafficEventInput) => {
    const occurredAt = event.occurredAt || new Date().toISOString();
    db.prepare(
      `INSERT INTO gateway_traffic_events (
        occurred_at,
        gateway_name,
        route_id,
        target_type,
        method,
        path,
        status_code,
        duration_ms,
        request_bytes,
        response_bytes,
        error_classification
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      occurredAt,
      event.gatewayName,
      event.routeId || null,
      event.targetType || null,
      event.method,
      event.path,
      event.statusCode,
      Math.max(0, Math.round(event.durationMs)),
      Math.max(0, Math.round(event.requestBytes || 0)),
      Math.max(0, Math.round(event.responseBytes || 0)),
      event.errorClassification || null,
    );

    // Retain only the newest bounded event window so telemetry storage stays
    // predictable even if the gateway receives sustained traffic.
    db.prepare(`
      DELETE FROM gateway_traffic_events
      WHERE id IN (
        SELECT id
        FROM gateway_traffic_events
        ORDER BY occurred_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(GATEWAY_TRAFFIC_RETENTION_LIMIT);
  })(input);
}

export function summarizeGatewayTraffic(filters: GatewayTrafficSummaryFilters): GatewayTrafficSummaryRow[] {
  const { whereSql, params } = gatewayTrafficWhere(filters);
  const rows = db.prepare(
    `
      SELECT
        e.gateway_name,
        e.route_id,
        e.target_type,
        r.method AS route_method,
        r.path_pattern AS route_path_pattern,
        COUNT(*) AS request_count,
        SUM(CASE WHEN e.status_code BETWEEN 200 AND 399 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN e.status_code BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS client_error_count,
        SUM(CASE WHEN e.status_code >= 500 THEN 1 ELSE 0 END) AS server_error_count,
        ROUND(AVG(e.duration_ms), 1) AS avg_duration_ms,
        MAX(e.duration_ms) AS max_duration_ms,
        SUM(e.request_bytes) AS total_request_bytes,
        SUM(e.response_bytes) AS total_response_bytes,
        MAX(e.occurred_at) AS last_seen_at
      FROM gateway_traffic_events e
      LEFT JOIN routes r ON r.id = e.route_id
      WHERE ${whereSql}
      GROUP BY
        e.gateway_name,
        e.route_id,
        e.target_type,
        r.method,
        r.path_pattern
      ORDER BY request_count DESC, last_seen_at DESC, e.gateway_name ASC
    `,
  ).all(...params) as Omit<GatewayTrafficSummaryRow, 'error_counts'>[];

  const errorRows = db.prepare(
    `
      SELECT
        e.gateway_name,
        e.route_id,
        e.target_type,
        e.error_classification,
        COUNT(*) AS count
      FROM gateway_traffic_events e
      WHERE ${whereSql} AND e.error_classification IS NOT NULL
      GROUP BY e.gateway_name, e.route_id, e.target_type, e.error_classification
    `,
  ).all(...params) as {
    gateway_name: string;
    route_id: string | null;
    target_type: string | null;
    error_classification: string;
    count: number;
  }[];

  const errorCountsByKey = new Map<string, Record<string, number>>();
  for (const row of errorRows) {
    const key = `${row.gateway_name}::${row.route_id || ''}::${row.target_type || ''}`;
    const counts = errorCountsByKey.get(key) || {};
    counts[row.error_classification] = row.count;
    errorCountsByKey.set(key, counts);
  }

  return rows.map((row) => ({
    ...row,
    error_counts: errorCountsByKey.get(`${row.gateway_name}::${row.route_id || ''}::${row.target_type || ''}`) || {},
  }));
}

export function listGatewayTrafficEvents(
  filters: GatewayTrafficRequestsFilters,
  limit: number,
): { totalMatched: number; events: GatewayTrafficEventRow[] } {
  const { whereSql, params } = gatewayTrafficWhere(filters);
  const extraClauses: string[] = [];
  const extraParams: Array<string | number> = [];

  if (filters.method) {
    extraClauses.push('e.method = ?');
    extraParams.push(filters.method);
  }
  if (filters.statusCode != null) {
    extraClauses.push('e.status_code = ?');
    extraParams.push(filters.statusCode);
  }
  if (filters.errorClassification) {
    extraClauses.push('e.error_classification = ?');
    extraParams.push(filters.errorClassification);
  }

  const finalWhere = [whereSql, ...extraClauses].join(' AND ');
  const finalParams = [...params, ...extraParams];

  const totalMatched = (
    db.prepare(`SELECT COUNT(*) AS count FROM gateway_traffic_events e WHERE ${finalWhere}`).get(
      ...finalParams,
    ) as { count: number }
  ).count;
  const events = db.prepare(
    `
      SELECT
        e.id,
        e.occurred_at,
        e.gateway_name,
        e.route_id,
        e.target_type,
        e.method,
        e.path,
        e.status_code,
        e.duration_ms,
        e.request_bytes,
        e.response_bytes,
        e.error_classification
      FROM gateway_traffic_events e
      WHERE ${finalWhere}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ?
    `,
  ).all(...finalParams, limit) as GatewayTrafficEventRow[];

  return { totalMatched, events };
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

// ---------------------------------------------------------------------------
// Saved external database connections
// ---------------------------------------------------------------------------

export interface DatabaseConnectionRow {
  id: string;
  name: string;
  engine: string;
  summary_json: string;
  encrypted_config: string;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
  last_test_status: string | null;
  last_test_error: string | null;
}

export function listDatabaseConnections(): DatabaseConnectionRow[] {
  return db
    .prepare('SELECT * FROM database_connections ORDER BY updated_at DESC')
    .all() as DatabaseConnectionRow[];
}

export function getDatabaseConnection(id: string): DatabaseConnectionRow | undefined {
  return db.prepare('SELECT * FROM database_connections WHERE id = ?').get(id) as
    | DatabaseConnectionRow
    | undefined;
}

export function createDatabaseConnection(
  id: string,
  name: string,
  engine: string,
  summaryJson: string,
  encryptedConfig: string,
): DatabaseConnectionRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO database_connections
      (id, name, engine, summary_json, encrypted_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, engine, summaryJson, encryptedConfig, now, now);
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
