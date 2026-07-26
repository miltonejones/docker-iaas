# Prompt: Add a minimal read-only audit log API

Implement a minimal authenticated read-only audit log API.

## Goal

Expose recent audit events so operators can inspect the audit trail without directly opening the SQLite database.

## Why this matters in Dockyard

Dockyard now has initial audit logging, but audit data is much less useful if it is only written and never surfaced. A minimal read endpoint creates a practical observability loop and makes later UI work straightforward.

This should stay intentionally small: no editing, no deletion, no complex reporting.

## Suggested API shape

A simple endpoint such as:
- `GET /api/system/audit`
- or `GET /api/audit`

## Response shape

Return recent rows ordered newest-first with fields like:
- `id`
- `action`
- `resourceType`
- `resourceId`
- `userId`
- `detail`
- `createdAt`

## Instructions

1. Add the minimum persistence/query helper needed to list recent audit rows.
2. Add a read-only API endpoint.
3. Protect it behind existing auth middleware.
4. Support a small `limit` query param with a safe maximum.
5. Keep the implementation simple and reviewable.

## Constraints

- Do **not** add audit mutation endpoints.
- Do **not** add deletion or admin-only editing features.
- Do **not** over-engineer filtering/search unless trivial.

## Acceptance criteria

- Authenticated callers can retrieve recent audit events.
- Results are ordered newest-first.
- A safe `limit` is enforced.
- `npm run typecheck` passes.
- `npm test` passes.
