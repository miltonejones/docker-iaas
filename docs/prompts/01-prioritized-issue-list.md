# Prompt: Prioritized Issue List for Dockyard

## Purpose

Produce a ranked, actionable backlog of the most important open issues in the Dockyard project. The list should be ordered by a combination of **risk**, **blast radius**, and **effort required** — not by feature desirability alone — because this codebase carries unusually high operational privilege.

## Why this matters for Dockyard specifically

Dockyard is a personal Docker IaaS control plane that has access to:

- `/var/run/docker.sock` (full Docker daemon control)
- host filesystem mounts (`/:/host:ro`)
- saved database credentials (AES-256-GCM encrypted, but still in one trust domain)
- GitHub token and deploy automation
- DNS credentials
- AI-generated code that can be committed and deployed

The combination of **high privilege + rapid feature expansion + solo maintenance** means the backlog must be triaged by blast radius, not just user value. A missing RBAC check in a destructive route is more urgent than a missing feature.

## Embedded project context

- **Stack:** Express (TypeScript) + React (Vite, TypeScript) + SQLite (better-sqlite3) + dockerode + MinIO + Caddy
- **Monorepo layout:** `server/` | `web/` | `relay/` | `scripts/`
- **Largest files of concern:**
  - `server/src/db.ts` — schema, migrations, and persistence for all domains in one file
  - `server/src/databaseManagement.ts` — validation, crypto, adapters, preview, execution, backup/restore
  - `web/src/api.ts` — entire client SDK in one file
  - `scripts/issue-consumer.mjs` — ~56 kB autonomous issue-to-fix pipeline
- **Deployment:** Dockerized, GitHub Actions CI, GHCR images, SSH-based deploy
- **Known weak areas from prior evaluation:**
  - Authentication/authorization maturity lags privilege level
  - No structured audit log for destructive actions
  - Autonomous fix pipeline does direct push/deploy without PR-first gate
  - Host file access is broad (`/:/host:ro`)
  - Integration test coverage is likely below required risk level

## Instructions

You are producing a prioritized issue list for the Dockyard project. Work through the following steps:

1. **Identify all open risk categories** — security, architectural debt, testing gaps, operational maturity, product clarity. Use the project context above as your starting point.

2. **For each issue**, evaluate:
   - **Severity** (Critical / High / Medium / Low)
   - **Blast radius** — what can go wrong if this is not addressed
   - **Effort** (S / M / L / XL)
   - **Blocking dependencies** — does fixing this unblock other work

3. **Rank the list** by the following composite priority:
   - Critical severity issues first, regardless of effort
   - Among equals, prefer lower-effort items that unblock higher-effort ones
   - Security and data-integrity issues outrank feature and DX issues at the same severity

4. **Write each item** as a concise GitHub Issue-style entry with:
   - A short title (imperative verb phrase)
   - 2–4 sentence description of the problem and its consequence if unaddressed
   - Severity / Effort / Blast-radius labels
   - First concrete step to start (one sentence)

5. Produce at least **20 issues**, covering:
   - At least 6 security issues
   - At least 4 architectural/refactor issues
   - At least 4 testing issues
   - At least 3 operational/observability issues
   - At least 3 product/documentation issues

## Expected output / acceptance criteria

- A numbered Markdown list ordered by priority
- Each item includes: title, description, severity, effort, blast radius, and first step
- Security issues appear disproportionately at the top
- No duplicates or vague catch-alls ("improve quality")
- Each item is actionable: a developer could pick it up without further clarification
- The list reflects this specific project's privilege model — not a generic web app backlog

## Optional: files to include for richer output

Attach or paste the following if available:

- `server/src/db.ts` — to identify migration/schema risks
- `server/src/databaseManagement.ts` — to identify crypto and adapter risks
- `server/src/routes/` directory listing — to audit privileged route surface
- `scripts/issue-consumer.mjs` — to evaluate automation governance risks
- Current GitHub Issues list — to avoid duplicating existing work
