# Hardening Index

This file is the canonical numbered reference for Dockyard's current high-priority hardening work.

Use these item numbers in commit messages, PR descriptions, and issue notes when you want a stable shorthand such as:

- `refs hardening #1 #2`
- `implements #7`
- `partial progress on #8`

For execution order and phase guidance, also see:
- `docs/backlog/high-priority-hardening-plan.md`

## Numbered items

1. **Extract audit DB module**  
   Move audit-log persistence from `server/src/db.ts` into a dedicated module.  
   See: `docs/prompts/01-extract-audit-db-module.md`

2. **Test gateway audit logging**  
   Add focused tests covering audit-log writes for gateway create/delete and domain enable/delete flows.  
   See: `docs/prompts/02-test-gateway-audit-logging.md`

3. **Extract gateway DB module**  
   Move gateway route/domain/telemetry persistence from `server/src/db.ts` into a dedicated module.  
   See: `docs/prompts/03-extract-gateway-db-module.md`

4. **Standardize JWT secret handling**  
   Make JWT secret loading consistent between `console` and `consumer`.  
   See: `docs/prompts/04-standardize-jwt-secret-handling.md`

5. **Test JWT secret boot behavior**  
   Add tests for secret-file loading, env fallback, and fail-fast behavior.  
   See: `docs/prompts/05-test-jwt-secret-boot.md`

6. **Audit dangerous container actions**  
   Add audit logging for high-risk container operations such as delete, exec, env updates, and file writes.  
   See: `docs/prompts/06-audit-container-actions.md`

7. **Audit host actions**  
   Add audit logging for host file transfer and host build operations.  
   See: `docs/prompts/07-audit-host-actions.md`

8. **Audit database mutations**  
   Add audit logging for confirmed DB grants, mutations, migrations, backups, and restores.  
   See: `docs/prompts/08-audit-database-mutations.md`

9. **Audit GitHub mutations**  
   Add audit logging for GitHub write or deployment-relevant mutation operations.  
   See: `docs/prompts/09-audit-github-mutations.md`

10. **Add audit log API**  
    Implement a minimal authenticated read-only API for recent audit events.  
    See: `docs/prompts/10-add-audit-log-api.md`

11. **Extract assistant DB modules**  
    Move assistant session and issue persistence into dedicated modules.  
    See: `docs/prompts/11-extract-assistant-db-modules.md`

12. **Extract database ops DB module**  
    Move saved DB connection / operation / job persistence into a dedicated module.  
    See: `docs/prompts/12-extract-database-ops-db-module.md`

## Notes

- The numbering in this file should remain stable once referenced by commits.
- Add new hardening work by appending new items instead of renumbering existing ones.
- If an item is split into multiple sub-tasks, preserve the parent item number and add sub-item notation rather than shifting the whole list.
