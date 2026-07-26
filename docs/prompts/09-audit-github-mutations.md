# Prompt: Add audit logging to GitHub mutation operations

Add structured audit logging for GitHub write or deployment-relevant mutation operations performed by Dockyard.

## Goal

Record audit entries for GitHub-linked actions that can mutate code or deployment state.

## Why this matters in Dockyard

Dockyard includes GitHub-linked automation and an issue-fix pipeline. Actions that clone, commit, push, or deploy artifacts are high-trust operations. They should be visible in the audit trail even if the underlying work succeeds silently.

## Target files

Primary target:
- `server/src/routes/github.ts`

Use helper files only if necessary.

## Actions to audit

Audit mutation-bearing flows such as:
- commit-and-push
- pull-to-container
- pull-to-bucket if it changes deployed/runtime state in a meaningful way
- any route that causes repository or deployment-relevant mutations

## Instructions

1. Use `recordAuditLog()`.
2. Add clear action names for each audited mutation path.
3. Include authenticated user id where available.
4. Keep audit writes best-effort.
5. Use safe summaries in `detail`.

## Safety rules

Do **not** log:
- token values
- file contents
- raw secrets

Prefer summaries like:
- owner/repo
- branch/ref
- number of files changed
- destination container or bucket
- operation type

## Acceptance criteria

- GitHub mutation flows emit audit entries.
- Secrets and file contents are not logged.
- `npm run typecheck` passes.
- `npm test` passes.
