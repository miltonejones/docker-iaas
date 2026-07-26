# Prompt: Add audit logging to host file and host build actions

Add structured audit logging to host file transfer and host build operations.

## Goal

Audit host-adjacent actions that can move files or deploy generated artifacts.

## Why this matters in Dockyard

Dockyard can interact with host-visible files and run predefined host build presets. Those operations are safety-sensitive because they cross the boundary between the control plane and the underlying machine or runtime artifacts.

These actions should be visible in the audit trail.

## Target files

- `server/src/routes/hostFiles.ts`
- `server/src/routes/hostBuilds.ts`

## Actions to audit

Add audit coverage for:
- host file copied to bucket
- host file copied to container
- host build preset executed / deployed

## Instructions

1. Use `recordAuditLog()`.
2. Add action names like:
   - `host_file.copy_to_bucket`
   - `host_file.copy_to_container`
   - `host_build.run`
3. Include user id where available.
4. Use safe summaries in `detail`.
5. Preserve current runtime behavior if audit logging fails.

## Safety rules

Do **not** log:
- file contents
- credentials
- secret values

Use summaries such as:
- source path
- destination bucket/key
- destination container/path
- preset name
- artifact destination path

## Acceptance criteria

- All host-file and host-build mutation paths emit audit entries.
- No sensitive content is logged.
- `npm run typecheck` passes.
- `npm test` passes.
