# High Priority Hardening Plan

This backlog defines the recommended order for closing Dockyard's highest-priority gaps.

The goal is to make progress through a sequence of **small, reviewable, implementation-first changes** rather than broad redesign work.

## Principles

- Run prompts **one at a time**.
- Prefer **one PR per prompt**.
- Preserve existing behavior unless the prompt explicitly allows a behavior change.
- Require `npm run typecheck` and `npm test` for every step.
- Avoid mixing module extraction with unrelated product work.
- Prefer safe summaries and explicit non-goals when touching privileged paths.

## Order of execution

1. `docs/prompts/01-extract-audit-db-module.md`
2. `docs/prompts/02-test-gateway-audit-logging.md`
3. `docs/prompts/03-extract-gateway-db-module.md`
4. `docs/prompts/04-standardize-jwt-secret-handling.md`
5. `docs/prompts/05-test-jwt-secret-boot.md`
6. `docs/prompts/06-audit-container-actions.md`
7. `docs/prompts/07-audit-host-actions.md`
8. `docs/prompts/08-audit-database-mutations.md`
9. `docs/prompts/09-audit-github-mutations.md`
10. `docs/prompts/10-add-audit-log-api.md`
11. `docs/prompts/11-extract-assistant-db-modules.md`
12. `docs/prompts/12-extract-database-ops-db-module.md`

## Dependency notes

- **01** should land before broader DB extraction work so audit boundaries are clearer.
- **02** should land immediately after **01** so audit regressions are caught early.
- **03** should happen before other gateway persistence changes expand further.
- **04** and **05** should happen before more auth-adjacent changes.
- **06** through **09** expand coverage of dangerous actions once audit scaffolding is stabilized.
- **10** should happen after enough audit data exists to justify surfacing it.
- **11** and **12** are larger decomposition steps that should follow early hardening wins.

## Suggested tracking checklist

- [ ] 01 extract audit DB module
- [ ] 02 test gateway audit logging
- [ ] 03 extract gateway DB module
- [ ] 04 standardize JWT secret handling
- [ ] 05 test JWT secret boot
- [ ] 06 add audit logging to container actions
- [ ] 07 add audit logging to host actions
- [ ] 08 add audit logging to database mutation paths
- [ ] 09 add audit logging to GitHub mutation paths
- [ ] 10 add read-only audit log API
- [ ] 11 extract assistant DB modules
- [ ] 12 extract database operations DB module

## Completion criteria for this phase

This high-priority phase is complete when:
- audit logging is modularized and covered by tests
- dangerous mutation paths emit audit events
- JWT secret handling is consistent across services
- authenticated users can inspect recent audit events
- `server/src/db.ts` is meaningfully decomposed by domain
