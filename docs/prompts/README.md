# Prompt Library

This directory contains focused, implementation-first prompts for closing high-priority gaps in Dockyard.

These prompts are designed for coding-oriented LLMs that perform best when the task is:
- narrowly scoped
- tied to exact files
- explicit about preserving behavior
- explicit about acceptance criteria
- free from broad architectural ambiguity

## How to use these prompts

1. Run **one prompt at a time**.
2. Prefer **one branch / one PR per prompt** unless a prompt explicitly depends on another in the same change.
3. Preserve behavior unless the prompt explicitly asks for a behavior change.
4. Always require:
   - `npm run typecheck`
   - `npm test`
5. Do not combine refactors with unrelated feature work.

## Recommended execution order

1. `01-extract-audit-db-module.md`
2. `02-test-gateway-audit-logging.md`
3. `03-extract-gateway-db-module.md`
4. `04-standardize-jwt-secret-handling.md`
5. `05-test-jwt-secret-boot.md`
6. `06-audit-container-actions.md`
7. `07-audit-host-actions.md`
8. `08-audit-database-mutations.md`
9. `09-audit-github-mutations.md`
10. `10-add-audit-log-api.md`
11. `11-extract-assistant-db-modules.md`
12. `12-extract-database-ops-db-module.md`

## Why these exist

Dockyard has improved meaningfully in security and operational discipline, especially around:
- JWT secret handling
- SSRF mitigation
- gateway/domain audit logging
- supply-chain pinning
- CI alignment

The biggest remaining high-priority gaps are:
- oversized persistence modules, especially `server/src/db.ts`
- incomplete audit coverage across dangerous mutation paths
- inconsistent secret/config handling between services
- limited observability for newly added audit events
- need for targeted tests around new safety behavior

These prompts are meant to close those gaps with the least planning burden possible.
