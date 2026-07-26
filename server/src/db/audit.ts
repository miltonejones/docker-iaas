import type Database from 'better-sqlite3';

let db: Database.Database;

export function initAuditTables(database: Database.Database): void {
  db = database;
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        user_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
  } catch {
    /* best-effort — don't let migration failures block startup */
  }
}

export function recordAuditLog(
  action: string,
  resourceType: string,
  resourceId?: string | null,
  userId?: string | null,
  detail?: string | null,
): void {
  try {
    db.prepare(
      'INSERT INTO audit_log (action, resource_type, resource_id, user_id, detail) VALUES (?, ?, ?, ?, ?)',
    ).run(action, resourceType, resourceId ?? null, userId ?? null, detail ?? null);
  } catch {
    /* best-effort — don't let audit failures break the app */
  }
}

export interface AuditRow {
  id: number;
  action: string;
  resource_type: string;
  resource_id: string | null;
  user_id: string | null;
  detail: string | null;
  created_at: string;
}

export function listAuditLogs(limit = 100): AuditRow[] {
  try {
    return db
      .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?')
      .all(limit) as AuditRow[];
  } catch {
    return [];
  }
}
