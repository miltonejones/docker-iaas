import type Database from 'better-sqlite3';

let db: Database.Database;

export function initGatewayTables(database: Database.Database): void {
  db = database;

  db.exec(`
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_port INTEGER,
      method TEXT,
      path_pattern TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Migration: add display_name if upgrading from older schema.
  try { db.exec('ALTER TABLE routes ADD COLUMN display_name TEXT'); } catch { /* ok */ }

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

  // Migrations for columns added after initial schema.
  try { db.exec('ALTER TABLE routes ADD COLUMN user_id TEXT REFERENCES users(id)'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE gateway_traffic_events ADD COLUMN entry_point TEXT DEFAULT \'gw_prefix\''); } catch { /* ok */ }
  try { db.exec('ALTER TABLE routes ADD COLUMN domain TEXT'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE routes ADD COLUMN domain_verified INTEGER DEFAULT 0'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE routes ADD COLUMN domain_dns_managed INTEGER DEFAULT 0'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE routes ADD COLUMN domain_hosted_zone_id TEXT'); } catch { /* ok */ }
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_domain ON routes(domain) WHERE domain IS NOT NULL'); } catch { /* ok */ }
}

// ── Route types & CRUD ──────────────────────────────────────────────────

export interface RouteRow {
  id: string;
  name: string;
  display_name: string | null;
  target_type: string;
  target_id: string;
  target_port: number | null;
  method: string | null;
  path_pattern: string | null;
  user_id: string | null;
  project_id: string | null;
  domain: string | null;
  domain_verified: number;
  domain_dns_managed: number;
  domain_hosted_zone_id: string | null;
  created_at: string;
  updated_at: string;
}

export function listRoutes(userId?: string, projectId?: string): RouteRow[] {
  if (userId && projectId) {
    return db.prepare('SELECT * FROM routes WHERE (user_id = ? OR user_id IS NULL) AND project_id = ? ORDER BY created_at DESC').all(userId, projectId) as RouteRow[];
  }
  if (userId) {
    return db.prepare('SELECT * FROM routes WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC').all(userId) as RouteRow[];
  }
  if (projectId) {
    return db.prepare('SELECT * FROM routes WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as RouteRow[];
  }
  return db.prepare('SELECT * FROM routes ORDER BY created_at DESC').all() as RouteRow[];
}

export function getRoute(id: string, userId?: string): RouteRow | undefined {
  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as RouteRow | undefined;
  if (row && userId && row.user_id !== userId && row.user_id !== null) return undefined;
  return row;
}

export function getRouteByName(name: string, userId?: string): RouteRow | undefined {
  const row = db.prepare('SELECT * FROM routes WHERE name = ?').get(name) as RouteRow | undefined;
  if (row && userId && row.user_id !== userId && row.user_id !== null) return undefined;
  return row;
}

export function getRoutesByName(name: string, userId?: string): RouteRow[] {
  if (userId) {
    return db.prepare('SELECT * FROM routes WHERE name = ? AND (user_id = ? OR user_id IS NULL) ORDER BY method DESC, path_pattern DESC').all(name, userId) as RouteRow[];
  }
  return db.prepare('SELECT * FROM routes WHERE name = ? ORDER BY method DESC, path_pattern DESC').all(name) as RouteRow[];
}

/** Look up a route by its custom domain.  Returns undefined if no route
 *  claims this domain.  Respects user scoping when a userId is given. */
export function getRouteByDomain(hostname: string, userId?: string): RouteRow | undefined {
  const row = db.prepare(
    'SELECT * FROM routes WHERE domain = ? AND domain_verified = 1',
  ).get(hostname) as RouteRow | undefined;
  if (row && userId && row.user_id !== userId && row.user_id !== null) return undefined;
  return row;
}

/** Like getRouteByDomain but returns ANY claim regardless of verification
 *  state.  Used for conflict checks when setting a domain — a pending
 *  claim on the same domain must be detected before the UNIQUE index
 *  surfaces it as a generic 500. */
export function getRouteByDomainAnyStatus(hostname: string, userId?: string): RouteRow | undefined {
  const row = db.prepare(
    'SELECT * FROM routes WHERE domain = ?',
  ).get(hostname) as RouteRow | undefined;
  if (row && userId && row.user_id !== userId && row.user_id !== null) return undefined;
  return row;
}

/** Set or clear the custom domain on a route.  Returns the updated row or
 *  undefined if the route was not found.  Caller must validate uniqueness
 *  before calling (the UNIQUE index on domain enforces it at DB level). */
export function setRouteDomain(id: string, domain: string | null): RouteRow | undefined {
  const existing = getRoute(id);
  if (!existing) return undefined;
  db.prepare('UPDATE routes SET domain = ?, domain_verified = 0, updated_at = ? WHERE id = ?')
    .run(domain, new Date().toISOString(), id);
  return getRoute(id)!;
}

/** Mark a route's domain as verified (certificate issued + live). */
export function verifyRouteDomain(id: string): RouteRow | undefined {
  const existing = getRoute(id);
  if (!existing) return undefined;
  db.prepare('UPDATE routes SET domain_verified = 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
  return getRoute(id)!;
}

export function setRouteDomainDnsManaged(id: string, zoneId: string): RouteRow | undefined {
  const existing = getRoute(id);
  if (!existing) return undefined;
  db.prepare(
    'UPDATE routes SET domain_dns_managed = 1, domain_hosted_zone_id = ?, updated_at = ? WHERE id = ?',
  ).run(zoneId, new Date().toISOString(), id);
  return getRoute(id)!;
}

export function createRoute(
  id: string,
  name: string,
  targetType: string,
  targetId: string,
  targetPort: number | null,
  method?: string | null,
  pathPattern?: string | null,
  userId?: string,
  displayName?: string | null,
  projectId?: string | null,
): RouteRow {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO routes (id, name, display_name, target_type, target_id, target_port, method, path_pattern, user_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, displayName || null, targetType, targetId, targetPort, method || null, pathPattern || null, userId || null, projectId || null, now, now);
  return getRoute(id)!;
}

export function deleteRoute(id: string): boolean {
  const result = db.prepare('DELETE FROM routes WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateRoute(id: string, fields: { displayName?: string | null; targetPort?: number | null; method?: string | null; pathPattern?: string | null; domain?: string | null }): RouteRow | undefined {
  const existing = getRoute(id);
  if (!existing) return undefined;

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (fields.displayName !== undefined) {
    updates.push('display_name = ?');
    params.push(fields.displayName);
  }
  if (fields.targetPort !== undefined) {
    updates.push('target_port = ?');
    params.push(fields.targetPort);
  }
  if (fields.method !== undefined) {
    updates.push('method = ?');
    params.push(fields.method || null);
  }
  if (fields.pathPattern !== undefined) {
    updates.push('path_pattern = ?');
    params.push(fields.pathPattern || null);
  }
  if (fields.domain !== undefined) {
    updates.push('domain = ?');
    params.push(fields.domain || null);
    updates.push('domain_verified = 0');
    if (fields.domain === null) {
      updates.push('domain_dns_managed = 0');
      updates.push('domain_hosted_zone_id = NULL');
    }
  }

  if (updates.length === 0) return existing;

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  db.prepare(`UPDATE routes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getRoute(id)!;
}

// ── Gateway traffic telemetry ───────────────────────────────────────────

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
  entry_point: string | null;
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
  entryPoint?: string | null;
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

export interface GatewayTrafficHourlyRow {
  bucket_start: string;
  request_count: number;
  success_count: number;
  client_error_count: number;
  server_error_count: number;
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
        error_classification,
        entry_point
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      event.entryPoint || null,
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

export function summarizeGatewayTrafficByHour(
  filters: GatewayTrafficSummaryFilters,
): GatewayTrafficHourlyRow[] {
  const { whereSql, params } = gatewayTrafficWhere(filters);
  return db.prepare(
    `
      SELECT
        strftime('%Y-%m-%dT%H:00:00.000Z', e.occurred_at) AS bucket_start,
        COUNT(*) AS request_count,
        SUM(CASE WHEN e.status_code BETWEEN 200 AND 399 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN e.status_code BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS client_error_count,
        SUM(CASE WHEN e.status_code >= 500 THEN 1 ELSE 0 END) AS server_error_count
      FROM gateway_traffic_events e
      WHERE ${whereSql}
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `,
  ).all(...params) as GatewayTrafficHourlyRow[];
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

/** Get all routes with a verified custom domain — used to rebuild Caddy site
 *  files on startup after a volume loss or redeploy. */
export function getVerifiedDomainRoutes(): { id: string; name: string; domain: string }[] {
  return db.prepare(
    "SELECT id, name, domain FROM routes WHERE domain IS NOT NULL AND domain_verified = 1",
  ).all() as { id: string; name: string; domain: string }[];
}
