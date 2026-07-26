# Prompt: Extract assistant persistence modules from `server/src/db.ts`

Refactor `server/src/db.ts` by extracting assistant-related persistence into dedicated modules.

## Goal

Create:
- `server/src/db/assistantSessions.ts`
- `server/src/db/assistantIssues.ts`

Move assistant session and assistant issue persistence logic into those files.

## Why this matters in Dockyard

Dockyard's assistant subsystem is now a real product surface, not a small helper feature. It includes:
- saved sessions
- session search behavior
- issue tracking
- duplicate detection
- issue status workflows

Keeping that persistence mixed into a giant catch-all DB file makes future changes riskier and harder to review.

## What to move

Move assistant session logic such as:
- list/get/create/update/delete session helpers
- related row/summary types

Move assistant issue logic such as:
- list/get/create/update/delete/clear issue helpers
- count-by-status helpers
- recent duplicate detection logic
- related types/constants

## Instructions

1. Create the new files.
2. Move assistant-specific persistence functions and types into them.
3. Preserve current names and semantics where practical.
4. Keep duplicate-issue detection behavior unchanged.
5. Keep user scoping behavior unchanged.
6. Ensure table creation/migrations still happen during startup.
7. Update imports/callers with minimal disruption.

## Constraints

- Do **not** redesign assistant workflows.
- Do **not** change issue-state semantics.
- Do **not** mix this with unrelated persistence extraction.

## Acceptance criteria

- Assistant persistence lives in dedicated modules.
- Existing assistant routes and helpers compile unchanged in behavior.
- Duplicate detection and scoping still work the same.
- `npm run typecheck` passes.
- `npm test` passes.
