# Prompt: Add audit logging to confirmed database mutation paths

Add structured audit logging for high-risk database actions.

## Goal

Audit confirmed, mutation-bearing database actions without logging sensitive data.

## Why this matters in Dockyard

Dockyard stores encrypted saved DB connections and exposes mutation, migration, grant, backup, and restore flows. Those are among the highest-risk operations in the app and should have traceable audit coverage.

The audit trail should capture that an action happened, by whom, and at a safe summary level — without leaking credentials or full query bodies.

## Target files

Primary targets:
- `server/src/routes/databases.ts`
- `server/src/databaseManagement.ts` only if needed to construct safe summaries

## Actions to audit

Audit confirmed/destructive actions such as:
- grant
- mutate
- migrate
- backup
- restore
- create/update/delete saved connection if not already audited elsewhere

## Instructions

1. Use `recordAuditLog()`.
2. Only log confirmed/destructive actions, not routine reads.
3. Include user id when available.
4. Use safe summaries in `detail`.
5. Keep preview/confirm behavior exactly as it is.
6. Keep audit logging best-effort.

## Safety rules

Do **not** log:
- raw credentials
- full SQL bodies
- Mongo URIs with secrets
- full request payloads containing sensitive material

Prefer summaries like:
- connection id/name
- engine
- action category
- target database name
- step counts / row counts / job ids where available

## Acceptance criteria

- Confirmed DB mutation paths emit audit entries.
- Sensitive data is not logged.
- Preview behavior remains unchanged.
- `npm run typecheck` passes.
- `npm test` passes.
