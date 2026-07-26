# Prompt: Extract saved database persistence from `server/src/db.ts`

Refactor `server/src/db.ts` by extracting saved database connection / operation / job persistence into a dedicated module.

## Goal

Create `server/src/db/databaseOps.ts` and move saved database persistence responsibilities into it.

## Why this matters in Dockyard

The database-management subsystem is now one of Dockyard's most powerful and sensitive areas. It includes:
- saved encrypted external DB connections
- operation history
- backup and restore job tracking
- mutation and migration support

That persistence deserves its own module boundary so future hardening and maintenance do not have to flow through a single oversized DB file.

## What to move

Move logic such as:
- database connection CRUD
- test result persistence helpers
- operation history helpers
- job history helpers
- related row types

## Instructions

1. Create `server/src/db/databaseOps.ts`.
2. Move database connection / operation / job persistence functions and related types.
3. Preserve current SQL behavior and export semantics unless a tiny compatibility fix is necessary.
4. Ensure startup table creation/migrations still happen.
5. Update `server/src/databaseManagement.ts` and any route callers with minimal disruption.

## Constraints

- Do **not** redesign schema or workflow behavior.
- Do **not** mix this with query/mutation logic changes in `databaseManagement.ts`.
- Keep the PR focused on decomposition only.

## Acceptance criteria

- Saved DB persistence lives in `server/src/db/databaseOps.ts`.
- Callers compile with unchanged runtime behavior.
- `server/src/db.ts` becomes substantially smaller.
- `npm run typecheck` passes.
- `npm test` passes.
