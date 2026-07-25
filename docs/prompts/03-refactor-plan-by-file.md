# Prompt: Refactor Plan by File for Dockyard

## Purpose

Produce a concrete, file-by-file refactor plan that breaks down Dockyard's oversized modules into smaller, well-bounded units. The plan should be ordered by priority (highest-risk / highest-friction files first) and written so that each step can be executed incrementally without breaking the running system.

## Why this matters for Dockyard specifically

Dockyard has expanded from a container manager into a multi-domain control plane. The codebase is still largely organized as it was when the project was smaller, which means several files now carry far too many responsibilities. This creates three concrete problems:

1. **Every new feature touches shared files**, causing merge risk and unintended side-effects.
2. **Security reviews are harder** because trust boundaries, validation, and execution logic are mixed in the same file.
3. **Tests are harder to write** because each function has too many dependencies to isolate.

The refactor plan must be risk-aware: because Dockyard manages Docker, databases, credentials, and deploys, a careless refactor can introduce regressions in high-privilege paths.

## Embedded project context

### Files that need refactoring (in approximate priority order)

#### `server/src/db.ts` — highest priority
Currently contains:
- SQLite schema creation (`CREATE TABLE` statements)
- In-place migrations (cumulative `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS`)
- Persistence functions for: containers, users/auth, assistant sessions, issues, gateway traffic, lambda functions, routes, buckets, database connections and jobs, notifications
- Cross-domain queries (e.g., joining sessions with issues)

This is a "control plane kitchen sink." A bug in one domain's query can affect migrations for another.

#### `server/src/databaseManagement.ts` — highest priority
Currently contains:
- Input validation
- AES-256-GCM encryption/decryption of credentials
- MySQL driver (mysql2) integration
- MongoDB driver integration
- Schema inspection (SHOW TABLES, DESCRIBE, db.listCollections)
- Query normalization and dynamic query building
- Mutation preview generation
- Query execution
- Backup generation and restore
- Result serialization
- Summary formatting

This is at least 6 separate concerns jammed into one file.

#### `scripts/issue-consumer.mjs` — high priority
Approximately 56 kB of a single JavaScript module that:
- Polls for open issues
- Calls an AI API to generate fixes
- Applies file changes
- Commits and pushes
- Triggers deployment
- Handles retries and error states

This is a state machine, an AI client, a Git client, a file editor, and a deploy orchestrator in one script.

#### `web/src/api.ts` — medium priority
A single client SDK file exposing API calls for all features: containers, buckets, gateway, functions, databases, issues, sessions, notifications, assistant, auth. As the UI grows, this becomes a merge-conflict magnet.

#### `server/src/gatewayProxy.ts` — medium priority
Proxy logic, route resolution, telemetry recording, and static-file serving are likely mixed. Separating the proxy executor from the route resolver and the telemetry layer would improve testability and reduce SSRF risk surface.

#### `server/src/index.ts` — lower priority, but worth reviewing
Top-level Express app setup: if it's mounting routers and also containing initialization logic, bootstrapping, and middleware configuration, that's worth splitting for clarity.

### Stack and constraints

- **Language:** TypeScript (server, web) and JavaScript (scripts)
- **Database:** better-sqlite3 (synchronous API)
- **Runtime:** Node.js; no dependency injection framework
- **Test framework:** vitest (web), supertest (server)
- **Constraint:** Changes must be backward-compatible at the API level; the UI must not break

## Instructions

Produce a file-by-file refactor plan. For each file:

1. **State the problem** — what responsibilities the file currently holds that it shouldn't
2. **Propose the split** — list the new files/modules that should result, with a one-line description of each
3. **Define the migration path** — step-by-step sequence that can be done incrementally without breaking the app:
   - Which new file to create first
   - How to move logic without changing external behavior
   - When to update imports/consumers
   - How to validate the change is safe (what to run/check)
4. **Identify the risk** — what can go wrong during this refactor and how to avoid it
5. **Estimate the effort** — S (< 1 day) / M (1–3 days) / L (3–7 days) / XL (> 1 week)

### Files to cover (in priority order)

1. `server/src/db.ts`
2. `server/src/databaseManagement.ts`
3. `scripts/issue-consumer.mjs`
4. `web/src/api.ts`
5. `server/src/gatewayProxy.ts`
6. `server/src/index.ts` (if applicable)

### Additional instructions

- Do not propose rewrites — only incremental decompositions
- Every proposed new file should have a single, nameable responsibility
- Prefer colocation by domain over colocation by type (e.g., `db/gateway.ts` not `persistence/index.ts`)
- Note any shared utilities that should be extracted (e.g., encryption helpers, query sanitizers)
- Flag any refactor steps that touch security-sensitive code (crypto, auth, exec) — those need extra review

## Expected output / acceptance criteria

- A Markdown document with one section per file
- Each section includes: problem statement, proposed split (list of new files + one-line description each), migration path (numbered steps), risk notes, and effort estimate
- The plan is incremental — no step requires rewriting more than one concern at a time
- After each step, the application should still run and existing tests should still pass
- Security-sensitive steps are clearly flagged
- A reader who has never seen this codebase before could follow the plan without needing to ask clarifying questions

## Optional: files to include for richer output

Attach or paste the following for the most accurate plan:

- `server/src/db.ts` — full file
- `server/src/databaseManagement.ts` — full file
- `scripts/issue-consumer.mjs` — full file
- `web/src/api.ts` — full file
- `server/src/gatewayProxy.ts` — full file
- `server/src/index.ts` — full file
- `server/src/routes/` — directory listing with file sizes
