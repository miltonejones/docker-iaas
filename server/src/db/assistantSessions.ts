import type Database from 'better-sqlite3';

let db: Database.Database;

export function initAssistantSessionTables(database: Database.Database): void {
  db = database;
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

  // Migration: add user_id — this table is created after the bulk user_id block.
  try { db.exec('ALTER TABLE assistant_sessions ADD COLUMN user_id TEXT REFERENCES users(id)'); } catch { /* ok */ }
  // Migration: add assistant_id — persists which user-defined assistant a session belongs to.
  try { db.exec('ALTER TABLE assistant_sessions ADD COLUMN assistant_id TEXT REFERENCES user_assistants(id)'); } catch { /* ok */ }
}

// ---------------------------------------------------------------------------
// Ask Dockyard sessions — named, persisted assistant conversations.
// ---------------------------------------------------------------------------

export interface AssistantSessionRow {
  id: string;
  name: string;
  state: string;
  user_id: string | null;
  assistant_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssistantSessionSummaryRow {
  id: string;
  name: string;
  assistant_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Lists saved sessions, optionally filtered by a search term matched against
 *  both the session name and its full conversation content (`state`), so the
 *  sidebar search box can find sessions by what was discussed, not just how
 *  they were titled. */
export function listAssistantSessions(userId?: string, query?: string): AssistantSessionSummaryRow[] {
  const term = query?.trim();
  const like = term ? `%${term}%` : undefined;

  if (userId) {
    if (like) {
      return db
        .prepare(
          'SELECT id, name, assistant_id, created_at, updated_at FROM assistant_sessions WHERE (user_id = ? OR user_id IS NULL) AND (name LIKE ? OR state LIKE ?) ORDER BY updated_at DESC',
        )
        .all(userId, like, like) as AssistantSessionSummaryRow[];
    }
    return db
      .prepare('SELECT id, name, assistant_id, created_at, updated_at FROM assistant_sessions WHERE user_id = ? OR user_id IS NULL ORDER BY updated_at DESC')
      .all(userId) as AssistantSessionSummaryRow[];
  }
  if (like) {
    return db
      .prepare(
        'SELECT id, name, assistant_id, created_at, updated_at FROM assistant_sessions WHERE name LIKE ? OR state LIKE ? ORDER BY updated_at DESC',
      )
      .all(like, like) as AssistantSessionSummaryRow[];
  }
  return db
    .prepare('SELECT id, name, assistant_id, created_at, updated_at FROM assistant_sessions ORDER BY updated_at DESC')
    .all() as AssistantSessionSummaryRow[];
}

export function getAssistantSession(id: string, userId?: string): AssistantSessionRow | undefined {
  const row = db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id) as AssistantSessionRow | undefined;
  if (row && userId && (row as unknown as { user_id: string | null }).user_id !== userId) return undefined;
  return row;
}

export function createAssistantSession(id: string, name: string, state: string, userId?: string, assistantId?: string): AssistantSessionRow {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO assistant_sessions (id, name, state, user_id, assistant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, state, userId || null, assistantId || null, now, now);
  return getAssistantSession(id)!;
}

export function updateAssistantSession(
  id: string,
  fields: { name?: string; state?: string; assistantId?: string | null },
): AssistantSessionRow | undefined {
  const existing = getAssistantSession(id);
  if (!existing) return undefined;

  const updates: string[] = [];
  const params: (string | null)[] = [];

  if (fields.name !== undefined) {
    updates.push('name = ?');
    params.push(fields.name);
  }
  if (fields.state !== undefined) {
    updates.push('state = ?');
    params.push(fields.state);
  }
  if (fields.assistantId !== undefined) {
    updates.push('assistant_id = ?');
    params.push(fields.assistantId);
  }

  if (updates.length === 0) return existing;

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  db.prepare(`UPDATE assistant_sessions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getAssistantSession(id)!;
}

export function deleteAssistantSession(id: string): boolean {
  const result = db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

