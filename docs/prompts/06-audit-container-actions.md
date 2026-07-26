# Prompt: Add audit logging to dangerous container actions

Add structured audit logging for high-risk container actions.

## Goal

Use the existing audit logging helper to record dangerous or mutation-heavy container operations.

## Why this matters in Dockyard

Container operations are among the most privileged actions in Dockyard. They can execute commands, mutate environments, write files, and remove running infrastructure. Those actions need traceability.

This task extends audit coverage beyond gateway/domain management into core runtime control-plane behavior.

## Target files

Primary target:
- `server/src/routes/containers.ts`

Use helper files only if necessary.

## Actions to audit

Add audit entries for actions such as:
- container delete
- container exec
- container exec stream
- environment update
- file write
- file replace
- bulk file write
- other clearly destructive or mutation-bearing container operations already exposed by the API

## Instructions

1. Use `recordAuditLog()`.
2. Add clear action names such as:
   - `container.delete`
   - `container.exec`
   - `container.exec.stream`
   - `container.env.update`
   - `container.files.write`
   - `container.files.replace`
   - `container.files.bulk_write`
3. Include resource type and resource id where available.
4. Include authenticated user id where available.
5. Keep audit writes best-effort and non-blocking.
6. Use concise, safe summaries in `detail`.

## Safety rules

Do **not** log:
- secrets
- full file contents
- sensitive command output
- raw environment variable values

Prefer summaries like:
- container id/name
- command name or abbreviated command summary
- target path
- count of files affected

## Acceptance criteria

- High-risk container mutation paths emit audit entries.
- Sensitive payloads are not written to audit logs.
- `npm run typecheck` passes.
- `npm test` passes.
