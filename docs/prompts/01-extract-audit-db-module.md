# Prompt: Extract audit logging from `server/src/db.ts`

Refactor `server/src/db.ts` by extracting the audit log functionality into a dedicated module.

## Goal

Create a new file `server/src/db/audit.ts` and move the audit log persistence responsibilities into it.

This should include:
- the `audit_log` table creation / migration logic
- the `recordAuditLog()` helper
- any small related types/helpers if needed

## Why this matters in Dockyard

Dockyard is a high-privilege control plane. It can manage containers, gateway routes, domains, host file transfers, database operations, and GitHub-linked automation. Audit logging is one of the first control-plane safety boundaries that should stand on its own.

Right now, `server/src/db.ts` is doing too much. Extracting audit logging first is the smallest useful decomposition step because it:
- reduces central file sprawl
- creates a clearer home for future audit queries and retention work
- makes later audit coverage expansion less error-prone

## Instructions

1. Create `server/src/db/audit.ts`.
2. Move the `audit_log` table creation/migration logic into that module.
3. Move `recordAuditLog()` into that module.
4. Preserve the existing function signature and best-effort behavior exactly.
5. If necessary, expose an initializer like `initAuditTables(db)` and call it from the main DB bootstrap.
6. Update imports/callers so the app still compiles.
7. Avoid changing unrelated persistence logic.
8. Preserve useful comments where they still make sense.

## Constraints

- Do **not** redesign the database layer in this change.
- Do **not** change the audit table schema unless required for compatibility.
- Do **not** mix this with broader gateway, session, or database-ops extraction.
- Keep the diff narrowly scoped.

## Acceptance criteria

- `server/src/db/audit.ts` exists and owns audit log persistence.
- The audit table is still created during startup.
- `recordAuditLog()` behaves exactly as before.
- Existing callers compile without behavior changes.
- `npm run typecheck` passes.
- `npm test` passes.
