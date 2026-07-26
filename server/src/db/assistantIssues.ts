import type Database from 'better-sqlite3';

let db: Database.Database;

export function initAssistantIssueTables(database: Database.Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_issues (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      details_json TEXT NOT NULL DEFAULT '{}',
      user_id TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      resolved_by TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Migration: add status/resolution tracking columns to pre-existing
  // assistant_issues tables created before update_issue support was added.
  try { db.exec("ALTER TABLE assistant_issues ADD COLUMN status TEXT NOT NULL DEFAULT 'open'"); } catch { /* ok */ }
  try { db.exec('ALTER TABLE assistant_issues ADD COLUMN resolution TEXT'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE assistant_issues ADD COLUMN resolved_by TEXT'); } catch { /* ok */ }
  try { db.exec('ALTER TABLE assistant_issues ADD COLUMN engine TEXT'); } catch { /* ok */ }
}

// ---------------------------------------------------------------------------
// Assistant issue reporting — persisted error/diagnostic reports the
// assistant can write and read back for debugging and observability.
// ---------------------------------------------------------------------------

export interface AssistantIssueRow {
  id: string;
  summary: string;
  category: string;
  details_json: string;
  user_id: string | null;
  created_at: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  engine: string | null;
}

export const ASSISTANT_ISSUE_STATUSES = ['open', 'in_progress', 'needs_review', 'deploying', 'resolved', 'closed', 'wont_fix', 'deferred'] as const;

export function listAssistantIssues(limit = 50, userId?: string, status?: string): AssistantIssueRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (userId) {
    clauses.push('(user_id = ? OR user_id IS NULL)');
    params.push(userId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  return db
    .prepare(`SELECT * FROM assistant_issues ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as AssistantIssueRow[];
}

/** Count issues per status, scoped to a user's own issues plus unowned ones. */
export function countAssistantIssuesByStatus(userId?: string): Record<string, number> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (userId) {
    clauses.push('(user_id = ? OR user_id IS NULL)');
    params.push(userId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS count FROM assistant_issues ${where} GROUP BY status`)
    .all(...params) as { status: string; count: number }[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

export function getAssistantIssue(id: string, userId?: string): AssistantIssueRow | undefined {
  const row = db.prepare('SELECT * FROM assistant_issues WHERE id = ?').get(id) as AssistantIssueRow | undefined;
  if (row && userId && row.user_id !== userId && row.user_id !== null) return undefined;
  return row;
}

// Window within which an identical summary/category from the same user is
// treated as a duplicate push (e.g. a retried webhook or a double-submit)
// rather than a distinct new issue.
const ISSUE_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function findRecentDuplicateIssue(
  summary: string,
  category: string,
  userId?: string,
): AssistantIssueRow | undefined {
  const normalizedSummary = summary.trim().toLowerCase();
  const candidates = db
    .prepare(
      'SELECT * FROM assistant_issues WHERE user_id IS ? ORDER BY created_at DESC LIMIT 20',
    )
    .all(userId ?? null) as AssistantIssueRow[];
  const cutoff = Date.now() - ISSUE_DEDUPE_WINDOW_MS;
  return candidates.find(
    (row) =>
      row.summary.trim().toLowerCase() === normalizedSummary &&
      row.category === category &&
      new Date(row.created_at).getTime() >= cutoff,
  );
}

export function createAssistantIssue(
  details: { summary: string; category?: string; details?: Record<string, unknown>; engine?: string | null },
  userId?: string,
): { row: AssistantIssueRow; created: boolean } {
  const category = details.category || 'general';
  // Guard against duplicate entries from a single logical report being
  // pushed more than once (e.g. a retried webhook delivery or accidental
  // double submission) within a short window.
  const existing = findRecentDuplicateIssue(details.summary, category, userId);
  if (existing) return { row: existing, created: false };

  const id = `iss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO assistant_issues (id, summary, category, details_json, user_id, created_at, engine) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, details.summary, category, JSON.stringify(details.details ?? {}), userId ?? null, now, details.engine ?? null);
  return { row: getAssistantIssue(id)!, created: true };
}

/** Deletes a single issue by id. Scoped to the requesting user unless the
 *  issue is unowned (user_id IS NULL), mirroring the read scoping used by
 *  getAssistantIssue. Returns true if a row was removed. */
export function deleteAssistantIssue(id: string, userId?: string): boolean {
  const row = getAssistantIssue(id, userId);
  if (!row) return false;
  const result = db.prepare('DELETE FROM assistant_issues WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Updates an issue's status and/or resolution details. Scoped to the
 *  requesting user unless the issue is unowned (user_id IS NULL), mirroring
 *  getAssistantIssue. Returns undefined if the issue isn't found/visible. */
export function updateAssistantIssue(
  id: string,
  fields: { status?: string; resolution?: string; resolvedBy?: string; summary?: string; details_json?: string; engine?: string | null },
  userId?: string,
): AssistantIssueRow | undefined {
  const row = getAssistantIssue(id, userId);
  if (!row) return undefined;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.status !== undefined) {
    sets.push('status = ?');
    params.push(fields.status);
  }
  if (fields.resolution !== undefined) {
    sets.push('resolution = ?');
    params.push(fields.resolution);
  }
  if (fields.resolvedBy !== undefined) {
    sets.push('resolved_by = ?');
    params.push(fields.resolvedBy);
  }
  if (fields.summary !== undefined) {
    sets.push('summary = ?');
    params.push(fields.summary);
  }
  if (fields.details_json !== undefined) {
    sets.push('details_json = ?');
    params.push(fields.details_json);
  }
  if (fields.engine !== undefined) {
    sets.push('engine = ?');
    params.push(fields.engine);
  }
  if (!sets.length) return row;

  params.push(id);
  db.prepare(`UPDATE assistant_issues SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getAssistantIssue(id, userId);
}

/** Bulk-deletes issues, optionally scoped to a category, so the queue can be
 *  cleared out once issues have been triaged/resolved. Scoped to the
 *  requesting user's own issues plus unowned ones, same as listAssistantIssues.
 *  Returns the number of rows removed. */
export function clearAssistantIssues(userId?: string, category?: string): number {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (userId) {
    clauses.push('(user_id = ? OR user_id IS NULL)');
    params.push(userId);
  }
  if (category) {
    clauses.push('category = ?');
    params.push(category);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = db.prepare(`DELETE FROM assistant_issues ${where}`).run(...params);
  return result.changes;
}

